# Telescope Picker

A standalone desktop VS Code extension with a **native popup for fuzzy filenames
and fast text search**.
Selecting a result previews the file **where your code is already open**, in
the original editor group. There is no bottom preview panel or picker webview.

## Try it

Requires desktop VS Code 1.108 or newer for native file-icon theme support.

1. Install the platform-matching VSIX (for example `telescope-picker-win32-x64-0.8.0.vsix`)
   using **Extensions: Install from VSIX**.
2. Run **Developer: Reload Window** when updating an already-running version.
3. Open a folder or multi-root workspace.
4. Press **Ctrl+Alt+P** (**Cmd+Alt+P** on macOS), or run
   **Telescope Picker: Find Files**.
5. To search **inside files**, run **Telescope Picker: Search File Contents**,
   or use the popup's search icon to switch modes. The files icon switches back.

The native popup keeps input focus while the selected file appears in the
current code editor behind it. Native VS Code syntax highlighting, language
support, encoding, and unsaved document contents apply.

| Key / action | Behavior |
| --- | --- |
| Type | Fuzzy-match filenames/paths, or search literal text in content mode |
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

Files over 1 MiB that are not already open skip automatic preview and show
the compact title **Large file · Enter to open**. Enter can still open them.
Other preview/open failures use short status titles; full details are logged
to **Telescope Picker** in Output rather than expanding the popup.

Previews are normal VS Code editors, not artificially read-only documents. The
popup keeps keyboard focus, but you can deliberately click the editor to edit.
Such edits are preserved. Enter commits the file choice, not document changes.
If no text editor was open, cancel closes the picker-created preview tabs and
returns focus to the editor group. Other existing editor tabs are not closed.

**Telescope Picker: Resume Picker** restores the last mode, query, and selected file/line.
State is saved per workspace on close or acceptance. Opening an already-open
picker reuses it. Native Quick Pick supplies accessibility, matching highlights,
themes, fonts, and final result ordering. Fuzzysort pre-ranks filename results;
text results are ordered by path and line, with up to 200 candidates displayed.
Remap shortcuts if another extension conflicts.

## File icons and grouped results

Filename results use your **currently active file-icon theme**, resolved by
VS Code itself through the stable `QuickPickItem.resourceUri` and `ThemeIcon.File`
APIs. This works with image- and font-based themes, including Material Icon Theme,
Vira, and built-in Seti. Theme switching follows the native renderer rather than
a cached copy of the `workbench.iconTheme` setting. No theme definitions are
parsed, icons/fonts copied, or theme settings changed by the extension.

Content matches are grouped by file URI under **non-selectable file headings**
showing the relative path, workspace root, and visible match count.
Matching rows show the active theme's file icon and code excerpt, with
`relative/path:line · workspace root` beside each match, so its source remains
visible even when the file heading has scrolled out of view.
Arrow keys and optional
Ctrl+J/K navigation skip headings; Enter, split, Escape, and resume still act on
matching lines. The 200-result cap counts matches, not file headings.
Identical paths in different workspace roots remain separate groups.

Non-selectable separators cannot display resource icons, so themed icons appear
on matching rows, not the headings. Missing icons and resources use VS Code's own
theme resolution and fallback behavior; there is no bundled replacement icon set.
Native resource icon support became stable in VS Code 1.108, which is why 0.8.0
raises the minimum supported version. No custom DOM or private services are used.

## Fast text search inside files

Starting in **0.5.0**, content search uses **literal, case-insensitive text**
instead of fuzzy subsequences. For example, `fuzzyNeedle` finds `FUZZYNEEDLE`,
but `fzndl` does not. Filename search remains fuzzy. File headings show paths and
workspace roots; matching rows show code excerpts and line numbers. Selection reveals the matching line in the
current editor and highlights its matched characters using theme colors.
Enter and opening beside both navigate to that exact line. Highlights are
removed when changing selection/query or closing/accepting the picker.

- Type a nonempty query to begin. Queries are debounced by 80 ms; obsolete
  searches and their packaged backend processes are cancelled.
- The query is passed directly to **explicitly packaged ripgrep**, which searches
  workspace directories and streams **only matching lines**, rather than sending
  every line to the extension host. No `workspace.findFiles` discovery is needed
  before text search. There is no total content-byte/line/file cap; the popup
  retains the first 200 lines in path/line order and displays the full matching-line
  count. Very broad queries can still take longer.
- Dirty documents use their live, decoded contents instead of stale disk matches.
  Their ignore-file eligibility is cached and refreshed on filesystem/settings
  changes. This does not invoke VS Code's bundled executable,
  private APIs, shell commands, workspace code, or an external service. The
  extension uses its packaged backend rather than private services or proposed search APIs.
- Like native search, content mode respects `files.exclude`, `search.exclude`,
  `.gitignore`, and `.ignore`, including sibling-dependent `when` exclusions.
  `search.exclude` overrides matching `files.exclude` entries. It also honors
  `search.useIgnoreFiles`, `search.useGlobalIgnoreFiles`,
  `search.useParentIgnoreFiles`, and `search.followSymlinks`. Hidden files are
  eligible unless excluded/ignored. Ripgrep configuration files are disabled.
  **This is intentionally different from filename discovery**, described below.
- Binary files are skipped by ripgrep. Reported binary/unsupported-encoding
  matches are discarded; reported counts are shown in the title and encoding
  details in **Output: Telescope Picker**, not an exhaustive count of ignored files.
  UTF-8 and BOM-detected UTF-16 are supported. Dirty text already decoded by VS
  Code can use other encodings. Unopened non-filesystem URI resources are
  explicitly reported as unsupported; their open text documents can still be searched.
- File/document changes refresh the active content query. A result whose line
  changed before preview/open is rejected with an explicit refresh error rather
  than navigating to stale coordinates. Read/discovery/backend failures show an
  error instead of claiming a complete scan.
- The existing **1 MiB automatic preview limit** still applies to unopened files,
  not content scanning. Press Enter to explicitly open larger matches.
- Regex punctuation and spaces are literal; every occurrence on a matching line
  is highlighted. Multiline/NUL queries are rejected explicitly. This popup does
  not implement regex, replace, whole-word, or case-sensitive controls; use VS
  Code's Find in Files for those workflows.
  The command also accepts an optional initial query string
  when invoked programmatically.

## Discovery and preview behavior

- **Filename discovery** uses public `workspace.findFiles` APIs for each workspace root.
  **`files.exclude` applies; `search.exclude`, `.gitignore`, and `.ignore` are
  not additionally applied.** Add build/dependency directories to `files.exclude`
  if they should not appear.
- Root descriptions distinguish duplicate filenames. Equal root names include
  their URI, and overlapping roots are deduplicated by URI. The cached index is
  invalidated on file creation/deletion, root changes, or `files.exclude` changes.
- The **filename** index is capped at 100,000 unique paths and the popup receives at most 200
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
  telemetry, workspace-code execution, automatic writes, or global setting changes are used.

Restricted workspaces and desktop URI-based remote workspaces are supported by
design. Content search requires the packaged binary to match the extension host's
OS/architecture. VSIX packages target the machine running `npm run package`; build
on the matching host for SSH/WSL/container installations, rather than installing
a Windows binary on Linux. Non-filesystem content-search limitations apply above.
SSH, WSL, containers, macOS, Linux, and real screen-reader workflows need
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
preview-disabled settings, restoration, acceptance, and splitting. Content tests
exercise the actual packaged backend, cancellation, literal/Unicode matching,
uncapped searches beyond 32 MiB and 100,000 lines, binary/encoding handling,
ignore/exclude/sibling rules, overlapping roots, live text, progress,
invalidation, mode switching, resume, match highlights, and exact-line opening.
Icon/group tests verify native resource URIs and theme-icon references in both
modes, heading isolation, multi-root groups, keyboard navigation, escaped labels,
and match-count truncation independent of headings.
Extension-host tests run on VS Code **1.108.0** against an isolated two-root
workspace and exercise actual preview switching, dirty contents, original
selections/scroll restoration, temporary-tab cleanup, Enter pinning, resume,
opening beside, literal on-disk/unsaved text search, grouped navigation/resume,
switching between image- and font-based icon themes, and exact matching-line
acceptance. Set `VSCODE_TEST_VERSION` or `VSCODE_EXECUTABLE_PATH` to
test another desktop build.
Set `TELESCOPE_TEST_EXTENSION_PATH` to an installed extension directory to test
the packaged runtime rather than the development bundle.

If npm 10.9.2 crashes resolving Vitest optional peers with an `edgesOut` error,
use `npx --yes npm@11 ci` instead of upgrading global npm.

### Performance baseline

The ranking benchmark uses 50,000 synthetic C++ paths over 250 directories and
100 warm queries. On Windows x64, AMD Ryzen 7 7700X, 63 GiB reported RAM,
Node 22.16.0, the v0.2 baseline was approximately **18 ms p50 / 29 ms p95**.
It verifies the 200-result limit and fails above 50 ms ranking p95.
Immutable fuzzysort snapshots avoid per-candidate custom scoring costs.

The literal-content regression test uses a 34 MiB UTF-8 file, over 100,000
nonmatching lines and 205 matching lines. On the same Windows x64 machine,
five complete provider searches took **76, 47, 47, 51, and 47 ms**, including
process startup and result processing. The test enforces a 500 ms ceiling per
run on this fixture. These are sparse-query measurements, not a guarantee for
every workspace, and exclude input debounce, popup rendering and preview loading.

These figures exclude native popup rendering, IPC, discovery, document loading,
and editor activation. Opening within 150 ms and end-to-end visible updates
within 50 ms remain acceptance targets, not verified promises.

## Boundaries and next work

- `src/controller.ts`: native popup lifecycle, query, navigation, resume, acceptance.
- `src/editorPreview.ts`: serialized native previews, tab ownership and restoration.
- `src/files.ts`: URI discovery and cache invalidation.
- `src/contents.ts`: streaming content search, live documents, progress and cancellation.
- `src/searchScope.ts`: native-style ignore/exclude settings and sibling rules.
- `src/ranking.ts`: maintained matcher and candidate limits.
- `src/latest.ts` / `src/types.ts`: request generations and result shapes.

Regex/replace, open-editor/recent-file providers, symbols, Git operations,
and plugins are not implemented. Literal text search keeps the popup/preview
workflow; it is not a full replacement for VS Code's Find in Files.
