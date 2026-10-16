# Telescope Pick

A standalone desktop VS Code extension with a **native popup for fuzzy filenames
and fast text search**.
Selecting a result previews the file **where your code is already open**, in
the original editor group. There is no bottom preview panel or picker webview.

## Try it

Requires desktop VS Code 1.108 or newer for native file-icon theme support.

1. Install the platform-matching VSIX (for example `jules-telescope-picker-win32-x64-0.11.6.vsix`)
   using **Extensions: Install from VSIX**.
2. Run **Developer: Reload Window** when updating an already-running version.
3. Open a folder or multi-root workspace.
4. Press **Ctrl+Alt+P** (**Cmd+Alt+P** on macOS), or run
   **Telescope Picker: Find Files**.
5. To search **inside files**, press **Ctrl+Alt+F** (**Cmd+Alt+F** on macOS),
   run **Telescope Picker: Search File Contents**,
   or use the popup's search icon to switch modes. The files icon switches back.
6. To search only the active editor, press **Ctrl+Alt+L** (**Cmd+Alt+L** on macOS)
   or run **Telescope Picker: Search Current File**. The popup's current-file
   button switches to the document that was active when the picker opened.

**Current-file mode** searches literal text without case sensitivity using the
live document, including unsaved edits, untitled files, and files outside a
workspace. It shows all matching lines with native file icons and source
locations. Selection previews the exact line; Enter, split, and Escape behave
like workspace content search. The target remains fixed while navigating, and
Resume Picker restores the target URI, query and selection (unsaved contents
must still exist in the editor). Workspace include/exclude/ignore settings do
not restrict this explicitly chosen file. Editing the target refreshes results;
chat and other documents do not. An open text editor is required.
Current-file matches follow ascending source line order, not relevance ranking.
Each row uses the same file label with its line number and code excerpt alongside
it, preventing native Quick Pick label ranking from reordering the matches.
Search File Contents uses the same ascending line order when all results belong
to a single file. Multi-file searches retain their existing native ranking.

## Browse Git changes

Run **Telescope Picker: Browse Git Changes**, use its Git compare button in the
picker, or click the Git changes icon in Git's Source Control title bar.
Assign your preferred shortcut through **Telescope Picker: Configure Keyboard
Shortcuts**; this command does not claim another default key combination.
The command ID remains `telescopePicker.searchGitDiffs` for existing keybindings.

**All diff hunks appear immediately; no query is required.** Use Up/Down to
navigate changed sections, grouped by repository, change type, and file.
Each row shows the Git hunk range, added/removed line counts, and a short code
excerpt. Nearby edits share a hunk using Git's normal three context lines.
Untracked text files appear as one whole-file addition. Pure renames, binary
changes, empty files, and other metadata-only changes still have a navigation
row even without text hunks. There is no 200-hunk limit.

Optionally type to filter by filename/path or literal, case-insensitive text in
changed lines. Clearing the input restores the full list. Invoking Browse Git
Changes afresh clears a prior filter; Resume Picker retains it and the selected
hunk.

- **Staged:** compares HEAD to the index, including new repositories without HEAD.
- **Unstaged:** compares the index to the saved working-tree file.
- **Untracked:** treats the file's live text as added lines.
- **Conflicts:** compares the merge-base index stage (`:1`) to the saved working
  file, including conflict markers. Add/add conflicts without a base treat the
  working file as added text. The extension does not resolve conflicts.

Selection immediately previews **VS Code's native diff editor** at the changed
section while keyboard focus stays in the picker. Moving between hunks in one
file reuses its diff tab. **Enter** keeps the diff open as a normal pinned tab;
**Ctrl/Cmd+Enter** opens it beside.
Staged diffs show HEAD versus index, never the unstaged working tree. Additions
and deletions use an empty side where needed. A deletion opens near its hunk on
the modified side. Escape restores the previous editor, including an existing
native diff tab. VS Code's existing Git and merge tools handle staging,
discarding, and conflict resolution; the picker never changes Git state.

This uses the built-in **vscode.git API v1** for repositories, status updates,
Git executable location, and historical document URIs. Git must be installed and
the built-in extension enabled. Every repository registered with Source Control
is listed, including multiple roots; repository/status changes refresh the
active list. Folder filters for filename/workspace-content search do not
filter Git results. Git's tracked/untracked status determines eligibility.

Tracked-file patches use **saved Git changes**. Save edits first to include
them; a dirty editor that no longer matches a result is explicitly rejected
rather than opening a wrong line. Untracked live documents include unsaved edits.
Binary changes are listed without text hunks and left to VS Code's native viewer.
Git textconv and external diff
programs are disabled. Git output and newly loaded untracked file text are bounded
to 64 MiB per file; exceeding this is an explicit error, not silent truncation.
Obsolete requests stop their child Git process and cannot publish stale results.
Read/Git failures appear in the popup and Output; no-repository and clean-tree
states are explicit.

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

### Configure your shortcuts

Run **Telescope Picker: Configure Keyboard Shortcuts** to open VS Code's shortcut
editor filtered to this extension. Change **Find Files**, **Search File Contents**, or **Search Current File**
to your preferred keys; use **Change Keybinding** or **Remove Keybinding** to
replace or disable a default. These are overridable defaults, not runtime-hardcoded
keys. Changes take effect immediately without rebuilding or reloading.

For text configuration, run **Preferences: Open Keyboard Shortcuts (JSON)**.
Add entries to the existing array in your user `keybindings.json`, for example:

```jsonc
[
  { "key": "ctrl+alt+p", "command": "-telescopePicker.files", "when": "!terminalFocus" },
  { "key": "ctrl+alt+f", "command": "-telescopePicker.searchContents", "when": "!terminalFocus" },
  { "key": "ctrl+shift+o", "command": "telescopePicker.files", "when": "!terminalFocus" },
  { "key": "ctrl+shift+g", "command": "telescopePicker.searchContents", "when": "!terminalFocus" }
]
```

The example keys may override other VS Code commands; choose unused keys or
inspect conflicts in the shortcut editor. On macOS, remove the `cmd+alt+p` and
`cmd+alt+f` defaults instead, and use `cmd` in your custom bindings if preferred.
Use `keybindings.json`, not `settings.json`, for key strings: VS Code's stable
extension API does not dynamically register arbitrary shortcuts from settings.
This also preserves native support for chords, `when` clauses, conflict
resolution, profiles, and Settings Sync.

### Include and exclude folders

Configure **Telescope Picker: Include** and **Telescope Picker: Exclude** in VS Code
Settings, or add this to your workspace settings:

```jsonc
{
  "telescopePicker.include": ["src", "include"],
  "telescopePicker.exclude": ["src/generated", "**/node_modules/**", "out"]
}
```

Both settings apply to **Find Files and Search File Contents**, including dirty
open documents, and refresh an open picker when changed. An empty include list
means all eligible files; exclusions always win. Paths are relative to each
workspace root. A folder includes/excludes its descendants; glob examples include
`**/*.cpp`, `**/*.cppm`, and `**/generated/**`. Use forward slashes in globs
(Windows backslashes in folder paths are also normalized). Absolute paths, parent
traversal, empty entries and negated patterns are rejected with an explicit error.
Use the exclude list rather than `!` patterns.

Multi-root workspaces can override these resource-scoped settings per folder.
These filters narrow existing discovery rules; they do not re-include files
hidden by `files.exclude`, or by content search's ignore/exclusion settings.
Content exclusions prune ripgrep traversal; includes are checked on results to
avoid overriding ignore files. Filename discovery still respects `files.exclude`;
custom filters are applied before the 100,000-file index limit, which can require
enumerating more files when custom filters are enabled.

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
text results include all matching lines; the native popup applies its query ranking.
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
Changing the content query resets selection and scrolling to the first match.
Later batches of the same search preserve your navigation and scroll position;
Resume Picker still restores the previous selection.
While results stream in, the first ordered match stays selected until you
navigate. Unchanged result batches do not rebuild or reselect the list.
For a fresh content query, VS Code chooses the first visible match using its
native query ranking; previews follow that active row rather than forcing the
first path-sorted backend result.
Document updates outside workspace folders (such as chat inputs), and
metadata-only document events, do not restart content searches.
Arrow keys and optional
Ctrl+J/K navigation skip headings; Enter, split, Escape, and resume still act on
matching lines. Content search has no result-count cap; all matching lines are available.
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
  retains and displays all matching lines. Very broad queries use more memory
  and can take longer to render, filter, and update than narrower queries.
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
- The **filename** index is capped at 100,000 unique paths, but the popup receives
  every matching indexed file, including all indexed files for an empty query.
  There is no 200-result limit in either mode. The title discloses the index limit
  if reached. Broad queries can cost more memory and rendering time.
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
OS/architecture. Separate native VSIX builds cover these targets:

| Extension host | Intel/AMD x64 | ARM64 |
| --- | --- | --- |
| Windows | `win32-x64` | `win32-arm64` |
| macOS | `darwin-x64` | `darwin-arm64` |
| Linux (glibc) | `linux-x64` | `linux-arm64` |

For SSH, WSL, and containers, choose the **remote extension host's** OS and
architecture, not the local desktop's, and install in that remote environment.
Alpine/musl Linux, 32-bit hosts, and browser-hosted VS Code are not supported
package targets. Non-filesystem content-search limitations apply above.
SSH, WSL, containers, and real screen-reader workflows still need manual
qualification. Windows has been tested locally; macOS/Linux qualification
depends on successful native CI runs, not just producing a VSIX.

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
developing. The publisher is `jules`, so the extension ID is
`jules.jules-telescope-picker`. Publishing requires access to that Marketplace publisher.
When switching from earlier `local.telescope-picker` builds, uninstall the local
extension before installing this one to avoid duplicate command registrations.

The original extension logo lives in `media/icon.svg`; VS Code uses the
256 x 256 PNG in `media/icon.png`. After editing the vector source, run
`npm run generate:icon` to regenerate the packaged icon on any supported desktop
development platform.

### Cross-platform packages

The **Test and package desktop platforms** GitHub Actions workflow builds all six
targets on matching native runners. Each job runs type checking, unit tests
(including the real ripgrep backend), VS Code extension-host tests, and packaging.
Linux extension-host tests use Xvfb. Download the separate VSIX artifacts from a
successful workflow run; no Marketplace publication or GitHub release is automatic.
Hosted ARM runners require a repository/account eligible for those GitHub runners.

Locally, `npm ci` and `npm run package` build the current host's target and
check that its bundled ripgrep executable runs. Packages are saved under
`releases/<version>/`.

Run `npm run package:all` to cross-package all six targets into that same version
folder, along with `SHA256SUMS.txt`. This requires npm, Node, and `tar` on PATH.
The script builds the portable JavaScript once, downloads each official ripgrep
binary at the installed loader's exact version, and packages an isolated runtime
with only that target's binary. It checks executable formats, but cannot run
foreign binaries: cross-packaging is not a substitute for native CI tests.
No publishing, commits, or GitHub uploads happen automatically.

Unit tests cover relevance, discovery/cache, request generations, the native
popup, editor-preview cancellation/races, dirty documents, pinned/existing tabs,
preview-disabled settings, restoration, acceptance, and splitting. Content tests
exercise the actual packaged backend, cancellation, literal/Unicode matching,
uncapped searches beyond 32 MiB and 100,000 lines, binary/encoding handling,
ignore/exclude/sibling rules, overlapping roots, live text, progress,
invalidation, mode switching, resume, match highlights, and exact-line opening.
Icon/group tests verify native resource URIs and theme-icon references in both
modes, heading isolation, multi-root groups, keyboard navigation, escaped labels,
and complete result rendering beyond 200 matches independently of headings.
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
It verifies that every filename match is returned and fails above the 50 ms
ranking p95 target. The historical v0.2 figures above used a 200-result limit
and are not an unlimited-result performance measurement.
With unlimited filename results on the same machine, a 100-query run over
50,000 paths measured approximately **59 ms p50 / 178 ms p95** (Node 22.16.0).
This exceeds the 50 ms target, so the benchmark currently exits unsuccessfully
for unlimited results. Popup rendering and IPC add further cost; all results
are returned rather than silently restoring a cap.
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
