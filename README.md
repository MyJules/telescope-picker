# Telescope Picker

A standalone, desktop VS Code extension prototype: a keyboard-first file picker
with fuzzy results and a read-only, highlighted code preview. The picker lives
in an **editor tab**, not an unsupported floating overlay. This project has no
dependency on the neighboring C++ project.

## Try it

Requires desktop VS Code 1.95 or newer.

1. Install `telescope-picker-0.1.1.vsix` using **Extensions: Install from VSIX**.
2. Open a folder or multi-root workspace.
3. Run **Telescope Picker: Find Files**, or press **Ctrl+Alt+P**
   (**Cmd+Alt+P** on macOS).

| Key | Action |
| --- | --- |
| Type | Fuzzy-match filenames and relative paths |
| Up / Down | Select without moving focus out of the input |
| Page Up / Page Down | Move ten results |
| Enter | Open the selected file in the original editor group |
| Ctrl+Enter / Cmd+Enter | Open beside |
| Escape | Close and restore the previous editor and selection |
| Alt+P | Toggle preview |
| Alt+Up / Alt+Down | Scroll preview without moving input focus |
| Tab | Reach the preview toggle and scrollable code region |

Enable `telescopePicker.vimNavigation` for Ctrl+J / Ctrl+K navigation.
The binding does not replace VS Code's Quick Open. Remap it in Keyboard
Shortcuts if it conflicts with an installed extension.

**Telescope Picker: Resume Picker** restores the last query and selected URI.
State is saved per workspace when the picker closes, including after acceptance.
Invoking Find Files while the picker is open focuses the existing picker.
Click once to select a result; double-click to open it.

At narrow widths, the preview collapses automatically. Toggle it to show a
stacked results/preview layout. Theme colors, editor fonts, focus outlines,
high-contrast borders, reduced-motion preferences, combobox/listbox semantics,
live result counts, and explicit errors are supported. Syntax colors use VS Code
theme color variables, not the editor's TextMate or semantic token engine.
Results and long previews scroll within their panes; the footer reserves its
own space and wraps shortcut hints rather than overlapping file or code text.

## Discovery and preview behavior

- Discovery uses public `workspace.findFiles` APIs, per workspace root, with the
  default exclusion argument. **`files.exclude` applies. `search.exclude`,
  `.gitignore`, and `.ignore` are not additionally applied.** Put additional
  exclusions in `files.exclude`, including dependency/build directories if needed.
- Roots have separate badges; duplicate root names include their URI. Overlapping
  roots are deduplicated by URI. The index is cached and invalidated on file
  creation/deletion, root changes, or `files.exclude` changes.
- The index contains at most 100,000 unique paths. Queries report total matches
  within that index and render at most 200 rows. Both limits are disclosed in
  the status area. No-workspace, loading, no-match, discovery, preview, and open
  failures are explicit; error details also appear in **Output: Telescope Picker**.
- Preview uses unsaved text from already-open documents. Otherwise it reads
  through `workspace.fs`, never opens a text document or editor, and never writes
  files. Since that public API reads whole resources, files over **1 MiB** are
  rejected before reading; a size check also runs after reading.
- Displayed previews are bounded to **128 KiB of UTF-8, 400 lines, and 2,000
  characters per line**. Truncation is indicated. Binary, UTF-16, invalid UTF-8,
  deleted, and unavailable files show an explanation instead of a misleading
  empty preview. Open the file normally to inspect unsupported encodings/sizes.
- highlight.js highlights common languages, CMake, and C++ module extensions;
  unknown languages remain escaped plain text. Match highlights are in the
  result paths. Preview is read-only and scrollable, not an embedded Monaco.
- Preview requests are coalesced over 35 ms. Query and selection generations
  reject stale responses. Closing cancels discovery and preview tokens and
  prevents late work from updating a disposed picker. Some `workspace.fs`
  providers cannot interrupt an in-flight read; its result is still discarded.
- No private DOM, internal services, bundled executable paths, external content,
  telemetry, code execution, or network search backend is used. Restricted
  workspaces are supported because the extension only lists/reads/opens files.

Desktop remote workspaces use URI-based APIs and the workspace extension host.
SSH, WSL, containers, macOS, Linux, and real screen-reader workflows still need
manual qualification. Browser-hosted VS Code is intentionally not supported.

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

Press F5 for an Extension Development Host. `npm run watch` rebuilds bundles
while developing. The VSIX is a local prototype with publisher `local`; choose
a real publisher and repository before Marketplace publication.

`npm test` runs ranking relevance, protocol, cancellation, provider/cache,
bounded-preview, controller/lifecycle, and jsdom keyboard/interaction tests.
`npm run test:host` downloads and tests VS Code **1.95.3** in an isolated profile
against the two-root fixture workspace. Set `VSCODE_TEST_VERSION` to another
release, or `VSCODE_EXECUTABLE_PATH` to a desktop executable. It checks real
exclusions, roots, dirty documents, no preview-tab clutter, panel reuse,
close/focus restoration, and resume.

`npm run preview` serves the actual HTML/CSS/webview with a **50,000-file mock**
and a 400-line preview to exercise scrolling and footer containment
at `http://127.0.0.1:4173`. It is a visual/keyboard harness, not a web extension.
It does not open real files or test VS Code editor focus. Stop it with Ctrl+C.

If npm 10.9.2 fails resolving Vitest's optional peers with an `edgesOut` error,
use `npx --yes npm@11 ci`. No global npm upgrade is required.

### Performance baseline

Measured on Windows x64, AMD Ryzen 7 7700X, 63 GiB reported RAM,
Node 22.16.0, using 50,000 synthetic C++ paths spread over 250 directories.
The benchmark warms five different queries, then measures 100 ranking calls:
approximately **13.5 ms p50 / 22.2 ms p95 / 29 ms max** in the final validation run.
It checks the 200-row output limit and fails if ranking p95 exceeds 50 ms.
The relevance tests cover basename preference, path abbreviations, CMake,
case-insensitive queries, highlighted character positions, and duplicate roots.
The maintained `fuzzysort` matcher uses cached immutable snapshots and native
scoring; avoiding a per-candidate custom score callback materially reduced latency.

These numbers cover **host ranking only**, not IPC, discovery, webview rendering,
or time to focus. Warm opening within 150 ms and end-to-end visible query updates
within 50 ms remain acceptance targets, **not verified promises**.
Browser mock checks validate input focus, selection, preview rendering, and the
480 px collapse/toggle layout, but are not substitutes for extension-host or
real assistive-technology testing.

## Boundaries and next work

- `src/controller.ts`: lifecycle, selection, focus, resume, cancellation.
- `src/files.ts`: URI-based discovery and cache invalidation.
- `src/ranking.ts`: maintained fuzzy matcher, limits, highlight positions.
- `src/preview.ts`: bounded resource loading and escaped syntax highlighting.
- `src/protocol.ts`: validated, typed host/UI messages.
- `src/webview/`: DOM rendering, keyboard controls, accessibility.

This is the file-picking deliverable, not the entire roadmap. Live grep,
open-editor/recent-file providers, symbols, Git operations, and plugins are not
implemented. Resume was included early because it also validates lifecycle state.
Before adding search infrastructure, assess the editor-tab interaction in a real
workspace. Then measure end-to-end timings, expand platform/accessibility tests,
and validate stable public text-search APIs before choosing a packaged ripgrep
backend. No grep backend or undocumented executable discovery is present.
