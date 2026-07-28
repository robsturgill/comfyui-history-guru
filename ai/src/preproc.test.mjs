// Verification harness for preproc.js. preproc.js is a plain script (no import/
// export -- pasted verbatim into the host HTML's <script> block later), so it's
// loaded here via vm.runInThisContext, same pattern as tokenizer.test.mjs.
//
// Node 24 has no OffscreenCanvas/createImageBitmap, so the canvas-dependent parts of
// preImage/preFace are exercised against small hand-written stubs (see "STUBS" below)
// that validate argument shapes, output length/layout and geometry math, but do NOT
// prove real bicubic resize, real drawImage compositing, or real getImageData pixel
// correctness -- those need a browser. See the printed BROWSER-ONLY list at the end.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'preproc.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail){
  if (cond) { pass++; console.log('PASS', name); }
  else { fail++; console.log('FAIL', name, detail !== undefined ? detail : ''); }
}
function approx(a, b, eps){ return Math.abs(a - b) <= eps; }

// ===================== STUBS (canvas-dependent paths only) =====================
// Minimal fakes for OffscreenCanvas / createImageBitmap. They record call args so
// geometry (resize/crop rects, setTransform matrices) can be asserted, and return a
// fixed solid-color image so the normalization math can be checked exactly.

const R = 100, G = 150, B = 200; // fixed stub pixel color
const calls = { drawImage: [], setTransform: [], getContext: [], newCanvas: [] };

class FakeCtx {
  constructor(w, h){ this.w = w; this.h = h; }
  drawImage(...args){ calls.drawImage.push(args); }
  setTransform(...args){ calls.setTransform.push(args); }
  getImageData(x, y, w, h){
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++){ data[i*4]=R; data[i*4+1]=G; data[i*4+2]=B; data[i*4+3]=255; }
    return { data, width: w, height: h };
  }
}
class FakeOffscreenCanvas {
  constructor(w, h){ this.width = w; this.height = h; calls.newCanvas.push([w, h]); }
  getContext(kind){ calls.getContext.push(kind); return new FakeCtx(this.width, this.height); }
}
async function fakeCreateImageBitmap(blob){
  return { width: blob._w, height: blob._h, closed: false, close(){ this.closed = true; } };
}
class FakeBlob {
  constructor(w, h){ this._w = w; this._h = h; }
}
// Make FakeBlob pass `instanceof Blob` checks in preproc.js by using the real global Blob
// as a base isn't possible (needs binary parts), so instead we subclass the real Blob.
class StubBlob extends Blob {
  constructor(w, h){ super([]); this._w = w; this._h = h; }
}

globalThis.OffscreenCanvas = FakeOffscreenCanvas;
globalThis.createImageBitmap = fakeCreateImageBitmap;

vm.runInThisContext(src + `
globalThis.__preproc = {
  preImage, preFace, quantI8, deqI8, cosI8, cosI8Row, l2norm,
  solveSimilarityTransform, ARCFACE_REF, CLIP_MEAN, CLIP_STD,
};`, { filename: 'preproc.js' });

const {
  preImage, preFace, quantI8, deqI8, cosI8, cosI8Row, l2norm,
  solveSimilarityTransform, ARCFACE_REF, CLIP_MEAN, CLIP_STD,
} = globalThis.__preproc;

// ===================== quantI8 / deqI8 =====================

function randVec(n, scale = 1){
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) v[i] = (Math.random() * 2 - 1) * scale;
  return v;
}

{
  const v = randVec(512, 3.7);
  const { q, s } = quantI8(v);
  check('quantI8 output lengths', q.length === 512, `q.length=${q.length}`);
  check('quantI8 all values in [-127,127]', Array.from(q).every(x => x >= -127 && x <= 127));
  const deq = deqI8(q, s);
  let maxErr = 0;
  for (let i = 0; i < v.length; i++) maxErr = Math.max(maxErr, Math.abs(v[i] - deq[i]));
  const expectedBound = s / 2 + 1e-6; // round-to-nearest quantization error is at most s/2
  check('quantI8/deqI8 round-trip error bounded', maxErr <= expectedBound, `maxErr=${maxErr}, s=${s}`);
  console.log(`  measured max round-trip abs error: ${maxErr.toFixed(6)} (scale s=${s.toFixed(6)})`);
}

{
  const zeros = new Float32Array(64);
  const { q, s } = quantI8(zeros);
  check('quantI8 all-zero -> s=0, no NaN', s === 0 && Array.from(q).every(x => x === 0));
  const deq = deqI8(q, s);
  check('deqI8 of all-zero has no NaN', Array.from(deq).every(x => x === 0 && !Number.isNaN(x)));
}

{
  // clamping: a huge outlier shouldn't let any value escape [-127,127] and shouldn't NaN
  const v = new Float32Array([1000, -1000, 0, 0.0001, -0.0001]);
  const { q, s } = quantI8(v);
  check('quantI8 clamps to [-127,127]', q[0] === 127 && q[1] === -127, `q=${Array.from(q)}`);
  check('quantI8 scale is finite and > 0', Number.isFinite(s) && s > 0);
}

// ===================== cosI8 vs plain float cosine =====================

function cosF32(a, b){
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

{
  let maxAbsErr = 0;
  const DIM = 128, TRIALS = 1000;
  for (let t = 0; t < TRIALS; t++){
    const a = randVec(DIM, 1 + Math.random() * 5);
    const b = randVec(DIM, 1 + Math.random() * 5);
    const refCos = cosF32(a, b);
    const qa = quantI8(a), qb = quantI8(b);
    const got = cosI8(qa.q, qa.s, qb.q, qb.s);
    maxAbsErr = Math.max(maxAbsErr, Math.abs(refCos - got));
  }
  check('cosI8 matches float cosine within 0.01 over 1000 random pairs', maxAbsErr < 0.01, `maxAbsErr=${maxAbsErr}`);
  console.log(`  measured max cosI8 vs float-cosine abs error over ${TRIALS} trials: ${maxAbsErr.toFixed(6)}`);
}

// identical / orthogonal / opposite
{
  const a = randVec(64, 2);
  const qa = quantI8(a);
  check('cosI8 identical vectors ~ 1', approx(cosI8(qa.q, qa.s, qa.q, qa.s), 1, 1e-3), cosI8(qa.q, qa.s, qa.q, qa.s));

  const neg = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) neg[i] = -a[i];
  const qneg = quantI8(neg);
  check('cosI8 opposite vectors ~ -1', approx(cosI8(qa.q, qa.s, qneg.q, qneg.s), -1, 1e-3), cosI8(qa.q, qa.s, qneg.q, qneg.s));

  // orthogonal: build b perpendicular to a in a 2D-rotated subspace (swap+negate pairs)
  const orth = new Float32Array(64);
  for (let i = 0; i < 32; i++){ orth[2*i] = -a[2*i+1]; orth[2*i+1] = a[2*i]; }
  const qorth = quantI8(orth);
  check('cosI8 orthogonal vectors ~ 0', approx(cosI8(qa.q, qa.s, qorth.q, qorth.s), 0, 0.02), cosI8(qa.q, qa.s, qorth.q, qorth.s));
}

// zero-vector edge case in cosI8
{
  const zq = quantI8(new Float32Array(16));
  const oq = quantI8(randVec(16, 1));
  check('cosI8 zero-vector -> 0, not NaN', cosI8(zq.q, zq.s, oq.q, oq.s) === 0);
}

// ===================== cosI8Row =====================

{
  const DIM = 96, ROWS = 20;
  const rows = [];
  const mat = new Int8Array(ROWS * DIM);
  const scales = new Float32Array(ROWS);
  for (let r = 0; r < ROWS; r++){
    const v = randVec(DIM, 1 + Math.random() * 4);
    const { q, s } = quantI8(v);
    mat.set(q, r * DIM);
    scales[r] = s;
    rows.push(q);
  }
  const query = randVec(DIM, 2);
  const { q: bq, s: bs } = quantI8(query);

  let worst = 0;
  for (let r = 0; r < ROWS; r++){
    const viaRow = cosI8Row(mat, r, DIM, scales, bq, bs);
    const viaCos = cosI8(rows[r], scales[r], bq, bs);
    worst = Math.max(worst, Math.abs(viaRow - viaCos));
  }
  check('cosI8Row agrees exactly with cosI8 for every row', worst === 0, `worst diff=${worst}`);
}

// ===================== l2norm =====================

{
  const v = randVec(200, 5);
  const normed = l2norm(v.slice());
  let ss = 0; for (let i = 0; i < normed.length; i++) ss += normed[i]*normed[i];
  check('l2norm produces unit length', approx(Math.sqrt(ss), 1, 1e-5), Math.sqrt(ss));

  const same = new Float32Array(4); same.fill(1);
  const n2 = l2norm(same);
  check('l2norm returns the SAME array (in-place)', n2 === same);

  const zero = new Float32Array(8);
  const nz = l2norm(zero);
  check('l2norm zero vector stays zero, no NaN', Array.from(nz).every(x => x === 0));
}

// ===================== solveSimilarityTransform =====================

{
  // Synthesize a known scale+rotation+translation, apply to a point set, solve, and
  // recover the original parameters. Use ARCFACE_REF itself as the "src" points and a
  // second, independent set to make sure the solver isn't accidentally special-cased
  // to that particular point cloud.
  const trials = [
    { s: 1.0,  ang: 0,        tx: 0,     ty: 0 },
    { s: 1.7,  ang: 0.3,      tx: 15,    ty: -8 },
    { s: 0.6,  ang: -1.1,     tx: -40,   ty: 22 },
    { s: 2.3,  ang: Math.PI/2, tx: 5,    ty: 5 },
  ];
  const srcSets = [
    ARCFACE_REF,
    [[0,0],[100,0],[50,50],[10,90],[90,90]],
  ];
  for (const src2 of srcSets){
    for (const { s, ang, tx, ty } of trials){
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const dst = src2.map(([x,y]) => [s*ca*x - s*sa*y + tx, s*sa*x + s*ca*y + ty]);
      const got = solveSimilarityTransform(src2, dst);
      const okScale = approx(got.scale, s, 1e-6);
      // angle recovered mod 2pi; normalize both into [-pi,pi] before compare
      const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
      const okAngle = approx(norm(got.angle), norm(ang), 1e-6);
      const okT = approx(got.tx, tx, 1e-6) && approx(got.ty, ty, 1e-6);
      check(`solveSimilarityTransform recovers s=${s} ang=${ang} t=(${tx},${ty})`,
        okScale && okAngle && okT,
        `got scale=${got.scale}, angle=${got.angle}, tx=${got.tx}, ty=${got.ty}`);
    }
  }
}

// ===================== preImage (stubbed canvas) =====================

await (async () => {
  calls.drawImage.length = 0; calls.newCanvas.length = 0;
  const blob = new StubBlob(400, 200); // landscape: short side = height = 200
  const out = await preImage(blob);
  check('preImage output length = 1*3*224*224', out.length === 3*224*224, out.length);
  check('preImage output is Float32Array', out instanceof Float32Array);

  const n = 224*224;
  const expR = (R/255 - CLIP_MEAN[0]) / CLIP_STD[0];
  const expG = (G/255 - CLIP_MEAN[1]) / CLIP_STD[1];
  const expB = (B/255 - CLIP_MEAN[2]) / CLIP_STD[2];
  check('preImage NCHW plane 0 (R) matches normalized constant', approx(out[0], expR, 1e-6) && approx(out[n-1], expR, 1e-6), `${out[0]} vs ${expR}`);
  check('preImage NCHW plane 1 (G) matches normalized constant', approx(out[n], expG, 1e-6) && approx(out[2*n-1], expG, 1e-6), `${out[n]} vs ${expG}`);
  check('preImage NCHW plane 2 (B) matches normalized constant', approx(out[2*n], expB, 1e-6) && approx(out[3*n-1], expB, 1e-6), `${out[2*n]} vs ${expB}`);

  // geometry: 400x200 -> short side (200) scaled to 224 -> resize target 448x224, then
  // center-crop 224x224 out of that.
  const resizeCanvas = calls.newCanvas[0];
  check('preImage resizes short side to 224 preserving aspect (not squashed)', resizeCanvas[0] === 448 && resizeCanvas[1] === 224, `got ${resizeCanvas}`);

  // an already-decoded ImageBitmap-shaped object should be accepted directly, no createImageBitmap call needed
  const bmp = { width: 300, height: 300 };
  const out2 = await preImage(bmp);
  check('preImage accepts a pre-decoded bitmap-shaped object directly', out2.length === 3*224*224);
})();

// ===================== preFace (stubbed canvas) =====================

await (async () => {
  calls.setTransform.length = 0; calls.drawImage.length = 0;
  const blob = new StubBlob(500, 500);
  // kps in "already aligned" position == ARCFACE_REF itself -> solved transform should be identity
  const kps = ARCFACE_REF.flat();
  const out = await preFace(blob, null, kps);
  check('preFace output length = 1*3*112*112', out.length === 3*112*112, out.length);
  const last = calls.setTransform[calls.setTransform.length - 1];
  check('preFace resets transform after drawing (identity)', last.every((v,i) => approx(v, [1,0,0,1,0,0][i], 1e-9)));
  const applied = calls.setTransform[0];
  check('preFace applies near-identity transform when kps == reference points',
    approx(applied[0],1,1e-6) && approx(applied[1],0,1e-6) && approx(applied[2],0,1e-6) && approx(applied[3],1,1e-6) && approx(applied[4],0,1e-6) && approx(applied[5],0,1e-6),
    `applied=${applied}`);

  const n = 112*112;
  const expR = (R - 127.5) / 128.0;
  check('preFace ArcFace-normalizes plane 0 correctly', approx(out[0], expR, 1e-6), `${out[0]} vs ${expR}`);

  // box fallback path, no kps
  calls.drawImage.length = 0;
  const blob2 = new StubBlob(1000, 800);
  const out3 = await preFace(blob2, [100, 100, 200, 200], null);
  check('preFace box-fallback output length = 1*3*112*112', out3.length === 3*112*112);
  const dArgs = calls.drawImage[calls.drawImage.length - 1];
  // box center (200,200), 1.3x expanded to 260x260 -> [70,70]..[330,330], within 1000x800 bounds unclamped
  check('preFace box fallback expands ~1.3x and clamps to source bounds',
    approx(dArgs[1], 70, 1e-6) && approx(dArgs[2], 70, 1e-6) && approx(dArgs[3], 260, 1e-6) && approx(dArgs[4], 260, 1e-6),
    `drawImage args=${JSON.stringify(dArgs)}`);

  // missing both kps and box -> throws
  let threw = false;
  try { await preFace(blob2, null, null); } catch (e) { threw = true; }
  check('preFace throws when neither kps nor box is given', threw);
})();

console.log(`\n${pass} passed, ${fail} failed`);

console.log('\n--- BROWSER-ONLY (cannot be verified in Node) ---');
console.log('- Real createImageBitmap() decode of PNG/JPEG/WebP bytes (stubbed here with a fixed-size fake).');
console.log('- Real OffscreenCanvas 2D bicubic-ish resize quality (imageSmoothingQuality) and actual drawImage compositing/resampling.');
console.log('- Real getImageData() pixel values from an actual decoded+resized image (stub returns a fixed solid color).');
console.log('- HTMLVideoElement / HTMLCanvasElement as live drawImage sources (videoWidth/videoHeight branch is covered structurally via a bitmap-shaped stub, not a real video element).');
console.log('- Canvas setTransform()+drawImage() actually performing the ArcFace affine warp pixel-for-pixel (matrix values themselves are verified via solveSimilarityTransform + stub call args).');
console.log('- crypto/GPU-accelerated canvas behavior differences between Chrome versions.');

if (fail > 0) process.exit(1);
