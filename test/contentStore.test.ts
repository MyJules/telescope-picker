import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { ContentStore } from '../src/contentStore';
import { FileProvider } from '../src/files';
import { createDocument, resetEditors, settings, Uri, workspace } from './vscode';

let directory: string;
let files: FileProvider;
let provider: ContentProvider;
const services: ContentStore[] = [];
const log = vi.fn();

vi.mock('../src/contentStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/contentStore')>();
  return {
    ...actual,
    ContentStore: class extends actual.ContentStore {
      constructor(path = join(directory, 'worker.cjs')) { super(path); }
    }
  };
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'telescope-content-worker-'));
  await build({
    entryPoints: ['src/contentStoreWorker.ts'], outfile: join(directory, 'worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022'
  });
});
afterAll(async () => { await rm(directory, { recursive: true }); });

let fixture: string;
beforeEach(async () => {
  resetEditors();
  fixture = await mkdtemp(join(tmpdir(), 'telescope-paged-search-'));
  workspace.workspaceFolders = [{ uri: Uri.file(fixture), name: 'workspace', index: 0 }];
  files = new FileProvider();
  provider = new ContentProvider(files, log);
});
afterEach(async () => {
  provider.dispose();
  files.dispose();
  services.splice(0).forEach(service => service.dispose());
  await rm(fixture, { recursive: true });
});

async function search(query: string, selectedId: () => string | undefined = () => undefined): Promise<ContentUpdate> {
  let last: ContentUpdate | undefined;
  await provider.search(query, update => { last = update; }, { size: 200, selectedId });
  if (!last) throw new Error('Expected paged search results');
  return last;
}

it('pages real backend output with exact IDs, line order, dirty text, ignores and encoding handling', async () => {
  await writeFile(join(fixture, '.gitignore'), 'ignored.ts\n');
  await writeFile(join(fixture, 'ignored.ts'), 'needle');
  await writeFile(join(fixture, 'excluded.ts'), 'needle');
  settings.set('search.exclude', { 'excluded.ts': true });
  await writeFile(join(fixture, 'z.ts'), 'needle\n'.repeat(300));
  await writeFile(join(fixture, 'a.ts'), 'needle\n'.repeat(205));
  await writeFile(join(fixture, 'dirty.ts'), 'disk needle');
  const dirty = vscode.Uri.file(join(fixture, 'dirty.ts'));
  workspace.textDocuments.push(createDocument(dirty, true, 'header\nneedle\nneedle'));
  await writeFile(join(fixture, 'binary.dat'), Buffer.from('needle\n\0needle'));
  await writeFile(join(fixture, 'invalid.txt'), Buffer.from([0xff, ...Buffer.from('needle')]));
  await writeFile(join(fixture, 'cr.txt'), '\uFEFFheader\r\rneedle\r');
  await writeFile(join(fixture, 'utf16.txt'), Buffer.from('\uFEFFheader\r\nneedle\r\n', 'utf16le'));
  const first = await search('needle');
  expect(first.complete).toBe(true);
  expect(first.total).toBe(509);
  expect(first.unsupported).toBe(1);
  expect(first.items).toHaveLength(200);
  const second = await first.page?.load(200);
  const third = await first.page?.load(400);
  const all = [...first.items, ...second?.items ?? [], ...third?.items ?? []];
  expect(all).toHaveLength(509);
  expect(new Set(all.map(item => item.id)).size).toBe(509);
  expect(all.filter(item => item.uri === dirty.toString()).map(item => item.location.line)).toEqual([1, 2]);
  expect(all.find(item => item.path === 'cr.txt')?.location.line).toBe(2);
  expect(all.find(item => item.path === 'utf16.txt')?.location.line).toBe(1);
  expect(all[0]?.id).toBe(JSON.stringify([vscode.Uri.file(join(fixture, 'a.ts')).toString(), 0]));
  expect(all.at(-1)?.location.line).toBe(299);
  const selected = all.at(-1)?.id;
  const resumed = await search('needle', () => selected);
  expect(resumed.page?.offset).toBe(400);
  provider.cancel();
  await expect(resumed.page?.load(0)).rejects.toBeInstanceOf(vscode.CancellationError);
});

it('cancels worker-backed scans during streaming and can immediately search again', async () => {
  await writeFile(join(fixture, 'first.ts'), 'needle');
  await writeFile(join(fixture, 'many.ts'), 'needle\n'.repeat(20_000));
  const updates: ContentUpdate[] = [];
  await expect(provider.search('needle', update => {
    updates.push(update);
    provider.cancel();
  }, { size: 200, selectedId: () => undefined })).rejects.toBeInstanceOf(vscode.CancellationError);
  expect(updates).toHaveLength(1);
  expect((await search('notPresent')).total).toBe(0);
});

it('decodes and parses a matching record spanning many backend chunks without losing text or UTF-16 positions', async () => {
  const text = `${'\u{1F600}'.repeat(150_000)}needle`;
  await writeFile(join(fixture, 'long.ts'), text);
  const result = await search('needle');
  expect(result.total).toBe(1);
  expect(result.items[0]?.location.text).toBe(text);
  expect(result.items[0]?.location.matches).toEqual([300_000, 300_001, 300_002, 300_003, 300_004, 300_005]);
}, 10_000);

it('reports worker and parser failures explicitly and rejects requests after disposal', async () => {
  const missing = new ContentStore(join(directory, 'missing.cjs'));
  services.push(missing);
  await expect(missing.page(0, 200)).rejects.toThrow();
  const store = new ContentStore();
  services.push(store);
  await expect(store.parse('needle', ['invalid JSON'])).rejects.toThrow('Content result storage failed');
  await expect(store.page(-1, 200)).rejects.toThrow('Invalid content result page');
  store.dispose();
  await expect(store.page(0, 200)).rejects.toBeInstanceOf(vscode.CancellationError);
});
