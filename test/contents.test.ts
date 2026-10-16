import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ContentProvider, type ContentUpdate } from '../src/contents';
import { FileProvider } from '../src/files';
import { createDocument, documentChanged, fileChanged, fileCreated, resetEditors, Uri, workspace } from './vscode';

let directory: string;
let files: FileProvider;
let provider: ContentProvider;
const log = vi.fn();
beforeEach(async () => {
  resetEditors();
  directory = await mkdtemp(join(tmpdir(), 'telescope-content-'));
  workspace.workspaceFolders = [{ uri: Uri.file(directory), name: 'workspace', index: 0 }];
  workspace.findFiles.mockResolvedValue([]);
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

it('fuzzy-matches individual lines through the packaged streaming backend and distinguishes files', async () => {
  const first = await fixture('first.ts', '// title\r\nconst fuzzyNeedle = 1;\r\n');
  const second = await fixture('second.ts', 'const fuzzyNeedle = 2;\n');
  workspace.findFiles.mockResolvedValue([first, second]);
  const result = await search('fzndl');
  expect(result.total).toBe(2);
  expect(result.scanned).toBe(2);
  expect(result.items.map(item => item.id)).toEqual(expect.arrayContaining([
    JSON.stringify([first.toString(), 1]), JSON.stringify([second.toString(), 0])
  ]));
  for (const item of result.items)
    expect(item.location.matches.map(index => item.location.text[index]).join('').toLowerCase()).toBe('fzndl');
  expect(workspace.findFiles.mock.calls[0]?.[2]).toBeUndefined();
});

it('searches dirty live contents instead of stale disk text, including non-filesystem documents', async () => {
  const uri = await fixture('dirty.ts', 'const diskOnly = true;');
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(uri.toString()), true, '// comment\nconst unsavedNeedle = 1;'));
  workspace.findFiles.mockResolvedValue([uri]);
  expect((await search('unsvndl')).items[0]?.location.line).toBe(1);
  expect((await search('diskOnly')).total).toBe(0);
  const virtual = Uri.parse('memfs:///workspace/dirty.ts');
  workspace.findFiles.mockResolvedValue([virtual]);
  workspace.textDocuments.push(createDocument(vscode.Uri.parse(virtual.toString()), true, 'virtualNeedle'));
  expect((await search('vrtndl')).items[0]?.uri).toBe(virtual.toString());
});

it('has no total byte/line index cap and only retains the best 200 matching lines', async () => {
  const uri = await fixture('large.txt', `${'a'.repeat(340)}\n`.repeat(100_001) + 'uniqueNeedle\n'.repeat(205));
  workspace.findFiles.mockResolvedValue([uri]);
  const result = await search('uniqueNeedle');
  expect(result.total).toBe(205);
  expect(result.items).toHaveLength(200);
  expect(result.items[0]?.location.line).toBe(100_001);
  expect(result.items.at(-1)?.location.line).toBe(100_200);
}, 20_000);

it('skips binary/invalid UTF-8 with explicit counts and decodes UTF-16 text', async () => {
  const binary = await fixture('binary.dat', Buffer.from('needle\n\0needle\n'));
  const invalid = await fixture('invalid.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0xff]), Buffer.from('needle\n')]));
  const utf16 = await fixture('utf16.txt', Buffer.from('\uFEFFheader\r\nneedle\r\n', 'utf16le'));
  workspace.findFiles.mockResolvedValue([binary, invalid, utf16]);
  const result = await search('needle');
  expect(result.binary).toBe(1);
  expect(result.unsupported).toBe(1);
  expect(result.total).toBe(1);
  expect(result.items[0]?.uri).toBe(utf16.toString());
  expect(result.items[0]?.location).toMatchObject({ line: 1, text: 'needle' });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('non-UTF-8'));
});

it('handles lone CR line endings and UTF-8 BOM without shifting preview locations', async () => {
  workspace.findFiles.mockResolvedValue([await fixture('cr.txt', '\uFEFFheader\r\rneedle\rnext\r')]);
  const result = await search('needle');
  expect(result.items[0]?.location).toMatchObject({ line: 2, text: 'needle' });
});

it('discloses unsupported unopened resources rather than pretending they were searched', async () => {
  workspace.findFiles.mockResolvedValue([Uri.parse('memfs:///workspace/file.ts')]);
  const result = await search('needle');
  expect(result).toMatchObject({ unsupported: 1, scanned: 1, files: 1, total: 0 });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('filesystem URI'));
});

it('reports deleted files and missing backend failures explicitly', async () => {
  workspace.findFiles.mockResolvedValue([Uri.file(join(directory, 'deleted.ts'))]);
  await expect(search('needle')).rejects.toThrow('Content search failed');
  provider.dispose();
  provider = new ContentProvider(files, log, async () => { throw new Error('Backend missing'); });
  await expect(search('needle')).rejects.toThrow('Backend missing');
});

it('reports a missing packaged executable without hanging the scan', async () => {
  workspace.findFiles.mockResolvedValue([await fixture('source.ts', 'needle')]);
  provider.dispose();
  provider = new ContentProvider(files, log, async () => join(directory, 'missing-rg.exe'));
  await expect(search('needle')).rejects.toThrow('ENOENT');
});

it('cancels live scanning, discards obsolete updates and signals all relevant changes', async () => {
  const uri = Uri.file(join(directory, 'live.ts'));
  workspace.findFiles.mockResolvedValue([uri]);
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
  documentChanged.fire();
  fileCreated.fire();
  expect(changed).toHaveBeenCalledTimes(3);
});

it('terminates the streaming backend when a content query is cancelled', async () => {
  workspace.findFiles.mockResolvedValue([await fixture('stream.txt', 'needle\n'.repeat(20_000))]);
  const updates: ContentUpdate[] = [];
  await expect(provider.search('needle', update => {
    updates.push(update);
    provider.cancel();
  })).rejects.toBeInstanceOf(vscode.CancellationError);
  expect(updates).toHaveLength(1);
});
