# History Guru 🧘‍♂️ v4.7.0 (ChromeEdge Edition)

> **The 100% Offline, Single-File File Manager & Metadata Viewer for AI Images.**

**History Guru** has evolved into a precision instrument for AI creators. It is no longer just a viewer—it is a full-fledged **Local File Manager** and **Metadata Editor** for your ComfyUI and A1111 output folders. 

Organize, sort, move, rename, and "un-bake" your AI generations without ever leaving the metadata view. It runs entirely in your browser using the modern *File System Access API*. This fork targets **Chrome / Edge only** — the Firefox edition has been retired in favor of focusing on the full file-management feature set that only the File System Access API can provide.

---

## ✨ Core Feature Set

### 📂 Pro-Grade File Management (Chrome/Edge Only)
*   **True File Operations:** Create folders, rename files on disk, and move files between directories directly from the UI.
*   **Multi-Select Engine:** Full Windows-style `Shift+Click` (range) and `Ctrl+Click` (toggle) selection, plus a ☑ **selection mode** where a plain click selects — no key held — with checkboxes and a **Delete N** bar.
*   **Deletion That Doesn't Lose Your Place:** Delete from the detail view, from a multi-selection, or by right-click. The listing updates in place, so an active search survives the delete instead of being wiped.
*   **Bulk Drag & Drop:** Select a group of images and drag them into the sidebar to organize your library in seconds.
*   **Direct Overwrite:** The "Fix & Save" engine writes updated metadata directly back to the original file—no more `fixed_` copies cluttering your folders.

### 🪄 Advanced Metadata & LoRA Engine
*   **LoRA "Un-Baking":** Intelligent parser auto-detects baked resources in ComfyUI/A1111 metadata and imports them into the editable LoRA manager.
*   **Universal LoRA Manager:** Add, remove, update strength, and reorder LoRA tags via a dedicated visual editor.
*   **Lossless Injection:** Writes corrected metadata directly back to the PNG binary using CRC32 checksum injection—no re-encoding or quality loss.
*   **Pro-Grade EXIF:** Deep support for UNICODE (UTF-16), ASCII, and UTF-8 encoded `UserComment` fields.

### 🖼️ High-Performance Gallery
*   **Massive Scaling:** Dynamic thumbnail engine provides **3x larger previews** via a smooth scaling slider.
*   **Hybrid View:** Instant toggle between a **Categorized List View** (with clickable sort headers) and a **Visual Grid View**.
*   **Cinema Mode:** A split-screen "Detail View" for full-height image inspection alongside live metadata editing.
*   **Memory Safety:** Systematic `URL Lifecycle Management` and debounced URL revocation ensure smooth performance even with 1000+ images.

### 🔎 Advanced Search & Filtering
*   **Boolean Query Language:** Bare words are ANDed, plus `AND` / `OR` / `NOT`, `-exclusions`, `"quoted phrases"`, and `( )` grouping — e.g. `(man OR woman) AND fish -river model:flux`.
*   **Field-Scoped Terms:** Aim a term at one field with `field:value` — `name` `path` `prompt` `neg` `model` `sampler` `seed` `steps` `cfg` `size` `lora`, plus aliases like `file`, `folder`, `positive`, `negative`, `checkpoint`, `resolution`.
*   **Search the Raw Workflow:** `json:` looks inside the embedded metadata itself — node class types, node titles you typed, upscale model names, custom-node widget values — everything the summarised fields never see. Composes with the rest: `json:UltimateSDUpscale AND -json:karras`. Files imported before this existed need a one-time **Build JSON index** in the ⚙ panel; new files are indexed as they're scanned.
*   **Query Builder:** The ⚙ button opens an *All of these / Any of these / None of these* panel with a "Search in" field selector. It shows a live preview of the query it generates and drops it into the search box, so it teaches the syntax instead of hiding it.
*   **Model Filter:** A toolbar dropdown of every checkpoint in your library with per-model file counts (and a `— No model` bucket), composable with both the text search and the ⭐ favorites filter.
*   **Toolbar Sorting:** Sort field and an ascending/descending toggle now sit in the toolbar — with **Model** as a new sort key — and stay in sync with the clickable list-view column headers.
*   **Built-In Reference:** Press `?` for a full syntax cheat sheet of every operator and field.

### 🌗 Daylight & Night Modes
*   **Universal Parity:** Reworked Light Mode with theme-aware CSS variables. Overlays, labels, and selection highlights are high-contrast and perfectly legible in bright environments.
*   **Themed Scrollbars:** The folder tree, main view, inspector, and JSON viewer all use styled scrollbars tuned for both themes.

### 🔍 Content-Based Duplicate Detection
*   **Three-Stage Pipeline:** Escalates from free size-bucketing, to a partial 64KB hash, to a full SHA-256 — so libraries with thousands of images stay fast; only true collisions ever get fully hashed.
*   **N-Way Grouping:** Finds every copy of a file, not just pairs, across all subfolders, independent of filename.
*   **Guided Cleanup:** Review groups sorted by reclaimable space, with thumbnails, `Keep oldest / newest / shortest path` auto-selection, and two confirmations before anything is deleted.

### 📄 JSON / Workflow Viewer
*   **Full Metadata Inspector:** View a file's raw embedded ComfyUI `prompt`/`workflow` chunks or A1111 `parameters` text, with syntax highlighting.
*   **Clickable Node Outline:** Jump straight to any node by id, type, or title.
*   **Search & Export:** In-place search with match stepping, plus copy-to-clipboard or save-to-disk.

### ⚡ Pagination & Lazy Loading
*   **Scales to 10,000+ Images:** Page-based rendering (100/200/500/1000/All) keeps the DOM light, while thumbnails only decode once they scroll into view.
*   **Measured Performance:** 10,000 items render in ~60ms with only the visible thumbnails ever opened.

### 🎬 Video Metadata Extraction
*   **Prompts & Workflows From Video:** MP4/MOV metadata is read straight out of the container (`moov/udta/meta/ilst`, both the classic `©cmt` atom and the `mdta` keys table), and WebM/MKV out of the Matroska `Tags` element. Positive and negative prompts, model, seed, steps, CFG, sampler and LoRAs now populate for video exactly as they do for images.
*   **Two Generator Formats:** ComfyUI/VideoHelperSuite node graphs *and* flat settings dictionaries from wrappers like WanGP, which use their own key names (`negative_prompt`, `num_inference_steps`, `guidance_scale`, `activated_loras`).
*   **True Resolution:** Read from the container's own `tkhd` box (or Matroska `PixelWidth`/`PixelHeight`), so the Size field shows `1024x1536` instead of `8.7MB`. Audio tracks are skipped automatically.
*   **Streams, Never Buffers:** Hundreds-of-megabytes files are walked by slicing the box chain — only the metadata box is ever read, so scanning a video library stays as fast as scanning images.
*   **Workflow Viewer for Video:** The JSON viewer now opens on videos, with the full clickable node outline, syntax highlighting and search.
*   **Graceful Fallback:** Videos with no AI metadata (or an unreadable container) keep the old `Video` placeholder — but still show their real resolution.

### 🖼️ Expanded Format Support
*   Added **GIF**, **MOV**, and **MKV** alongside PNG/JPEG/WebP and MP4/WebM. Unplayable video containers fall back to a labelled placeholder tile instead of a blank thumbnail.
*   **Animated PNG & WebP:** ComfyUI's `SaveAnimatedPNG` (`comf` chunks) and `SaveAnimatedWEBP` (EXIF tags) metadata is now extracted.
*   **Safer "Fix & Save":** Animated GIF/WebP now prompt before flattening to a single frame, and non-image files are rejected before anything is written. Metadata editing stays images-only — rewriting a video container would corrupt it.

### 🧠 On-Device AI Search *(optional)*
*Search your library by **what the picture shows**, not just what the metadata says. Nothing leaves your machine.*

*   **Semantic Search:** `sem:"a giraffe on a beach"` ranks the whole library by meaning, using CLIP image/text embeddings. Works on **video too** — five frames are sampled per clip and scored on the best match, so a two-second appearance in a sixty-second clip still finds it.
*   **Find Similar:** `like:"folder1/x.png"` surfaces visually similar images. No inference needed — it reuses the image's own stored embedding, so it is instant.
*   **Face Grouping:** Faces are detected, embedded and clustered. Name a person once in the **People** view and search `face:rob` forever after. Merging is one click, because clustering reliably over-splits the same person across lighting and angles.
*   **Composes With Everything:** `sem:"portrait" model:flux -blurry` works exactly as you'd expect. Semantic terms rank; the normal filters still narrow.
*   **Runs On Your NPU:** Uses **WebNN** via ONNX Runtime Web, which is the only browser API that can reach an NPU (WebGPU cannot). It probes NPU → GPU → WebGPU → CPU and picks what actually performs, rejecting any backend that returns garbage.
*   **Opt-In and Reversible:** Analysis is an explicit button, cancellable and resumable; results cache to IndexedDB so it never redoes work. **Clear AI data** removes it all without touching your images.
*   **Index Once, Use Anywhere:** **Export index** writes every embedding, face and person name to a single JSON file; **Import index** restores it on another machine holding the same library, so you analyze once rather than once per device. The import checks that the two sides actually line up — it reports how many files matched, and refuses outright if the index was built with a different model or a different precision.

---

## 🚀 How to Use

### 🟢 Chrome / Edge / Opera
*Best for: Managing files, bulk organizing, and direct disk editing.*

1.  **Open** `Guru Manager ChromeEdge Edition.html` in your browser.
2.  **Grant Permission:** Click **"Open Folder"** and select your directory. When the browser asks, click **"Edit"** or **"Allow"** to enable file management features.
3.  **Organize:** Use the sidebar to create folders. Use `Shift+Click` to select groups and drag them into new locations.
4.  **Edit:** Click any image to open the Inspector. Edit prompts or LoRAs and hit **"Fix & Save"** to overwrite the file on disk.

---

## 🧠 Enabling AI Search

Everything above works by double-clicking the HTML. **AI search does not**, and that is a browser rule rather than a design choice: Chrome blocks WebNN, WebGPU *and* Web Workers on `file://` pages because it is not a secure context. `http://localhost` **is** one, so the app ships a tiny launcher.

You need [Node.js](https://nodejs.org) (v18+) and about **500 MB** of disk for the models.

**1 — Turn on WebNN in your browser.** Go to `chrome://flags` (or `edge://flags`), search for **WebNN**, set **"Enables WebNN API"** to **Enabled**, and restart the browser.

> On Edge, NPU support may additionally need launching with `msedge.exe --disable_webnn_for_npu=0`.
> On Windows you want **11 version 24H2 or newer** plus a current NPU driver. Without WebNN the app still works — it falls back to your GPU, just slower.

**2 — Download the models (once).**

```bash
node fetch-models.mjs
```

Pulls the ONNX Runtime and four models (CLIP vision + text, a face detector, a face embedder) into `ai/`. Add `--int8` for a smaller ~155 MB CPU-only set. This is the *only* time anything is downloaded — all inference afterwards is local and offline.

**3 — Start the launcher.**

```bash
node serve.mjs
```

Then open **http://127.0.0.1:8787**. It binds to localhost only and is not reachable from your network.

**4 — Check your machine (optional).** Open **http://127.0.0.1:8787/ai-check.html** for a green/red report on secure context, WebNN, NPU, GPU and workers. If something is off, this says exactly what.

**5 — Index your library.** Open your folder, click **🧠**, then **Analyze**. First run compiles the models (~20 s) before the counter moves. A few thousand images takes a while — it is cancellable and resumes where it left off.

> **Heads-up:** `file://` and `http://127.0.0.1:8787` are **different origins**, so the metadata cache, favourites and folder permission do not carry across. The first launcher run rescans your library once. Keep the port at 8787 — changing it changes the origin and starts over.

Opened the old way, the app behaves exactly as before, with the 🧠 button dimmed and explaining why.

---

## ⌨️ Keyboard Shortcuts
*   `Arrow Keys` - Navigate images in detail view
*   `Esc` - Blur active input / Close overlays / Exit detail view
*   `T` - Toggle theme (Dark/Light)
*   `F` - Focus search box
*   `R` - Refresh folder
*   `?` or `/` - Show help & shortcuts
*   `S` - Toggle Statistics view
*   `D` - Find duplicates
*   `[` / `]` - Page back / forward

---

## 🔧 Technical Architecture
*   **WebNN + ONNX Runtime Web:** On-device inference with an NPU → GPU → WebGPU → CPU ladder, benchmarked at runtime and demoted if a backend compiles but silently offloads to CPU.
*   **int8 Embeddings:** 512-d vectors stored quantized (512 bytes each, ~5 MB for 10k images) with a scale factor. Ranking is a flat cosine scan of one contiguous buffer — ~10 ms over 10k items, no vector index needed.
*   **File System Access API:** Direct disk I/O for file moves and renames.
*   **IndexedDB Caching:** Instant subsequent loads for thousands of images.
*   **Virtual Scrolling & Pagination:** Near-zero lag when browsing massive collections, with lazy-loaded thumbnails.
*   **CRC32 Binary Injection:** Patches PNG chunks without re-encoding pixel data.
*   **Container Walkers:** Hand-rolled ISOBMFF (MP4/MOV) and EBML (WebM/MKV) readers that slice only the metadata boxes, so a 200MB video costs a few KB of reads.
*   **Staged SHA-256 Hashing:** Size bucket → partial hash → full hash, so duplicate scans stay cheap at scale.

---

## 📄 License
MIT License - Free to use, modify, and distribute for the AI art community.

---

## 🚀 Version History

### [4.6.0] - 2026-07-28
*   **On-device AI search.** Semantic search (`sem:`), visual similarity (`like:`) and face grouping (`face:`), all running locally through WebNN — no cloud, no account, no upload.
*   **People view** for naming and merging face clusters, reachable from the 🧠 panel.
*   **`serve.mjs`** — a zero-dependency localhost launcher, because browsers block WebNN/WebGPU/Workers on `file://`. **`fetch-models.mjs`** downloads the models once.
*   **`ai-check.html`** reports whether your machine and browser can actually run it.
*   The app is still **one HTML file** and still works by double-click, with AI disabled and explaining why.

### [4.5.0] - 2026-07-26
- **Video Metadata**: MP4/MOV/WebM/MKV metadata is now read from the container and parsed — prompts, model, seed, steps, CFG, sampler and LoRAs, plus true resolution from `tkhd`/`PixelWidth`. Supports ComfyUI/VHS node graphs and flat settings dicts (WanGP). Files are sliced, never buffered.
- **JSON Viewer Opens on Video**: Replaced the "Videos carry no embedded workflow" message with the real workflow viewer, node outline included.
- **Animated PNG / WebP**: ComfyUI `SaveAnimatedPNG` (`comf` chunks) and `SaveAnimatedWEBP` (EXIF tags) metadata now extracted.
- **Fixed — prompts were wrong on images too**: The negative prompt duplicated the positive one on many workflows. Three causes: output slot indices were ignored when following conditioning links, `inputs.text` was collected twice, and `ConditioningZeroOut` (how Flux/Chroma graphs make an empty negative) echoed the positive prompt back. Negatives now read correctly — an empty negative on a Flux workflow is the right answer.
- **Fixed — Seed and Model on images**: Seed showed a raw node reference (`["182",0]`) when it came from a Seed/Primitive node, and Model was blank whenever the model port ran through a switch or reroute node. Both now resolve; all bundled samples report real values.
- **Cached videos upgrade in place** via a metadata version stamp, without discarding the image cache.

### [4.4.0] - 2026-07-26
- **Advanced Search**: The search box now parses a real query language — AND/OR/NOT, `-exclusions`, `"phrases"`, `( )` grouping, and `field:value` terms across name, path, prompts, model, sampler, seed, steps, cfg, size, and LoRAs.
- **Search Builder**: A ⚙ panel composes *All / Any / None* terms plus a field selector into that syntax, with a live query preview; the box also gained an ✕ clear button.
- **Model Filter & Toolbar Sorting**: Filter by checkpoint (with per-model counts) from the toolbar, and sort from the toolbar with an asc/desc toggle and a new **Model** key, kept in sync with the list-view headers.
- **Themed Scrollbars**: Tree, main view, inspector, and JSON viewer scrollbars now follow the active theme.
- **Fixed**: Sticky list/duplicate toolbars no longer sit 20px down with images scrolling through the gap above them; list header columns now line up with their rows; the search box lost phantom icon padding and gained a minimum width; the ⭐ favorites filter is now respected while searching; search input is debounced.
- **Still unsupported**: Video metadata extraction — see `docs/VIDEO-METADATA.md` (local-only) for findings and a proposal.

### [4.3.0] - 2026-07-26 (ChromeEdge-only fork)
- **Duplicate Detection Rebuilt**: Replaced the old pairs-only 50KB hash with a 3-stage (size → partial hash → full SHA-256) scanner that finds true n-way groups, plus a full review UI with keep/delete selection and auto-select modes.
- **Pagination & Lazy Thumbnails**: Added a page-size selector and IntersectionObserver-based lazy loading so libraries of 10,000+ images render in milliseconds instead of wedging the browser.
- **JSON / Workflow Viewer**: New dialog for inspecting a file's raw ComfyUI `prompt`/`workflow` chunks or A1111 `parameters`, with syntax highlighting, a clickable node outline, and in-place search.
- **More Formats**: Added `gif`, `mov`, `mkv` support; undecodable video containers now show a labelled fallback tile instead of a blank thumbnail.
- **Fix & Save Safety Guards**: Videos and unrecognised files are rejected before any write; animated GIF/WebP now prompt before flattening to a single frame.
- **Fixed**: Empty file list on first open (library in subfolders rendered nothing), wrong image resolution display (now read from the file header, not workflow-claimed latent size), and "Fix & Save" silently hanging on video files.
- **Removed**: Firefox Edition — this fork is Chrome/Edge only going forward.

### [4.2.1] - 2025-12-24
- **US Date Format**: Switched to `MM/DD/YYYY` localization.
- **List Alignment**: Fixed "Header Shift" bug when thumbnails are off.
- **First-Seen Engine**: Cached initial scan dates to separate "Created" from "Modified".

### [4.2.0] - 2025-12-24
- **Direct Overwrite**: "Fix & Save" now overwrites original files in Chrome/Edge.
- **Multi-Selection**: Added `Shift+Click` and `Ctrl+Click` support.
- **Bulk Drag & Drop**: Move selected files in groups.
- **On-Disk Renaming**: Added rename feature to the metadata panel.
- **LoRA Un-baking**: Auto-import baked resources into editable tags.
- **Dual-Engine Export**: High-fidelity Save Picker for Chromium; Binary-masking for Firefox.
- **Ergonomic Layout**: LoRA Manager moved below Negative Prompt.

### [4.1.0] - 2025-12-21
- **Thumbnail Scaling**: Reworked math for 3x larger previews.
- **Grid/List Toggle**: Dedicated button for instant layout switching.
- **Thumbnail Toggle**: Status indicator (Green/Red) for visibility.
- **Light Mode Audit**: High-contrast variables for Daylight Mode.

### [4.0.0] - 2025-12-22
- **Advanced Memory Management**: URL Lifecycle Management to prevent leaks.
- **EXIF Engine**: Enhanced support for UNICODE and Civitai standards.
- **Duplicate Finder**: Ultra-fast hashing (first 50KB).

---
**Made with ❤️ for the AI art community**


