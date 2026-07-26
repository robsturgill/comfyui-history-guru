# History Guru — ChromeEdge Edition

A **single self-contained HTML file** that browses a local image library, extracts AI generation
metadata (ComfyUI / A1111) from PNG/JPEG, and manages files in place via the File System Access API.

**Hard constraint: this must stay one file.** No build step, no bundler, no external assets, no CDN
scripts. All CSS lives in the one `<style>` block, all JS in the one `<script>` block. If a change
would normally warrant a new module, add a clearly commented section instead.

| | |
|---|---|
| App file | [Guru Manager ChromeEdge Edition.html](Guru%20Manager%20ChromeEdge%20Edition.html) (~1275 lines) |
| Test data | `samples/` — folder1, folder2, folder3 |
| Test data backup | `samples -backup/` — **never modify, never open in the app.** Restore `samples/` from here after destructive tests |
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

`samples/` is deliberately arranged to cover every duplicate case:

| Content | Files | Case exercised |
|---|---|---|
| A | `folder1/t2i_2026_07_21_00002_.png`, `folder3/t2i_2026_07_21_00002_.png`, `folder3/Comfyui-0002.png` | **3-way** group, cross-folder, one renamed |
| B | `folder1/t2i_2026_07_21_00015_.png`, `folder2/t2i_2026_07_24_00015_88888.png` | sibling folders + renamed |
| C | `folder1/t2i_2026_07_21_00019_.png`, `folder1/t2i_2026_07_21_00019_ - Copy.png` | same folder |
| unique | `..._00014_`, `..._00017_`, `..._00018_` | must NOT be grouped |

Expected result: **3 groups, 7 files**.

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

### Supported formats

`RX_MEDIA` and `RX_VIDEO` (declared next to `DB`) are the **single source of truth** — don't inline
an extension list anywhere else, and keep `RX_VIDEO` a strict subset of `RX_MEDIA` or a file will be
listed but never classified (or classified but never listed).

- Images: `png` `jpg` `jpeg` `webp` `gif`
- Video: `mp4` `webm` `mov` `mkv`

Videos skip metadata parsing entirely — `proc()` sets `model:"Video"` and puts the **file size in MB**
into `meta.size`, and `dim` stays null. Chrome cannot decode every container (`.mkv` in particular),
so `vidFallback()` swaps an errored `<video>` for a labelled 🎬 tile rather than leaving it blank.
It must be attached **after** the element is in the DOM — it replaces the node via `parentNode`.

### `fixSave()` is images-only

It rewrites PNG `tEXt` chunks, and for any non-PNG it rasterises through a canvas, writes a `.png`,
then **deletes the original**. Three guards protect that path:

1. Videos bail out immediately. Previously a video blob reached `new Image()`, which fires `onerror`,
   not `onload` — and the old `await new Promise(r => i.onload = r)` never settled, hanging silently.
2. `readDims(b)` doubles as a decodable-image check; unrecognised headers abort before any write.
3. `isAnimated(b)` (accurate GIF block walk, plus the WebP `VP8X` animation flag) prompts before
   flattening, because conversion keeps one frame and removes the original.

The image load now races `onload`/`onerror`/timeout, so no failure mode can hang it.

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

### Markup — lines 118–214
Header buttons (each wired with an inline `onclick`), sidebar tree, `#grid` (the single container
that all four view modes render into), detail layer, inspector, overlays, help.

### Persistence — lines 313–317 (`iDB`, `dPut`, `dDel`, `dAll`)
Thin IndexedDB wrappers. Schema version is **1**; adding fields to a cache item needs no migration.

### Filesystem — lines 319–322
`initFileSystem()` → picker; `fullScan()` → clears registries and rewalks; `scD()` → the recursive
walk that populates `fReg`/`dReg` and calls `proc()` for uncached files.

### Metadata parsing ("the BRAIN") — lines 324–521
PNG chunk walking (`tEXt`/`iTXt`/`zTXt`/`eXIf`), JPEG EXIF UserComment, then
`parseMetadata()` → `parseComfy()` (workflow graph traversal, LoRA extraction) or `parseA1111()`.
Self-contained and independent of everything below it.

### Views — lines 526–534, 891–991
`setView(mode)` sets `vMode` + button active states, then calls `rend()`.
`rend()` is the **single render entry point**: it picks a class for `#grid` and dispatches to
`renderStats()`, `renderDuplicates()`, or the inline grid/list builders.
**To add a view mode:** add the branch in `setView`, the class + early-return in `rend()`, and a
`renderX(container)` function.

### Duplicate detection — lines 536–826
See the dedicated section below.

### File operations — 830 (`contextDelete`), 993 (`moveFile`), 1137 (`fixSave`), 1198 (`renameFile`)
`fixSave()` rewrites PNG `tEXt` chunks with a hand-rolled CRC32 (`crT`/`cr32`, line ~1135) and
converts non-PNG to PNG via canvas. Any file mutation must update **all three** of `fReg`, `cache`,
and IndexedDB, or the UI desyncs.

### Keyboard — line 1112
Single global `keydown` listener with early returns. Input/textarea targets bail first, then
detail-mode keys, then global shortcuts. Bound: `?` `Esc` `Enter` `Delete` `F` `R` `T` `D` `S` `3`
and arrows/Home/End in list mode.

### Search — line 1237
Input handler that scans all of `cache` (filename, prompts, model, sampler, seed, steps, cfg, size,
resources) and replaces `cFiles` wholesale.

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
4. If a destructive test ran, restore `samples/` from `samples -backup/`.
