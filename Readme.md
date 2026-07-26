# History Guru 🧘‍♂️ v4.4.0 (ChromeEdge Edition)

> **The 100% Offline, Single-File File Manager & Metadata Viewer for AI Images.**

**History Guru** has evolved into a precision instrument for AI creators. It is no longer just a viewer—it is a full-fledged **Local File Manager** and **Metadata Editor** for your ComfyUI and A1111 output folders. 

Organize, sort, move, rename, and "un-bake" your AI generations without ever leaving the metadata view. It runs entirely in your browser using the modern *File System Access API*. This fork targets **Chrome / Edge only** — the Firefox edition has been retired in favor of focusing on the full file-management feature set that only the File System Access API can provide.

---

## ✨ Core Feature Set

### 📂 Pro-Grade File Management (Chrome/Edge Only)
*   **True File Operations:** Create folders, rename files on disk, and move files between directories directly from the UI.
*   **Multi-Select Engine:** Full Windows-style `Shift+Click` (range) and `Ctrl+Click` (toggle) selection.
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

### 🎬 Expanded Format Support
*   Added **GIF**, **MOV**, and **MKV** alongside PNG/JPEG/WebP and MP4/WebM. Unplayable video containers fall back to a labelled placeholder tile instead of a blank thumbnail.
*   **Safer "Fix & Save":** Animated GIF/WebP now prompt before flattening to a single frame, and non-image files are rejected before anything is written.
*   **Video metadata — not yet supported:** Videos are listed, played, and managed, but their metadata is not parsed — no prompts, workflow, or true resolution, just a `Video` placeholder and the file size. Sample ComfyUI video files are needed before this can be built and verified.

---

## 🚀 How to Use

### 🟢 Chrome / Edge / Opera
*Best for: Managing files, bulk organizing, and direct disk editing.*

1.  **Open** `Guru Manager ChromeEdge Edition.html` in your browser.
2.  **Grant Permission:** Click **"Open Folder"** and select your directory. When the browser asks, click **"Edit"** or **"Allow"** to enable file management features.
3.  **Organize:** Use the sidebar to create folders. Use `Shift+Click` to select groups and drag them into new locations.
4.  **Edit:** Click any image to open the Inspector. Edit prompts or LoRAs and hit **"Fix & Save"** to overwrite the file on disk.

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
*   **File System Access API:** Direct disk I/O for file moves and renames.
*   **IndexedDB Caching:** Instant subsequent loads for thousands of images.
*   **Virtual Scrolling & Pagination:** Near-zero lag when browsing massive collections, with lazy-loaded thumbnails.
*   **CRC32 Binary Injection:** Patches PNG chunks without re-encoding pixel data.
*   **Staged SHA-256 Hashing:** Size bucket → partial hash → full hash, so duplicate scans stay cheap at scale.

---

## 📄 License
MIT License - Free to use, modify, and distribute for the AI art community.

---

## 🚀 Version History

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


