import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { ContentProvider } from '../src/contents';
import { createContentMatcher } from '../src/ranking';
import { commands, createDocument, documentChanged, fileCreated, MockQuickPick, resetEditors, window, workspace, Uri } from './vscode';

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
const waitResults = async (): Promise<void> => {
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

it('uses a native popup without creating or focusing a preview panel', async () => {
  await controller.show();
  expect(window.createQuickPick).toHaveBeenCalledTimes(1);
  expect(window.createWebviewPanel).not.toHaveBeenCalled();
  expect(commands.executeCommand.mock.calls.some(call => call[0].includes('preview'))).toBe(false);
  expect(picker.ignoreFocusOut).toBe(true);
});
it('previews in the original editor while preserving popup focus', async () => {
  await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledWith(
    expect.objectContaining({ uri: expect.anything() }), { viewColumn: 1, preserveFocus: true, preview: true }));
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
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
  await vi.waitFor(() => expect(picker.title).toContain('File deleted'));
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
  await vi.waitFor(() => expect(picker.items).toHaveLength(2));
  expect(picker.title).toContain('2 matching lines');
  expect(picker.items[0]?.description).toContain('src/main.cpp:2');
  await vi.waitFor(() => expect(window.activeTextEditor?.selection.start.line).toBe(1));
  picker.accept();
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
  expect(window.activeTextEditor?.selection.start.line).toBe(1);
});
it('resumes content mode, query and selection across streaming updates', async () => {
  await contentMode('fuzzyNeedle');
  await vi.waitFor(() => expect(picker.items).toHaveLength(2));
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
  await vi.waitFor(() => expect(picker.items).toHaveLength(2));
  const stale = picker.items[0];
  picker.value = 'otherNeedle';
  picker.activeItems = stale ? [stale] : [];
  await controller.openBeside();
  expect(window.activeTextEditor?.viewColumn).not.toBe(2);
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('otherNeedle'));
  expect(picker.items).toHaveLength(1);
  documentChanged.fire();
  expect(picker.items[0]?.id).toBeUndefined();
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('otherNeedle'));
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
it('keeps automatic-preview errors visible while content results continue streaming', async () => {
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
    expect(picker.title).toContain('1 MiB');
    expect(picker.title).toContain('Search complete');
  } finally { spy.mockRestore(); }
});
