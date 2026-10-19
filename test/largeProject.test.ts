import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { MockQuickPick, createDocument, resetEditors, settings, Uri, window, workspace } from './vscode';

vi.mock('../src/contentStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/contentStore')>();
  return {
    ...actual,
    ContentStore: class extends actual.ContentStore {
      constructor() { super(resolve('dist', 'contentStoreWorker.js')); }
    }
  };
});

const root = process.env.TELESCOPE_BENCHMARK_ROOT;
let controller: PickerController;
const logs: string[] = [];

beforeEach(() => {
  resetEditors();
  settings.set('telescopePicker.automaticPreview', false);
  workspace.workspaceFolders = root ? [{ uri: Uri.file(root), name: 'benchmark', index: 0 }] : [];
  workspace.fs.stat.mockImplementation(async uri => ({ size: (await stat(uri.fsPath)).size }));
  workspace.openTextDocument.mockImplementation(async uri => {
    const document = createDocument(uri, false, await readFile(uri.fsPath, 'utf8'));
    workspace.textDocuments.push(document);
    return document;
  });
  logs.length = 0;
  controller = new PickerController({ workspaceState: {
    keys: () => [], get: <T>(_key: string, fallback?: T): T | undefined => fallback,
    update: async () => {}
  } }, { appendLine: message => logs.push(message) });
});
afterEach(() => { controller.dispose(); });

it.skipIf(!root)('keeps broad real-project searches responsive with bounded native popup payloads', async () => {
  for (const query of ['const', 'e']) {
    let lastTick = performance.now();
    let maxGap = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastTick);
      lastTick = now;
    }, 10);
    const start = performance.now();
    try {
      await controller.show(false, 'contents', query);
      const elapsed = performance.now() - start;
      const picker: MockQuickPick = window.createQuickPick.mock.results.at(-1)?.value;
      expect(picker.title).toContain('Search complete');
      expect(picker.items.filter(item => item.id)).toHaveLength(200);
      expect(picker.items.length).toBeLessThanOrEqual(400);
      const total = Number(/(\d+) matching lines/.exec(picker.title)?.[1]);
      expect(total).toBeGreaterThan(1000);
      picker.clickButton('Next page');
      await expect.poll(() => picker.title, { interval: 10 }).toContain('Page 2/');
      await new Promise(resolve => setTimeout(resolve, 20));
      console.log(JSON.stringify({ query, matchingLines: total, elapsedMs: elapsed, maxEventLoopGapMs: maxGap }));
      expect(maxGap).toBeLessThan(150);
      expect(logs.some(log => log.startsWith('Text search failed'))).toBe(false);
    } finally { clearInterval(heartbeat); }
  }
}, 120_000);

it.skipIf(!root)('opens a streamed file and switches to file search without waiting for a broad scan', async () => {
  const start = performance.now();
  const searching = controller.show(false, 'contents', 'e');
  let picker: MockQuickPick;
  await expect.poll(() => {
    picker = window.createQuickPick.mock.results.at(-1)?.value;
    return picker.items.some(item => item.id);
  }, { interval: 10 }).toBe(true);
  const firstResultsMs = performance.now() - start;
  picker = window.createQuickPick.mock.results.at(-1)?.value;
  expect(picker.busy).toBe(true);
  const openStart = performance.now();
  await controller.openBeside();
  const openMs = performance.now() - openStart;
  await searching;
  expect(picker.dispose).toHaveBeenCalled();
  expect(window.activeTextEditor).toBeDefined();
  workspace.findFiles.mockResolvedValue([Uri.file(`${root}\\package.json`)]);
  const nextSearch = controller.show(false, 'contents', 'e');
  await expect.poll(() => {
    picker = window.createQuickPick.mock.results.at(-1)?.value;
    return picker.items.some(item => item.id);
  }, { interval: 10 }).toBe(true);
  const switchStart = performance.now();
  await controller.show(false, 'files', '');
  const switchMs = performance.now() - switchStart;
  picker = window.createQuickPick.mock.results.at(-1)?.value;
  expect(picker.items[0]?.id).toBe(Uri.file(`${root}\\package.json`).toString());
  await nextSearch;
  console.log(JSON.stringify({ firstResultsMs, openMs, switchMs }));
  expect(firstResultsMs).toBeLessThan(1000);
  expect(openMs).toBeLessThan(250);
  expect(switchMs).toBeLessThan(250);
}, 30_000);
