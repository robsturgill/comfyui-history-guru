// --- AI:PREPROC ---
// Image preprocessing (CLIP + ArcFace) and int8 embedding codec, dependency-free.
// Plain script -- no import/export -- gets pasted verbatim into the host script block
// block later, so it must also run unmodified inside a Web Worker (hence
// createImageBitmap + OffscreenCanvas throughout; `new Image()` doesn't exist there).

// CLIP (ViT-B/32) per-channel normalization constants, RGB order.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD  = [0.26862954, 0.26130258, 0.27577711];

// Canonical ArcFace 5-point reference landmarks for a 112x112 aligned crop
// (left eye, right eye, nose, left mouth corner, right mouth corner).
const ARCFACE_REF = [[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],[41.5493,92.3655],[70.7299,92.2041]];

// Blob needs decoding to a drawable; ImageBitmap/HTMLVideoElement/HTMLCanvasElement
// are already valid drawImage() sources and are used as-is (so a caller who already
// decoded via createImageBitmap once can hand that same bitmap to both preImage and
// preFace without paying for a second decode).
async function _toDrawable(src){
  if (typeof Blob !== 'undefined' && src instanceof Blob) return await createImageBitmap(src);
  return src;
}
function _srcDims(src){
  // HTMLVideoElement reports size as videoWidth/videoHeight, everything else as width/height.
  if (src && typeof src.videoWidth === 'number' && src.videoWidth) return [src.videoWidth, src.videoHeight];
  return [src.width, src.height];
}

// ----- CLIP image preprocessing -----

// Resize short side to 224 (CLIP's own Resize(224, BICUBIC)), THEN center-crop to
// 224x224. This two-step order is load-bearing: a plain squash-resize straight to
// 224x224 warps the aspect ratio and silently degrades retrieval quality rather than
// erroring, so there's nothing that flags the bug -- it just quietly returns worse
// matches forever.
async function preImage(src){
  const madeBitmap = (typeof Blob !== 'undefined' && src instanceof Blob);
  const drawable = madeBitmap ? await createImageBitmap(src) : src;
  const [sw, sh] = _srcDims(drawable);
  const scale = 224 / Math.min(sw, sh);
  const rw = Math.max(224, Math.round(sw * scale));
  const rh = Math.max(224, Math.round(sh * scale));

  const rcv = new OffscreenCanvas(rw, rh);
  const rctx = rcv.getContext('2d');
  rctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in rctx) rctx.imageSmoothingQuality = 'high'; // closest canvas gets to bicubic
  rctx.drawImage(drawable, 0, 0, rw, rh);

  const cx = Math.floor((rw - 224) / 2), cy = Math.floor((rh - 224) / 2);
  const ccv = new OffscreenCanvas(224, 224);
  const cctx = ccv.getContext('2d');
  cctx.drawImage(rcv, cx, cy, 224, 224, 0, 0, 224, 224);

  const { data } = cctx.getImageData(0, 0, 224, 224); // RGBA Uint8ClampedArray, interleaved
  const n = 224 * 224;
  const out = new Float32Array(3 * n);
  // NCHW (channel-planar: all R, then all G, then all B) -- NOT interleaved. A model
  // expecting NCHW fed interleaved data doesn't error, it just produces plausible-
  // looking garbage, so this loop is the one place that ordering has to be exactly right.
  for (let i = 0, o = 0; i < n; i++, o += 4){
    out[i]         = (data[o]     / 255 - CLIP_MEAN[0]) / CLIP_STD[0];
    out[n + i]     = (data[o + 1] / 255 - CLIP_MEAN[1]) / CLIP_STD[1];
    out[2 * n + i] = (data[o + 2] / 255 - CLIP_MEAN[2]) / CLIP_STD[2];
  }
  if (madeBitmap && drawable.close) drawable.close(); // only close bitmaps we decoded ourselves
  return out;
}

// ----- ArcFace alignment -----

// Solve a 4x4 linear system in place via Gaussian elimination with partial pivoting.
// 4x4-only helper for solveSimilarityTransform below -- not a general linear solver.
function _solve4(M, rhs){
  for (let col = 0; col < 4; col++){
    let piv = col;
    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col){ const t = M[col]; M[col] = M[piv]; M[piv] = t; const tr = rhs[col]; rhs[col] = rhs[piv]; rhs[piv] = tr; }
    const pv = M[col][col];
    if (Math.abs(pv) < 1e-12) continue; // degenerate (e.g. all points coincident); leave row be
    for (let r = 0; r < 4; r++){
      if (r === col) continue;
      const f = M[r][col] / pv;
      if (f === 0) continue;
      for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
      rhs[r] -= f * rhs[col];
    }
  }
  const x = new Array(4);
  for (let i = 0; i < 4; i++) x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : rhs[i] / M[i][i];
  return x;
}

// Least-squares 2D similarity transform (uniform scale + rotation + translation, no
// reflection) mapping src points onto dst points:
//   dst_x = a*x - b*y + tx,  dst_y = b*x + a*y + ty      (a,b) == (s*cosθ, s*sinθ)
// Parameterizing rotation+scale as the single pair (a,b) -- instead of scale and angle
// separately -- keeps the whole model linear in its 4 unknowns [a,b,tx,ty], so N>=2
// point correspondences solve directly via normal equations. That's the standard
// Umeyama/Procrustes result for the *no-reflection* 2D case: because rotation+uniform-
// scale matrices [[a,-b],[b,a]] already form a linear subspace (isomorphic to complex
// multiplication), least-squares over that subspace needs no SVD and can't produce a
// reflection by construction -- unlike the general N-D Umeyama solve.
function solveSimilarityTransform(src, dst){
  const n = src.length;
  let Sxx = 0, Syy = 0, Sx = 0, Sy = 0;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  for (let i = 0; i < n; i++){
    const x = src[i][0], y = src[i][1], dx = dst[i][0], dy = dst[i][1];
    Sxx += x * x; Syy += y * y; Sx += x; Sy += y;
    b0 += x * dx + y * dy;
    b1 += -y * dx + x * dy;
    b2 += dx;
    b3 += dy;
  }
  const Sxy2 = Sxx + Syy;
  const M = [
    [Sxy2, 0,    Sx,  Sy],
    [0,    Sxy2, -Sy, Sx],
    [Sx,   -Sy,  n,   0],
    [Sy,   Sx,   0,   n],
  ];
  const [a, b, tx, ty] = _solve4(M, [b0, b1, b2, b3]);
  return { a, b, tx, ty, scale: Math.hypot(a, b), angle: Math.atan2(b, a) };
}

// 5-point aligned 112x112 ArcFace crop. `kps` (10 numbers, x,y x5 in source-image
// pixel coords) takes priority when present; `box` ([x,y,w,h]) is a fallback that
// just crops+resizes -- squashing is acceptable there since it's a coarse fallback,
// unlike preImage where it's a correctness bug.
async function preFace(src, box, kps){
  const madeBitmap = (typeof Blob !== 'undefined' && src instanceof Blob);
  const drawable = madeBitmap ? await createImageBitmap(src) : src;
  const cv = new OffscreenCanvas(112, 112);
  const ctx = cv.getContext('2d');

  if (kps && kps.length === 10){
    const pts = [[kps[0],kps[1]],[kps[2],kps[3]],[kps[4],kps[5]],[kps[6],kps[7]],[kps[8],kps[9]]];
    const { a, b, tx, ty } = solveSimilarityTransform(pts, ARCFACE_REF);
    // Canvas setTransform(a,b,c,d,e,f) maps (x,y) -> (a*x+c*y+e, b*x+d*y+f); feeding it
    // our (a,-b,b,a,tx,ty) makes drawImage(drawable,0,0) forward-warp every source pixel
    // through the solved similarity transform directly, with the canvas's own bilinear
    // resampling doing the work -- no manual per-pixel warpAffine needed.
    ctx.setTransform(a, b, -b, a, tx, ty);
    ctx.drawImage(drawable, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else if (box && box.length === 4){
    const [sw, sh] = _srcDims(drawable);
    const [x, y, w, h] = box;
    const cx = x + w / 2, cy = y + h / 2;
    const ew = w * 1.3, eh = h * 1.3;
    const ex0 = Math.max(0, cx - ew / 2), ey0 = Math.max(0, cy - eh / 2);
    const ex1 = Math.min(sw, cx + ew / 2), ey1 = Math.min(sh, cy + eh / 2);
    const cw = Math.max(1, ex1 - ex0), ch = Math.max(1, ey1 - ey0);
    ctx.drawImage(drawable, ex0, ey0, cw, ch, 0, 0, 112, 112);
  } else {
    throw new Error('preFace: requires kps (10 numbers) or box ([x,y,w,h])');
  }

  const { data } = ctx.getImageData(0, 0, 112, 112);
  const n = 112 * 112;
  const out = new Float32Array(3 * n);
  // ArcFace norm (x-127.5)/128 on 0-255 values, NCHW, RGB order -- same plane layout
  // rationale as preImage above.
  for (let i = 0, o = 0; i < n; i++, o += 4){
    out[i]         = (data[o]     - 127.5) / 128.0;
    out[n + i]     = (data[o + 1] - 127.5) / 128.0;
    out[2 * n + i] = (data[o + 2] - 127.5) / 128.0;
  }
  if (madeBitmap && drawable.close) drawable.close();
  return out;
}

// ----- int8 embedding codec -----

// Symmetric (zero-point-free) per-vector quantization: q = round(f/s), s = max(|f|)/127.
// Symmetric, not affine, because embeddings are ranked by cosine similarity, which is
// scale-invariant but NOT shift-invariant -- an affine zero-point would have to be
// subtracted back out before every dot product, which defeats doing this in int math
// at all. Clamped to [-127,127] (not -128) so the range is symmetric around 0.
function quantI8(f32){
  let mx = 0;
  for (let i = 0; i < f32.length; i++){ const a = f32[i] < 0 ? -f32[i] : f32[i]; if (a > mx) mx = a; }
  const q = new Int8Array(f32.length);
  if (mx === 0) return { q, s: 0 }; // all-zero vector: skip 1/0 below, q is already all-zero
  const s = mx / 127, inv = 1 / s;
  for (let i = 0; i < f32.length; i++){
    let v = Math.round(f32[i] * inv);
    v = v > 127 ? 127 : (v < -127 ? -127 : v);
    q[i] = v;
  }
  return { q, s };
}

function deqI8(q, s){
  const out = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) out[i] = q[i] * s; // multiply, never divide -- NaN-safe even when s===0
  return out;
}

// True cosine similarity: dot(a,b) / (|a| * |b|), computed over the raw int8 codes
// with an integer accumulator (safe well past any realistic embedding dimension --
// int8*int8 summed over thousands of terms stays far under 2^53). `as`/`bs` are kept
// in the signature for symmetry with the codec but are provably inert here: for
// symmetric quantization (q=f/s) the scale cancels exactly in the cosine ratio --
// (as*bs*dot)/(as*sqrt(na)*bs*sqrt(nb)) == dot/sqrt(na*nb) -- so this is the *exact*
// cosine, not an approximation that happens to skip the scales.
function cosI8(aq, as, bq, bs){
  const n = aq.length;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++){
    const av = aq[i], bv = bq[i];
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0; // zero vector: cosine undefined, define as 0 rather than NaN
  return dot / Math.sqrt(na * nb);
}

// Hot loop: cosine of one row of a packed row-major Int8Array matrix (dim values/row)
// against a standalone int8 query vector. Ranks 10k+ items per keystroke, so this is
// allocation-free and closure-free by design -- no .map/.slice, no function values
// created per call. sArr/bs accepted for signature symmetry with cosI8 (see there for
// why per-vector scale doesn't need to enter the computation at all).
function cosI8Row(mat, row, dim, sArr, bq, bs){
  const base = row * dim;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < dim; i++){
    const av = mat[base + i], bv = bq[i];
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// In-place L2 normalize; returns the same array so callers can chain. Embeddings are
// normalized before quantization so int8's 127 buckets get spent on *direction*
// (what cosine ranking actually uses), not wasted on magnitude variance across items.
function l2norm(f32){
  let ss = 0;
  for (let i = 0; i < f32.length; i++) ss += f32[i] * f32[i];
  const norm = Math.sqrt(ss);
  if (norm === 0) return f32; // zero vector: nothing to normalize, leave as-is
  const inv = 1 / norm;
  for (let i = 0; i < f32.length; i++) f32[i] *= inv;
  return f32;
}
// --- /AI:PREPROC ---
