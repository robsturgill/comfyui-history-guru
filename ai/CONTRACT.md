# AI Search — frozen interface contract (Phase 0)

Everything here is **frozen**. Phase 1/2 workstreams implement against these signatures and shapes;
they do not renegotiate them. If something genuinely cannot be built as specified, raise it rather
than diverging silently — three other streams are coding against this document.

Scaffold landed in `Guru Manager ChromeEdge Edition.html`. All stubs are live and safe to call today;
each returns a trivially inert value so that `file://` behaviour is byte-for-byte unchanged.

---

## 1. The gate

```js
const aiOK=()=>window.isSecureContext&&/^https?:$/.test(location.protocol)&&localStorage.getItem('guru-ai')!=='off';
```

**Nothing in the AI section may execute when `aiOK()` is false.** No worker spawn, no `fetch`, no
`caches.open`, no `navigator.ml` probe. `localStorage['guru-ai']='off'` is a hard kill switch that
works on localhost with no code change.

The `#aiBtn` header button carries class `ai-off` (`opacity:.45`) when the gate is closed. It is
**never** given the `disabled` attribute — the click must still land so the panel can explain why.

---

## 2. Worker message protocol

Worker file: `ai/ai-worker.js`, classic worker, `importScripts('./ort/ort.all.min.js')`.
Every message is `{t, id, ...}`. `id` is an opaque caller-chosen token echoed back on every reply
belonging to that request. Errors **never** throw across the boundary — they come back as `err`.

### Main → worker

| `t` | Payload | Meaning |
|---|---|---|
| `init` | `{manifest, prefer}` | Load ORT, walk the backend ladder, create sessions. `prefer` is `'auto'\|'npu'\|'gpu'\|'webgpu'\|'wasm'`. Replies `ready` once. |
| `img` | `{id, bitmap, want}` | Embed one image. `bitmap` is an `ImageBitmap`, **transferred**. `want` is `{clip:true, faces:true}`. Replies `res`. |
| `frame` | `{id, bitmap, fi, nF, want}` | One sampled video frame, `fi` of `nF`. Same reply shape as `img` plus `fi`. |
| `text` | `{id, ids}` | Embed a query. `ids` is `Int32Array(77)` from `clipTokenize`. Replies `vec`. |
| `cluster` | `{id, embs, ths}` | Cluster face embeddings. `embs` is `{v:Int8Array(N*512), s:Float32Array(N), key:[...]}`. Replies `clusters`. |
| `cancel` | `{id}` | Abandon in-flight work. `id` omitted cancels everything. Replies `err` with `code:'cancelled'` for each dropped request. |

### Worker → main

| `t` | Payload |
|---|---|
| `ready` | `{backend:{name, device, ms, partitioned}, models:{...}}` — `name` e.g. `'webnn'`, `device` e.g. `'npu'`, `ms` = median of 3 warm-up inferences, `partitioned` = true when the empirical benchmark demoted the winner |
| `res` | `{id, fi?, emb:Int8Array(512), embS:Float32, faces:[…], ms}` |
| `vec` | `{id, emb:Int8Array(512), embS:Float32}` |
| `clusters` | `{id, assign:Int32Array(N), clusters:[{id, cent:Int8Array(512), centS, n, rep}]}` |
| `prog` | `{id, done, total, phase}` — `phase` is `'load'\|'image'\|'face'\|'cluster'` |
| `err` | `{id?, code, msg}` — `code` ∈ `'nomodel'\|'nodecode'\|'oom'\|'cancelled'\|'backend'\|'unknown'` |

**Session lifecycle.** Image and face phases are strictly sequential and each model compiles exactly
once per phase; `session.release()` between phases. Never interleave, never churn an NPU session
mid-job (NPU graph compile is ~5× the GPU's). One `run()` at a time per session — ORT sessions are
not safe for concurrent `run()`.

---

## 3. `manifest.json`

Written by `fetch-models.mjs` into `ai/models/`. `freeDims` comes from reading each ONNX graph's
input protos — **never guesswork**; WebNN requires static shapes and this is the single most common
runtime failure.

```jsonc
{
  "v": 1,
  "models": {
    "clipVision": {
      "variants": {
        "fp16": { "file": "clip-vision-fp16.onnx", "bytes": 184549376, "sha256": "…" },
        "int8": { "file": "clip-vision-int8.onnx", "bytes": 92897280,  "sha256": "…" }
      },
      "inputs":  [{ "name": "pixel_values", "shape": [1, 3, 224, 224], "dtype": "float32" }],
      "outputs": [{ "name": "image_embeds", "shape": [1, 512] }],
      "freeDims": { "batch_size": 1 }
    },
    "clipText":  { "…": "inputs input_ids int32 [1,77] → text_embeds [1,512]" },
    "faceDet":   { "…": "SCRFD-500M-KPS, [1,3,640,640] → boxes+scores+5 kps" },
    "faceEmb":   { "…": "ArcFace w600k_mbf, [1,3,112,112] → [1,512]" }
  },
  "tokenizer": { "vocab": "clip-tokenizer/vocab.json", "merges": "clip-tokenizer/merges.txt" }
}
```

## 3a. BACKEND ASSIGNMENT IS NOT FREE CHOICE — measured, 2026-07-28

**The two CLIP towers must run on different backends. This is a correctness requirement, not tuning.**

| Model | Backend | Why |
|---|---|---|
| `clipVision` | **`webnn:npu`** | Healthy: finite, discriminating, deterministic |
| `clipText` | **`webnn:gpu`** | NPU yields **all-NaN**; plain `webgpu` is degenerate |
| `faceDet` | `webnn:npu` | 11 ms, `partitioned=false` |
| `faceEmb` | `webnn:npu` | Compiles and runs clean |

- **`clipText` on `webnn:npu` returns 512 NaNs.** CLIP's causal attention mask is a `Where` feeding
  `-inf`; WebNN/NPU turns that into NaN. ORT warns `Could not find a CPU kernel and hence can't
  constant fold Where node '/text_model/Where'` — that warning is the tell. It does **not** throw,
  so only a NaN check catches it.
- **`clipText` on plain `webgpu` is degenerate** — same spread (~0.048) but it ranks one arbitrary
  image top for unrelated queries ("a photograph of a person", "a cat or a dog" and "a city street
  at night" all return the same fox). Spread alone does **not** prove correctness; only cross-modal
  ranking does.
- **WASM cannot load the fp16 models at all** (`ERROR_CODE: 1`). A WASM fallback must therefore use
  **int8 for both towers**. Never mix an fp16 tower with an int8 tower — they do not share an
  embedding space, which is what makes a mixed fallback silently return nonsense.

### On a machine with NO WebNN, `faceEmb` must demote to WASM — measured, 2026-07-31

The table above was measured on the NPU box. On a discrete-GPU machine with WebNN unavailable
(`WebNN is not supported in current environment`) the whole ladder falls to `webgpu`, and there
**`faceEmb` is 10.6x slower on the GPU than on the CPU**:

| Model | `webgpu` | `wasm` | Resolved |
|---|---|---|---|
| `clipVision` fp16 | **10.3 ms** | fails to load (fp16) | `webgpu` |
| `faceDet` SCRFD-500M | **31.9 ms** | 38.3 ms | `webgpu` — under the 10% margin, correctly not demoted |
| `faceEmb` ArcFace mbf | 116.0 ms | **11.0 ms** | `wasm` (demoted) |

ArcFace w600k_mbf is a depthwise-separable net at 112×112 — ~0.45 GFLOPs across many tiny kernels,
so per-dispatch overhead dominates and the GPU loses badly. It is **not** partitioning; the graph is
clean, it is simply the wrong shape of work for a GPU.

**The demotion probe could not see this**, because `openModel`'s tier guard (`tier !== win.tier →
continue`) skipped the WASM candidate. That guard exists to stop an fp16 CLIP tower being demoted to
an int8 *different model*; it was also being applied to `faceDet`/`faceEmb`, which have **no
`variants`** — `variantOf()` returns the same `.onnx` whatever the tier says. The guard is now
conditional on `spec(key).variants`, so variant-less models get a genuine like-for-like probe.

**Safe for existing indexes — no `AIV` bump.** Both EPs load byte-identical weights: cosine
agreement **1.0**, max abs element diff **4.5e-6**. Face embeddings and cluster assignments are
unchanged (thresholds are 0.50/0.55).

Measured end to end on `samples/` (6 images, 2 faces each, `want:{clip,faces}`):
**294.5 ms → 81.6 ms per image, 3.4 → 12.3 images/sec.** Decode is only ~9 ms of that, so the
pipeline is *not* decode-bound and prefetching decode would have bought ~3%.

One cosmetic wart: the panel labels the winning `wasm` candidate `tier: int8`, because `tierOf()` is
a pure function of the EP. For a variant-less model there is no int8 build — the file is the same.

**Validation evidence** (vision `webnn:npu` + text `webnn:gpu`, real `samples/`): "a close-up
portrait of a face" scores 0.2628 on the face close-up — the matrix maximum; "a cat or a dog" puts
both foxes and the raccoon in the top three. The two known-duplicate pairs in `samples/` produce
**identical cosine rows**, confirming determinism end to end.

**Required sanity gate on every text session:** reject the EP if any output is non-finite. A
session that compiles, benchmarks fast and returns NaN is the default failure here, not an edge case.

**The gate's probe input must be REALISTICALLY SHAPED, not a constant fill.** This defeated the gate
once already: filled with a flat token id, `clipText` on `webnn:npu` *passed* sanity and every query
came back NaN with `embS=0`. CLIP's text tower pools at the `argmax(EOS)` position, so a constant
fill has no EOS, never takes the degenerate path, and looks healthy. The probe now feeds
`[49406, …, 49407]` + zero padding — BOS, tokens, EOS, pad. With that, the ladder correctly logs:

```
load clipText -> webnn:gpu   REJECTED: webnn:npu failed sanity: non-finite output
```

`clipText` is also **never demotion-probed**. It runs once per query, so speed is worth nothing,
and plain `webgpu` passes every hard-failure check while being semantically degenerate — a
speed-based demotion would silently swap a working tower for a broken one.

**End-to-end verified** through the worker with int8 embeddings: "a close-up portrait of a face"
→ face close-up (0.2604), "a cat or a dog" → fox (0.2180). Face detection returns 1 face on both
human-face images and **0 on the fox**, confirming SCRFD anchor decode, NMS and coordinate rescale.

### VERIFIED against ORT 1.27.0 on the WebNN NPU — 2026-07-28

All four models **compile and run on `webnn` / `deviceType:'npu'`** on the target machine. This was
the single biggest risk in the plan and it is now retired.

| Model | File | NPU compile |
|---|---|---|
| `faceDet` SCRFD-500M-KPS | 2.4 MB | 1,380 ms |
| `faceEmb` ArcFace w600k_mbf | 13.0 MB | 3,666 ms |
| `clipText` fp16 | 121.4 MB | 4,541 ms |
| `clipVision` fp16 | 167.9 MB | **6,989 ms** |

~16.6 s to compile all four. One-time per session — **compile once, hold the session for the whole
phase.** ORT is loaded via `<script src="ai/ort/ort.all.min.js">`; `crossOriginIsolated` is **true**
under `serve.mjs`, so `ort.env.wasm.numThreads=4` is available on the WASM path.

### Three things the real ONNX files contradict

1. **`freeDims` must NOT be all-ones.** The exporters mark *every* axis dynamic, so defaulting each
   to 1 compiles CLIP vision as `1×1×1×1` — it builds a session **without erroring** and then emits
   garbage. The correct, verified values are now generated from a `RESOLVE_DIMS` table in
   `fetch-models.mjs`, which throws on an unlisted axis rather than defaulting:

   ```
   clipVision {batch_size:1, num_channels:3, height:224, width:224}
   clipText   {batch_size:1, sequence_length:77}
   faceDet    {'?':640}        // both spatial axes share the name "?", so one override sets both
   faceEmb    {None:1}         // ArcFace literally names its batch axis "None"
   ```

2. **`clipText.input_ids` is `int64`, not `int32`.** `clipTokenize()` returns `Int32Array(77)`, so
   the worker **must widen it to `BigInt64Array`** before feeding ORT. Feeding an Int32 tensor will
   fail at run time.

3. **The manifest is not uniformly shaped.** `clipVision`/`clipText` carry `variants:{fp16,int8}`;
   `faceDet`/`faceEmb` carry `file`/`bytes`/`sha256` directly. Consumers must handle both:
   `const v = m.variants ? (m.variants.fp16||m.variants.int8) : m;`

**SCRFD outputs** are 9 tensors in 3 stride groups — scores `[12800|3200|800, 1]`, boxes `[…, 4]`,
keypoints `[…, 10]` — i.e. genuine 5-point KPS. Strides are 8/16/32 over a 640×640 input.

**Precision rule.** `fp16` for WebNN/WebGPU, `int8` **only** for the WASM fallback. The common
`model_quantized.onnx` files are ORT *dynamic* quantization and will compile fine then partition
heavily to CPU — the silent-slow failure mode. Both CLIP towers must match in checkpoint **and**
precision tier; mixing shifts the shared embedding space and quietly wrecks retrieval.

Weights are cached in the **Cache API**, not IndexedDB — the app's IDB holds the metadata cache,
which is expensive to rebuild, and 300+ MB of blobs alongside it raises eviction risk for that store.

---

## 4. Cache-item AI fields

Attached to the existing `cache` item and re-`dPut`, exactly as the duplicate scanner already does
with `sha`/`shaSize`/`shaMtime`. **No schema migration, DB version stays 1.**

| Field | Type | Meaning |
|---|---|---|
| `ai` | `number` | Model-version stamp. Equals `AIV` when current. **This is a plain number, not an object** — `aiNeeds()` compares `it.ai !== AIV`. |
| `emb` | `Int8Array(512)` | Quantized CLIP image embedding. For video, the L2-renormalized mean over frames, so the uniform image path and "find similar" need no special-casing. |
| `embS` | `number` | Dequantization scale for `emb`. Value ≈ `emb[i] * embS`. |
| `embF` | `Int8Array(nF*512)` | Video only. Per-frame vectors, concatenated. Videos score **`max` over frames**, never a pooled mean. |
| `nF` | `number` | Video only. Frame count in `embF` (5). |
| `faces` | `Array` | `[{box:[x,y,w,h], score, kps:[10 floats], emb:Int8Array(512), embS, c:clusterId}]` |
| `aiSkip` | `string\|undefined` | Set when the item cannot be analyzed: `'nodecode'` (e.g. `.mkv`), `'toobig'`, `'error'`. Counted separately as "unsupported"; **never retried until `AIV` bumps**. |
| `aiMs` | `number` | Wall-clock ms for this item's analysis. Diagnostics only. |
| `pA` | `number[]` | **Manual layer.** Person ids added by hand. Omitted when empty. |
| `pR` | `number[]` | **Manual layer.** Person ids suppressed by hand. Omitted when empty. |

### The manual layer never touches clusterer-owned state

`aiCluster()` overwrites **every** `faces[].c` from the worker's `assign` array and **replaces**
`aiMeta.clusters` wholesale, keeping only `name`/`hidden` matched by id. So a hand-correction stored
as a mutation of `c` is erased by the next Analyze run — silently, hundreds of photos at a time.

`pA`/`pR` exist for exactly that reason. Removing a person writes a **suppression entry**; it never
edits `c`. The effective set is `(detected ∪ pA) \ pR`, and **every** reader goes through
`peopleOf(v)` — `popPeople`, `searchFields().face`, `aiClusterMembers`, `aiBuildExport`. Miss one and
the feature half-works: skip it in `searchFields` and "Show all" for a hand-tagged person returns an
empty list.

`applyPersonEdit(v,id,act)` (`act` = `'add'|'rm'|'set'`) is the only mutator, shared by the inspector
and the bulk selection bar. `'set'` removes before it adds, or the incoming id suppresses itself.

`cacheRecordFor(p)` mints a minimal record for a path in `fReg` with nothing in `cache` — reachable
because `proc()` ends in `catch{}`. Skipping those would tag 9 of 12 selected images while the toast
claimed 12.

**`AIV` is not bumped for this.** No model, quantization or preprocessing changed.

Embeddings are stored int8 + scale, not float32 — 512 B/vector instead of 2 KB. IndexedDB stores
typed arrays natively via structured clone; no base64.

**Batch the writes.** Use `dPutMany(arr)` (new, sits next to `dPut`), flushing every 100 items and on
cancel/finish. Per-item `dPut` over 10k items is 10k transactions. This also makes the job resumable
for free — `aiNeeds()` re-derives the remaining set on restart, so no progress bookkeeping is needed.

---

## 5. The `__ai__` sentinel record

Library-global state lives in a **reserved key inside the existing store `"i"`** — not a version-2
store. A DB version bump creates a real downgrade hazard: this app is one HTML file that gets copied
around, and an older copy opening `open(DB,1)` afterwards throws `VersionError`, which surfaces as
`alert("Access denied.")` with no path back.

```js
{
  p: '__ai__',                       // reserved: keys starting '_' are app records, not cache entries
  v: AIV,
  backend: { name, device, ms, partitioned },
  lastRun: 1753600000000,
  nextM: 1000001,                    // monotonic allocator for hand-made person ids
  clusters: [{ id, name, cent: Int8Array(512), centS, n, rep: 'folder1/x.png', hidden },
             { id: 1000000, name: 'Ann', manual: true, hidden: false }]
}
```

### Hand-made people

A person the clusterer never found — created from the People view or the picker's `＋ New person…` —
is a cluster entry with `manual: true` and no centroid.

**Ids come from `nextM`, starting at `MANUAL_ID0 = 1000000`. Never negative.** `c >= 0` and
"`c < 0` is the noise bucket" checks are spread across the file, and a negative id would be silently
treated as an unclustered face everywhere.

**`aiCluster()` must `.concat()` the manual entries back** after rebuilding the table from the
worker's response. The clusterer never emits them, so a plain reassignment deletes every hand-made
person and orphans every `pA` tag pointing at one. This is covered by `ai/src/people.test.mjs`
("manual tags and a hand-made person both outlive a cluster rebuild") — that test is the reason the
file exists, and it fails the moment the `concat` is dropped.

`aiClusterMembers()` reports `pA`-only members as `{i:-1, box:null}`, and `aiDrawCrop` bails on
`i<0`: such a card renders with fewer crops rather than a broken canvas. `renderFaces` also keeps a
manual cluster with **zero** members, or a person created by mistake could never be renamed or
deleted. Deleting one removes the cluster *and* purges its id from every `pA`/`pR` (`aiPurgePerson`).

`dAll()` routes a key starting `_` **and containing no `.`** to `aiLoadMeta(rec)` instead of `cache`.
The no-dot test is load-bearing: every cache key is a path ending in a media extension, so a real
user folder named `_archive` cannot be mistaken for a reserved record and silently dropped from the
cache. Reserved keys must therefore be extension-free (`__ai__`, not `__ai__.json`).

Every other consumer is
already safe by construction: `opD` iterates `fReg`; `runSearch` does `fReg.get(p)` then `continue`;
`renderStats` does `if(!item.m)continue`.

**Cluster names resolve at query time, not write time.** `AIC` (`Map<clusterId, name>`) is the
in-memory projection, rebuilt by `aiLoadMeta`. Denormalizing names onto file records would make a
rename rewrite hundreds of records and risk drift.

---

## 6. Stub signatures — the cross-boundary contract

These are already in the file and called from existing code. Implementations must preserve the
signature and stay safe to call with no model loaded.

```js
// Lifts sem:/like: terms out of the AST into `out`, leaving {t:'true'} behind so the boolean pass
// ignores them. Pure AST work, no AI dependency — IMPLEMENTED, do not rewrite.
function advExtractSem(n, out, neg) -> node
//   out receives {kind:'sem'|'like', q:string, neg:boolean}
//   A `not` whose child collapses to {t:'true'} collapses to {t:'true'} as well, so a bare
//   -sem:x stays boolean-neutral rather than emptying the listing. Negation is the scorer's job.

function aiLoadMeta(rec)            // IMPLEMENTED. Sets aiMeta, rebuilds AIC from rec.clusters.
function toggleAI()                 // STUB → AI:PANEL. Opens the panel. Must never throw.
function renderFaces(c)             // STUB → AI:FACES. Renders vMode==='faces' into container c.
async function aiQueryVecs(sems)    // STUB → AI:SEARCH. Returns null when unavailable.
                                    //   -> null | [{kind, neg, emb:Int8Array(512), embS}]
function aiScore(a, qv)             // STUB → AI:SEARCH. Mutates `a` in place, setting `.s` per item.
function aiInvalidateMat()          // STUB → AI:SEARCH. Drops the packed scoring matrix.
const aiNeeds = it => !!it && !it.aiSkip && (it.ai !== AIV);   // IMPLEMENTED
```

### Wiring already done by the scaffold — do not re-add

- `aiInvalidateMat()` is **already called** from `fullScan`, `contextDelete`, `deleteMarkedDuplicates`
  and the Delete-key handler. WS-F only has to make the function do something.
- `runSearch` already takes `const seq=++searchSeq` and re-checks `seq!==searchSeq` after every
  `await`, already calls `advExtractSem`, and already switches `sortBy` to `relevance` (saving
  `prevSort`) when `aiQueryVecs` returns a non-null result.
- `applySort` already has the `relevance` branch sorting on `.s`; `opD` and `clearSearch` already
  restore `prevSort` when leaving a relevance sort.
- `searchFields` already builds `f.face` from `v.faces` via `AIC`, and joins it into `f.all`.
- `FIELD_ALIAS` already maps `face`/`person`/`who` → `face`, plus `sem` and `like`.

### Scoring rules (WS-F)

- `.s` is the per-item score the `relevance` sort reads. Items with no embedding score `-1` and are
  dropped from the listing.
- Threshold is **relative, not absolute**: keep top-K (default 200) **and** drop below
  `bestScore * 0.75`. CLIP cosines cluster in 0.15–0.35 and shift with phrasing.
- `like:` is rank-only, no floor — image↔image cosines run 0.6–0.95.
- Multiple `sem:` terms AND together as `min` over queries.
- Videos score **`max` over `embF` frames**, never the pooled mean.
- Build the packed `Int8Array(N*512)` matrix once, lazily, in memory. Brute force is correct to
  ~200k items. **No ANN index.**
- Surface the coverage gap in `#fCount` — `412 items · semantic · 6,880 not yet indexed`. Silently
  showing a subset of the library is the worst outcome.

---

## 7. Reserved marker blocks

Each stream inserts **only between its own markers**, never at EOF, so three-way merge sees disjoint
hunks. `AI:CSS` is in the `<style>` block; the rest are at the end of the `<script>` block.

| Marker | Stream | Contents |
|---|---|---|
| `AI:CSS` | E | All new CSS. Both themes. Colors from `--ai-ok` / `--ai-warn` / `--ai-bad` / `--ai-chip` only. |
| `AI:TOKENIZER` | B | `clipTokenize(str) -> Int32Array(77)`, byte-BPE, inline |
| `AI:PREPROC` | C | `preImage`, `preFace` (5-point similarity transform), `quantI8`/`deqI8`/`cosI8` |
| `AI:SEARCH` | F | Matrix build/invalidate, `aiScore`, `aiQueryVecs` |
| `AI:PANEL` | G | AI panel, `setAIProgress`, analyze/cancel orchestration, video frame sampler |
| `AI:FACES` | H | `renderFaces`, `syncClusterUI`, `aiRenameCluster`, crop rendering |
| `AI:PORT` | — | `aiBuildExport` / `aiImportPlan` / `aiImportApply`, `b64enc`/`b64dec`, picker wrappers |

When a stream implements a stub, it **moves the body inside its marker block** and deletes the stub
from the contract area — it does not leave two definitions (the later one silently wins).

---

## 7a. Index export/import (`AI:PORT`)

Moves an analyzed index to a second machine holding the **same library**. Format version is `PORTV`,
independent of `AIV`: bump `PORTV` only when the *file layout* changes, `AIV` when the *vectors* do.

```json
{ "guruAI": 2, "aiv": 1, "tier": "fp16", "backend": {…}, "exported": 1753…, "count": 8500,
  "nextM": 1000001,
  "items":    [ {"p":"…", "d":1753…, "ai":1, "emb":"<b64>", "embS":0.012,
                 "embF":"<b64>", "nF":5, "aiSkip":"nodecode", "pA":[1000000], "pR":[3],
                 "faces":[{"box":[…], "score":…, "kps":[…], "emb":"<b64>", "embS":…, "c":3}]} ],
  "clusters": [ {"id":3, "name":"Rob", "cent":"<b64>", "centS":…, "n":42, "rep":"…", "hidden":false},
                {"id":1000000, "name":"Ann", "manual":true, "hidden":false} ] }
```

**The version check is `j.guruAI > PORTV`, not `!==`.** v1 → v2 was purely additive, so a v1 file
reads fine with the new keys simply absent. An exact check would make the user's *own* older exports
unreadable the moment `PORTV` moved — and files in flight between machines is the entire point of
this feature. A *newer* file this build cannot understand still throws.

**`pA`/`pR` travel as plain number arrays**, no base64, and the export skip guard is
`ai === undefined && no pA && no pR` — an image tagged by hand but never analyzed carries no `ai`
stamp and would otherwise be dropped, losing the user's work on the far machine.

`nextM` is merged with `Math.max(local, imported, MANUAL_ID0)` on import — never moves backwards, or
the next person created locally collides with an imported one.

**Two gates, and only one of them is obvious.**

- `aiv !== AIV` → refuse. Different model, incomparable vectors.
- **`tier` mismatch → refuse.** This is the silent one. `aiBuildMat` packs every `emb` in `cache`
  into a single matrix with no provenance, so fp16 vectors imported onto an int8 machine sit in an
  embedding space they don't belong to and rank garbage while every hard-failure check passes — the
  same genre as the NaN text tower in §3a. `aiImportIndex()` therefore `await aiWorker()` **before**
  planning, because `aiBackend.tier` is `null` until the EP probe has run and a null tier silently
  skips the gate.

**Both ends await the probe, and that is not symmetry for its own sake.** `aiExportIndex()` awaits it
too, because the `aiMeta.backend.tier` fallback only helps a library that has been *clustered* —
`aiMeta` is created by `aiCluster()` and nothing else. A user who ran semantic analysis, never
touched faces, then reloaded and exported would write `tier: null`, and a null tier doesn't trip the
gate on the far end, it **disables** it. Verified: that path emitted `tier:null` and the resulting
file imported onto an int8 machine with no refusal.

`tier: null` can therefore still arrive from an older file or a machine whose models failed to load
(the `aiBackend={name:'error'}` path carries no `tier`). That case gets its **own** `confirm`, not a
line in the summary — an unverifiable import is the dangerous direction, and it is recoverable via
*Clear AI data* + re-analyze, which argues for a hard prompt rather than a refusal.

**Matching is by path, validated against `d` (lastModified).** Deliberately no content hashing: that
is the cost the duplicate scanner's three-stage design exists to avoid, and cache items carry no byte
size to validate against anyway (`meta.size` is a *string* on the video fallback path). A file whose
mtime moved is reported as `changed` and skipped — unless `changed > hit`, which means the copy onto
this machine didn't preserve dates at all, and the user is offered the override rather than being
shown an import that silently did nothing.

**`faces[].c` addresses the cluster table it was written against.** So `aiImportApply` resets `c` to
`-1` on every local face *not* covered by the import; leaving it would re-point that face at whoever
holds the same id in the imported table. Cluster-id remapping across two populated devices is **not**
implemented and should not be added quietly — it is a merge, not a restore.

**`pA`/`pR` address it too**, and get the same treatment: an id the imported table does not define is
dropped, counted as `dropped`, and named in both the import confirm and the result toast.

`aiInvalidateMat()` after applying is mandatory. Skip it and the stale packed matrix survives and the
whole import appears to have done nothing.

---

## 7b. Caching trap — cost real debugging time, read this

`serve.mjs` sends `Cache-Control: immutable` for **exactly two things**: everything under
`/ai/ort/` (third-party runtime) and `/ai/models/*.onnx|.bin` (downloaded weights). Everything else —
`manifest.json`, `ai-worker.js`, `ai/src/*.js` — is `no-store`.

This bit **twice**. A `/ai/*.js` rule also matches `ai-worker.js`, so edits to the worker appeared
to do nothing for a full debug cycle: the fixed sanity gate was written, deployed, and the browser
kept running the year-cached old copy. If a change to worker or preproc source seems to have no
effect, check the response headers before you touch the code again.

This matters because `manifest.json` is *regenerated* by `fetch-models.mjs`. An earlier version of
`serve.mjs` marked all of `/ai/` immutable, so Chrome pinned a stale manifest for a year and the
worker was silently built and benchmarked against **old `freeDims`** (`{'?':1}` for faceDet,
`1×1×1×1` for clipVision). Symptoms were baffling and looked like model/precision problems:
`ShapeInferenceError` on a model that had demonstrably compiled minutes earlier, and cross-tower
embedding degradation that appeared to implicate fp16 or WebGPU.

**When anything shape-related behaves impossibly, clear both caches before believing the result:**

```js
for (const k of await caches.keys()) await caches.delete(k);   // 'guru-ai-w1' holds the weights
await fetch('ai/models/manifest.json', {cache:'reload'});
```

The worker's own weight cache key is `guru-ai-w1`. Bump it, or clear it, whenever weights change.

## 8. Invariants that will bite

- **Selection changes must not call `rend()`** — `rend()` calls `clearURLs()`, which revokes object
  URLs and blanks every thumbnail. Use direct DOM updates, as `syncDupGroupUI()` does. This is the
  single most likely violation in the whole feature.
- Every new color must be a CSS var defined in **both** `:root` and `[data-theme="light"]`.
  `data-theme` sits on `<body>`, not `<html>`.
- Never put padding on `.grid-scroll` — it breaks both sticky bars.
- `showToast()` interpolates raw HTML — `esc()` anything derived from a filename or a face name.
- `opD` and `runSearch` are **two independent listing builders**. Any new filter predicate must be
  applied in both, exactly as `passModel` is.
- Never `f.arrayBuffer()` a video. Slice it.
- Video decode: the `finally` block must do `v.pause(); v.removeAttribute('src'); v.load()` and
  revoke the object URL, or Chrome accumulates decoders and stalls after a few hundred videos.
- `file://` and `http://127.0.0.1:8787` are **different origins**. IndexedDB, localStorage favorites
  and folder permissions do not carry across. A one-time re-scan under the launcher is expected.
