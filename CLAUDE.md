# History Guru — ChromeEdge Edition

A **single self-contained HTML file** that browses a local image library, extracts AI generation
metadata (ComfyUI / A1111) from PNG/JPEG, and manages files in place via the File System Access API.

**Hard constraint: this must stay one file.** No build step, no bundler, no external assets, no CDN
scripts. All CSS lives in the one `<style>` block, all JS in the one `<script>` block. If a change
would normally warrant a new module, add a clearly commented section instead.

| | |
|---|---|
| App file | [Guru Manager ChromeEdge Edition.html](Guru%20Manager%20ChromeEdge%20Edition.html) (~1275 lines) |
| Test data | `samples/` — folder1, folder2, folder3, video |
| Test data | `samples/` is git-ignored and **has no backup**. Anything destructive (delete, `fixSave` conversion) is unrecoverable — copy the folder aside first if a test needs it |
| Runtime | Chrome / Edge only (File System Access API). Runs from `file://` |

---

## Running & testing

Open the HTML file directly in Chrome, click **Open Folder**, pick `samples/`, and grant
read-write permission. The picker is a native dialog, so it **cannot be automated** — a human must
click through it.

To test logic without the picker, seed the in-memory registries from the devtools console with fake
handles (any object with `.name` and `async getFile()` works, plus `removeEntry` on directory
handles). Stub `db` before doing this so mock paths don't get written into the real IndexedDB cache:

```js
db = {transaction:()=>({objectStore:()=>({put(){},delete(){}}), set oncomplete(f){setTimeout(f,0)}})};
fReg.set('folder1/a.png', {name:'a.png', getFile:async()=>new File([bytes],'a.png')});
```

For UI work you don't need real files at all: generate the bytes with `canvas.toBlob()`, so the whole
library is synthetic and no picker is involved. Seed `fReg` + `cache` (+ `dupGroups` for the
duplicates view), then `rTree(); buildModelFilter(); syncSortUI(); await opD(null,'')` and hide
`#wel`. That is enough to exercise list/grid/dups rendering, sticky headers, sorting, filtering and
the search parser end-to-end. Note `dReg` needs `''` mapped to a root stub, and each folder handle
needs a `removeEntry` if you touch delete paths.

That same seeding works **fully automated** through Playwright against `node serve.mjs` — navigate
to `http://127.0.0.1:8787/`, run the seed in one `evaluate`, then drive real clicks. For anything
destructive, stub `removeEntry` to record instead of delete:

```js
const mkDir = p => ({name:p.split('/').pop()||'root', kind:'directory',
    async removeEntry(n){ window.__deleted.push((p?p+'/':'')+n) }});
```

That exercises the `cFiles` splice, the `aIdx`/`selectedIndex` fixups and "does the search survive"
with zero filesystem writes — which matters, because `samples/` has no backup.

**Testing the video path without the picker.** The parsers are pure and run fine in Node: extract the
`<script>` block, brace-match out `parseMetadata`/`parseComfy`/`readVideoMeta`/etc., and call them
directly — Node's `File`/`Blob` give the same `slice()`/`arrayBuffer()` contract Chrome does, so
`readVideoMeta(new File([buf], name))` works unchanged. Note a naive brace-matcher **fails** on
`parseMetadata`, which contains `indexOf('{')` and `'}'` as string data; skip string/comment/regex
spans.

To drive the *real UI* on real video metadata, rebuild each sample as `ftyp` + a 16-byte stub `mdat`
+ its genuine `moov`. That drops an 8.8MB file to ~9KB — small enough to base64 into a seeded page —
while keeping the metadata byte-identical. The video won't decode (so `vidFallback()` fires), but
every metadata path is exercised. The preview pane only executes files **inside the project folder**,
so write the harness there and delete it afterwards.

`samples/` is deliberately arranged to cover every duplicate case:

| Content | Files | Case exercised |
|---|---|---|
| A | `folder1/t2i_2026_07_21_00002_.png`, `folder3/t2i_2026_07_21_00002_.png`, `folder3/Comfyui-0002.png` | **3-way** group, cross-folder, one renamed |
| B | `folder1/t2i_2026_07_21_00015_.png`, `folder2/t2i_2026_07_24_00015_88888.png` | sibling folders + renamed |
| C | `folder1/t2i_2026_07_21_00019_.png`, `folder1/t2i_2026_07_21_00019_ - Copy.png` | same folder |
| unique | `..._00014_`, `..._00017_`, `..._00018_` | must NOT be grouped |

Expected result: **3 groups, 7 files**. `samples/video/` does not affect this — all four videos have
distinct byte sizes, so they are dropped at stage 1 of the duplicate scan.

`samples/video/` covers the three `©cmt` shapes described in [Video metadata](#video-metadata):

| File | Writer | Exercises |
|---|---|---|
| `2026-07-23.mp4`, `2026-07-24.mp4` | ComfyUI VHS `VideoCombine` | escaped-graph unwrap, WAN two-sampler graph, 2 LoRAs, `1024x1536` from `tkhd` |
| `2026-07-23-00h47m40s_…giraffe speaks.mp4` | WanGP / LTX-2 | flat settings dict → `parseSettings`, `activated_loras`, `960x960` (note its `resolution` field claims `1280x704` — the container wins) |
| `grok-video-….mp4` | Grok | **no** AI metadata (`Signature:` + a `covr` JPEG); must degrade to the `Video` placeholder while still showing `416x736` |

Two files have an audio track, so their second `tkhd` reads `0x0` — that is the case the `w > 0`
filter exists for.

---

## Core state (line ~216)

Everything hangs off a handful of module-level globals. Know these before changing anything:

| Global | Meaning |
|---|---|
| `rH` | Root `FileSystemDirectoryHandle` from the picker |
| `fReg` | `Map<relPath, FileHandle>` — **every image file, recursively**, across all subfolders |
| `dReg` | `Map<relPath, DirHandle>` — `''` maps to the root |
| `cache` | `Map<relPath, item>` — parsed metadata, mirrored to IndexedDB (`DB = "GuruV610"`, store `"i"`, keyPath `p`) |
| `cFiles` | The files currently listed in the main view (one folder, or search results) |
| `vMode` | `'list'` \| `'grid'` \| `'stats'` \| `'dups'` — drives `rend()` |
| `objURLs` | Live object URLs; `clearURLs()` revokes them once the set exceeds 100 |

A `cache` item is `{p, n, d, firstSeen, m, v, dim}` — path, name, lastModified, first-seen date,
parsed metadata, isVideo, and true pixel dimensions. The duplicate scanner adds `sha`, `shaSize`,
`shaMtime`.

### JSON / workflow viewer

`viewJSON()` (the inspector's JSON button) reads the file again and shows its embedded text chunks.
`readTextChunks()` exists because `extractText()` concatenates every chunk into one blob and
**discards the keywords** — the viewer needs them to separate ComfyUI's `prompt` (API form, keys are
node ids) from `workflow` (UI graph, `nodes[]` array). Both node shapes are handled in
`renderJsonOutline()`.

Search wraps matches with a TreeWalker over text nodes rather than regex over HTML, because the
syntax highlighter has already inserted tags. Matches are wrapped **back-to-front**:
`surroundContents` splits the text node, and reverse order keeps the earlier offsets valid.

The `Escape` handler for this dialog sits **before** the input guard in the global `keydown`
listener — the search box is an `<input>`, so otherwise Escape would only blur it.

### Sticky bars and the scroll gutter

`.grid-scroll` has **no padding** — the 20px gutter lives on `.grid` and `.list-view` instead. This
is load-bearing: padding on the scroller insets the containing block that a `position:sticky` child
is constrained to, which parked `.list-head` and `.dup-bar` 20px below the top of the scroll area
and let rows scroll through the transparent strip above them. If you put padding back on
`.grid-scroll`, both sticky bars break the same way.

`.list-head` must keep the **same `grid-template-columns` as `.list-row`** (first track is
`calc(var(--thumb-size) / 2.5 + 18px)`, not a fixed px value) or the labels drift off their data as
the thumbnail slider moves.

### Pagination and lazy media

`rend()` renders `pageItems()`, not `cFiles`. Two separate caps, and both are needed:

- **Pagination** (`pageSize`, default 200, persisted as `guru-page-size`; `0` = All) caps how many
  DOM nodes exist.
- **Lazy loading** (`observeMedia` / `loadTileMedia`, IntersectionObserver with 400px margin) caps
  how many of them actually open their file. A 200-item page still decodes 200 full-size PNGs
  (~700MB of bitmap) if loaded eagerly, so pagination alone is not enough.

Measured on 3.46MB PNGs: 10,000 items renders in 60ms with 200 DOM rows, 10 files opened and 10MB
heap. Before this, 3,000 items wedged the renderer permanently.

**The invariant that matters:** `selectedIndex`, `aIdx`, shift-ranges and `enterDet()` all address
**`cFiles`**, but only the current page is in the DOM. Render loops therefore compute
`const i = pageStart() + j` and pass `i` to every handler — never the slice index. Anything mapping
the other way (`scrollToSelected`) must subtract `pageStart()`.

Reset `curPage = 0` wherever `cFiles` is rebuilt: `opD()`, the search handler, `sortByColumn()`,
`changeSort()`. `ensurePageFor()` flips the page when arrow keys or the detail viewer walk past a
page edge.

### Deleting files — one path, and it must not rescan

`deletePaths(paths)` is the **only** place a file is removed. It updates `fReg`, `cache`, IndexedDB,
`favorites` (persisted) and `selectedItems`, prunes `dupGroups`, then filters the rows out of
`cFiles` and calls `rend()`.

**It deliberately does not call `fullScan()` or `opD()`.** Both rebuild `cFiles` from `fReg`, which
throws away an active search while leaving the query in the box — that was the bug. `confirmDelete()`
wraps it with the confirmation and toast; `deleteSelection()` and `deleteFromDetail()` wrap that.

Folder deletes are the one exception and still `fullScan()`, because they change the tree.

In the detail view the next image slides into the slot `aIdx` already points at, so `aIdx` only
moves when the list empties or the deleted item was last.

### Selection mode

`selectMode` (toolbar ☑) changes **only what a plain click does** — it selects instead of opening.
`Ctrl`/`Shift` click are untouched, and double-click still opens the viewer. Checkboxes are always
in the DOM and revealed by `body.sel-mode`, so toggling the mode never re-renders.

- **Selection changes call `syncSelUI()`, never `rend()`** — `rend()` calls `clearURLs()`, which
  revokes the thumbnail object URLs and blanks the images. Same rule as `syncDupGroupUI()`.
- Grid and list share **one** `tileClick(e,f,i)`. They were near-identical copies; don't fork them.
- `pruneSelection()` must run wherever `cFiles` is rebuilt (`opD`, `runSearch`), or the bar counts
  and deletes rows the user cannot see.
- The list checkbox is **absolutely positioned** inside `.list-cell1`. Laid out inline it pushes the
  thumbnail past the first grid track, which is pinned to `.list-head` — see the sticky-bar note.
- The bar lives outside `.grid-scroll`, between `#gridToolbar` and the scroller, so it never fights
  `position:sticky`. It is shown by `body.sel-mode.sel-able:not(.mode-detail)` — a single rule,
  because a separate hide rule loses on specificity.

### Supported formats

`RX_MEDIA` and `RX_VIDEO` (declared next to `DB`) are the **single source of truth** — don't inline
an extension list anywhere else, and keep `RX_VIDEO` a strict subset of `RX_MEDIA` or a file will be
listed but never classified (or classified but never listed).

- Images: `png` `jpg` `jpeg` `webp` `gif`
- Video: `mp4` `webm` `mov` `mkv`

Videos are parsed by `readVideoMeta()` — see [Video metadata](#video-metadata) below. Chrome cannot
decode every container (`.mkv` in particular), so `vidFallback()` swaps an errored `<video>` for a
labelled 🎬 tile rather than leaving it blank. It must be attached **after** the element is in the
DOM — it replaces the node via `parentNode`.

### `fixSave()` is images-only

It rewrites PNG `tEXt` chunks, and for any non-PNG it rasterises through a canvas, writes a `.png`,
then **deletes the original**. Three guards protect that path:

1. Videos bail out immediately. Previously a video blob reached `new Image()`, which fires `onerror`,
   not `onload` — and the old `await new Promise(r => i.onload = r)` never settled, hanging silently.
2. `readDims(b)` doubles as a decodable-image check; unrecognised headers abort before any write.
3. `isAnimated(b)` (accurate GIF block walk, plus the WebP `VP8X` animation flag) prompts before
   flattening, because conversion keeps one frame and removes the original.

The image load now races `onload`/`onerror`/timeout, so no failure mode can hang it.

### Video metadata

`readVideoMeta(file)` walks the container and returns `{text, dim}`. It takes a **`File`, not an
ArrayBuffer** — the signature differs from `readDims(buffer)` on purpose. Videos run to hundreds of
MB; the reader slices the box/element chain and only ever fully reads `moov` (MP4) or `Tags`/`Tracks`
(Matroska), capped by `MOOV_CAP`. **Never change this to `f.arrayBuffer()`** — that would pull entire
videos into memory per item and undo the pagination/lazy-load work.

Dimensions come from `tkhd` (last 8 bytes of the box, so no version branch) or Matroska
`PixelWidth`/`PixelHeight`. Tracks with `w == 0` are audio — skip them. Verified against all four
samples: `tkhd` matched the `stsd` coded size exactly, with identity matrices.

**Where the metadata actually lives — verified, and it is *not* what the research doc predicted.**
All four samples use the classic iTunes `©cmt` atom under `moov/udta/meta/ilst`, **not** the `mdta`
keys/ilst mechanism. Both are supported (`mdta` resolves the 1-based index into the `keys` table;
otherwise the fourcc maps through `NAMED`), but `©cmt` is what real files carry.

The payload is a **wrapper object**, and the graph inside it is a *JSON string*, not an object:

```
©cmt = {"prompt": "{\"6\": {\"class_type\": \"CLIPTextEncode\", ...}}"}
```

That escaping is why the raw text can't go straight to `parseMetadata()`: its sniff looks for the
literal `"class_type"`, and in the escaped form the character after `class_type` is `\`, not `"`, so
it never matches and the file silently parses as nothing. `unwrapMeta()` exists solely to pull the
inner strings out. It returns `{text}` for a node graph or `{obj}` for a flat settings dict.

Three shapes show up in practice, and all three are covered:

| Sample | `©cmt` shape | Handled by |
|---|---|---|
| ComfyUI VHS `VideoCombine` | `{"prompt":"<escaped graph>"}` — note **no `workflow` key**, matching [VHS #486](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/issues/486) | `unwrapMeta` → `parseMetadata` → `parseComfy` |
| WanGP / DeepBeepMeep | flat settings dict: `prompt`, `negative_prompt`, `resolution`, `seed`, `num_inference_steps`, `guidance_scale`, `activated_loras`, `model_type` | `unwrapMeta` → `parseSettings` |
| Grok video | `Signature: <base64>` — not AI metadata at all | falls through to the `Video` placeholder, but still gets `dim` |

`hasMeta()` decides whether a parse recovered anything; if not, `proc()` keeps the **old placeholder**
(`model:"Video"`, `meta.size` = file size in MB). That fallback is deliberate — an unparseable
container is no worse off than before. Note `meta.size` still doubles as a filesize string *only* on
that path; when metadata parses, `dim` supplies the resolution.

Cached videos carry a `vm` stamp. `backfillDim()` re-runs `proc()` for any video whose `vm !== VMETA`,
so **bump `VMETA` when the video parser changes** rather than bumping `DB` — the latter would discard
every image's cached metadata too.

`fixSave()` stays images-only. Rewriting a `moov` means recomputing every `stco`/`co64` offset in the
file; there is no safe hand-rolled version of that.

### Non-obvious parser fixes that videos exposed

Three bugs in `findUpstreamText()` were found via the video samples but affected **images equally** —
don't "simplify" them back out:

1. **Output slots were ignored.** `["50",0]` and `["50",1]` both resolved to node 50 and then
   collected *both* its `positive` and `negative` upstreams, so the negative prompt got spliced onto
   the positive one and both fields came out identical. When a node has both inputs, the slot index
   now picks one.
2. **`inputs.text` was added twice** — step 2 adds it, then step 3's generic sweep re-matched it via
   `key.includes('text')`, concatenated with no separator. A `used` set now guards it.
3. **`ConditioningZeroOut` echoed the positive prompt.** Flux/Chroma graphs wire the *positive*
   encoder into it to synthesise an empty negative, so recursing through it reported the positive
   text as the negative. It now returns `""`. This is why the PNG samples correctly show an empty
   negative — that is right, not a regression.

### Animated PNG and WebP

`comf` is ComfyUI `SaveAnimatedPNG`'s chunk type (written after IDAT). Its payload is the exact
`tEXt` shape — `keyword \0 json` — so both `extractText()` and `readTextChunks()` treat it as `tEXt`.

`extractWebPExif()` reads the RIFF `EXIF` chunk → TIFF IFD0 → ASCII tags, stripping the `prompt:` /
`workflow:` prefix ComfyUI writes (tag `0x0110` = prompt, `0x010F` = workflow, further keys walking
downwards). It returns `""` when absent so the caller falls back to the previous behaviour — which
was decoding the whole file as text and hoping.

Neither had a real sample. Both were verified against synthesized files built from the ComfyUI
writer's own layout; a genuine `SaveAnimatedPNG` / `SaveAnimatedWEBP` output would be worth a recheck.

### Image dimensions come from the file, never the workflow

`readDims(buffer)` parses the container header directly — PNG `IHDR`, JPEG `SOFn`, WebP
`VP8`/`VP8L`/`VP8X`, GIF — and `proc()` stores the result as `dim`. **Display always prefers `dim`**
over `m.meta.size`.

This is not a nicety. Workflow metadata records the *latent* size, which is wrong the moment a graph
upscales or resizes, and its `width`/`height` are frequently node references (`["49", 0]`) rather
than literals — interpolating those produced the sizes like `"49,0x49,1"` this used to display. And
it is not always recoverable at all: the samples route through a `ResolutionSelector` node that
stores only `aspect_ratio: "2:3"`, `megapixels: 1`, `multiple: 8` and *computes* 840x1256 at
execution time, so the real numbers appear nowhere in the file's metadata. Node ids also differ
between workflows, so nothing may key off a specific id.

`parseComfy` still derives `meta.size` (via `resolveNum`, which follows references generically and
refuses non-numeric values) but that is only a fallback for videos and unreadable headers.

Cache entries written before `dim` existed are repaired by `backfillDim()`, called from `scD()` on
cache hits. It reads only the first 64KB and leaves parsed metadata untouched — no full re-parse.

Paths are always **forward-slash relative to the opened root**, never absolute. The parent-directory
handle for a path is `dReg.get(path.slice(0, path.lastIndexOf('/'))) || rH`.

### `opD(h, p)` — the listing function, and its one trap

`opD` fills `cFiles` using the filter `!h || parentOf(file) === p`:

- `opD(null, "")` → **All Files**, every image at every depth. This is the "All Files" sidebar state,
  and what `fullScan()` ends with. `cDir` is legitimately `null` here — don't "fix" that.
- `opD(dReg.get('folder1'), 'folder1')` → only that folder's direct children.

Passing the **root handle** (`opD(rH, "")`) is almost always a bug: it means "files whose parent is
the root", i.e. only loose files sitting directly in the opened folder, so a library organised into
subfolders renders empty. That was the initial-load bug fixed in `fullScan()`.

---

## Section map

Line numbers drift with edits — grep the marker comments (`// STATE`, `// DB`, `// FS`,
`// --- BRAIN`, `// --- LOGIC ---`, `// ===== DUPLICATE DETECTION =====`, `// MOVE ENGINE`).

### Styles — lines 6–117
CSS variables on `:root` and `[data-theme="light"]`. **Every new color must come from a var** or it
breaks light mode. Duplicates-view styles start at `.dup-view` (line ~83).

Note `data-theme` sits on **`<body>`, not `<html>`** — so `[data-theme="light"] .foo` works, but a
var read off `document.documentElement` always returns the dark value. Scrollbars are themed through
`--sb-track` / `--sb-thumb` / `--sb-thumb-hov` plus the `::-webkit-scrollbar-*` pseudos.

### Markup — lines 118–214
Header buttons (each wired with an inline `onclick`), sidebar tree, `#grid` (the single container
that all four view modes render into), detail layer, inspector, overlays, help.

### Persistence — lines 313–317 (`iDB`, `dPut`, `dDel`, `dAll`)
Thin IndexedDB wrappers. Schema version is **1**; adding fields to a cache item needs no migration.

### Filesystem — lines 319–322
`initFileSystem()` → picker; `fullScan()` → clears registries and rewalks; `scD()` → the recursive
walk that populates `fReg`/`dReg` and calls `proc()` for uncached files.

### Metadata parsing ("the BRAIN") — lines 324–521
PNG chunk walking (`tEXt`/`iTXt`/`zTXt`/`eXIf`/`comf`), JPEG EXIF UserComment, WebP RIFF EXIF
(`extractWebPExif`), then `parseMetadata()` → `parseComfy()` (workflow graph traversal, LoRA
extraction) or `parseA1111()`. Self-contained and independent of everything below it.

### Video container metadata — grep `// ===================== VIDEO CONTAINER METADATA`
`readVideoMeta()` (ISOBMFF + EBML walkers), `unwrapMeta()`, `parseSettings()`, `hasMeta()`,
`videoChunks()`. Sits next to `readDims()`/`dimStr` and feeds the same BRAIN — see
[Video metadata](#video-metadata).

### Views — lines 526–534, 891–991
`setView(mode)` sets `vMode` + button active states, then calls `rend()`.
`rend()` is the **single render entry point**: it picks a class for `#grid` and dispatches to
`renderStats()`, `renderDuplicates()`, or the inline grid/list builders.
**To add a view mode:** add the branch in `setView`, the class + early-return in `rend()`, and a
`renderX(container)` function.

### Duplicate detection — lines 536–826
See the dedicated section below.

### File operations — grep `// ===================== SHARED FILE DELETE`, then `moveFile`, `fixSave`, `renameFile`
`fixSave()` rewrites PNG `tEXt` chunks with a hand-rolled CRC32 (`crT`/`cr32`, line ~1135) and
converts non-PNG to PNG via canvas. Any file mutation must update **all three** of `fReg`, `cache`,
and IndexedDB, or the UI desyncs.

### Keyboard — line 1112
Single global `keydown` listener with early returns. Input/textarea targets bail first, then
detail-mode keys, then global shortcuts. Bound: `?` `Esc` `Enter` `Delete` `F` `R` `T` `D` `S` `3`
and arrows/Home/End in list mode.

### Search — grep `// ===================== ADVANCED SEARCH`
A boolean query language over `cache`, not a substring scan. `advTokenize` → `advParse` (recursive
descent, `or > and > unary`) → `advEval` against the field bag built by `searchFields()`. Bare words
are ANDed, so a single-word query behaves exactly like the old one. `-x` / `!x` / `NOT x` negate,
`"…"` is a phrase, `( )` group, `field:value` restricts to one field (`FIELD_ALIAS` maps the
synonyms). A malformed query never throws — `pUn()` skips stray operators and unclosed parens just
end the group.

`searchFields()` joins every field into `f.all` with a **double space** so a quoted phrase can't
match across a field boundary. Unknown `field:` names fall back to `f.all`.

`runSearch()` replaces `cFiles` wholesale and is the only search entry point; the input handler
debounces into it (160ms). The advanced panel (`advCompose`) is a *front-end for the syntax*, not a
second engine — it composes a query string, writes it into `#sIn`, and calls the same path.

### Filters

Two filters narrow every listing and must be applied in **both** `opD()` and `runSearch()`:
`showFavoritesOnly` and `modelFilter` (via `passModel`). `refreshList()` re-runs whichever of the two
listings is currently active — use it after changing a filter rather than calling `opD` directly.

`buildModelFilter()` repopulates the toolbar dropdown from `fReg` and **clears a filter pinned to a
model that no longer exists**, which would otherwise silently show an empty library. Call it after
any scan.

`syncSortUI()` keeps the toolbar sort dropdown and the clickable `.list-head` columns showing the
same state — both drive `sortBy`/`sortDirection`, so whichever the user touches, call it.

---

## Duplicate detection (lines 536–826)

Matches on **file content**, so it is completely independent of filenames and spans every subfolder
under the opened root. Designed to stay cheap with thousands of images via three escalating stages —
each one only sees what survived the previous one:

1. **Size bucket** — `getFile()` returns metadata without reading bytes. A file with a unique byte
   size cannot have a duplicate and is dropped here. This is the main win; typically >95% of files
   never get read.
2. **Partial hash** — first 64 KB + last 64 KB (`DUP_PARTIAL`) of the size collisions. Files ≤128 KB
   are fully covered here and get flagged `wholeFileHashed` so stage 3 skips them.
3. **Full SHA-256** — entire file, only for partial-hash survivors. Cached on the `cache` item as
   `sha`/`shaSize`/`shaMtime` and persisted, so rescans of unchanged files are free.

`crypto.subtle.digest('SHA-256')` is native and available on `file://` (Chrome treats it as a secure
context). `jsHash()` is a 128-bit fallback that should never fire in practice.
`dupPool()` runs 8–16 files concurrently so hashing overlaps disk I/O.

**Do not "optimize" this into a single-pass full hash.** The staging is the entire point.

### Key functions

| Function | Line | Role |
|---|---|---|
| `findDuplicates()` | 616 | Header 🔍 button + `D` key. Toggles out of the view, else starts a scan |
| `scanDuplicates()` | 622 | The 3-stage pipeline; builds `dupGroups` |
| `dupBucket(list, keyFn)` | 581 | Groups by key, returns only buckets with >1 member |
| `renderDuplicates(c)` | 666 | Progress / empty / results markup |
| `attachDupThumbs`, `loadDupThumb` | 728, 734 | IntersectionObserver lazy thumbnails |
| `dupKeep` / `dupMark` / `dupAutoSelect` | 757–775 | Selection; auto modes are `oldest`/`newest`/`shortest`/`none` |
| `syncDupGroupUI` / `updateDupDeleteBtn` | 776, 788 | **Direct DOM updates, not a re-render** |
| `deleteMarkedDuplicates()` | 796 | Confirms, deletes, updates registries |

### Data shape

```js
dupGroups = [{
  id, hash, size,                       // sorted by reclaimable bytes, descending
  files: [{path, name, size, mtime, handle, del}]   // sorted oldest-first
}]
```

### Invariants to preserve

- **Selection changes must not call `rend()`.** `rend()` calls `clearURLs()`, which revokes the
  thumbnail object URLs and blanks the images. Use `syncDupGroupUI()` instead.
- **Nothing is marked for deletion by default.** The user opts in, per group or via an auto button.
- **Two confirms before deleting**, and a distinct extra warning when a group has *every* copy
  marked (that would lose the image entirely).
- Deletion updates `fReg`, `cache`, IndexedDB, `selectedItems`, and `favorites`, then calls
  `opD(cDir, currP)` — a targeted refresh, not a `fullScan()`.
- Groups that drop below 2 files after a delete are removed from `dupGroups`.

### Known limits

Exact-content matching only. Re-encoded, resized, or re-compressed near-duplicates are **not**
detected — that would need perceptual hashing (dHash/pHash over a downscaled grayscale bitmap),
which is a much heavier and fuzzier feature. Not currently implemented.

---

## On-device AI search (WebNN)

Semantic search (`sem:"a giraffe on a beach"`) and face clustering (`face:rob`), running entirely on
the local machine. **The app is still one HTML file** — the AI section lives in marker blocks at the
end of the `<script>`. Weights and the ORT runtime are *data*, in the git-ignored `ai/`.

### It cannot run from `file://`, and that is not fixable

Chrome gates WebNN, WebGPU **and Web Workers** behind a secure context, and `file://` is not one. So:

```bash
node serve.mjs        # then open http://127.0.0.1:8787
```

Everything is behind `aiOK()`. Opened by double-click the app behaves **exactly as before**; the only
delta is a dimmed 🧠 button. `localStorage['guru-ai']='off'` is a hard kill switch.

**`file://` and `http://127.0.0.1:8787` are different origins.** IndexedDB, favorites and folder
permissions do not carry over — the first launcher run rescans. Keep the port fixed; changing it
changes the origin and wipes the index again.

### Setup

`node fetch-models.mjs` (once, ~500 MB) → `ai/ort/` + `ai/models/`. `--int8` for the smaller
WASM-only set, `--force` to re-download.

### Read `ai/CONTRACT.md` before touching any of this

It is the frozen interface and it records several findings that are **not** guessable, all of which
cost real debugging time:

- **The CLIP text tower returns all-NaN on `webnn:npu`** (causal mask `Where` + `-inf`). It does not
  throw. Vision runs on the NPU, **text must run on `webnn:gpu`**, and `clipText` is never
  demotion-probed because plain `webgpu` is *semantically degenerate* while passing every
  hard-failure check.
- **The EP sanity gate's probe input must be realistically shaped.** A constant token fill has no
  EOS, misses the degenerate path, and silently passed the broken NPU tower.
- **`freeDims` must never default to 1.** Every CLIP axis is exported dynamic; all-ones compiles a
  `1×1×1×1` graph that builds fine and emits garbage. `fetch-models.mjs` throws instead.
- **WASM cannot load the fp16 models at all** — a WASM fallback needs int8 for *both* towers, and
  mixing tiers breaks the shared embedding space.
- **Only `/ai/ort/` and `/ai/models/*.onnx` are cache-immutable.** A broader rule pins
  `manifest.json` and `ai-worker.js`, and your edits appear to do nothing.

### Structure

| Marker block | Contents |
|---|---|
| `AI:CSS` | All new styles. Colours from `--ai-ok/--ai-warn/--ai-bad/--ai-chip` only |
| `AI:TOKENIZER` / `AI:PREPROC` | Verbatim copies of `ai/src/*.js`, which the worker also `importScripts` — **do not let them diverge**. Tested by `ai/src/*.test.mjs` in Node |
| `AI:SEARCH` | Packed int8 matrix, `aiQueryVecs`, `aiScore`, `findSimilar` |
| `AI:PANEL` | Panel, worker plumbing, batch job, video frame sampler |
| `AI:FACES` | People view, rename, merge, hide, plus the **manual person layer** (see below). The 👥 toolbar button is the way *back* into it — `aiSearchCluster()` ("Show all") leaves for a search. Cluster ids stay surfaced on the card and in the inspector because `aiPickPerson()` accepts one typed, for clusters that were never named |
| `AI:PORT` | Index export/import. `aiBuildExport` / `aiImportPlan` / `aiImportApply` are split from the picker wrappers so the whole round trip is testable without a native dialog — see CONTRACT §7a for the format and the two refusal gates |

Cache items gain `ai` (a **plain number**, the `AIV` stamp), `emb`/`embS`, `embF`/`nF` for video,
and `faces[]`. Library-global cluster state is a **reserved `__ai__` record inside store `"i"`** —
the DB version stays 1 deliberately, because a bump would make an older copy of the HTML fail with
`VersionError` → `alert("Access denied.")`. `dAll()` routes `_`-prefixed, extension-free keys to
`aiLoadMeta`.

Bump `AIV` when a model, its quantization, or preprocessing changes — `aiNeeds()` then re-analyzes
without discarding any parsed image metadata.

**No AI work happens in `scD()` or `proc()`.** Analysis is an explicit opt-in job, so opening a
folder is exactly as fast as before.

### The manual person layer, and the one way to break it

`aiCluster()` overwrites **every** `faces[].c` and **replaces** `aiMeta.clusters` on each Analyze
run. So hand-corrected person assignments cannot live there — they would be erased, silently,
hundreds of photos at a time. They live in `pA` (added) / `pR` (suppressed) on the cache item, and
removing a person writes a suppression entry rather than editing `c`.

- `peopleOf(v)` = `(detected ∪ pA) \ pR` and is the **only** reader. Skipping it in
  `searchFields().face` makes "Show all" return an empty list for a hand-tagged person.
- `applyPersonEdit(v,id,'add'|'rm'|'set')` is the only mutator — inspector chips and the selection
  bar's 👤 People… share it. `'set'` removes before it adds.
- Hand-made people are `clusters[]` entries with `manual:true` and ids from `aiMeta.nextM`, starting
  at `1000000`. **`aiCluster()` must `.concat()` them back**, and ids must never be negative —
  `c<0` means noise everywhere in this file.
- `aiSearchCluster()` queries `face:person-<id>`, never the name: two people can be named "Rob", and
  the card showing a friendly name is a display concern, not a query one.

`ai/src/people.test.mjs` drives the real page through Playwright against `node serve.mjs` and exists
mainly for the re-cluster case. Verified by mutation: drop the `.concat(man)` and it fails.

Seeding `cache` alone is **not** enough to test scoring: `aiBuildMat()` filters on `fReg.has(p)`, so
an item with a perfectly good `emb` that isn't in the file registry never enters the matrix, gets
`s = -1`, and is dropped — `aiScore` rewrites its array in place, so the symptom is an empty result
rather than a zero score. Seed `fReg` too.

## Conventions

- Terse, minified-ish style: single-letter locals, chained ternaries, `document.getElementById`
  inline. Match it — don't reformat surrounding code.
- Comments are reserved for non-obvious *why*, not narration.
- Inline `onclick="fn(...)"` for UI wiring; anything interpolated into HTML that came from a
  filename or path must go through `esc()` (line 547).
- User feedback is `showToast(msg, 'info'|'success'|'error')`; destructive actions use `confirm()`.
- Helpers available: `fmtBytes()`, `fmtWhen()`, `esc()` (lines 545–547).

## Before finishing a change

1. Syntax check without a browser:
   ```bash
   node -e "const fs=require('fs');const h=fs.readFileSync('Guru Manager ChromeEdge Edition.html','utf8');fs.writeFileSync('/tmp/c.js',h.match(/<script>([\s\S]*)<\/script>/)[1])" && node --check /tmp/c.js
   ```
2. Load in Chrome, open `samples/`, and confirm the feature works against real handles.
3. Check **both themes** — light mode regressions are the most common miss.
4. `samples/` has no backup — copy it aside before running anything destructive.
