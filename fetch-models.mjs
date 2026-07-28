#!/usr/bin/env node
// fetch-models.mjs — one-time model downloader for the on-device AI feature (Workstream A).
//
// Node 24, zero npm dependencies, stdlib only. Downloads ONNX Runtime Web + the CLIP / face
// models into ai/ort and ai/models, then writes ai/models/manifest.json by reading the real
// input/output/shape info out of each ONNX file's protobuf header (never guessed — see
// ai/CONTRACT.md §3).
//
// Usage:
//   node fetch-models.mjs           fetch everything (fp16 + int8 CLIP towers, faces, ORT runtime)
//   node fetch-models.mjs --int8    skip the fp16 CLIP towers (smaller, WASM-only path)
//   node fetch-models.mjs --force   re-download even if a file already matches the manifest
//
// Safe to re-run: anything already on disk whose size + sha256 match the expected values below
// is skipped.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AI_DIR = path.join(__dirname, 'ai');
const ORT_DIR = path.join(AI_DIR, 'ort');
const MODELS_DIR = path.join(AI_DIR, 'models');

const ORT_VERSION = '1.27.0'; // current stable onnxruntime-web on npm as of writing — see report

const argv = new Set(process.argv.slice(2));
const FLAG_INT8 = argv.has('--int8');
const FLAG_FORCE = argv.has('--force');
const FLAG_HELP = argv.has('--help') || argv.has('-h');

if (FLAG_HELP) {
  console.log(`fetch-models.mjs — downloads ai/ort + ai/models for the on-device AI feature

  --int8   skip the fp16 CLIP towers (smaller download, WASM-only path)
  --force  re-download even if a file already matches the manifest
  --help   this message`);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Source inventory. `bytes`/`sha256` are the known-good values fetched from the origin (HF's
// LFS metadata API, or computed locally against the pinned onnxruntime-web@1.27.0 CDN build).
// They double as the "expected" values for the skip-if-present check and as an integrity check
// on every fresh download.
// ---------------------------------------------------------------------------------------------

const CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist`;
const CLIP_REPO = 'https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main';
const FACE_REPO = 'https://huggingface.co/immich-app/buffalo_s/resolve/main';

/** @type {Array<{key:string, url:string, dir:string, file:string, bytes:number, sha256:string, group?:string, variant?:string, int8Skippable?:boolean, kind:'ort'|'onnx'}>} */
const SOURCES = [
  // --- ONNX Runtime Web, the /all jsep UMD build (WebGPU + WebNN + WASM/CPU all in one) ---
  {
    key: 'ort-all', kind: 'ort', dir: ORT_DIR, file: 'ort.all.min.js',
    url: `${CDN}/ort.all.min.js`,
    bytes: 811518, sha256: 'df84c52a502d111dc25a50179f7e36d553776f3387d714aeff775d1d296296a3',
  },
  {
    key: 'ort-wasm-jsep-mjs', kind: 'ort', dir: ORT_DIR, file: 'ort-wasm-simd-threaded.jsep.mjs',
    url: `${CDN}/ort-wasm-simd-threaded.jsep.mjs`,
    bytes: 46614, sha256: '3ee381d20a80f51a788a1c4a5872f6f1d047538dd4342f4af00062de5f9ea4c6',
  },
  {
    key: 'ort-wasm-jsep-wasm', kind: 'ort', dir: ORT_DIR, file: 'ort-wasm-simd-threaded.jsep.wasm',
    url: `${CDN}/ort-wasm-simd-threaded.jsep.wasm`,
    bytes: 26827543, sha256: '78feeeb3d08f6bcee94d938ed322f69073bb8076b5f9d34697a574ffba8deb48',
  },

  // --- CLIP ViT-B/32, Xenova's ONNX export ---
  {
    key: 'clip-vision-fp16', kind: 'onnx', dir: MODELS_DIR, file: 'clip-vision-fp16.onnx',
    url: `${CLIP_REPO}/onnx/vision_model_fp16.onnx`,
    bytes: 176080659, sha256: '35c4e0fb0aeee527dcde1693520b214a34424a786babd530f35366bad5844efd',
    group: 'clipVision', variant: 'fp16', int8Skippable: true,
  },
  {
    key: 'clip-vision-int8', kind: 'onnx', dir: MODELS_DIR, file: 'clip-vision-int8.onnx',
    url: `${CLIP_REPO}/onnx/vision_model_int8.onnx`,
    bytes: 88648877, sha256: '0ab0c1b3ace708e539633af1744d5a95247fe4e14d3e08ff197ef82a6cb9bd93',
    group: 'clipVision', variant: 'int8',
  },
  {
    key: 'clip-text-fp16', kind: 'onnx', dir: MODELS_DIR, file: 'clip-text-fp16.onnx',
    url: `${CLIP_REPO}/onnx/text_model_fp16.onnx`,
    bytes: 127339794, sha256: 'df587ffbf248bf20d44fa6e16adc5ebc27ead691860e5333dbdaab5fd6bf3f6e',
    group: 'clipText', variant: 'fp16', int8Skippable: true,
  },
  {
    key: 'clip-text-int8', kind: 'onnx', dir: MODELS_DIR, file: 'clip-text-int8.onnx',
    url: `${CLIP_REPO}/onnx/text_model_int8.onnx`,
    bytes: 64070791, sha256: '18845f2ccc35223bb7fec403383a131154b11ac0918df25cf51986df5efd3a21',
    group: 'clipText', variant: 'int8',
  },

  // --- Faces: InsightFace buffalo_s pack (SCRFD-500M-KPS detector + w600k_mbf embedder),
  //     re-hosted by immich-app with a plain ONNX export. No precision split — always fetched. ---
  {
    key: 'face-det', kind: 'onnx', dir: MODELS_DIR, file: 'face-det-scrfd500m.onnx',
    url: `${FACE_REPO}/detection/model.onnx`,
    bytes: 2524817, sha256: '5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a',
    group: 'faceDet',
  },
  {
    key: 'face-emb', kind: 'onnx', dir: MODELS_DIR, file: 'face-emb-w600k-mbf.onnx',
    url: `${FACE_REPO}/recognition/model.onnx`,
    bytes: 13616099, sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
    group: 'faceEmb',
  },
];

const activeSources = SOURCES.filter(s => !(FLAG_INT8 && s.int8Skippable));

// ---------------------------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------------------------

function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function alreadyGood(src) {
  const dest = path.join(src.dir, src.file);
  if (FLAG_FORCE) return false;
  try {
    const st = await fsp.stat(dest);
    if (st.size !== src.bytes) return false;
  } catch {
    return false;
  }
  const actual = await sha256File(dest);
  return actual === src.sha256;
}

function printProgress(label, received, total) {
  const pct = total ? ((received / total) * 100).toFixed(1) : '?';
  process.stdout.write(`\r  ${label}: ${fmtMB(received)}MB / ${total ? fmtMB(total) + 'MB' : '?'} (${pct}%)   `);
}

async function downloadOnce(src) {
  const dest = path.join(src.dir, src.file);
  const part = dest + '.part';
  await fsp.mkdir(src.dir, { recursive: true });

  const res = await fetch(src.url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${src.url}`);
  }
  const total = Number(res.headers.get('content-length')) || src.bytes || 0;

  let received = 0;
  let lastPrint = 0;
  const nodeStream = Readable.fromWeb(res.body);
  const out = fs.createWriteStream(part);
  nodeStream.on('data', chunk => {
    received += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 150 || received === total) {
      printProgress(src.file, received, total);
      lastPrint = now;
    }
  });
  await pipeline(nodeStream, out);
  process.stdout.write('\n');

  const actualBytes = (await fsp.stat(part)).size;
  const actualSha = await sha256File(part);
  if (actualBytes !== src.bytes || actualSha !== src.sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(
      `checksum mismatch for ${src.file}: got ${actualBytes}B/${actualSha}, expected ${src.bytes}B/${src.sha256}`
    );
  }
  await fsp.rename(part, dest);
}

async function downloadWithRetry(src) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await downloadOnce(src);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt}/${MAX_ATTEMPTS} failed for ${src.file}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  throw new Error(`giving up on ${src.file} after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
}

// ---------------------------------------------------------------------------------------------
// Minimal protobuf wire-format reader for ONNX ModelProto headers.
//
// Only length-delimited (wire type 2) and varint (wire type 0) fields are meaningful for the
// shapes/names we need; everything else is skipped generically by wire type.
//
// Real onnx.proto3 field numbers used here (verified against the actual spec, not guessed —
// see the report for a correction vs. the task brief's shorthand numbering):
//   ModelProto.graph            = 7   (wire 2)
//   GraphProto.input            = 11  (wire 2, repeated ValueInfoProto)
//   GraphProto.output           = 12  (wire 2, repeated ValueInfoProto)
//   ValueInfoProto.name         = 1   (wire 2, string)
//   ValueInfoProto.type         = 2   (wire 2, TypeProto)
//   TypeProto.tensor_type       = 1   (wire 2, TypeProto.Tensor)  [oneof]
//   TypeProto.Tensor.elem_type  = 1   (wire 0, varint)
//   TypeProto.Tensor.shape      = 2   (wire 2, TensorShapeProto)
//   TensorShapeProto.dim        = 1   (wire 2, repeated Dimension)
//   Dimension.dim_value         = 1   (wire 0, varint)            [oneof]
//   Dimension.dim_param         = 2   (wire 2, string)            [oneof]
// ---------------------------------------------------------------------------------------------

const ELEM_TYPE = {
  1: 'float32', 2: 'uint8', 3: 'int8', 4: 'uint16', 5: 'int16', 6: 'int32', 7: 'int64',
  8: 'string', 9: 'bool', 10: 'float16', 11: 'double', 12: 'uint32', 13: 'uint64',
  16: 'bfloat16',
};

function readVarint(buf, pos) {
  let result = 0, shift = 1, b;
  do {
    b = buf[pos++];
    result += (b & 0x7f) * shift;
    shift *= 128;
  } while (b & 0x80);
  return [result, pos];
}

// Yields {field, wireType, value} for varint/32-bit fields, {field, wireType, start, end} for
// length-delimited fields. Throws on wire types we don't expect in ONNX (groups, 3/4).
function* iterFields(buf, start, end) {
  let pos = start;
  while (pos < end) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      yield { field, wireType, value };
    } else if (wireType === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      yield { field, wireType, start: pos, end: pos + len };
      pos += len;
    } else if (wireType === 5) {
      yield { field, wireType, value: buf.readUInt32LE(pos) };
      pos += 4;
    } else if (wireType === 1) {
      yield { field, wireType, value: buf.readBigUInt64LE(pos) };
      pos += 8;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType} at byte ${pos}`);
    }
  }
}

function findAll(buf, start, end, wantField) {
  const out = [];
  for (const f of iterFields(buf, start, end)) {
    if (f.field === wantField) out.push(f);
  }
  return out;
}

function findFirst(buf, start, end, wantField) {
  for (const f of iterFields(buf, start, end)) {
    if (f.field === wantField) return f;
  }
  return undefined;
}

function parseDimension(buf, start, end) {
  const dv = findFirst(buf, start, end, 1); // dim_value, varint
  if (dv && dv.wireType === 0) return dv.value;
  const dp = findFirst(buf, start, end, 2); // dim_param, string
  if (dp && dp.wireType === 2) return buf.toString('utf8', dp.start, dp.end);
  return null; // fully unspecified dimension
}

function parseValueInfo(buf, start, end) {
  const nameF = findFirst(buf, start, end, 1);
  const name = nameF ? buf.toString('utf8', nameF.start, nameF.end) : '(unnamed)';
  const typeF = findFirst(buf, start, end, 2);
  let dtype = 'unknown', shape = [];
  if (typeF) {
    const tensorF = findFirst(buf, typeF.start, typeF.end, 1); // TypeProto.tensor_type
    if (tensorF) {
      const elemF = findFirst(buf, tensorF.start, tensorF.end, 1);
      if (elemF) dtype = ELEM_TYPE[elemF.value] || `elem_type:${elemF.value}`;
      const shapeF = findFirst(buf, tensorF.start, tensorF.end, 2);
      if (shapeF) {
        const dims = findAll(buf, shapeF.start, shapeF.end, 1);
        shape = dims.map(d => parseDimension(buf, d.start, d.end));
      }
    }
  }
  return { name, dtype, shape };
}

/** Reads an ONNX file and returns {inputs, outputs, freeDims}. */
async function readOnnxIO(filePath) {
  const buf = await fsp.readFile(filePath);
  const graphF = findFirst(buf, 0, buf.length, 7); // ModelProto.graph
  if (!graphF) throw new Error(`${filePath}: no graph field found — not a valid ModelProto?`);

  const inputFields = findAll(buf, graphF.start, graphF.end, 11); // GraphProto.input
  const outputFields = findAll(buf, graphF.start, graphF.end, 12); // GraphProto.output

  const inputs = inputFields.map(f => parseValueInfo(buf, f.start, f.end));
  const outputs = outputFields.map(f => parseValueInfo(buf, f.start, f.end));

  // Only the *input* axes matter for freeDimensionOverrides; output dims are derived by the graph.
  // Deliberately NOT defaulted to 1 — see RESOLVE_DIMS. Defaulting every named axis to 1 compiles
  // CLIP vision as 1x1x1x1 instead of 1x3x224x224: it builds a session without complaining and then
  // produces garbage, which is the worst possible failure mode.
  const dynDims = [];
  for (const io of inputs) {
    for (const d of io.shape) if (typeof d === 'string' && !dynDims.includes(d)) dynDims.push(d);
  }

  return { inputs, outputs, dynDims };
}

// The real value each named axis must take, per model. Verified against ORT 1.27.0 on the WebNN NPU:
// with these, all four models compile; with all-ones they do not (or compile wrong).
// Note the exporters name these inconsistently - SCRFD calls both spatial axes "?" (so one override
// sets both, which is what we want for square 640x640) and ArcFace literally names its batch axis
// "None". Anything not listed here is a hard error rather than a silent default.
const RESOLVE_DIMS = {
  clipVision: { batch_size: 1, num_channels: 3, height: 224, width: 224 },
  clipText:   { batch_size: 1, sequence_length: 77 },
  faceDet:    { '?': 640 },
  faceEmb:    { None: 1 },
};

function resolveFreeDims(key, dynDims) {
  const table = RESOLVE_DIMS[key];
  if (!table) throw new Error(`No RESOLVE_DIMS entry for model "${key}" — add one; do not default to 1.`);
  const out = {};
  for (const d of dynDims) {
    if (!(d in table)) throw new Error(
      `Model "${key}" has dynamic axis "${d}" with no value in RESOLVE_DIMS. ` +
      `WebNN needs static shapes; guessing 1 here silently produces a wrong-shaped graph.`);
    out[d] = table[d];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------------------------

async function fileMeta(dir, file) {
  const p = path.join(dir, file);
  try {
    const st = await fsp.stat(p);
    const sha256 = await sha256File(p);
    return { file, bytes: st.size, sha256, path: p };
  } catch {
    return null;
  }
}

async function buildManifest() {
  const models = {};

  // clipVision / clipText: variants keyed by precision, inputs/outputs/freeDims read from
  // whichever variant is present on disk (fp16 preferred — both variants share the same graph
  // I/O, only weight precision differs).
  for (const [groupKey, prefix] of [['clipVision', 'clip-vision'], ['clipText', 'clip-text']]) {
    const fp16 = await fileMeta(MODELS_DIR, `${prefix}-fp16.onnx`);
    const int8 = await fileMeta(MODELS_DIR, `${prefix}-int8.onnx`);
    if (!fp16 && !int8) continue;
    const variants = {};
    if (fp16) variants.fp16 = { file: fp16.file, bytes: fp16.bytes, sha256: fp16.sha256 };
    if (int8) variants.int8 = { file: int8.file, bytes: int8.bytes, sha256: int8.sha256 };
    const io = await readOnnxIO((fp16 || int8).path);
    models[groupKey] = {
      variants,
      inputs: io.inputs.map(({ name, dtype, shape }) => ({ name, dtype, shape })),
      outputs: io.outputs.map(({ name, dtype, shape }) => ({ name, dtype, shape })),
      freeDims: resolveFreeDims(groupKey, io.dynDims),
    };
  }

  // faceDet / faceEmb: single precision, flat file/bytes/sha256 alongside inputs/outputs/freeDims.
  for (const [groupKey, file] of [['faceDet', 'face-det-scrfd500m.onnx'], ['faceEmb', 'face-emb-w600k-mbf.onnx']]) {
    const meta = await fileMeta(MODELS_DIR, file);
    if (!meta) continue;
    const io = await readOnnxIO(meta.path);
    models[groupKey] = {
      file: meta.file, bytes: meta.bytes, sha256: meta.sha256,
      inputs: io.inputs.map(({ name, dtype, shape }) => ({ name, dtype, shape })),
      outputs: io.outputs.map(({ name, dtype, shape }) => ({ name, dtype, shape })),
      freeDims: resolveFreeDims(groupKey, io.dynDims),
    };
  }

  const manifest = {
    v: 1,
    models,
    tokenizer: { vocab: 'clip-tokenizer/vocab.json', merges: 'clip-tokenizer/merges.txt' },
  };

  const manifestPath = path.join(MODELS_DIR, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifest, manifestPath };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  console.log(`fetch-models.mjs — onnxruntime-web ${ORT_VERSION}${FLAG_INT8 ? ' (--int8: skipping fp16 CLIP towers)' : ''}${FLAG_FORCE ? ' (--force)' : ''}\n`);

  await fsp.mkdir(ORT_DIR, { recursive: true });
  await fsp.mkdir(MODELS_DIR, { recursive: true });

  let downloaded = 0, skipped = 0, totalBytes = 0;
  for (const src of activeSources) {
    totalBytes += src.bytes;
    const good = await alreadyGood(src);
    if (good) {
      console.log(`  [skip] ${src.file} (${fmtMB(src.bytes)}MB, already up to date)`);
      skipped++;
      continue;
    }
    console.log(`  [fetch] ${src.file} <- ${src.url}`);
    await downloadWithRetry(src);
    downloaded++;
  }

  console.log(`\n${downloaded} file(s) downloaded, ${skipped} already up to date. ~${fmtMB(totalBytes)}MB total for this invocation.\n`);

  console.log('Reading ONNX headers and writing manifest...');
  const { manifest, manifestPath } = await buildManifest();
  console.log(`Wrote ${manifestPath}`);
  for (const [key, m] of Object.entries(manifest.models)) {
    const ins = m.inputs.map(i => `${i.name}:${i.dtype}${JSON.stringify(i.shape)}`).join(', ');
    const outs = m.outputs.map(o => `${o.name}${JSON.stringify(o.shape)}`).join(', ');
    console.log(`  ${key}: in[${ins}] -> out[${outs}] freeDims=${JSON.stringify(m.freeDims)}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nfetch-models.mjs failed:', err.stack || err.message);
  process.exit(1);
});
