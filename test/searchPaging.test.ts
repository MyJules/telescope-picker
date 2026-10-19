import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { FileRanking } from '../src/fileRanking';
import { createContentMatcher } from '../src/ranking';
import {
  createDocument, MockQuickPick, resetEditors, settings, Uri, window, workspace
} from './vscode';

let controller: PickerController;
let picker: MockQuickPick;
const log = vi.fn();
const saved = new Map<string, unknown>();
const rows = () => picker.items.filter(item => item.id);
const matches = Array.from({ length: 1005 }, (_, line) => {
  const match = createContentMatcher('needle')({
    id: 'file:///workspace/many.ts', path: 'many.ts', root: 'workspace', name: 'many.ts'
  }, line, 'needle');
  if (!match) throw new Error('Missing fixture match');
  return match;
});
const result: ContentUpdate = {
  items: matches, total: matches.length, roots: 1, searchedRoots: 0, complete: false, binary: 0, unsupported: 0
};

beforeEach(() => {
  resetEditors();
  saved.clear();
  settings.set('telescopePicker.automaticPreview', false);
  workspace.workspaceFolders = [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }];
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(matches[0]!.uri), false, 'needle\n'.repeat(1005)));
  workspace.findFiles.mockResolvedValue([]);
  controller = new PickerController({ workspaceState: {
    keys: () => [...saved.keys()],
    get: <T>(key: string, fallback?: T): T | undefined => saved.has(key) ? saved.get(key) as T : fallback,
    update: async (key: string, value: unknown) => { saved.set(key, value); }
  } }, { appendLine: log });
});

afterEach(() => { controller.dispose(); });

async function show(): Promise<void> {
  await controller.show(false, 'contents', 'needle');
  picker = window.createQuickPick.mock.results.at(-1)?.value;
}

it('makes every streamed match accessible without restarting the search and resumes a later page', async () => {
  const search = vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    update({ ...result, complete: true, searchedRoots: 1 });
  });
  await show();
  const seen = rows().map(row => row.id);
  expect(picker.title).toContain('Page 1/6');
  expect(picker.buttons.some(button => button.tooltip === 'Previous page')).toBe(false);
  for (let page = 1; page < 6; page++) {
    picker.clickButton('Next page');
    expect(rows().length).toBeLessThanOrEqual(200);
    seen.push(...rows().map(row => row.id));
    expect(picker.activeItems[0]?.id).toBe(matches[page * 200]?.id);
  }
  expect(seen).toEqual(matches.map(match => match.id));
  expect(picker.buttons.some(button => button.tooltip === 'Next page')).toBe(false);
  picker.clickButton('Previous page');
  controller.navigate(1);
  const selected = picker.activeItems[0]?.id;
  picker.hide();
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value;
  expect(picker.title).toContain('Page 5/6');
  expect(picker.activeItems[0]?.id).toBe(selected);
  expect(search).toHaveBeenCalledTimes(2);
});

it('keeps a later-page selection stable during streaming and opens it before the scan completes', async () => {
  let publish: ((value: ContentUpdate) => void) | undefined;
  let finish: (() => void) | undefined;
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (_query, update) => {
    publish = update;
    update({ ...result, items: matches.slice(0, 500), total: 500 });
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const searching = controller.show(false, 'contents', 'needle');
  try {
    await vi.waitFor(() => expect(finish).toBeDefined());
    picker = window.createQuickPick.mock.results.at(-1)?.value;
    picker.clickButton('Next page');
    controller.navigate(1);
    const selected = picker.activeItems[0]?.id;
    publish?.(result);
    expect(picker.activeItems[0]?.id).toBe(selected);
    expect(picker.title).toContain('Page 2/6');
    expect(picker.busy).toBe(true);
    await controller.openBeside();
    expect(window.activeTextEditor?.selection.start.line).toBe(201);
    expect(picker.dispose).toHaveBeenCalled();
    await searching;
  } finally { finish?.(); await searching; }
});

it('resets paging for a replacement query and rejects stale page controls and rows', async () => {
  vi.spyOn(ContentProvider.prototype, 'search').mockImplementation(async (query, update) => {
    update(query === 'needle' ? result : { ...result, items: matches.slice(0, 1), total: 1, complete: true });
  });
  await show();
  picker.clickButton('Next page');
  const old = picker.activeItems;
  picker.value = 'replacement';
  expect(picker.buttons.some(button => button.tooltip?.includes('page'))).toBe(false);
  picker.activeItems = old;
  const opened = window.showTextDocument.mock.calls.length;
  await controller.openBeside();
  expect(window.showTextDocument.mock.calls.length).toBe(opened);
  await vi.waitFor(() => expect(picker.busy).toBe(false));
  expect(rows()).toHaveLength(1);
  expect(picker.title).not.toContain('Page');
});

it('bounds filename rows and reads Quick Pick snapshots a constant number of times', async () => {
  const files = matches.map((match, index) => ({
    id: `file:///workspace/file-${index}.ts`, path: `file-${index}.ts`, root: match.root, matches: []
  }));
  vi.spyOn(FileRanking.prototype, 'rank').mockResolvedValue({ items: files, total: files.length });
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value;
  let items = picker.items;
  let reads = 0;
  Object.defineProperty(picker, 'items', {
    get: () => { reads++; return [...items]; },
    set: (value: typeof items) => { items = value; }
  });
  expect(rows()).toHaveLength(200);
  const before = reads;
  picker.clickButton('Next page');
  expect(reads - before).toBeLessThan(10);
  expect(rows()).toHaveLength(200);
  expect(rows()[0]?.id).toBe(files[200]?.id);
  expect(picker.title).toContain('Page 2/6');
});
