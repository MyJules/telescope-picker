import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { createContentMatcher } from '../src/ranking';
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
  expect(picker.items[0]?.iconPath).toBe(vscode.ThemeIcon.File);
  expect(picker.items[0]?.resourceUri?.toString()).toBe('file:///workspace/src/main.cpp');
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
  expect(contentItems()[0]?.label).toBe('(whitespace)');
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
  expect(contentItems()[0]?.description).toBe('src/main.cpp:2 · workspace');
  expect(picker.activeItems[0]?.id).toBe(contentItems()[0]?.id);
  await vi.waitFor(() => expect(window.activeTextEditor?.selection.start.line).toBe(1));
  picker.accept();
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
  expect(window.activeTextEditor?.selection.start.line).toBe(1);
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
  await vi.waitFor(() => expect(contentItems()).toHaveLength(3));
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
  await vi.waitFor(() => expect(contentItems()[0]?.label).toContain('otherNeedle'));
  expect(contentItems()).toHaveLength(1);
  const edited = workspace.textDocuments.find(document => document.uri.toString() === 'file:///workspace/src/main.cpp');
  if (!edited) throw new Error('Expected workspace document');
  documentChanged.fire({ document: edited, contentChanges: [{}] });
  expect(picker.items[0]?.id).toBeUndefined();
  await vi.waitFor(() => expect(contentItems()[0]?.label).toContain('otherNeedle'));
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
      'src/main.cpp:2 · workspace', 'src/main.cpp:3 · workspace', 'src/other.cpp:1 · workspace'
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
    const items = Array.from({ length: 200 }, (_, index) => ({
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
    expect(picker.title).toContain('205 matching lines (showing 200)');
    expect(picker.items[0]?.label).toContain('main.cpp · root0');
    expect(picker.items[2]?.label).toContain('main.cpp · root1');
    expect(contentItems()[0]?.description).toBe('main.cpp:1 · root0');
    expect(contentItems()[1]?.description).toBe('main.cpp:1 · root1');
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
    expect(contentItems()[0]?.description).toBe('\\$(warning).cpp:1 · \\$(error)');
  });
