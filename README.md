# Telescope Picker

A standalone desktop VS Code extension with a **native fuzzy file popup**.
Selecting a result previews the file **where your code is already open**, in
the original editor group. There is no bottom preview panel or picker webview.

## Try it

Requires desktop VS Code 1.95 or newer.

1. Install `telescope-picker-0.3.0.vsix` using **Extensions: Install from VSIX**.
2. Run **Developer: Reload Window** when updating an already-running version.
3. Open a folder or multi-root workspace.
4. Press **Ctrl+Alt+P** (**Cmd+Alt+P** on macOS), or run
   **Telescope Picker: Find Files**.

The native popup keeps input focus while the selected file appears in the
current code editor behind it. Native VS Code syntax highlighting, language
support, encoding, and unsaved document contents apply.

| Key / action | Behavior |
| --- | --- |
| Type | Fuzzy-match filenames and relative paths |
| Up / Down | Select and preview files in the original editor group |
| Enter | Keep the selected file open as a normal, non-preview tab |
| Ctrl+Enter (Windows/Linux), Cmd+Enter (macOS) | Restore the original file on the left and open the selection beside |
| Per-result split icon | Open that file beside |
| Escape | Close the popup, remove temporary previews, and restore the original file, selections, visible range, and editor focus |
| Ctrl+J / Ctrl+K | Navigate if `telescopePicker.vimNavigation` is enabled |

The original document is never edited, saved, or reverted by the extension.
Dirty documents, existing tabs, and displaced background previews are preserved.
An original unpinned preview is reopened as a preview on cancel, even if VS Code
closed its document while replacing the tab. Preview uses normal editor
tabs temporarily, unlike the earlier webview implementation. Temporary tabs
created by the picker are cleaned on cancel; files you modify or pin are kept.
If native preview tabs are disabled in your settings, extension-created clean
tabs are still tracked and cleaned rather than accumulating.

Previews are normal VS Code editors, not artificially read-only documents. The
popup keeps keyboard focus, but you can deliberately click the editor to edit.
Such edits are preserved. Enter commits the file choice, not document changes.
If no text editor was open, cancel closes the picker-created preview tabs and
returns focus to the editor group. Other existing editor tabs are not closed.

**Telescope Picker: Resume Picker** restores the last query and selected URI.
State is saved per workspace on close or acceptance. Opening an already-open
picker reuses it. Native Quick Pick supplies accessibility, matching highlights,
themes, fonts, and final result ordering. The extension pre-ranks up to 200
candidates with fuzzysort. Remap shortcuts if another extension conflicts.

## Discovery and preview behavior

- Discovery uses public `workspace.findFiles` APIs for each workspace root.
  **`files.exclude` applies; `search.exclude`, `.gitignore`, and `.ignore` are
  not additionally applied.** Add build/dependency directories to `files.exclude`
  if they should not appear.
- Root descriptions distinguish duplicate filenames. Equal root names include
  their URI, and overlapping roots are deduplicated by URI. The cached index is
  invalidated on file creation/deletion, root changes, or `files.exclude` changes.
- The index is capped at 100,000 unique paths and the popup receives at most 200
  ranked candidates. The title discloses truncation and total match counts.
  Queries over 1,024 characters show an explicit error.
- Loading, no matches, discovery errors, preview errors, and opening failures are
  explicit. Details are logged in **Output: Telescope Picker**. Status rows do
  not open files.
- Automatic preview waits 35 ms to coalesce rapid navigation. Files already
  loaded by VS Code use their live contents. Other resources are checked with
  `workspace.fs.stat`; files over **1 MiB** are not automatically loaded.
  Press Enter to explicitly open an oversized file.
- Native document/editor APIs handle encoding and binary/unsupported-resource
  errors. An unsuccessful automatic preview leaves the prior editor intact and
  reports the error in the popup title. No custom truncated/plain-text preview
  or separate syntax-highlighting dependency remains.
- Document/editor opens cannot be cancelled by the public API. Generation checks
  discard obsolete document loads, and editor changes are serialized so cancel
  restores the original file **after** an in-flight preview open completes.
  A new picker waits for that restoration before capturing its original editor.
- Selection ranges and the viewport's center line are restored using public editor
  APIs. Tests allow one line of rounding; VS Code does not expose pixel-exact
  viewport offsets.
- No private DOM, internal services, executable discovery, webview content,
  telemetry, code execution, automatic writes, or global setting changes are used.

Restricted workspaces and desktop URI-based remote workspaces are supported by
design. SSH, WSL, containers, macOS, Linux, and real screen-reader workflows need
additional manual qualification. Browser-hosted VS Code is not supported.

## Develop and validate

Use Node.js 22.16 or newer. Open this directory as its own VS Code workspace.

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:host
npm run benchmark
npm run package
```

Press F5 for an Extension Development Host. `npm run watch` rebuilds while
developing. The local VSIX publisher is `local`; choose a real publisher and
repository before Marketplace publication.

Unit tests cover relevance, discovery/cache, request generations, the native
popup, editor-preview cancellation/races, dirty documents, pinned/existing tabs,
preview-disabled settings, restoration, acceptance, and splitting.
Extension-host tests run on VS Code **1.95.3** against an isolated two-root
workspace and exercise actual preview switching, dirty contents, original
selections/scroll restoration, temporary-tab cleanup, Enter pinning, resume,
and opening beside. Set `VSCODE_TEST_VERSION` or `VSCODE_EXECUTABLE_PATH` to
test another desktop build.

If npm 10.9.2 crashes resolving Vitest optional peers with an `edgesOut` error,
use `npx --yes npm@11 ci` instead of upgrading global npm.

### Performance baseline

The ranking benchmark uses 50,000 synthetic C++ paths over 250 directories and
100 warm queries. On Windows x64, AMD Ryzen 7 7700X, 63 GiB reported RAM,
Node 22.16.0, the v0.2 baseline was approximately **18 ms p50 / 29 ms p95**.
It verifies the 200-result limit and fails above 50 ms ranking p95.
Immutable fuzzysort snapshots avoid per-candidate custom scoring costs.

These figures exclude native popup rendering, IPC, discovery, document loading,
and editor activation. Opening within 150 ms and end-to-end visible updates
within 50 ms remain acceptance targets, not verified promises.

## Boundaries and next work

- `src/controller.ts`: native popup lifecycle, query, navigation, resume, acceptance.
- `src/editorPreview.ts`: serialized native previews, tab ownership and restoration.
- `src/files.ts`: URI discovery and cache invalidation.
- `src/ranking.ts`: maintained matcher and candidate limits.
- `src/latest.ts` / `src/types.ts`: request generations and result shapes.

Live grep, open-editor/recent-file providers, symbols, Git operations, and
plugins are not implemented. Validate this native popup/current-editor workflow
before adding providers. For grep, verify stable public search APIs before
choosing a packaged ripgrep backend.
