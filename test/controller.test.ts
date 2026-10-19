import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { createContentMatcher } from '../src/ranking';
import { GitChangesProvider } from '../src/gitChanges';
import { FileRanking } from '../src/fileRanking';
import { commands, configurationChanged, createDocument, documentChanged, fileCreated, MockQuickPick, resetEditors, settings, window, workspace, Uri } from './vscode';

class State implements vscode.Memento {
  readonly saved: unknown[] = [];
  keys(): readonly string[] { return []; }
  get<T>(_key: string): T | undefined;
  get<T>(_key: string, defaultValue: T): T;
  get<T>(_key: string, defaultValue?: T): T | undefined { return defaultValue; }
  async update(_key: string, value: unknown): Promise<void> { this.saved.push(value); }
}
let controller: PickerController;
let picker: MockQuickPick;
let state: State;
let original: vscode.TextEditor;
const log = vi.fn();
const contentItems = () => picker.items.filter(item => item.id);
const waitResults = async (): Promise<void> => {
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  await vi.waitFor(() => expect(picker.items[0]?.id).toBe('file:///workspace/src/main.cpp'));
};

beforeEach(async () => {
  resetEditors();
  workspace.workspaceFolders = [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }];
  workspace.findFiles.mockResolvedValue([
    Uri.parse('file:///workspace/src/main.cpp'), Uri.parse('file:///workspace/src/other.cpp')
  ]);
  workspace.fs.stat.mockResolvedValue({ size: 20 });
  const document = createDocument(vscode.Uri.parse('file:///workspace/original.ts'), true);
  workspace.textDocuments.push(document);
  original = await window.showTextDocument(document, { viewColumn: 1, preview: false });
  window.showTextDocument.mockClear();
  state = new State();
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (query, update) => {
    const matchLine = createContentMatcher(query);
    const items = workspace.textDocuments.flatMap(document =>
      Array.from({ length: document.lineCount }, (_, line) => matchLine({
        id: document.uri.toString(), path: workspace.asRelativePath(document.uri),
        root: 'workspace', name: document.uri.path
      }, line, document.lineAt(line).text)).filter(item => item !== undefined));
    update({ items, total: items.length, searchedRoots: 1, roots: 1, binary: 0, unsupported: 0, complete: true });
  });
  controller = new PickerController({ workspaceState: state }, { appendLine: log });
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
});
afterEach(() => { controller.dispose(); vi.restoreAllMocks(); });

it('lists Git hunks without a query, opens the native diff and resumes', async () => {
  const search = vi.spyOn(GitChangesProvider.prototype, 'search').mockImplementation(async (query, update) => {
    const match = createContentMatcher(query || 'unsaved')({
      id: original.document.uri.toString(), path: 'original.ts', root: 'workspace · Unstaged', name: 'original.ts'
    }, 0, original.document.lineAt(0).text);
    if (!match) throw new Error('Missing Git fixture match');
    update({ items: [{ ...match, diff: {
      left: 'git:/workspace/original.ts?index', right: original.document.uri.toString(),
      title: 'original.ts (Unstaged)', side: 'added', modifiedLine: 0, emptyLeft: false, emptyRight: false,
      hunk: '@@ -1 +1 @@ · +1 / -1 · const unsaved = 1;'
    } }], total: 1, complete: true, searchedRoots: 1, roots: 1, binary: 0, unsupported: 0 });
  });
  await controller.show(false, 'gitDiffs');
  expect(contentItems()).toHaveLength(1);
  expect(search).toHaveBeenCalledWith('', expect.any(Function));
  picker.value = 'unsaved';
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  expect(contentItems()[0]?.label).toMatch(/^@@/);
  expect(contentItems()[0]?.description).toContain('Unstaged');
  expect(picker.title).toContain('Git Changes · 1 hunks / changes');
  await controller.openBeside();
  expect(commands.executeCommand).toHaveBeenCalledWith('vscode.diff', expect.anything(), expect.anything(),
    'original.ts (Unstaged)', expect.objectContaining({ viewColumn: vscode.ViewColumn.Beside }));
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(picker.value).toBe('unsaved');
  expect(search).toHaveBeenCalledTimes(3);
});

it('clears an existing filter when opening the Git hunk browser', async () => {
  const search = vi.spyOn(GitChangesProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({ items: [], total: 0, complete: true, searchedRoots: 1, roots: 1, binary: 0, unsupported: 0 });
  });
  picker.value = 'oldFilter';
  await controller.show(false, 'gitDiffs');
  expect(picker.value).toBe('');
  expect(search).toHaveBeenLastCalledWith('', expect.any(Function));
  expect(picker.items[0]?.label).toBe('No Git changes.');
});

it('orders deletion and addition hunks by the modified-side jump location', async () => {
  vi.spyOn(GitChangesProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({
      items: [
        { id: 'earlier-deletion', oldLine: 200, newLine: 10, side: 'removed' as const },
        { id: 'later-addition', oldLine: 50, newLine: 50, side: 'added' as const }
      ].map(item => ({
        id: item.id, uri: original.document.uri.toString(), path: 'original.ts', root: 'workspace · Unstaged',
        location: { line: item.oldLine, text: '', matches: [] },
        diff: {
          left: 'git:/workspace/original.ts?index', right: original.document.uri.toString(),
          title: 'original.ts (Unstaged)', side: item.side, modifiedLine: item.newLine,
          emptyLeft: false, emptyRight: false, hunk: item.id
        }
      })),
      total: 2, complete: true, searchedRoots: 1, roots: 1, binary: 0, unsupported: 0
    });
  });
  await controller.show(false, 'gitDiffs');
  expect(contentItems().map(item => item.id)).toEqual(['earlier-deletion', 'later-addition']);
});

it('applies an explicit new query when invoking an already-open search mode', async () => {
  await controller.show(false, 'currentFile', 'unsaved');
  expect(contentItems()).toHaveLength(1);
  await controller.show(false, 'currentFile', 'missingNeedle');
  expect(picker.value).toBe('missingNeedle');
  expect(picker.items[0]?.label).toBe('No matching text.');
});

it('waits for acceptance before opening a new picker so its first request is not lost', async () => {
  let release: (() => void) | undefined;
  const show = window.showTextDocument.getMockImplementation();
  if (!show) throw new Error('Missing editor mock');
  window.showTextDocument.mockImplementationOnce(async (document, options) => {
    await new Promise<void>(done => { release = done; });
    return show(document, options);
  });
  const accepting = controller.openBeside();
  await vi.waitFor(() => expect(release).toBeDefined());
  const opening = controller.show(false, 'currentFile', 'unsaved');
  if (!release) throw new Error('Expected pending acceptance');
  release();
  await accepting;
  await opening;
  const next: MockQuickPick = window.createQuickPick.mock.results.at(-1)?.value;
  expect(next).not.toBe(picker);
  expect(next.value).toBe('unsaved');
  expect(next.items.filter(item => item.id)).toHaveLength(1);
});

it('does not restore the original editor when native Quick Pick hides during acceptance', async () => {
  settings.set('telescopePicker.automaticPreview', false);
  const show = window.showTextDocument.getMockImplementation();
  if (!show) throw new Error('Missing editor mock');
  window.showTextDocument.mockImplementationOnce(async (document, options) => {
    picker.hide();
    await new Promise(resolve => setTimeout(resolve, 10));
    return show(document, options);
  });
  await controller.openBeside();
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
  expect(window.activeTextEditor?.viewColumn).toBe(2);
  expect(picker.dispose).toHaveBeenCalledTimes(1);
});

it('searches only the original current document including unsaved text without a workspace', async () => {
  workspace.workspaceFolders = [];
  const scans = vi.mocked(ContentProvider.prototype.search).mock.calls.length;
  await controller.show(false, 'currentFile');
  picker.value = 'UNSAVED';
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(contentItems()[0]?.resourceUri?.toString()).toBe('file:///workspace/original.ts');
  expect(contentItems()[0]?.description).toBe('1: const unsaved = 1;');
  expect(picker.title).toContain('Current File · 1 matching lines');
  expect(ContentProvider.prototype.search).toHaveBeenCalledTimes(scans);
  picker.hide();
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(contentItems()[0]?.resourceUri?.toString()).toBe('file:///workspace/original.ts');
  expect(picker.value).toBe('UNSAVED');
});

it('keeps current-file matches in ascending line order instead of ranking code labels', async () => {
  const document = createDocument(vscode.Uri.parse('file:///workspace/order.ts'), true,
    'export function needle() {}\n// unrelated\nneedle\nconst needle = 1;');
  workspace.textDocuments.push(document);
  picker.hide();
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  picker.hide();
  await new Promise(resolve => setTimeout(resolve, 50));
  await window.showTextDocument(document, { viewColumn: 1, preview: false });
  await controller.show(false, 'currentFile', 'needle');
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(contentItems().map(item => item.description)).toEqual([
    '1: export function needle() {}', '3: needle', '4: const needle = 1;'
  ]);
  expect(new Set(contentItems().map(item => item.label)).size).toBe(1);
  expect(picker.matchOnDescription).toBe(false);
  expect(picker.activeItems[0]?.id).toBe(contentItems()[0]?.id);
  expect(controller.navigate(1)).toBe(true);
  expect(picker.activeItems[0]?.id).toBe(contentItems()[1]?.id);
});

it('orders single-file workspace-content matches by line and preserves their code and root', async () => {
  const document = createDocument(vscode.Uri.parse('file:///workspace/order.ts'), true,
    'export function orderNeedle() {}\n// gap\norderNeedle\nconst orderNeedle = 1;');
  workspace.textDocuments.push(document);
  await controller.show(false, 'contents', 'orderNeedle');
  expect(contentItems().map(item => item.description)).toEqual([
    '1: export function orderNeedle() {} · workspace',
    '3: orderNeedle · workspace',
    '4: const orderNeedle = 1; · workspace'
  ]);
  expect(new Set(contentItems().map(item => item.label)).size).toBe(1);
  expect(picker.matchOnDescription).toBe(false);
  expect(picker.activeItems[0]?.id).toBe(contentItems()[0]?.id);
  expect(controller.navigate(1)).toBe(true);
  expect(picker.activeItems[0]?.id).toBe(contentItems()[1]?.id);
});

it('shows explicit current-file errors, empty and no-match states', async () => {
  await controller.show(false, 'currentFile');
  expect(picker.items[0]?.label).toBe('Type text to search in the current file.');
  picker.value = 'missingText';
  await vi.waitFor(() => expect(picker.items[0]?.label).toBe('No matching text.'));
  picker.hide();
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  picker.hide();
  await new Promise(resolve => setTimeout(resolve, 50));
  window.activeTextEditor = undefined;
  await controller.show(false, 'currentFile', 'const');
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(picker.items[0]?.label).toContain('Open a text editor');
});

it('pages every current-file match and opens the exact line beside', async () => {
  picker.hide();
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  picker.hide();
  await new Promise(resolve => setTimeout(resolve, 50));
  const uri = vscode.Uri.parse('untitled:current-test');
  const document = createDocument(uri, true, 'const localNeedle = 1;\n'.repeat(305));
  workspace.textDocuments.push(document);
  await window.showTextDocument(document, { viewColumn: 1, preview: false });
  settings.set('telescopePicker.exclude', ['**']);
  await controller.show(false, 'currentFile', 'LOCALNEEDLE');
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  await vi.waitFor(() => expect(contentItems()).toHaveLength(200));
  expect(picker.title).toContain('305 matching lines · Page 1/2');
  picker.clickButton('Next page');
  expect(contentItems()).toHaveLength(105);
  controller.navigate(1);
  await controller.openBeside();
  expect(window.activeTextEditor?.document).toBe(document);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
  expect(window.activeTextEditor?.selection.start.line).toBe(201);
});

it('refreshes current-file text changes only and rejects obsolete local query work', async () => {
  await controller.show(false, 'currentFile');
  picker.value = 'const';
  picker.value = 'unsaved';
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(picker.value).toBe('unsaved');
  const rows = picker.items;
  documentChanged.fire({
    document: createDocument(vscode.Uri.parse('chat-input:///prompt'), true), contentChanges: [{}]
  });
  expect(picker.items).toBe(rows);
  const updated = createDocument(original.document.uri, true, 'const changedNeedle = 2;');
  workspace.textDocuments = [updated];
  documentChanged.fire({ document: updated, contentChanges: [{}] });
  await vi.waitFor(() => expect(picker.items[0]?.label).toBe('No matching text.'));
  picker.value = 'changedNeedle';
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(contentItems()[0]?.description).toBe('1: const changedNeedle = 2;');
});

it('shows an existing popup before waiting for a mode search to complete', async () => {
  let finish: (() => void) | undefined;
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(() => new Promise<void>(done => { finish = done; }));
  picker.value = 'const';
  picker.show.mockClear();
  const opening = controller.show(false, 'contents');
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(picker.show).toHaveBeenCalledTimes(1);
  if (!finish) throw new Error('Expected pending mode search');
  finish();
  await opening;
});

it('uses a native popup without creating or focusing a preview panel', async () => {
  await controller.show();
  expect(window.createQuickPick).toHaveBeenCalledTimes(1);
  expect(window.createWebviewPanel).not.toHaveBeenCalled();
  expect(commands.executeCommand.mock.calls.some(call => call[0].includes('preview'))).toBe(false);
  expect(picker.ignoreFocusOut).toBe(true);
  expect(picker.items[0]?.iconPath).toBe(vscode.ThemeIcon.File);
  expect(picker.items[0]?.resourceUri?.toString()).toBe('file:///workspace/src/main.cpp');
});
it('pages all matching filenames beyond 200, including an empty query', async () => {
  workspace.findFiles.mockResolvedValue(Array.from({ length: 305 }, (_, index) =>
    Uri.parse(`file:///workspace/File${index}.cpp`)));
  fileCreated.fire();
  await vi.waitFor(() => expect(picker.items).toHaveLength(200));
  expect(picker.title).toContain('Telescope Picker · 305 results · Page 1/2');
  const first = picker.items;
  picker.clickButton('Next page');
  expect(picker.items).toHaveLength(105);
  expect(new Set([...first, ...picker.items].map(item => item.id)).size).toBe(305);
  picker.value = 'File';
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  expect(picker.title).toContain('Telescope Picker · 305 results');
  expect(picker.items.length).toBeLessThanOrEqual(200);
});
it('previews in the original editor while preserving popup focus', async () => {
  await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledWith(
    expect.objectContaining({ uri: expect.anything() }), { viewColumn: 1, preserveFocus: true, preview: true }));
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
});
it('delegates icons to native file resources without rebuilding the picker on theme changes', async () => {
  const items = picker.items;
  const active = picker.activeItems;
  settings.set('workbench.iconTheme', 'material-icon-theme');
  configurationChanged.fire({ affectsConfiguration: key => key === 'workbench.iconTheme' });
  expect(picker.items).toBe(items);
  expect(picker.activeItems).toBe(active);
  await contentMode('Needle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
  expect(contentItems().every(item => item.iconPath === vscode.ThemeIcon.File)).toBe(true);
  expect(contentItems().map(item => item.resourceUri?.toString())).toEqual([
    'file:///workspace/src/main.cpp', 'file:///workspace/src/main.cpp', 'file:///workspace/src/other.cpp'
  ]);
  expect(picker.items.filter(item => item.kind === vscode.QuickPickItemKind.Separator)
    .every(item => !item.iconPath && !item.resourceUri && !item.label.includes('$('))).toBe(true);
});
it('keeps whitespace matches explicit instead of deriving a filename label from the resource URI', async () => {
  const uri = vscode.Uri.parse('file:///workspace/spaces.cpp');
  workspace.textDocuments.push(createDocument(uri, false, '   '));
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({
      items: [{
        id: 'whitespace', uri: uri.toString(), path: 'spaces.cpp', root: 'workspace',
        location: { line: 0, text: '   ', matches: [0] }
      }],
      total: 1, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0
    });
  });
  await controller.show(false, 'contents');
  picker.value = ' ';
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(contentItems()[0]?.description).toContain('(whitespace)');
  expect(contentItems()[0]?.resourceUri?.toString()).toBe(uri.toString());
});
it('restores the original document and saves resume state on Escape', async () => {
  picker.hide();
  await vi.waitFor(() => expect(window.activeTextEditor?.document).toBe(original.document));
  expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'telescopePicker.active', false);
  expect(state.saved).toEqual([{ query: '', mode: 'files', selectedId: 'file:///workspace/src/main.cpp' }]);
  expect(original.document.isDirty).toBe(true);
});
it('accepts beside and restores the original file on the left', async () => {
  await controller.openBeside();
  expect(window.showTextDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({ toString: expect.any(Function) }), { viewColumn: -2, preserveFocus: false, preview: false });
  expect(window.tabGroups.all[0]?.activeTab?.document).toBe(original.document);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
});
it('supports ordinary acceptance and the per-item split button', async () => {
  const item = picker.items[1];
  if (!item) throw new Error('Expected second file');
  picker.split(item);
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe(item.id);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
});
it('only opens items from the current result set', async () => {
  picker.activeItems = [{ label: 'private', id: 'file:///private/secret' }];
  await controller.openBeside();
  expect(window.showTextDocument).not.toHaveBeenCalled();
});
it('coalesces rapid filename input before ranking and reuses matching file rows', async () => {
  const originalRow = picker.items.find(item => item.id === 'file:///workspace/src/main.cpp');
  const ranking = vi.spyOn(FileRanking.prototype, 'rank');
  picker.value = 'm';
  picker.value = 'ma';
  picker.value = 'main';
  expect(ranking).not.toHaveBeenCalled();
  await waitResults();
  expect(ranking).toHaveBeenCalledTimes(1);
  expect(ranking.mock.calls[0]?.[1]).toBe('main');
  expect(picker.items[0]).toBe(originalRow);
});

it('drops stale query results and preserves newer input during invalidation', async () => {
  picker.value = 'obsolete';
  picker.value = 'main';
  await waitResults();
  expect(picker.items).toHaveLength(1);
  fileCreated.fire();
  await waitResults();
  expect(picker.value).toBe('main');
});
it('resumes the last query and selection before a preview has loaded', async () => {
  picker.value = 'other';
  await vi.waitFor(() => expect(picker.items[0]?.id).toBe('file:///workspace/src/other.cpp'));
  picker.hide();
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/other.cpp');
  expect(picker.value).toBe('other');
});
it('supports Vim-style navigation', () => {
  controller.navigate(1);
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/other.cpp');
  controller.navigate(-1);
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/main.cpp');
});
it('surfaces discovery and opening failures without losing the popup', async () => {
  workspace.findFiles.mockRejectedValueOnce(new Error('Discovery unavailable'));
  fileCreated.fire();
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('Discovery unavailable'));
  picker.value = 'main';
  await waitResults();
  window.showTextDocument.mockRejectedValueOnce(new Error('File deleted'));
  picker.accept();
  await vi.waitFor(() => expect(picker.title).toBe('Could not open file · See Output'));
  expect(log).toHaveBeenCalledWith('File deleted');
  expect(picker.enabled).toBe(true);
});

async function contentMode(query = ''): Promise<void> {
  workspace.textDocuments.push(
    createDocument(vscode.Uri.parse('file:///workspace/src/main.cpp'), true, '// title\nconst fuzzyNeedle = 1;\nconst otherNeedle = 2;'),
    createDocument(vscode.Uri.parse('file:///workspace/src/other.cpp'), true, 'const fuzzyNeedle = 3;')
  );
  await controller.show(false, 'contents');
  picker.value = query;
}
it('switches the existing native popup between file names and contents without scanning an empty query', async () => {
  await contentMode();
  expect(window.createQuickPick).toHaveBeenCalledTimes(1);
  expect(picker.items[0]?.label).toContain('Type text');
  expect(picker.buttons[0]?.tooltip).toBe('Find files');
  picker.preview();
  await waitResults();
  expect(picker.buttons[0]?.tooltip).toBe('Search file contents');
  picker.preview();
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('Type text'));
});
it('searches lines, preserves code-editor previews, and opens a match at its real line', async () => {
  await contentMode('fuzzyNeedle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
  expect(picker.title).toContain('2 matching lines');
  expect(picker.items[0]).toMatchObject({
    kind: vscode.QuickPickItemKind.Separator,
    label: 'src/main.cpp · workspace (1)'
  });
  expect(contentItems()[0]?.description).toBe('2: const fuzzyNeedle = 1; · workspace');
  expect(picker.activeItems[0]?.id).toBe(contentItems()[0]?.id);
  await vi.waitFor(() => expect(window.activeTextEditor?.selection.start.line).toBe(1));
  picker.accept();
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
  expect(window.activeTextEditor?.selection.start.line).toBe(1);
});
it('keeps previous results visible while loading but rejects stale acceptance', async () => {
  await contentMode('fuzzyNeedle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
  const previous = picker.items;
  const stale = picker.activeItems;
  picker.value = 'otherNeedle';
  expect(picker.items).toBe(previous);
  expect(picker.busy).toBe(true);
  picker.activeItems = stale;
  const opened = window.showTextDocument.mock.calls.length;
  await controller.openBeside();
  expect(window.showTextDocument.mock.calls.length).toBe(opened);
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  expect(contentItems()).toHaveLength(1);
  expect(contentItems()[0]?.description).toContain('otherNeedle');
});

it('keeps streamed content row layout stable when a second file arrives', async () => {
  let publish: ((value: ContentUpdate) => void) | undefined;
  const first = { id: 'first', uri: 'file:///workspace/first.ts', path: 'first.ts', root: 'workspace',
    location: { line: 0, text: 'needle', matches: [0] } };
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    publish = update;
    update({ items: [first], total: 1, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 });
  });
  await controller.show(false, 'contents', 'needle');
  const row = contentItems()[0];
  expect(row?.label).toBe('first.ts');
  if (!publish) throw new Error('Expected streamed search');
  publish({ items: [first, { ...first, id: 'second', uri: 'file:///workspace/second.ts', path: 'second.ts' }],
    total: 2, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0 });
  expect(contentItems()[0]).toBe(row);
  expect(contentItems()[0]?.description).toBe('1: needle · workspace');
});

it('keeps deep paths out of content labels while exposing the exact path on split-button hover', async () => {
  const path = `${'very-long-directory/'.repeat(15)}processor.ts`;
  const uri = `file:///workspace/${path}`;
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({
      items: [{ id: 'deep-match', uri, path, root: 'workspace',
        location: { line: 0, text: 'const unsaved = 1;', matches: [6] } }],
      total: 1, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0
    });
  });
  await controller.show(false, 'contents', 'unsaved');
  const row = contentItems()[0];
  expect(row?.label).toBe('processor.ts');
  expect(row?.description).toBe('1: const unsaved = 1; · workspace');
  expect(picker.items[0]?.label).toBe(`...${path.slice(-69)} · workspace (1)`);
  expect(row?.buttons?.[0]?.tooltip).toBe(`${path} · workspace\nOpen beside (Ctrl/Cmd+Enter)`);
  expect(row?.resourceUri?.toString()).toBe(uri);
  if (!row) throw new Error('Expected deep-path match');
  picker.split(row);
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe(uri);
});

it('distinguishes duplicate filenames in compact file rows without losing full paths', async () => {
  settings.set('telescopePicker.automaticPreview', false);
  const folder = 'very-long-directory/'.repeat(15);
  const paths = [`${folder}first/processor.ts`, `${folder}second/processor.ts`];
  workspace.findFiles.mockResolvedValue(paths.map(path => Uri.parse(`file:///workspace/${path}`)));
  fileCreated.fire();
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  await vi.waitFor(() => expect(picker.items[0]?.label).toBe('processor.ts'));
  expect(picker.items.map(item => item.label)).toEqual(['processor.ts', 'processor.ts']);
  expect(picker.items[0]?.description).toContain('first · workspace');
  expect(picker.items[1]?.description).toContain('second · workspace');
  for (const [index, row] of picker.items.entries()) {
    expect(Array.from(row.description ?? '').length).toBeLessThanOrEqual(72);
    expect(row.buttons?.[0]?.tooltip).toContain(paths[index]);
    expect(row.id).toBe(`file:///workspace/${paths[index]}`);
  }
});

it('bounds unusually long filenames and roots without splitting Unicode characters or changing grouping', async () => {
  const name = `${'\u{1F600}'.repeat(60)}.ts`;
  const root = 'long-workspace-name-'.repeat(10);
  const paths = [`first/${name}`, `second/${name}`];
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({
      items: paths.map(path => ({
        id: path, uri: `file:///workspace/${path}`, path, root,
        location: { line: 0, text: 'needle', matches: [0] }
      })),
      total: 2, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0
    });
  });
  await controller.show(false, 'contents', 'needle');
  const rows = contentItems();
  expect(rows).toHaveLength(2);
  expect(picker.items.filter(item => item.kind === vscode.QuickPickItemKind.Separator)).toHaveLength(2);
  for (const [index, row] of rows.entries()) {
    expect(Array.from(row.label)).toHaveLength(48);
    expect(row.label).toBe(`...${'\u{1F600}'.repeat(42)}.ts`);
    expect(row.description).toBe(`1: needle · ...${root.slice(-29)}`);
    expect(row.buttons?.[0]?.tooltip).toContain(`${paths[index]} · ${root}`);
  }
});

it('previews and accepts streamed matches while the search is still running', async () => {
  settings.set('telescopePicker.previewDelay', 0);
  let finish: (() => void) | undefined;
  let publish: ((value: ContentUpdate) => void) | undefined;
  const first = {
    id: 'first.ts', uri: 'file:///workspace/first.ts', path: 'first.ts', root: 'workspace',
    location: { line: 0, text: 'const unsaved = 1;', matches: [6] }
  };
  const items = ['first.ts', 'second.ts'].map(path => ({
    ...first, id: path, uri: `file:///workspace/${path}`, path
  }));
  const result = { items, total: 2, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 };
  vi.mocked(ContentProvider.prototype.search).mockImplementation(async (_query, update) => {
    publish = update;
    update(result);
    await new Promise<void>(done => { finish = done; });
  });
  const searching = controller.show(false, 'contents', 'unsaved');
  try {
    await vi.waitFor(() => expect(finish).toBeDefined());
    await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
    expect(picker.busy).toBe(true);
    const active = picker.activeItems;
    if (!publish) throw new Error('Expected content stream');
    publish({ ...result, items: [...items, { ...first, id: 'third.ts', uri: 'file:///workspace/third.ts', path: 'third.ts' }],
      total: 3 });
    expect(picker.activeItems).toBe(active);
    controller.navigate(1);
    await vi.waitFor(() => expect(window.activeTextEditor?.document.uri.toString()).toBe(items[1]?.uri));
    expect(picker.busy).toBe(true);
    await controller.openBeside();
    expect(picker.dispose).toHaveBeenCalled();
    expect(window.activeTextEditor?.viewColumn).toBe(2);
  } finally {
    finish?.();
    await searching;
  }
});

it('cancels on Escape and reopens without waiting for the closed content search to finish', async () => {
  let finish: (() => void) | undefined;
  let publish: ((value: ContentUpdate) => void) | undefined;
  vi.mocked(ContentProvider.prototype.search).mockImplementation(async (_query, update) => {
    publish = update;
    await new Promise<void>(done => { finish = done; });
  });
  const cancel = vi.spyOn(ContentProvider.prototype, 'cancel');
  const searching = controller.show(false, 'contents', 'needle');
  try {
    await vi.waitFor(() => expect(finish).toBeDefined());
    const closedPicker = picker;
    const calls = cancel.mock.calls.length;
    picker.hide();
    expect(cancel.mock.calls.length).toBeGreaterThan(calls);
    await searching;
    await controller.show();
    picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
    expect(picker).not.toBe(closedPicker);
    await waitResults();
    const rows = picker.items;
    if (!publish) throw new Error('Expected closed search callback');
    publish({ items: [], total: 0, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0 });
    expect(picker.items).toBe(rows);
  } finally {
    finish?.();
    await searching;
  }
});

it('reports opt-in search timings without logging query text', async () => {
  settings.set('telescopePicker.performanceDiagnostics', true);
  log.mockClear();
  await controller.show(false, 'contents', 'privateQueryNeedle');
  const entries = log.mock.calls.map(call => String(call[0]));
  expect(entries.some(entry => /^Performance: contents, .*ms search\/update, .*ms content row preparation\/dispatch/.test(entry))).toBe(true);
  expect(entries.join('\n')).not.toContain('privateQueryNeedle');
});

it('starts a new content query at the first match instead of retaining the old selection and scroll', async () => {
  await contentMode('Needle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
  controller.navigate(1);
  controller.navigate(1);
  expect(picker.activeItems[0]?.id).toBe(contentItems()[2]?.id);
  picker.keepScrollPosition = true;
  picker.value = 'needle';
  expect(picker.keepScrollPosition).toBe(false);
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  expect(picker.activeItems[0]?.id).toBe(contentItems()[0]?.id);
  expect(picker.keepScrollPosition).toBe(false);
});

it('preserves scrolling and navigation on later batches of the same content query', async () => {
  let publish: ((value: ContentUpdate) => void) | undefined;
  const items = ['first.cpp', 'second.cpp'].map(path => ({
    id: path, uri: `file:///workspace/${path}`, path, root: 'workspace',
    location: { line: 0, text: 'needle', matches: [0] }
  }));
  const result = { items, total: 2, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 };
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    publish = update;
    update(result);
  });
  await contentMode('needle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
  expect(picker.keepScrollPosition).toBe(false);
  controller.navigate(1);
  if (!publish) throw new Error('Expected content stream');
  publish({ ...result, searchedRoots: 1, complete: true });
  expect(picker.keepScrollPosition).toBe(true);
  expect(picker.activeItems[0]?.id).toBe('second.cpp');
});

it('resumes content mode, query and selection across streaming updates', async () => {
  await contentMode('fuzzyNeedle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
  controller.navigate(1);
  const selected = picker.activeItems[0]?.id;
  picker.hide();
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(picker.value).toBe('fuzzyNeedle');
  expect(picker.placeholder).toContain('within files');
  expect(picker.activeItems[0]?.id).toBe(selected);
  expect(state.saved.at(-1)).toMatchObject({ mode: 'contents', query: 'fuzzyNeedle', selectedId: selected });
});
it('debounces content queries and refreshes edited documents without accepting stale rows', async () => {
  await contentMode('obsolete');
  picker.value = 'fuzzyNeedle';
  await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
  const stale = contentItems()[0];
  picker.value = 'otherNeedle';
  picker.activeItems = stale ? [stale] : [];
  await controller.openBeside();
  expect(window.activeTextEditor?.viewColumn).not.toBe(2);
  await vi.waitFor(() => expect(contentItems()[0]?.description).toContain('otherNeedle'));
  expect(contentItems()).toHaveLength(1);
  const edited = workspace.textDocuments.find(document => document.uri.toString() === 'file:///workspace/src/main.cpp');
  if (!edited) throw new Error('Expected workspace document');
  documentChanged.fire({ document: edited, contentChanges: [{}] });
  expect(picker.items[0]?.id).toBeUndefined();
  await vi.waitFor(() => expect(contentItems()[0]?.description).toContain('otherNeedle'));
});
it('shows explicit content-query limits and cancels a pending scan when the popup closes', async () => {
  await contentMode('x'.repeat(1025));
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('1,024'));
  picker.value = 'fuzzyNeedle';
  picker.hide();
  await new Promise(done => setTimeout(done, 220));
  expect(state.saved.at(-1)).toMatchObject({ mode: 'contents', query: 'fuzzyNeedle' });
  expect(window.activeTextEditor?.document).toBe(original.document);
});
it('ignores chat documents and metadata-only document events while a content picker is open', async () => {
  await contentMode('Needle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
  const items = picker.items;
  const searches = vi.mocked(ContentProvider.prototype.search).mock.calls.length;
  documentChanged.fire({
    document: createDocument(vscode.Uri.parse('chat-input:///session/prompt'), true, 'const'),
    contentChanges: [{}]
  });
  const document = workspace.textDocuments[0];
  if (!document) throw new Error('Expected workspace document');
  documentChanged.fire({ document, contentChanges: [] });
  await new Promise(resolve => setTimeout(resolve, 120));
  expect(ContentProvider.prototype.search).toHaveBeenCalledTimes(searches);
  expect(picker.items).toBe(items);
});

it('follows the first ordered match until navigation and avoids redisplaying identical streamed rows', async () => {
  let publish: ((value: ContentUpdate) => void) | undefined;
  const items = ['a.cpp', 'z.cpp'].map(path => ({
    id: path, uri: `file:///workspace/${path}`, path, root: 'workspace',
    location: { line: 0, text: 'const value = 1;', matches: [0] }
  }));
  const result = { items: items.slice(1), total: 1, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 };
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    publish = update;
    update(result);
  });

  await contentMode('const');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
  expect(picker.activeItems[0]?.id).toBe('z.cpp');
  if (!publish) throw new Error('Expected content stream');
  publish({ ...result, items, total: 2 });
  expect(picker.activeItems[0]?.id).toBe('a.cpp');
  expect(picker.keepScrollPosition).toBe(false);
  controller.navigate(1);
  const rows = picker.items;
  const active = picker.activeItems;
  publish({ ...result, items, total: 2, searchedRoots: 1, complete: true });
  expect(picker.items).toBe(rows);
  expect(picker.activeItems).toBe(active);
  expect(picker.activeItems[0]?.id).toBe('z.cpp');
});
it('previews the native first visible match when popup ranking differs from provider path order', async () => {
  picker.nativeFirst = items => items.filter(item => item.id).at(-1);
  await contentMode('Needle');
  await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
  const firstVisible = contentItems().at(-1);
  expect(picker.activeItems[0]?.id).toBe(firstVisible?.id);
  await vi.waitFor(() => expect(window.activeTextEditor?.document.uri.toString())
    .toBe('file:///workspace/src/other.cpp'));
  expect(window.activeTextEditor?.selection.start.line).toBe(0);
});
it('keeps automatic-preview errors visible while content results continue streaming', async () => {
  let title = picker.title;
  const titles: string[] = [];
  Object.defineProperty(picker, 'title', {
    get: () => title,
    set: (value: string) => { title = value; titles.push(value); }
  });
  const uri = 'file:///workspace/large.ts';
  const item = {
    id: JSON.stringify([uri, 0]), uri, path: 'large.ts', root: 'workspace',
    location: { line: 0, text: 'needle', matches: [0, 1] }
  };
  const spy = vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    const result = { items: [item], total: 1, searchedRoots: 0, roots: 1, binary: 0, unsupported: 0, complete: false };
    update(result);
    await new Promise(done => setTimeout(done, 100));
    update({ ...result, searchedRoots: 1, complete: true });
  });
  try {
    workspace.fs.stat.mockResolvedValue({ size: 2 * 1024 * 1024 });
    await controller.show(false, 'contents');
    picker.value = 'needle';
    await vi.waitFor(() => expect(picker.busy).toBe(false), { timeout: 2000 });
    expect(picker.title).toBe('Large file · Enter to open');
    expect(picker.title.length).toBeLessThan(40);
    expect(titles.filter(value => value === 'Large file · Enter to open')).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 MiB'));
  } finally { spy.mockRestore(); }
});

it('keeps long preview failures out of the popup and restores the result title on navigation', async () => {
  const reason = `Cannot open file:///workspace/${'long-folder/'.repeat(100)}missing.cpp`;
  workspace.fs.stat.mockRejectedValueOnce(new Error(reason));
  controller.navigate(1);
  await vi.waitFor(() => expect(picker.title).toBe('Preview unavailable · See Output'));
  expect(log).toHaveBeenCalledWith(reason);
  expect(picker.title.length).toBeLessThan(40);
  controller.navigate(-1);
  expect(picker.title).toBe('Telescope Picker · 2 results');
});

it('groups repeated file matches and skips headings during navigation and acceptance', async () => {
    await contentMode('Needle');
    await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
    expect(picker.items.filter(item => item.kind === vscode.QuickPickItemKind.Separator)).toHaveLength(2);
    expect(picker.items[0]?.label).toContain('src/main.cpp · workspace (2)');
    expect(contentItems().map(item => item.description)).toEqual([
      '2: const fuzzyNeedle = 1; · workspace', '3: const otherNeedle = 2; · workspace', '1: const fuzzyNeedle = 3; · workspace'
    ]);
    const first = picker.activeItems[0];
    controller.navigate(1);
    expect(picker.activeItems[0]?.id).toBe(contentItems()[1]?.id);
    controller.navigate(1);
    expect(picker.activeItems[0]?.id).toBe(contentItems()[2]?.id);
    controller.navigate(-1);
    expect(picker.activeItems[0]?.id).toBe(contentItems()[1]?.id);
    const header = picker.items[0];
    if (!header) throw new Error('Expected file heading');
    picker.split(header);
    await controller.openBeside();
    await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
    expect(window.activeTextEditor?.selection.start.line).toBe(2);
    expect(first?.id).not.toBe(header.id);
  });

  it('navigates from a stable match ID when streamed items replace the active object', async () => {
    await contentMode('Needle');
    await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
    const first = contentItems()[0];
    if (!first) throw new Error('Expected first match');
    picker.activeItems = [{ ...first }];
    controller.navigate(1);
    expect(picker.activeItems[0]?.id).toBe(contentItems()[1]?.id);
  });

  it('reports when navigation must wait for more streamed groups and tolerates transient empty native selection', async () => {
    await contentMode('otherNeedle');
    await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
    expect(controller.navigate(1)).toBe(false);
    expect(controller.navigate(-1)).toBe(false);
    picker.activeItems = [];
    expect(controller.navigate(1)).toBe(false);
    picker.value = 'Needle';
    await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
    expect(controller.navigate(1)).toBe(true);
  });

  it('preserves programmatic navigation when a streamed update precedes native active-item events', async () => {
    let active = picker.activeItems;
    Object.defineProperty(picker, 'activeItems', {
      get: () => active,
      set: (items: typeof active) => { active = items; }
    });
    const items = ['first.cpp', 'second.cpp'].map(path => ({
      id: path, uri: `file:///workspace/${path}`, path, root: 'workspace',
      location: { line: 0, text: 'needle', matches: [0] }
    }));
    let publish: ((value: ContentUpdate) => void) | undefined;
    const result = { items, total: 2, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 };
    vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
      publish = update;
      update(result);
    });
    await controller.show(false, 'contents');
    picker.value = 'needle';
    await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
    picker.fireActive();
    expect(controller.navigate(1)).toBe(true);
    if (!publish) throw new Error('Expected content stream');
    publish({ ...result, items: items.map(item => ({ ...item })), complete: true, searchedRoots: 1 });
    expect(picker.activeItems[0]?.id).toBe('second.cpp');
  });

  it('ignores native query synchronization without losing a pending streamed resume selection', async () => {
    const items = ['first.cpp', 'second.cpp'].map(path => ({
      id: path, uri: `file:///workspace/${path}`, path, root: 'workspace',
      location: { line: 0, text: 'needle', matches: [0] }
    }));
    const result = { items, total: 2, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0 };
    let partial = false;
    let publish: ((value: ContentUpdate) => void) | undefined;
    const search = vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
      publish = update;
      update({ ...result, items: partial ? items.slice(0, 1) : items });
    });
    await controller.show(false, 'contents');
    picker.value = 'needle';
    await vi.waitFor(() => expect(contentItems()).toHaveLength(2));
    expect(controller.navigate(1)).toBe(true);
    picker.hide();
    partial = true;
    await controller.show(true);
    picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
    expect(contentItems()).toHaveLength(1);
    const searches = search.mock.calls.length;
    picker.value = 'needle';
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(search).toHaveBeenCalledTimes(searches);
    if (!publish) throw new Error('Expected content stream');
    publish({ ...result, complete: true, searchedRoots: 1 });
    expect(picker.activeItems[0]?.id).toBe('second.cpp');
  });

  it('keeps identical paths in different roots in separate groups and counts matches, not headers', async () => {
    const items = Array.from({ length: 205 }, (_, index) => ({
      id: `match-${index}`, uri: `file:///root${index}/main.cpp`, path: 'main.cpp', root: `root${index}`,
      location: { line: 0, text: 'needle', matches: [0] }
    }));
    vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
      update({ items, total: 205, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0 });
    });
    await controller.show(false, 'contents');
    picker.value = 'needle';
    await vi.waitFor(() => expect(contentItems()).toHaveLength(200));
    expect(picker.items).toHaveLength(400);
    expect(picker.title).toContain('205 matching lines');
    expect(picker.title).not.toContain('showing');
    expect(contentItems().at(-1)?.id).toBe('match-199');
    expect(picker.items[0]?.label).toContain('main.cpp · root0');
    expect(picker.items[2]?.label).toContain('main.cpp · root1');
    expect(contentItems()[0]?.description).toBe('1: needle · root0');
    expect(contentItems()[1]?.description).toBe('1: needle · root1');
    picker.clickButton('Next page');
    expect(contentItems()).toHaveLength(5);
    expect(contentItems().at(-1)?.id).toBe('match-204');
  });

  it('does not interpret icon syntax inside file paths, root names or matching code', async () => {
    vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
      update({
        items: [{
          id: 'match', uri: 'file:///workspace/special.cpp', path: '$(warning).cpp', root: '$(error)',
          location: { line: 0, text: 'const icon = "$(warning)";', matches: [6] }
        }],
        total: 1, roots: 1, searchedRoots: 1, complete: true, binary: 0, unsupported: 0
      });
    });
    await controller.show(false, 'contents');
    picker.value = 'icon';
    await vi.waitFor(() => expect(contentItems()).toHaveLength(1));
    expect(picker.items[0]?.label).toBe('\\$(warning).cpp · \\$(error) (1)');
    expect(contentItems()[0]?.label).toContain('\\$(warning)');
    expect(contentItems()[0]?.description).toBe('1: const icon = "\\$(warning)"; · \\$(error)');
  });
