# Changelog - Guru Manager

All notable changes to the Guru Manager project will be documented in this file.

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
