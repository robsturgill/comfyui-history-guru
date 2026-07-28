// ===================== AI INFERENCE WORKER (Workstream D) =====================
// Classic worker. Protocol is CONTRACT.md §2 verbatim: {t,id,...} in, {t,id,...} out.
// Nothing throws across the boundary -- every failure comes back as {t:'err',code,msg}.
//
// Three things in here are load-bearing and non-obvious; they are commented where they
// live, but in summary:
//   1. clipText.input_ids is int64. clipTokenize() hands back Int32Array(77) and feeding
//      that straight to ORT fails at run time -- it is widened to BigInt64Array.
//   2. A WebNN session can compile cleanly and then partition half its ops back to CPU,
//      running ~8x slower with no error anywhere. The only way to see that is to time it,
//      so every session is benchmarked on zeros and may be demoted (see openModel).
//   3. SCRFD anchor layout: mgrid[::-1] means x varies fastest, and the 2 anchors per
//      location are *consecutive*, not a second plane. Get that backwards and you get
//      plausible-looking boxes in the wrong places, with nothing to flag it.

let ORT = null, MAN = null, BASE = '', PREFER = 'auto', READY = null;
const SESS = {};      // key -> live InferenceSession
const EPC  = {};      // key -> resolved {ep,ms,tier,file,bytes,partitioned,tried}
let CLIP_TIER = null; // pinned once; both CLIP towers must share a precision tier
let FORCE_TIER = null;// init{tier} override, so a harness can compare EPs at equal precision
let CURPHASE = null;  // 'image' | 'face' -- 'text' is phase-neutral, see usePhase()

const WCACHE = 'guru-ai-w1';
const DET_TH = 0.5, NMS_IOU = 0.4, MIN_FACE = 24;
const LADDER = {
  auto:   [['webnn','npu'],['webnn','gpu'],['webgpu'],['wasm']],
  npu:    [['webnn','npu'],['webnn','gpu'],['webgpu'],['wasm']],
  gpu:    [['webnn','gpu'],['webgpu'],['wasm']],
  webgpu: [['webgpu'],['wasm']],
  wasm:   [['wasm']]
};
const tag = ep => ep[0] + (ep[1] ? ':' + ep[1] : '');
// int8 is the WASM fallback only. On an accelerator the dynamic-quantized graphs compile
// and then partition heavily to CPU -- the exact silent-slow failure this file guards against.
const tierOf = ep => ep[0] === 'wasm' ? 'int8' : 'fp16';

const post = (m, tr) => tr && tr.length ? self.postMessage(m, tr) : self.postMessage(m);
const perr = (id, code, msg) => post({t:'err', id: id == null ? undefined : id, code, msg: String(msg == null ? '' : msg).slice(0, 400)});

function codeOf(e){
  const s = String((e && (e.message || e)) || '');
  if (/cancell?ed/i.test(s)) return 'cancelled';
  if (/out of memory|oom|failed to allocate|allocation failed|Array buffer allocation/i.test(s)) return 'oom';
  if (/no execution provider|backend|executionProvider|ep not/i.test(s)) return 'backend';
  if (/fetch|HTTP \d|404|network|no such model|unknown model/i.test(s)) return 'nomodel';
  if (/decode|ImageBitmap|detached|neutered/i.test(s)) return 'nodecode';
  return 'unknown';
}

// ---------------------------------------------------------------- manifest helpers

function spec(key){
  const m = MAN && MAN.models && MAN.models[key];
  if (!m) throw new Error('unknown model: ' + key);
  return m;
}
// The manifest is deliberately non-uniform: CLIP carries variants{fp16,int8}, the face
// models carry file/bytes/sha256 directly.
function variantOf(key, tier){
  const m = spec(key);
  if (!m.variants) return m;
  return tier === 'int8' ? (m.variants.int8 || m.variants.fp16) : (m.variants.fp16 || m.variants.int8);
}
// Resolve a symbolic axis through freeDims. Never default to 1 -- CLIP vision at 1x1x1x1
// builds a session without erroring and then emits garbage.
function resolveShape(inp, fd){
  return inp.shape.map(d => {
    if (typeof d === 'number') return d;
    if (fd && fd[d] != null) return fd[d];
    throw new Error('unresolved free dim "' + d + '" for input ' + inp.name);
  });
}
const firstOut = (o, m) => o[m.outputs[0].name] || o[Object.keys(o)[0]];

// ORT hands fp16 tensors back as a Uint16Array. The manifests say float32 so this should
// never fire, but a silently-misread output is exactly the class of bug this file exists
// to prevent, so decode rather than trust.
function toF32(t){
  const d = t.data;
  if (d instanceof Float32Array) return Float32Array.from(d);
  if (t.type === 'float16'){
    const o = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++){
      const h = d[i], s = (h >> 15) & 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      let v;
      if (e === 0) v = (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
      else if (e === 31) v = f ? NaN : (s ? -Infinity : Infinity);
      else v = (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
      o[i] = v;
    }
    return o;
  }
  return Float32Array.from(d);
}

// ---------------------------------------------------------------- weights

// Cache API, not IndexedDB: the app's IDB holds the metadata cache, which is expensive to
// rebuild, and 300+MB of blobs alongside it raises eviction risk for that store.
async function weights(file){
  const url = new URL('models/' + file, BASE).href;
  try{
    const c = await caches.open(WCACHE);
    let r = await c.match(url);
    if (!r){
      const n = await fetch(url);
      if (!n.ok) throw new Error('fetch HTTP ' + n.status + ' ' + file);
      try{ await c.put(url, n.clone()); }catch(e){}   // quota: fine, we still hold `n`
      r = n;
    }
    return await r.arrayBuffer();
  }catch(e){
    if (/HTTP \d/.test(String(e.message))) throw e;
    const n = await fetch(url);
    if (!n.ok) throw new Error('fetch HTTP ' + n.status + ' ' + file);
    return await n.arrayBuffer();
  }
}

// ---------------------------------------------------------------- sessions

function zeroFeeds(key){
  const m = spec(key), fd = m.freeDims || {}, f = {};
  for (const inp of m.inputs){
    const sh = resolveShape(inp, fd);
    let n = 1; for (const d of sh) n *= d;
    f[inp.name] = inp.dtype === 'int64'
      ? new ORT.Tensor('int64', new BigInt64Array(n), sh)
      : new ORT.Tensor('float32', new Float32Array(n), sh);
  }
  return f;
}

async function mkSession(key, ep, buf){
  return await ORT.InferenceSession.create(buf, {
    executionProviders: [ep[1] ? {name: ep[0], deviceType: ep[1], powerPreference: 'high-performance'} : {name: ep[0]}],
    // WebNN wants the graph left close to as-exported; ORT's full pass set produces fused
    // nodes WebNN then can't map, which is one route into silent CPU partitioning.
    graphOptimizationLevel: ep[0] === 'webnn' ? 'basic' : 'all',
    freeDimensionOverrides: spec(key).freeDims || undefined
  });
}

// Median of 3 zero-tensor inferences. Zeros are fine: we are timing the graph partition,
// not the numerics, and a partitioned graph is slow regardless of input content.
async function benchMs(s, key){
  const f = zeroFeeds(key), t = [];
  for (let i = 0; i < 3; i++){ const t0 = performance.now(); await s.run(f); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  return t[1];
}

// A session can compile, run, and benchmark well while emitting constant, zero or NaN output --
// `benchMs` cannot see that, because it only measures how long a run takes. Two different inputs
// must therefore produce two different outputs before an EP is accepted.
//
// Deliberately a HARD-failure gate only (non-finite, all-zero, or effectively identical output
// for different inputs). A tighter threshold on synthetic inputs would start rejecting healthy
// sessions, since two synthetic patterns can legitimately embed close together. It does NOT catch
// subtler accuracy loss -- for that there is no substitute for the real cross-modal probe in
// ai-workercheck.html, which is where the WebGPU CLIP degradation on this machine was found.
async function sanity(s, key){
  if (key === 'faceDet') return null;   // detector: 9 heads, no single embedding to compare
  const m = spec(key), fd = m.freeDims || {};
  const mk = alt => {
    const f = {};
    for (const inp of m.inputs){
      const sh = resolveShape(inp, fd);
      let n = 1; for (const d of sh) n *= d;
      if (inp.dtype === 'int64'){
        // Must LOOK like a real tokenized sequence: BOS, a few tokens, EOS, then zero padding.
        // A constant fill is not good enough and silently defeated this whole gate: CLIP's text
        // tower pools at the argmax(EOS) position, and its causal mask only degenerates into NaN
        // on the real padded shape. Filled with a flat id there is no EOS, the bad path is never
        // taken, webnn:npu passed sanity, and every query embedding came back NaN with embS=0.
        const a = new BigInt64Array(n);
        const seq = alt ? [49406, 2368, 1929, 49407] : [49406, 320, 1125, 539, 49407];
        for (let i = 0; i < seq.length && i < n; i++) a[i] = BigInt(seq[i]);
        f[inp.name] = new ORT.Tensor('int64', a, sh);
      }else{
        const a = new Float32Array(n);
        for (let i = 0; i < n; i++) a[i] = alt ? Math.sin(i * 0.01) : (i % 97) / 97 - 0.5;
        f[inp.name] = new ORT.Tensor('float32', a, sh);
      }
    }
    return f;
  };
  const a = toF32(firstOut(await s.run(mk(0)), m));
  const b = toF32(firstOut(await s.run(mk(1)), m));
  let nz = false;
  for (let i = 0; i < a.length; i++){ if (!isFinite(a[i])) return 'non-finite output'; if (a[i] !== 0) nz = true; }
  for (let i = 0; i < b.length; i++) if (!isFinite(b[i])) return 'non-finite output';
  if (!nz) return 'all-zero output';
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++){ dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 'zero-norm output';
  if (dot / Math.sqrt(na * nb) > 0.9999) return 'identical output for two different inputs';
  return null;
}

// Walks the ladder for `key`, benchmarks at most two *successful* candidates, keeps the
// faster one. Resolution is cached in EPC, so a later phase re-creates the session with a
// single compile and no re-benchmark -- NPU compile is ~5x the GPU's and clipVision alone
// is 7 seconds; paying that twice per phase would dominate the whole job.
async function openModel(key){
  if (SESS[key]) return SESS[key];
  if (EPC[key]){
    const k = EPC[key];
    SESS[key] = await mkSession(key, k.ep, await weights(k.file));
    return SESS[key];
  }
  const cands = LADDER[PREFER] || LADDER.auto;
  const isCLIP = key === 'clipVision' || key === 'clipText';
  const tried = [];
  let win = null, alt = null;

  for (let i = 0; i < cands.length && !alt; i++){
    const ep = cands[i];
    // Both CLIP towers must match in checkpoint AND precision tier -- mixing shifts the
    // shared embedding space and quietly wrecks retrieval. So the first tower to resolve
    // pins the tier and the second follows it even if its own EP would prefer otherwise.
    const tier = FORCE_TIER || (isCLIP && CLIP_TIER ? CLIP_TIER : tierOf(ep));
    // The demotion probe must compare like with like. Tier is a function of the EP (int8 is
    // the WASM fallback only), so timing webgpu/fp16 against wasm/int8 would be timing two
    // *different models* and calling the gap "partitioning" -- and letting the int8 build win
    // on speed would silently move the whole library into a different embedding space. Once a
    // winner exists, only same-tier candidates are eligible as the probe. WASM stays a
    // fallback of last resort, reached when the ladder above it fails, never by demotion.
    if (win && tier !== win.tier) continue;
    const v = variantOf(key, tier);
    let s = null;
    try{
      s = await mkSession(key, ep, await weights(v.file));
    }catch(e){ tried.push(tag(ep) + ': ' + String(e.message || e).slice(0, 140)); continue; }
    let ms, bad;
    try{ ms = await benchMs(s, key); bad = await sanity(s, key); }
    catch(e){ tried.push(tag(ep) + ' run: ' + String(e.message || e).slice(0, 140)); try{ await s.release(); }catch(x){} continue; }
    if (bad){ tried.push(tag(ep) + ' failed sanity: ' + bad); try{ await s.release(); }catch(x){} continue; }
    const rec = {ep, ms, tier, file: v.file, bytes: v.bytes, s};
    if (!win){
      win = rec;
      // An explicit `prefer` is an instruction, not a hint: honour it and skip the probe.
      if (PREFER !== 'auto') break;
      // clipText is never probed for a faster alternative. It runs once per query (~10-30ms), so
      // speed is worth nothing here -- and the probe is actively dangerous: measured on this
      // machine, webnn:npu returns all-NaN (caught by sanity) but plain webgpu is *degenerate*,
      // returning the same image for "a photograph of a person", "a cat or a dog" and "a city
      // street at night". That passes every hard-failure check -- finite, non-zero, different
      // outputs for different inputs -- so a speed-based demotion would silently swap a working
      // tower for a broken one. Take the first EP that passes sanity and stop.
      if (key === 'clipText') break;
    } else alt = rec;
  }

  if (!win) throw new Error('backend: no execution provider accepted ' + key + ' — ' + (tried.join(' | ') || 'no candidates'));

  let keep = win, drop = alt, partitioned = false;
  // 10% margin so run-to-run jitter can't flap the choice. A genuinely partitioned WebNN
  // graph is ~8x off, not 5%.
  if (alt && alt.ms < win.ms * 0.9){ keep = alt; drop = win; partitioned = true; }
  if (drop){ try{ await drop.s.release(); }catch(e){} }
  if (isCLIP && !CLIP_TIER) CLIP_TIER = keep.tier;

  EPC[key] = {ep: keep.ep, ms: keep.ms, tier: keep.tier, file: keep.file, bytes: keep.bytes, partitioned, tried};
  SESS[key] = keep.s;
  // Additive fields on `prog` -- consumers that only read {id,done,total,phase} are unaffected,
  // but it is the only channel that can report a lazily-compiled model's real backend + ms.
  // `cands` lists every candidate that was actually benchmarked, in ladder order, so a demotion
  // is legible: without it the loser is invisible and `partitioned:true` looks like a glitch.
  post({t:'prog', id: null, phase: 'load', done: 1, total: 1, model: key,
        name: keep.ep[0], device: keep.ep[1] || null, ms: keep.ms, tier: keep.tier,
        file: keep.file, partitioned, rejected: tried,
        cands: [win, alt].filter(Boolean).map(r => ({tag: tag(r.ep), ms: r.ms, tier: r.tier}))});
  return SESS[key];
}

// Image and face phases are strictly sequential; this releases the previous phase's
// sessions at the boundary and only at the boundary. `want` is uniform across a phase, so
// in a real job this fires once, never per item -- an NPU session churned mid-job costs
// seconds each time. A `text` request is phase-neutral: a user searching while the library
// indexes must not evict clipVision.
async function usePhase(need){
  const ph = need.indexOf('faceDet') >= 0 ? 'face' : need.indexOf('clipVision') >= 0 ? 'image' : 'text';
  if (ph !== 'text'){
    if (CURPHASE && CURPHASE !== ph){
      for (const k of Object.keys(SESS)){
        if (k === 'clipText' || need.indexOf(k) >= 0) continue;
        try{ await SESS[k].release(); }catch(e){}
        delete SESS[k];
      }
    }
    CURPHASE = ph;
  }
  for (const k of need) await openModel(k);
}

// ---------------------------------------------------------------- CLIP

async function embedImage(bmp){
  const m = spec('clipVision'), px = await preImage(bmp);
  const o = await SESS.clipVision.run({[m.inputs[0].name]: new ORT.Tensor('float32', px, resolveShape(m.inputs[0], m.freeDims))});
  const v = toF32(firstOut(o, m));
  l2norm(v);
  return quantI8(v);
}

async function embedText(ids){
  const m = spec('clipText'), sh = resolveShape(m.inputs[0], m.freeDims);
  let n = 1; for (const d of sh) n *= d;
  // input_ids is int64. clipTokenize() returns Int32Array(77); handing that to ORT throws.
  const b = new BigInt64Array(n);
  for (let i = 0; i < n && i < ids.length; i++) b[i] = BigInt(ids[i] | 0);
  const o = await SESS.clipText.run({[m.inputs[0].name]: new ORT.Tensor('int64', b, sh)});
  const v = toF32(firstOut(o, m));
  l2norm(v);
  return quantI8(v);
}

// ---------------------------------------------------------------- SCRFD

// Letterbox into 640x640 anchored at the TOP-LEFT, padded black. Top-left rather than
// centred on purpose: the inverse is a single divide by `sc` with no offset to remember,
// and a forgotten offset is the classic "boxes are plausible but shifted" bug.
function preDet(bmp){
  const S = 640, w = bmp.width, h = bmp.height, sc = Math.min(S / w, S / h);
  const nw = Math.max(1, Math.round(w * sc)), nh = Math.max(1, Math.round(h * sc));
  const cv = new OffscreenCanvas(S, S), c = cv.getContext('2d', {willReadFrequently: true});
  c.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in c) c.imageSmoothingQuality = 'high';
  c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
  c.drawImage(bmp, 0, 0, nw, nh);
  const d = c.getImageData(0, 0, S, S).data, n = S * S, o = new Float32Array(3 * n);
  // SCRFD's own blobFromImage: (rgb - 127.5)/128, swapRB, NCHW.
  for (let i = 0, p = 0; i < n; i++, p += 4){
    o[i] = (d[p] - 127.5) / 128;
    o[n + i] = (d[p + 1] - 127.5) / 128;
    o[2 * n + i] = (d[p + 2] - 127.5) / 128;
  }
  return {data: o, sc};
}

function nms(a, thr){
  a.sort((p, q) => q.score - p.score);
  const keep = [];
  for (const c of a){
    let ok = true;
    for (const k of keep){
      const x1 = Math.max(c.x1, k.x1), y1 = Math.max(c.y1, k.y1);
      const x2 = Math.min(c.x2, k.x2), y2 = Math.min(c.y2, k.y2);
      const iw = x2 - x1, ih = y2 - y1;
      if (iw <= 0 || ih <= 0) continue;
      const inter = iw * ih;
      const u = (c.x2 - c.x1) * (c.y2 - c.y1) + (k.x2 - k.x1) * (k.y2 - k.y1) - inter;
      if (u > 0 && inter / u > thr){ ok = false; break; }
    }
    if (ok) keep.push(c);
  }
  return keep;
}

const STRIDE_OF = {12800: 8, 3200: 16, 800: 32};

// `out` is ORT's name->tensor map for all 9 SCRFD heads. Grouped by dims rather than by
// name or manifest order: the names are raw ONNX node ids ("443", "468", …) and nothing
// guarantees the run order matches the manifest's listing.
function scrfdDecode(out, sc, iw, ih, thr){
  const by = {};
  for (const k in out){
    const t = out[k], d = t.dims, c = d[d.length - 1];
    let tot = 1; for (const q of d) tot *= q;
    const N = tot / c;                       // derived, not d[0]: tolerates a leading batch axis
    const g = (by[N] = by[N] || {});
    if (c === 1) g.s = t.data; else if (c === 4) g.b = t.data; else if (c === 10) g.k = t.data;
  }
  const cand = [];
  for (const Nk in by){
    const g = by[Nk], N = +Nk, stride = STRIDE_OF[N];
    if (!stride || !g.s || !g.b || !g.k) continue;
    const fw = 640 / stride;   // 80 / 40 / 20
    const A = 2;               // SCRFD-500M-KPS: 2 anchors per spatial location
    for (let i = 0; i < N; i++){
      const score = g.s[i];
      if (score < thr) continue;
      // insightface builds centres as mgrid[:h,:w][::-1] -> x varies fastest, then
      // np.stack([centres]*num_anchors, axis=1) -> the A anchors sit CONSECUTIVELY.
      const loc = (i / A) | 0;
      const cx = (loc % fw) * stride, cy = ((loc / fw) | 0) * stride;
      const b = i * 4;
      // distance-to-bbox, distances are in stride units (net_outs * stride upstream).
      const x1 = cx - g.b[b] * stride, y1 = cy - g.b[b + 1] * stride;
      const x2 = cx + g.b[b + 2] * stride, y2 = cy + g.b[b + 3] * stride;
      const o = i * 10, kps = new Array(10);
      for (let j = 0; j < 5; j++){
        kps[2 * j]     = (cx + g.k[o + 2 * j] * stride) / sc;
        kps[2 * j + 1] = (cy + g.k[o + 2 * j + 1] * stride) / sc;
      }
      cand.push({score, x1: x1 / sc, y1: y1 / sc, x2: x2 / sc, y2: y2 / sc, kps});
    }
  }
  const kept = nms(cand, NMS_IOU), res = [];
  for (const c of kept){
    const x = Math.max(0, Math.min(iw, c.x1)), y = Math.max(0, Math.min(ih, c.y1));
    const X = Math.max(0, Math.min(iw, c.x2)), Y = Math.max(0, Math.min(ih, c.y2));
    res.push({box: [x, y, X - x, Y - y], score: c.score, kps: c.kps});
  }
  return res;
}

async function detectFaces(bmp, thr){
  const m = spec('faceDet'), p = preDet(bmp);
  const o = await SESS.faceDet.run({[m.inputs[0].name]: new ORT.Tensor('float32', p.data, resolveShape(m.inputs[0], m.freeDims))});
  return scrfdDecode(o, p.sc, bmp.width, bmp.height, thr == null ? DET_TH : thr);
}

async function embedFaces(bmp, dets){
  const fm = spec('faceEmb'), sh = resolveShape(fm.inputs[0], fm.freeDims), out = [];
  for (const d of dets){
    // Below ~24px there is not enough detail for ArcFace to produce a usable identity;
    // reported rather than dropped so the caller can show why.
    if (Math.max(d.box[2], d.box[3]) < MIN_FACE){
      out.push({box: d.box, score: d.score, kps: d.kps, skip: 'toosmall'});
      continue;
    }
    const px = await preFace(bmp, d.box, d.kps);
    const o = await SESS.faceEmb.run({[fm.inputs[0].name]: new ORT.Tensor('float32', px, sh)});
    const v = toF32(firstOut(o, fm));
    l2norm(v);
    const q = quantI8(v);
    out.push({box: d.box, score: d.score, kps: d.kps, emb: q.q, embS: q.s});
  }
  return out;
}

// ---------------------------------------------------------------- clustering

function doCluster(m){
  const e = m.embs || {}, th = m.ths || {};
  const v = e.v, s = e.s, key = e.key || null, conf = e.conf || null;
  const AT = th.assign != null ? th.assign : 0.50;
  const MT = th.merge != null ? th.merge : 0.55;
  const MINN = th.minN != null ? th.minN : 3;
  const D = 512, N = s ? s.length : 0;
  if (!N){ post({t:'clusters', id: m.id, assign: new Int32Array(0), clusters: []}); return; }

  // Strongest detections first so each cluster is seeded by its most reliable member --
  // a blurry profile shot seeding a cluster drags its centroid somewhere nothing matches.
  const ord = new Array(N); for (let i = 0; i < N; i++) ord[i] = i;
  if (conf) ord.sort((a, b) => conf[b] - conf[a]);

  const deq = i => { const f = new Float32Array(D), sc = s[i] || 0; for (let j = 0; j < D; j++) f[j] = v[i * D + j] * sc; return l2norm(f); };

  const cents = [], cnt = [], seed = [], assign = new Int32Array(N).fill(-1);
  for (let z = 0; z < N; z++){
    const i = ord[z], f = deq(i);
    let best = -2, bi = -1;
    for (let c = 0; c < cents.length; c++){
      const cc = cents[c]; let d = 0;
      for (let j = 0; j < D; j++) d += f[j] * cc[j];
      if (d > best){ best = d; bi = c; }
    }
    if (bi >= 0 && best >= AT){
      const cc = cents[bi], n = cnt[bi];
      for (let j = 0; j < D; j++) cc[j] = (cc[j] * n + f[j]) / (n + 1);   // running mean...
      l2norm(cc);                                                        // ...renormalized so it stays a direction
      cnt[bi] = n + 1; assign[i] = bi;
    }else{
      cents.push(f); cnt.push(1); seed.push(key ? key[i] : i); assign[i] = cents.length - 1;
    }
    if ((z & 255) === 0) post({t:'prog', id: m.id, done: z, total: N, phase: 'cluster'});
  }

  // All-pairs centroid merge. Greedy assignment is order-dependent: the same person can
  // seed two clusters when their first two frames are far apart, and only a second pass
  // over the settled centroids can see that.
  const par = new Int32Array(cents.length); for (let i = 0; i < cents.length; i++) par[i] = i;
  const find = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let a = 0; a < cents.length; a++) for (let b = a + 1; b < cents.length; b++){
    let d = 0; const A = cents[a], B = cents[b];
    for (let j = 0; j < D; j++) d += A[j] * B[j];
    if (d >= MT){ const ra = find(a), rb = find(b); if (ra !== rb) par[ra < rb ? rb : ra] = ra < rb ? ra : rb; }
  }

  const grp = new Map();
  for (let c = 0; c < cents.length; c++){
    const r = find(c), g = grp.get(r) || {members: [], n: 0};
    g.members.push(c); g.n += cnt[c]; grp.set(r, g);
  }
  const remap = new Int32Array(cents.length).fill(-1), outC = [];
  for (const [root, g] of grp){
    if (g.n < MINN) continue;   // n<3 is noise: one or two sightings is not a person
    const cent = new Float32Array(D);
    for (const c of g.members){ const cc = cents[c], w = cnt[c]; for (let j = 0; j < D; j++) cent[j] += cc[j] * w; }
    l2norm(cent);
    const q = quantI8(cent);
    const id = outC.length;
    for (const c of g.members) remap[c] = id;
    outC.push({id, cent: q.q, centS: q.s, n: g.n, rep: seed[root]});
  }
  for (let i = 0; i < N; i++) assign[i] = assign[i] >= 0 ? remap[assign[i]] : -1;

  post({t:'prog', id: m.id, done: N, total: N, phase: 'cluster'});
  const tr = [assign.buffer]; for (const c of outC) tr.push(c.cent.buffer);
  post({t:'clusters', id: m.id, assign, clusters: outC}, tr);
}

// ---------------------------------------------------------------- job queue

// One run() at a time per session, and in practice one job at a time full stop -- ORT
// sessions are not safe for concurrent run(). The job is decode-bound anyway (50-150ms
// per image on the main thread vs 15-40ms of NPU inference here), so serializing costs
// nothing: the main thread's next bitmap is already in flight while this one runs.
let Q = Promise.resolve();
const PEND = new Map();   // id -> queued message, so cancel can close its bitmap
const KILL = new Set();   // ids cancelled while already running
let EPOCH = 0;            // bumped by a bare `cancel`; jobs enqueued before it are dead

function closeMsg(m){ try{ if (m && m.bitmap && m.bitmap.close) m.bitmap.close(); }catch(e){} }
function chk(m){ if (m._e < EPOCH || KILL.has(m.id)) throw new Error('cancelled'); }

function enqueue(m){
  m._e = EPOCH;
  PEND.set(m.id, m);
  Q = Q.then(() => runJob(m));
}
async function runJob(m){
  if (!PEND.has(m.id)) return;   // cancelled while queued; err already posted
  PEND.delete(m.id);
  try{
    chk(m);
    if (!READY) throw new Error('worker not initialized');
    if (m.t === 'text') await jobText(m);
    else if (m.t === 'cluster') doCluster(m);
    else await jobImg(m);
  }catch(e){
    closeMsg(m);
    perr(m.id, codeOf(e), e && e.message || e);
  }finally{
    KILL.delete(m.id);
  }
}

async function jobImg(m){
  const tl = performance.now(), bmp = m.bitmap;
  if (!bmp || typeof bmp.width !== 'number' || !bmp.width) throw new Error('nodecode: no usable bitmap');
  const want = m.want || {clip: true, faces: false};
  const need = [];
  if (want.clip) need.push('clipVision');
  if (want.faces) need.push('faceDet', 'faceEmb');
  if (!need.length) throw new Error('nothing requested');

  await usePhase(need);
  // `ms` is inference only. Session compile lands on the first item of a phase and is 1-7s;
  // folding it into `ms` would make that item look 60x slower than the rest and poison any
  // per-image average the caller computes. It is reported separately as `loadMs`.
  const loadMs = performance.now() - tl, t0 = performance.now();
  chk(m);
  let emb = null, embS = 0, faces = [];
  if (want.clip){ const q = await embedImage(bmp); emb = q.q; embS = q.s; chk(m); }
  if (want.faces){
    const dets = await detectFaces(bmp, m.detTh);
    chk(m);
    faces = await embedFaces(bmp, dets);
  }
  closeMsg(m);
  const out = {t:'res', id: m.id, emb, embS, faces, ms: performance.now() - t0, loadMs};
  if (m.fi != null){ out.fi = m.fi; out.nF = m.nF; }
  const tr = [];
  if (emb) tr.push(emb.buffer);
  for (const f of faces) if (f.emb) tr.push(f.emb.buffer);
  post(out, tr);
}

async function jobText(m){
  await usePhase(['clipText']);
  chk(m);
  const q = await embedText(m.ids);
  post({t:'vec', id: m.id, emb: q.q, embS: q.s}, [q.q.buffer]);
}

// ---------------------------------------------------------------- init

async function doInit(m){
  if (READY){ post(READY); return; }
  // Resolved against the worker's own URL so a plain `new Worker('ai/ai-worker.js')` needs
  // no configuration; `base` exists for the case where the worker is spun from a Blob and
  // location.href is useless.
  BASE = m.base || new URL('./', location.href).href;
  importScripts(new URL('ort/ort.all.min.js', BASE).href, new URL('src/preproc.js', BASE).href);
  ORT = self.ort;
  if (!ORT) throw new Error('ort global missing after importScripts');
  ORT.env.wasm.wasmPaths = new URL('ort/', BASE).href;
  ORT.env.wasm.numThreads = self.crossOriginIsolated ? 4 : 1;
  ORT.env.wasm.proxy = false;              // already off the main thread
  ORT.env.logLevel = 'error';
  MAN = m.manifest;
  PREFER = m.prefer || 'auto';
  FORCE_TIER = m.tier || null;
  if (!MAN || !MAN.models) throw new Error('nomodel: manifest missing models');

  post({t:'prog', id: m.id, done: 0, total: 1, phase: 'load'});
  // Ladder walk + empirical benchmark on faceDet: 2.4MB and ~1.4s on the NPU, the cheapest
  // model that still exercises a real graph, so `init` costs seconds rather than the 16.6s
  // a full four-model compile would. The heavy sessions compile lazily at phase entry and
  // report their own backend + ms through `prog{phase:'load'}`.
  await openModel('faceDet');
  const probe = EPC.faceDet;
  try{ await SESS.faceDet.release(); }catch(e){}
  delete SESS.faceDet;

  const models = {};
  for (const k of Object.keys(MAN.models)){
    const r = EPC[k];
    const tier = r ? r.tier : (FORCE_TIER || ((k === 'clipVision' || k === 'clipText') && CLIP_TIER ? CLIP_TIER : tierOf(probe.ep)));
    const v = variantOf(k, tier);
    models[k] = {
      file: v.file, mb: +((v.bytes || 0) / 1048576).toFixed(1), tier,
      ep: tag(r ? r.ep : probe.ep), ms: r ? r.ms : null,
      resolved: !!r, partitioned: r ? r.partitioned : false,
      rejected: r ? r.tried : []
    };
  }
  READY = {t:'ready', backend: {name: probe.ep[0], device: probe.ep[1] || null, ms: probe.ms, partitioned: probe.partitioned}, models,
           coi: !!self.crossOriginIsolated, threads: ORT.env.wasm.numThreads, ortVersion: (ORT.env.versions && ORT.env.versions.common) || null};
  post({t:'prog', id: m.id, done: 1, total: 1, phase: 'load'});
  post(READY);
}

// ---------------------------------------------------------------- dispatch

self.onmessage = ev => {
  const m = ev.data || {};
  try{
    if (m.t === 'init'){ Q = Q.then(() => doInit(m).catch(e => perr(m.id, codeOf(e), e && e.message || e))); return; }
    // cancel is handled off the queue on purpose -- queued behind the work it is cancelling
    // it would never arrive in time to matter.
    if (m.t === 'cancel'){
      if (m.id == null){
        EPOCH++;
        for (const [id, q] of PEND){ closeMsg(q); perr(id, 'cancelled', 'cancelled'); }
        PEND.clear();
      }else if (PEND.has(m.id)){
        closeMsg(PEND.get(m.id)); PEND.delete(m.id); perr(m.id, 'cancelled', 'cancelled');
      }else KILL.add(m.id);
      return;
    }
    if (m.t === 'img' || m.t === 'frame' || m.t === 'text' || m.t === 'cluster'){ enqueue(m); return; }
    perr(m.id, 'unknown', 'unknown message type: ' + m.t);
  }catch(e){ perr(m.id, codeOf(e), e && e.message || e); }
};
self.onerror = e => { perr(undefined, 'unknown', (e && e.message) || 'worker error'); };
// ===================== /AI INFERENCE WORKER =====================
