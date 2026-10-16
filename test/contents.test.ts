import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { FileProvider } from '../src/files';
import {
  configurationChanged, createDocument, documentChanged, fileChanged, fileCreated,
  resetEditors, settings, Uri, workspace
} from './vscode';

let directory: string;
let files: FileProvider;
let provider: ContentProvider;
const log = vi.fn();
beforeEach(async () => {
  resetEditors();
  directory = await mkdtemp(join(tmpdir(), 'telescope-text-'));
  workspace.workspaceFolders = [{ uri: Uri.file(directory), name: 'workspace', index: 0 }];
  workspace.findFiles.mockResolvedValue([]);
  workspace.fs.stat.mockImplementation(async uri => {
    try { return { size: (await stat(uri.fsPath)).size }; }
    catch (reason) {
      if (reason instanceof Error && 'code' in reason && reason.code === 'ENOENT') throw vscode.FileSystemError.FileNotFound();
      throw reason;
    }
  });
  files = new FileProvider();
  provider = new ContentProvider(files, log);
});
afterEach(async () => {
  provider.dispose();
  files.dispose();
  await rm(directory, { recursive: true });
});

async function fixture(name: string, text: string | Buffer): Promise<Uri> {
  const path = join(directory, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return Uri.file(path);
}
async function search(query: string): Promise<ContentUpdate> {
  const updates: ContentUpdate[] = [];
  await provider.search(query, update => updates.push(update));
  const last = updates.at(-1);
  if (!last) throw new Error('Expected search updates');
  expect(last.complete).toBe(true);
  return last;
}

it('searches literal text in the backend, ignores case and does not wait for workspace discovery', async () => {
  const first = await fixture('first.ts', '// title\r\nconst fuzzyNeedle = 1;\r\n');
  const second = await fixture('file with spaces.ts', 'const FUZZYNEEDLE = 2;\n');
  const result = await search('fuzzyNeedle');
  expect(result.total).toBe(2);
  expect(result.items.map(item => item.id)).toEqual(expect.arrayContaining([
    JSON.stringify([first.toString(), 1]), JSON.stringify([second.toString(), 0])
  ]));
  for (const item of result.items)
    expect(item.location.matches.map(index => item.location.text[index]).join('').toLowerCase()).toBe('fuzzyneedle');
  expect((await search('fzndl')).total).toBe(0);
  expect(workspace.findFiles).not.toHaveBeenCalled();
});

it('preserves regex punctuation, whitespace and Unicode UTF-16 match positions', async () => {
  await fixture('literal.ts', '\u{1F600} [A].*  [a].* \n  \n-needle\n');
  const result = await search(' [a].* ');
  expect(result.items[0]?.location.matches).toHaveLength(14);
  expect(result.items[0]?.location.matches[0]).toBe(2);
  expect((await search('  ')).total).toBe(2);
  expect((await search('-needle')).total).toBe(1);
});

it('uses dirty text instead of disk matches and supports open virtual documents', async () => {
  const uri = await fixture('dirty.ts', 'const diskOnly = true;');
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(uri.toString()), true, '// comment\nconst unsavedNeedle = 1;'));
  expect((await search('unsavedNeedle')).items[0]?.location.line).toBe(1);
  expect((await search('diskOnly')).total).toBe(0);
  const root = Uri.parse('memfs:///workspace');
  workspace.workspaceFolders = [{ uri: root, name: 'virtual', index: 0 }];
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(`${root.toString()}/dirty.ts`), true, 'virtualNeedle'));
  const result = await search('virtualNeedle');
  expect(result.items[0]?.uri).toBe(`${root.toString()}/dirty.ts`);
  expect(result.unsupported).toBe(1);
});

it('quickly searches beyond 32 MiB/100,000 lines without sending every line to the host', async () => {
  await fixture('large.txt', `${'a'.repeat(340)}\n`.repeat(100_001) + 'uniqueNeedle\n'.repeat(205));
  const times: number[] = [];
  for (let index = 0; index < 5; index++) {
    const started = performance.now();
    const result = await search('uniqueNeedle');
    times.push(performance.now() - started);
    expect(result.total).toBe(205);
    expect(result.items).toHaveLength(205);
    expect(result.items[0]?.location.line).toBe(100_001);
    expect(result.items.at(-1)?.location.line).toBe(100_205);
  }
  const worst = Math.max(...times);
  console.log(`34 MiB literal search, five full-provider runs (ms): ${times.map(value => value.toFixed(1)).join(', ')}`);
  expect(worst).toBeLessThan(500);
}, 20_000);

it('returns every matching line across large on-disk and dirty files without truncation', async () => {
  await fixture('many.txt', 'allMatchesNeedle\n'.repeat(20_005));
  const dirty = await fixture('dirty-many.ts', 'diskOnlyNeedle\n');
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(dirty.toString()), true, 'allMatchesNeedle\n'.repeat(305)));
  const result = await search('allMatchesNeedle');
  expect(result.total).toBe(20_310);
  expect(result.items).toHaveLength(result.total);
  expect(new Set(result.items.map(item => item.id)).size).toBe(result.total);
  expect(result.items.filter(item => item.path === 'dirty-many.ts')).toHaveLength(305);
  expect(result.items.at(-1)?.location.line).toBe(20_004);
  expect(result.complete).toBe(true);
});

it('skips matching binary/unsupported-encoding files and decodes UTF-16', async () => {
  await fixture('binary.dat', Buffer.from('needle\n\0needle\n'));
  await fixture('invalid.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff]), Buffer.from('needle\n')]));
  const utf16 = await fixture('utf16.txt', Buffer.from('\uFEFFheader\r\nneedle\r\n', 'utf16le'));
  const result = await search('needle');
  expect(result.items.every(item => !item.uri.endsWith('binary.dat'))).toBe(true);
  expect(result.unsupported).toBe(1);
  expect(result.total).toBe(1);
  expect(result.items[0]?.uri).toBe(utf16.toString());
  expect(result.items[0]?.location).toMatchObject({ line: 1, text: 'needle' });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('unsupported encoding'));
});

it('handles CR-only line endings and UTF-8 BOM', async () => {
  await fixture('cr.txt', '\uFEFFheader\r\rneedle\rnext\r');
  expect((await search('needle')).items[0]?.location).toMatchObject({ line: 2, text: 'needle' });
});

it('honors files/search exclusions and ignore files for both disk and dirty matches', async () => {
  await fixture('.gitignore', 'ignored/\nignored.ts\n');
  await fixture('.ignore', 'local-only.ts\n');
  const ignored = await fixture('ignored.ts', 'needle');
  await fixture('ignored/deep.ts', 'needle');
  await fixture('local-only.ts', 'needle');
  await fixture('files-only/file.ts', 'needle');
  await fixture('search-only/file.ts', 'needle');
  await fixture('overridden/file.ts', 'needle');
  await fixture('.hidden.ts', 'needle');
  await fixture('visible.ts', 'needle');
  settings.set('files.exclude', { '**/files-only': true, '**/overridden': true });
  settings.set('search.exclude', { '**/search-only': true, '**/overridden': false });
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(ignored.toString()), true, 'needle'));
  const result = await search('needle');
  expect(result.items.map(item => item.path).sort()).toEqual(['.hidden.ts', 'overridden/file.ts', 'visible.ts']);
  settings.set('search.useIgnoreFiles', false);
  configurationChanged.fire({ affectsConfiguration: section => section === 'search' });
  expect((await search('needle')).items.map(item => item.path)).toEqual(expect.arrayContaining([
    'ignored.ts', 'ignored/deep.ts', 'local-only.ts'
  ]));
});

it('applies sibling-dependent exclusions and surfaces unexpected sibling-read errors', async () => {
  await fixture('generated.ts', 'source');
  const generated = await fixture('generated.js', 'needle');
  await fixture('standalone.js', 'needle');
  settings.set('files.exclude', { '**/*.js': { when: '$(basename).ts' } });
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(generated.toString()), true, 'needle'));
  expect((await search('needle')).items.map(item => item.path)).toEqual(['standalone.js']);
  workspace.fs.stat.mockRejectedValue(new Error('Permission denied'));
  await expect(search('needle')).rejects.toThrow('Permission denied');
});

it('honors parent-ignore settings without changing the user global Git configuration', async () => {
  await fixture('.ignore', 'ignored.ts\n');
  await fixture('nested/ignored.ts', 'needle');
  workspace.workspaceFolders = [{ uri: Uri.file(join(directory, 'nested')), name: 'nested', index: 0 }];
  expect((await search('needle')).total).toBe(1);
  settings.set('search.useParentIgnoreFiles', true);
  expect((await search('needle')).total).toBe(0);
});

it('deduplicates overlapping roots and distinguishes equal root names', async () => {
  await fixture('root.ts', 'needle');
  await fixture('nested/sample.ts', 'needle');
  workspace.workspaceFolders.push({ uri: Uri.file(join(directory, 'nested')), name: 'workspace', index: 1 });
  const result = await search('needle');
  expect(result.total).toBe(2);
  expect(new Set(result.items.map(item => item.uri)).size).toBe(2);
  expect(result.items.every(item => item.root.includes('file:'))).toBe(true);
});

it('discloses unsupported roots and reports missing backend/executable failures', async () => {
  workspace.workspaceFolders = [{ uri: Uri.parse('memfs:///workspace'), name: 'virtual', index: 0 }];
  expect(await search('needle')).toMatchObject({ unsupported: 1, total: 0 });
  workspace.workspaceFolders = [{ uri: Uri.file(directory), name: 'workspace', index: 0 }];
  provider.dispose();
  provider = new ContentProvider(files, log, async () => { throw new Error('Backend missing'); });
  await expect(search('needle')).rejects.toThrow('Backend missing');
  provider.dispose();
  provider = new ContentProvider(files, log, async () => join(directory, 'missing-rg.exe'));
  await expect(search('needle')).rejects.toThrow('ENOENT');
});

it('reports query/backend errors instead of presenting a completed empty search', async () => {
  await expect(search('')).rejects.toThrow('single-line');
  await expect(search('line\nbreak')).rejects.toThrow('single-line');
  await expect(search('\0')).rejects.toThrow('NUL');
  settings.set('search.exclude', { '[': true });
  await expect(search('needle')).rejects.toThrow('Text search failed');
});

it('cancels live updates and invalidates on document, filesystem and search-setting changes', async () => {
  const uri = await fixture('live.ts', 'needle\n'.repeat(2000));
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(uri.toString()), true, 'needle\n'.repeat(2000)));
  const updates: ContentUpdate[] = [];
  await expect(provider.search('needle', update => {
    updates.push(update);
    provider.cancel();
  })).rejects.toBeInstanceOf(vscode.CancellationError);
  expect(updates).toHaveLength(1);
  const changed = vi.fn();
  provider.onDidChange(changed);
  fileChanged.fire();
  const document = workspace.textDocuments[0];
  if (!document) throw new Error('Expected workspace document');
  documentChanged.fire({ document, contentChanges: [{}] });
  fileCreated.fire();
  configurationChanged.fire({ affectsConfiguration: section => section === 'search' });
  expect(changed).toHaveBeenCalledTimes(4);
});

it('terminates the query-specific backend when a search is cancelled', async () => {
  await fixture('stream.txt', 'needle\n'.repeat(20_000));
  const updates: ContentUpdate[] = [];
  await expect(provider.search('needle', update => {
    updates.push(update);
    provider.cancel();
  })).rejects.toBeInstanceOf(vscode.CancellationError);
  expect(updates).toHaveLength(1);
});
