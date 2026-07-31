# Changelog - Guru Manager

All notable changes to the Guru Manager project will be documented in this file.

## [4.7.0] - 2026-07-31

### Added
- **☑ Selection mode**: A toolbar toggle that makes a plain click *select* instead of open, so multi-select no longer requires holding `Ctrl` or `Shift`. Checkboxes appear on list rows and grid cards, and a bar above the listing shows the live count with **Select all**, **Clear** and **Delete N**. Double-click still opens the viewer. `Ctrl+Click` and `Shift+Click` behave exactly as before.
- **Delete from the detail view**: A 🗑 button in the inspector, and the `Delete` key while the viewer is open. The next image slides into the slot the deleted one occupied, so the viewer stays open on it rather than kicking back to the grid.
- **Bulk delete with a counted confirmation**: `Permanently delete N selected items?` — from the selection bar, the `Delete` key, or a right-click inside a multi-selection (which now acts on the whole selection, matching what drag-and-drop already did).
- **👥 People button** in the toolbar. "Show all" on a face card leaves the People view for a search; there was previously no way back short of starting over.
- **Person ids are visible**: each face card shows its `id N` (click to copy) — the number the *Merge…* prompt asks the user to type, which was only visible inside that prompt. The inspector also lists the people found in the open image as chips, so one click goes from an image to every photo of that person.

### Fixed
- **Deleting no longer discards an active search.** Every file delete ran `fullScan()`, which rebuilds `cFiles` from `fReg` and ends in `opD(null,'')` — so the results vanished while the query stayed sitting in the search box. Deletion now updates the registries and removes the rows from `cFiles` directly, preserving the search, the sort and the current page. Folder deletes still rescan, because they change the tree.
- **Deleted files are removed from favorites.** The `Delete`-key path never did, so a deleted path stayed in `localStorage` forever.
- **Deleted files are pruned from `dupGroups`.** Deleting outside the duplicates view left stale groups that rendered rows for files that no longer existed.
- The list row's selected-state background was a hardcoded `rgba(139,92,246,0.2)` inline style, bypassing `--sel-bg` and so wrong in light mode.

- **The header clipped its own icons below ~1180px.** It holds ~12 controls in a single non-wrapping row, so 🔍 🧠 👥 ⭐ simply ran off the right edge with nothing to scroll or wrap them back. Three breakpoints now shed labels before icons and icons never; below 760px the search box takes its own row and the tools wrap beneath it. The inspector was pinned to a hardcoded `top:60px` — it now reads `--head-h`, fed by a `ResizeObserver` on the header, so a wrapped header stays in sync with no magic number.

### Findings worth recording
- **`faceEmb` is 10.6× *slower* on the GPU than on the CPU** — 116 ms on `webgpu` vs 11 ms on `wasm`. ArcFace w600k_mbf is a depthwise-separable net at 112×112: ~0.45 GFLOPs spread over many tiny kernels, so per-dispatch overhead dominates and the GPU loses. The graph is **not** partitioned; it is simply the wrong shape of work for a GPU. This is what a big GPU sitting at ~40% utilisation looked like — the dominant cost was a model that should never have been on it.
- **The demotion probe could not see it.** `openModel`'s tier guard (`tier !== win.tier → continue`) skipped the WASM candidate. That guard exists to stop an fp16 CLIP tower being demoted into an int8 *different model*, but it was also applied to `faceDet`/`faceEmb`, which carry **no `variants`** — `variantOf()` returns the same `.onnx` whatever the tier says. Gated on `spec(key).variants`, so variant-less models get a genuine like-for-like probe. Byte-identical weights, so no `AIV` bump: cosine agreement 1.0, max abs diff 4.5e-6.
- **Measure before optimising a pipeline.** The obvious hypothesis was that the serial `decode → infer` loop starved the GPU. Measured, decode is **9 ms of 294 ms** — prefetching it would have bought ~3%. Net effect of fixing the real cause: **294.5 ms → 81.6 ms per image, 3.4 → 12.3 images/sec.**
- `faceDet` correctly stays on `webgpu` (31.9 vs 38.3 ms — inside the 10% margin), so the probe still discriminates rather than just preferring WASM.

### Changed
- The two near-identical click handlers in `rend()` (grid and list) are now one `tileClick()`. Selection changes update the DOM directly via `syncSelUI()` instead of calling `rend()`, which revokes the thumbnail object URLs — the same rule the duplicates and faces views already follow.
- `pruneSelection()` runs wherever `cFiles` is rebuilt, so the selection bar can never count — or delete — rows the user cannot see.

## [4.6.0] - 2026-07-28

### Added
- **🧠 On-Device AI Search**: Search by what the media *depicts*, not just its metadata. Everything runs locally — no cloud service, no upload, no account.
  - **Semantic search** — `sem:"a giraffe on a beach"` ranks the library by CLIP image/text similarity. Composes with every existing filter (`sem:"portrait" model:flux -blurry`), because semantic terms are lifted out of the boolean AST and applied as a *ranking* rather than a predicate.
  - **Visual similarity** — `like:"folder1/x.png"`. Runs no inference at all: the query vector is the item's own stored embedding.
  - **Face grouping** — detect → embed → cluster, with a **People** view for naming and merging. Merge is a first-class action because clustering reliably over-splits the same person across lighting and angle.
  - **Video is included** — five frames are sampled per clip and scored with `max()` over frames, never a pooled mean, so a two-second appearance in a sixty-second clip is still findable.
- **🚀 `serve.mjs`**: A ~110-line zero-dependency localhost launcher. Sends COOP/COEP so the page is `crossOriginIsolated` (which unlocks multi-threaded WASM on the fallback path), binds `127.0.0.1` only, and fails loudly on a busy port rather than silently moving — the port is part of the origin, and a changed origin means a fresh IndexedDB.
- **📦 `fetch-models.mjs`**: One-time model download (~500 MB, or ~155 MB with `--int8`). Reads each ONNX graph's real input protos to generate `manifest.json`, including the `freeDimensionOverrides` WebNN requires.
- **🩺 `ai-check.html`**: Reports secure context, WebNN, NPU/GPU device availability and worker support, with a plain-English verdict.

### Notes
- **AI features cannot run from `file://`.** Chrome gates WebNN, WebGPU *and* Web Workers behind a secure context. `http://localhost` qualifies; a local file does not. This is why the launcher exists. Opened by double-click the app is byte-for-byte unchanged in behaviour, with the 🧠 button dimmed and explaining why.
- **WebNN needs `chrome://flags` → "Enables WebNN API".** Without it the app degrades to WebGPU, then CPU.
- **`file://` and `http://127.0.0.1:8787` are different origins**, so the metadata cache, favourites and folder permissions do not carry across. One rescan is expected on the first launcher run.

### Findings worth recording
These cost real debugging time and are not guessable from documentation:
- **The CLIP text tower returns all-NaN on the NPU.** Its causal attention mask is a `Where` feeding `-inf`, which WebNN turns into NaN. It does **not** throw — the session compiles and benchmarks fast. Vision runs on the NPU; text is pinned to `webnn:gpu`.
- **A backend sanity gate is only as good as its probe input.** The gate fed a constant token fill, which has no EOS — and CLIP pools at the `argmax(EOS)` position, so the degenerate path was never taken and the broken tower passed. It now probes with a realistically shaped `[BOS … EOS]` + padding sequence.
- **Speed-based demotion is dangerous for the text tower.** Plain WebGPU passes every hard-failure check (finite, non-constant, input-sensitive) while being semantically degenerate — it returned the same image for "a photograph of a person", "a cat or a dog" and "a city street at night". The text tower is therefore never demotion-probed.
- **`freeDimensionOverrides` must never default to 1.** These exporters mark *every* axis dynamic, so an all-ones default compiles CLIP vision as `1×1×1×1` — which builds successfully and emits garbage. `fetch-models.mjs` now throws on an unlisted axis instead.
- **WASM cannot load the fp16 models at all.** A CPU fallback must use int8 for *both* CLIP towers; mixing precision tiers breaks the shared embedding space.
- **Cache headers are load-bearing.** Only `/ai/ort/` and `/ai/models/*.onnx` are immutable. A broader rule pinned `manifest.json` and `ai-worker.js` for a year, so edits appeared to do nothing and the app ran against a stale graph shape.

### Changed
- `dAll()` routes `_`-prefixed, extension-free keys to the AI metadata loader instead of the file cache, so library-global cluster state lives in the existing store. **The IndexedDB version deliberately stays at 1** — a bump would make an older copy of the HTML fail with `VersionError`, surfacing as `alert("Access denied.")` with no way back.
- `runSearch()` takes a sequence token and re-checks it after every `await`. The text encoder introduces async work inside a 160 ms debounce, so overlapping searches were guaranteed to land stale results otherwise.
- `applySort()` gained a `relevance` branch; `opD()` and `clearSearch()` restore the previous sort when leaving it, since neither assigns scores.
- Added `dPutMany()` — a 10k-item analysis run was 10k IndexedDB transactions.
- Help now documents `sem:`, `like:` and `face:`. `Esc` closes the AI panel.

### Removed
- References to a `samples -backup/` directory, which never existed. `samples/` has no backup; copy it aside before running anything destructive.

## [4.5.0] - 2026-07-26

### Added
- **🎬 Video Metadata Extraction**: Videos are no longer a blind spot. `readVideoMeta()` walks the container and hands the result to the existing parser, so prompts, model, seed, steps, CFG, sampler and LoRAs populate for MP4/MOV/WebM/MKV exactly as they do for PNGs.
  - **MP4 / MOV**: `moov → udta → meta → ilst`, supporting both the `mdta` keys table and the classic iTunes atoms. Worth recording that **every real sample used `©cmt`, not `mdta`** — the opposite of what the research doc predicted from ffmpeg's `-movflags use_metadata_tags` path.
  - **WebM / MKV**: the Matroska `Tags → Tag → SimpleTag → TagString` chain. Clusters are skipped by arithmetic and never read.
  - **Never buffers the file.** The box/element chain is walked with `File.slice()`, so only `moov` (or `Tags`/`Tracks`) is ever read. A naive `arrayBuffer()` would have pulled hundreds of megabytes into memory per item and undone the pagination/lazy-load work from 4.3.0.
- **📐 True Video Resolution**: Read from the container's `tkhd` box (its final 8 bytes, which is version-independent) or Matroska `PixelWidth`/`PixelHeight`. The Size field shows `1024x1536` instead of the `8.7MB` filesize string that used to sit in that slot. Audio tracks report `0x0` and are filtered out. Verified against `stsd` coded sizes on every sample.
- **🔓 JSON Wrapper Unwrapping**: ComfyUI/VHS store the graph as a JSON **string** inside a wrapper object — `{"prompt": "{\"6\": {\"class_type\": ...}}"}`. The backslash escaping means the literal `"class_type"` never appears, so `parseMetadata()`'s content sniff silently found nothing. `unwrapMeta()` pulls the inner documents out first. This one detail was the difference between "video metadata works" and "video metadata parses to nothing".
- **⚙️ Flat Settings-Dict Parser**: `parseSettings()` handles generators that write a settings dictionary rather than a node graph (WanGP/DeepBeepMeep and similar), mapping `negative_prompt`, `resolution`, `num_inference_steps`, `guidance_scale`, `activated_loras`/`loras_multipliers` and `model_type` onto the standard fields.
- **📄 JSON / Workflow Viewer Now Opens on Videos**: The hard-coded `'Videos carry no embedded workflow.'` toast is gone — it was simply wrong. Videos get the same dialog, syntax highlighting, clickable node outline and search. A wrapper containing JSON documents becomes one tab per document; a flat settings dict stays a single tab rather than sixty scalar ones.
- **🖼️ Animated PNG & WebP Metadata**: `comf` chunks (ComfyUI `SaveAnimatedPNG`) are now read as `tEXt`, and `extractWebPExif()` parses the RIFF `EXIF` chunk → TIFF IFD0 → ASCII tags `0x0110`/`0x010F`, stripping the `prompt:`/`workflow:` prefix. Previously WebP fell through to decoding the entire file as text and hoping the JSON survived.
- **🔄 In-Place Cache Upgrade**: Cached videos carry a `vm` version stamp; `backfillDim()` re-runs `proc()` for any entry behind the current `VMETA`. Video metadata improvements reach existing libraries without bumping the DB name and discarding every image's cached parse.

### Fixed
- **Negative prompts duplicated the positive prompt** — on images as well as videos. Three separate causes in `findUpstreamText()`:
  - **Output slot indices were ignored.** Following `["50", 0]` and `["50", 1]` both landed on node 50 and then collected *both* its `positive` and `negative` upstreams, so the two fields came out identical. Nodes carrying both conditioning inputs (`WanImageToVideo` and most `*ToVideo`/guider nodes) now honour the slot.
  - **`inputs.text` was added twice** — once by the explicit check, then again by the generic sweep whose `key.includes('text')` test matches the key `text`, concatenated with no separator so prompts appeared doubled end-to-end.
  - **`ConditioningZeroOut` echoed the positive prompt into the negative field.** Flux/Chroma graphs wire the positive encoder into it precisely to produce an *empty* negative, so recursing through it reported the positive text. It now returns empty. The bundled PNG samples correctly show a blank negative as a result — that is the correct reading of those workflows, not a regression.
- **Seed displayed a raw node reference, and Model came out blank** (images; found while tracing the video prompts). `meta.seed` printed `["182",0]` whenever the seed came from a `Seed (rgthree)`/Primitive node instead of a literal. `resolveNum` already followed references generically but sat *after* the sampler block and only knew the width/height slot convention; it moved above and gained an optional `keys` parameter, so `seed` and `noise_seed` resolve independently — a referenced seed that fails no longer shadows a literal `noise_seed`, which is the shape the ComfyUI VHS videos use. `findUpstreamModel` returned `""` whenever the model port ran through a passthrough node (`ComfySwitchNode` carries it on `on_true`/`on_false` and has none of the four loader fields); it now falls back to following any input that is a node reference, with a regex skipping ports carrying other data types and a `seen` set preventing cycles. All ten bundled PNG samples go from 0/10 to 10/10 fully resolved.
- **Videos were unsearchable by anything meaningful**: they only ever indexed `"8.7mb"` in the size field. They now match on prompt text, model, LoRA, seed and real resolution.
- **Statistics counted every video as a single `Video` model**, inflating that bucket and hiding real checkpoints. Parsed videos now report their actual model and LoRAs.

### Unchanged by design
- **"Fix & Save" remains images-only.** Rewriting a `moov` means recomputing every `stco`/`co64` chunk offset in the file; there is no safe hand-rolled version of that, and getting it wrong corrupts the video. The existing guard is correct and stays.
- **Videos with no AI metadata keep the `Video` placeholder** (one of the bundled samples is a Grok video whose `©cmt` holds only a signature blob). They still get their real resolution, so the fallback is strictly better than before rather than a dead end.

### Notes
- ComfyUI VHS MP4s in hand contain `prompt` but **no** `workflow` key, matching [VideoHelperSuite #486](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/issues/486). Handled gracefully; nothing recoverable on our side if the bytes were never written.
- The APNG `comf` and WebP EXIF paths had no real sample to test against. Both were verified against files synthesized from the ComfyUI writer's own layout, but a genuine `SaveAnimatedPNG`/`SaveAnimatedWEBP` output is worth a recheck.

## [4.4.0] - 2026-07-26

### Added
- **🔎 Advanced Search (Boolean Query Language)**: The search box now parses a real query language instead of doing one flat substring match across everything. Bare words are ANDed together; `AND` / `OR` / `NOT` operators, `-word` exclusion, `"quoted phrases"`, and `( )` grouping all work, and `field:value` restricts a term to a single field. Valid fields are `name` `path` `prompt` `neg` `model` `sampler` `seed` `steps` `cfg` `size` `lora`, plus friendlier aliases (`file`, `folder`, `positive`, `negative`, `checkpoint`, `ckpt`, `resolution`, `resource`). So `(man OR woman) AND fish -river model:flux` does what it looks like it does. Input that can't be parsed degrades gracefully instead of throwing.
- **⚙ Advanced Search Builder**: A gear button inside the search box opens a builder panel with three fields — *All of these* / *Any of these* / *None of these* — plus a "Search in" field selector. It composes the query syntax for you, shows a live preview of the generated query, and writes it into the search box, so it teaches the operators rather than hiding them behind a form. The search box also gained an ✕ clear button.
- **🏷️ Model Filter Dropdown**: A toolbar dropdown listing every distinct checkpoint found in the library with a per-model file count, plus a `— No model` bucket for files where no checkpoint was detected. It composes with the text search and the favorites filter rather than replacing them. Deliberately a toolbar control instead of a select embedded in the "Model" column header: the header stays a plain sort target, and the filter still works in Grid view where there is no header at all.
- **↕️ Sort Controls Moved to the Toolbar**: Sort now sits next to the model filter, pagination and thumbnail size, with a dedicated ascending/descending toggle button, and gained **Model** as a sort key. The toolbar dropdown and the clickable list-view column headers are two views of the same state — changing either updates the other.
- **🎚️ Themed Scrollbars**: The folder tree, main view, inspector and JSON viewer now use styled scrollbars driven by new `--sb-track` / `--sb-thumb` / `--sb-thumb-hov` variables, defined for both the dark and light themes so neither mode gets a stock scrollbar bolted onto a custom panel.
- **📖 Search Syntax Reference in Help**: The `?` overlay now documents every operator and searchable field with worked examples.

### Fixed
- **Sticky toolbars were transparent for their top 20px**: `.grid-scroll` carried `padding:20px`, and that padding insets the containing block a `position:sticky` child is constrained to — so the list-view column header and the duplicates action bar both parked 20px *below* the top of the scroll area, with images scrolling visibly through the gap above them. The gutter moved off the scroller and onto the inner views (`.grid`, `.list-view`), so both bars pin flush to the top. They also picked up a backdrop blur and a drop shadow so they read as overlays. This removed the `.dup-view{margin:-20px}` hack that existed only to cancel that padding.
- **List header columns didn't line up with their rows**: `.list-head` hard-coded a `55px` first column while `.list-row` uses `calc(var(--thumb-size) / 2.5 + 18px)` — 107.6px at the default thumbnail size — so every downstream label (Name, Model, Date Created, Date Modified) sat left of the data it was supposed to title. The header now uses the same track sizes as the rows.
- **Extra padding in the search box**: The input reserved `36px` of left padding for a search icon that was never in the markup. Tightened up, and the box now has a minimum width so it stops collapsing to nothing when the header gets cramped.
- **Favorites filter is now respected by search**: ⭐-only mode applied while browsing a folder but was silently dropped the moment you typed anything in the search box.
- **Search input is debounced (160ms)** instead of rescanning the entire cache on every keystroke.

### Known / unchanged
- **Video metadata is still not extracted**: videos short-circuit metadata parsing entirely and report only a placeholder model of `Video` plus their file size — no prompts, no workflow, no true resolution. Findings and an implementation proposal live in `docs/VIDEO-METADATA.md` (local-only; `docs/` is gitignored). Sample ComfyUI video files are needed before this can be built and verified.

## [4.3.0] - 2026-07-26

### Added
- **🔍 Rebuilt Duplicate Detection**: Replaced the old pairs-only 50KB hash with a 3-stage pipeline — free size-bucketing, then a partial 64KB hash, then a full SHA-256 for survivors — finding true n-way groups across all subfolders instead of just pairs. Adds a full review UI: thumbnails, per-file keep/delete, `Keep oldest / newest / shortest path` auto-select, and two confirms before deleting (with an extra warning if a group would lose every copy).
- **📄 JSON / Workflow Viewer**: New dialog for inspecting a file's raw embedded metadata — separate tabs for ComfyUI's `prompt` (API form) and `workflow` (UI graph), or A1111's plain-text `parameters`. Syntax highlighting, a clickable node outline (id/type/title), in-place search with match stepping, and copy/save-to-disk.
- **⚡ Pagination & Lazy Thumbnails**: Page-size selector (100/200/500/1000/All, default 200, remembered) plus `[`/`]` shortcuts, combined with IntersectionObserver-based lazy loading so thumbnails only decode once scrolled into view. Measured at 10,000 items: ~60ms render, 200 DOM rows, 10 files opened, 10MB heap — previously 3,000 images was enough to permanently wedge the renderer.
- **🎬 More Formats**: Added `gif`, `mov`, `mkv`. Format lists are now a single declaration (`RX_MEDIA`/`RX_VIDEO`) instead of two regexes that could drift apart. Undecodable containers (Matroska, some `.mov` codecs) show a labelled 🎬 fallback tile instead of a blank thumbnail.
- **🛡️ Fix & Save Safety Guards**: Files with no recognisable image header are rejected before any write, and animated GIF/WebP now prompt first since conversion keeps one frame and deletes the original.
- **New shortcuts**: `D` find duplicates, `[` / `]` page back/forward.

### Fixed
- **Empty file list on first open**: `fullScan()` finished by filtering to files whose parent is the root, so a library kept in subfolders showed nothing until you clicked into a folder and back. Now matches the "All Files" sidebar behavior.
- **Wrong image resolution on most images**: The Size field read `width`/`height` off the workflow's `EmptyLatentImage` node, which are frequently node references (e.g. `["49", 0]`) rather than literals, producing display values like `49,0x49,1`. Dimensions now come from the file's own header (PNG `IHDR`, JPEG `SOFn`, WebP, GIF), correct regardless of node ids, custom nodes, or upscales.
- **"Fix & Save" hung forever on videos**: The non-PNG branch awaited an `<img>`'s `onload`, but video blobs fire `onerror` instead, which was never handled. The image load now races `onload`/`onerror`/timeout so no failure mode can hang it.
- **JSON button did nothing**: Previously called a function that was never defined, throwing a silent `ReferenceError`. Replaced with the JSON/Workflow Viewer above.

### Removed
- **Firefox Edition**: This fork is Chrome/Edge only going forward; the File System Access API feature set (true file management, duplicate cleanup, direct overwrite) has no Firefox equivalent to keep parity with.

## [4.2.1] - 2025-12-24

### Added
- **📅 US Date Localization**: Updated the timestamp engine to use `MM/DD/YYYY` (en-US) format across both editions.
- **🕒 First-Seen Persistence**: Implemented a "Date Created" fallback using IndexedDB (Chrome/Edge) or session memory (Firefox) to distinguish the initial file scan from subsequent filesystem modifications.

### Fixed
- **📊 List View Alignment**: Resolved a major "Header Shift" bug where columns became misaligned when thumbnails were disabled.
- **📐 Header Synchronization**: Fixed invisible placeholder divs in the List View header to ensure columns (Name, Model, Created, Modified) stay perfectly aligned with their data rows.

## [4.2.0] - 2025-12-24

### Added
- **💾 Direct File Overwrite (Chrome/Edge)**: Optimized "Fix & Save" to overwrite original files directly via File System Access API instead of creating `fixed_` copies.
- **🖱️ Pro-Selection Engine**: Implemented full `Shift+Click` and `Ctrl+Click` multi-selection in both List and Grid views for the Chrome/Edge edition.
- **📦 Multi-File Operations (Chrome/Edge)**: Enabled bulk drag-and-drop moving for selected groups of files to new directories.
- **🪄 LoRA "Un-Baking"**: Intelligent parser now auto-imports "baked" ComfyUI/A1111 resources into editable LoRA tags, ensuring embedded models are never lost during metadata edits.
- **✏️ On-Disk Renaming (Chrome/Edge)**: Added a metadata-panel rename feature that updates file names directly on the filesystem.
- **🚀 Dual-Engine Export (Firefox)**: Implemented a hybrid "Save As" strategy using `showSaveFilePicker` for Chromium and `application/octet-stream` masking for Firefox to ensure system save prompts.
- **🏗️ Ergonomic UI Layout**: Relocated the LoRA Manager below the Negative Prompt to follow natural prompt-engineering hierarchy.
- **☀️ Daylight Parity**: Comprehensive Light Mode audit fixed invisible overlays (Help, Welcome, Resources) and boosted selection visibility with `--sel-bg` accents.
- **🧹 Debounced URL Revocation**: Optimized memory management to only flush Object URLs after 100 items, significantly smoothing out gallery scrolling.

### Fixed
- **📺 Fullscreen Integrity**: Fixed the "X" button in Fullscreen mode to correctly exit detail view and restore the previous UI state.
- **🖼️ Thumbnail Persistence**: Resolved a bug where thumbnails would unexpectedly turn back ON when exiting image detail mode.
- **⌨️ Keyboard Safeguards**: Updated `Esc` key behavior to blur active text inputs instead of closing the entire viewer.
- **🛡️ Renaming Sanitization**: Integrated strict filename sanitization to prevent illegal OS characters during rename operations.
- **📐 Z-Index Architecture**: Lifted all global overlays to `z-index: 5000` to prevent collision with the Metadata Inspector.

## [4.1.0] - 2025-12-21

### Added
- **Substantial Thumbnail Scaling**: Reworked the list view scaling math to provide much larger thumbnails when using the slider. The "Large" setting now results in thumbnails that are over 3x bigger than the original fixed size, ensuring a clear visual impact when scaling.
- **Increased Default Thumbnail Size**: Increased the base thumbnail size by 40% in both editions. The list view now automatically adjusts its row height and column widths to accommodate larger images without scaling the text.
- **Enhanced Slider Range**: Updated the thumbnail resizer slider to support 20% increments (5 steps) centered around the new larger default.
- **Context-Aware Grid Toggle**: The Grid/List toggle button now automatically hides when thumbnails are disabled, providing a cleaner UI when viewing metadata-only lists.
- **Grid View Mode (ChromeEdge)**: Implemented a proper Grid View for the ChromeEdge edition, allowing users to browse images as cards.
- **Grid/List Toggle**: Added a dedicated button (🔲/☰) in the header of both editions to easily switch between Grid and List views.
- **Responsive Thumbnails**: Linked the thumbnail resizer to both Grid cards and List images. Moving the slider now dynamically resizes images in both view modes.
- **Thumbnail Resizer**: Added a size slider to the grid toolbar in both editions. Users can now dynamically adjust the thumbnail size from 60% to 140% of the default size. The setting is saved persistently and automatically hides when thumbnails are disabled.
- **LoRA Visibility Improvements (Daylight Mode)**: Increased text contrast and added dedicated background variables for resource chips (LoRA, Model) and strength badges in both editions. Text is now significantly darker and more legible in Light Mode.
- **Metadata Stats Toggle (ChromeEdge)**: The Statistics button now acts as a toggle, allowing users to switch back to the main UI by clicking it again.
- **Thumbnail Toggle**: Added a "Thumbnails" button in the header of both ChromeEdge and Firefox editions to toggle image visibility in list view. Includes a visual status indicator (Green/Red dot) and persistent state via `localStorage`.
- **Comprehensive .gitignore**: Added a root-level file to prevent tracking of system-generated files and development-only tools.
- **Root-level CHANGELOG.md**: Documenting workspace-wide architectural changes.
- **Mandatory Descriptive Commits**: New coding rules for architectural transparency.

### Fixed
- **Dynamic Row Height**: Fixed an issue in both editions where list rows would maintain their large height even after turning thumbnails off.
- **Light Mode UI Fixes**: Fixed invisible refresh symbols and black background issues across both editions when in Light mode.
- **Merge Conflict Resolution**: Resolved sidebar layout conflicts in the Firefox Edition.

## [4.0.0] - 2025-12-22

### Added
- **🧠 Advanced Memory Management**: Implemented `URL Lifecycle Management` to prevent leaks.
- **🖼️ Pro-Grade EXIF Engine**: Enhanced metadata extraction for JPEG and WebP with full UNICODE support.
- **🖱️ Infinite Scroll Fix**: Smooth content loading even when thumbnails are disabled.
- **⚡ Ultra-Fast Duplicate Finder**: Near-instant scans using partial file hashing.
- **🛠️ Robust Scanning**: Folder loader now handles corrupted metadata gracefully.

### Fixed
- Fixed broken `detailImage` references and restored missing `renderTree` in Firefox Edition.
- Removed duplicate `applySort` logic.
