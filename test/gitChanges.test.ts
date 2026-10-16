import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { GitChangesProvider, parseDiffHunks, type GitAPI } from '../src/gitChanges';
import type { ContentUpdate } from '../src/contents';
import { createDocument, documentChanged, resetEditors, workspace } from './vscode';

let directory: string;
let provider: GitChangesProvider;
let api: GitAPI;
const event: vscode.Event<void> = () => ({ dispose() {} });
const git = (...args: string[]): string => execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
const uri = (path: string): vscode.Uri => vscode.Uri.file(join(directory, path));
const change = (path: string, status: number, original = path) => ({
  uri: uri(path), originalUri: uri(original), status
});
const state = () => {
  const value = api.repositories[0]?.state;
  if (!value) throw new Error('Missing repository');
  return value;
};
async function search(query: string): Promise<ContentUpdate> {
  let result: ContentUpdate | undefined;
  await provider.search(query, update => { result = update; });
  if (!result) throw new Error('Missing search result');
  expect(result.complete).toBe(true);
  return result;
}
beforeEach(async () => {
  resetEditors();
  directory = await mkdtemp(join(tmpdir(), 'telescope-git-'));
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Picker Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await writeFile(join(directory, 'file with spaces.ts'), 'heading\nconst oldNeedle = 1;\ncontext\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  api = {
    git: { path: 'git' },
    repositories: [{ rootUri: vscode.Uri.file(directory), state: {
      indexChanges: [], workingTreeChanges: [], untrackedChanges: [], mergeChanges: [], onDidChange: event
    } }],
    onDidOpenRepository: () => ({ dispose() {} }), onDidCloseRepository: () => ({ dispose() {} }),
    toGitUri: (uri, ref) => vscode.Uri.parse(`git:${uri.path}?${encodeURIComponent(ref)}`)
  };
  workspace.openTextDocument.mockImplementation(async value => {
    const parsed = typeof value === 'string' ? vscode.Uri.parse(value) : value;
    return createDocument(parsed, false, await readFile(parsed.fsPath, 'utf8'));
  });
  provider = new GitChangesProvider(async () => api);
});
afterEach(async () => {
  provider.dispose();
  await rm(directory, { recursive: true });
  vi.restoreAllMocks();
});

it('parses only changed lines with correct old/new coordinates, CRLF, and no-newline markers', () => {
  expect(parseDiffHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -2,2 +2,2 @@\n-oldNeedle\r\n context\n+newNeedle\r\n\\ No newline at end of file\n')[0]?.lines)
    .toEqual([
      { side: 'removed', line: 1, modifiedLine: 1, text: 'oldNeedle' },
      { side: 'added', line: 2, modifiedLine: 2, text: 'newNeedle' }
    ]);
  expect(parseDiffHunks('@@ -0,0 +1 @@\n+first\n')[0]?.lines).toEqual([
    { side: 'added', line: 0, modifiedLine: 0, text: 'first' }
  ]);
  expect(() => parseDiffHunks('@@ -1,2 +1 @@\n-one\n+two\n')).toThrow('diff');
});

it('shows a whole hunk immediately and optionally filters its changed text or filename', async () => {
  await writeFile(uri('file with spaces.ts').fsPath, 'heading\nconst newNeedle = "[A].*";\ncontext\n');
  Object.assign(state(), { workingTreeChanges: [change('file with spaces.ts', 5)] });
  const result = await search('');
  expect(result.items.map(item => [item.diff?.side, item.location.line, item.location.text])).toEqual([
    ['added', 1, 'const newNeedle = "[A].*";']
  ]);
  expect(result.items[0]?.uri).toBe(uri('file with spaces.ts').toString());
  expect(result.items[0]?.diff?.hunk).toContain('+1 / -1');
  expect((await search('oldNeedle')).total).toBe(1);
  expect((await search('file with spaces')).total).toBe(1);
  expect((await search('context')).total).toBe(0);
  expect((await search('[a].*')).total).toBe(1);
  expect(result.items[0]?.diff?.title).toBe('file with spaces.ts (Unstaged)');
});

it('separates staged and unstaged hunks of the same file without expanding each changed line', async () => {
  await writeFile(uri('file with spaces.ts').fsPath, 'stageNeedle\n'.repeat(305));
  git('add', '.');
  await writeFile(uri('file with spaces.ts').fsPath, 'workNeedle\n');
  Object.assign(state(), { indexChanges: [change('file with spaces.ts', 0)], workingTreeChanges: [change('file with spaces.ts', 5)] });
  const result = await search('stageNeedle');
  expect(result.total).toBe(2);
  expect(new Set(result.items.map(item => item.id)).size).toBe(2);
  expect(result.items[0]?.diff?.hunk).toContain('+305 / -3');
  expect(result.items[1]?.diff?.hunk).toContain('+1 / -305');
  expect(result.items[0]?.diff?.right).toContain('git:');
});

it('handles staged additions, deletions and renames without filename parsing', async () => {
  await rename(uri('file with spaces.ts').fsPath, uri('renamed \u00e9.ts').fsPath);
  await writeFile(uri('added.ts').fsPath, 'addedNeedle\n');
  git('add', '-A');
  Object.assign(state(), { indexChanges: [
    change('renamed \u00e9.ts', 3, 'file with spaces.ts'), change('added.ts', 1)
  ] });
  const result = await search('Needle');
  expect(result.items.some(item => item.diff?.emptyLeft && item.location.text === 'addedNeedle')).toBe(true);
  expect(result.items.filter(item => item.path === 'renamed \u00e9.ts')).toEqual([]);
  expect((await search('')).items.find(item => item.path === 'renamed \u00e9.ts')?.diff?.metadataOnly).toBe(true);
  await rm(uri('renamed \u00e9.ts').fsPath);
  git('add', '-A');
  Object.assign(state(), { indexChanges: [change('file with spaces.ts', 2)] });
  expect((await search('oldNeedle')).items[0]?.diff?.emptyRight).toBe(true);
});

it('handles an unborn repository index and untracked live documents without duplicate results', async () => {
  git('checkout', '--orphan', 'unborn');
  await writeFile(uri('fresh.ts').fsPath, 'freshNeedle\n');
  git('add', 'fresh.ts');
  Object.assign(state(), {
    indexChanges: [change('fresh.ts', 1)],
    workingTreeChanges: [change('untracked.ts', 7)], untrackedChanges: [change('untracked.ts', 7)]
  });
  await writeFile(uri('untracked.ts').fsPath, 'freshNeedle\nfreshNeedle\n');
  const result = await search('freshNeedle');
  expect(result.total).toBe(2);
  expect(result.items.every(item => item.diff?.emptyLeft)).toBe(true);
});

it('searches conflicted working files against the merge base without duplicating normal changes', async () => {
  git('checkout', '-qb', 'other');
  await writeFile(uri('file with spaces.ts').fsPath, 'theirsNeedle\n');
  git('commit', '-qam', 'theirs');
  git('checkout', '-q', 'main');
  await writeFile(uri('file with spaces.ts').fsPath, 'oursNeedle\n');
  git('commit', '-qam', 'ours');
  expect(() => git('merge', 'other')).toThrow();
  Object.assign(state(), { mergeChanges: [change('file with spaces.ts', 18)], workingTreeChanges: [change('file with spaces.ts', 18)] });
  const result = await search('theirsNeedle');
  expect(result.total).toBe(1);
  expect(result.items[0]?.root).toContain('Conflict');
  expect(result.items[0]?.diff?.side).toBe('added');
  expect((await search('oldNeedle')).total).toBe(1);
  expect((await search('oldNeedle')).items[0]?.diff?.left).toContain('%3A1');
});

it('includes binary changes as native-diff rows and reports errors explicitly', async () => {
  await writeFile(uri('binary.dat').fsPath, Buffer.from('oldNeedle\0'));
  git('add', '.');
  git('commit', '-qm', 'binary');
  await writeFile(uri('binary.dat').fsPath, Buffer.from('newNeedle\0'));
  Object.assign(state(), { workingTreeChanges: [change('binary.dat', 5)] });
  expect((await search('Needle')).binary).toBe(1);
  const binary = await search('');
  expect(binary.items[0]?.diff).toMatchObject({ metadataOnly: true, hunk: 'Binary file change' });
  await expect(search('a\nb')).rejects.toThrow('single-line');
  api = { ...api, repositories: [] };
  const empty = new GitChangesProvider(async () => api);
  try { await expect(empty.search('Needle', () => {})).rejects.toThrow('No Git repositories'); }
  finally { empty.dispose(); }
  Object.assign(api.git, { path: 'missing-telescope-git-executable' });
  await expect(search('Needle')).rejects.toThrow('Git diff failed');
});

it('returns separate distant hunks, groups nearby edits, and has no 200-hunk limit', async () => {
  const original = Array.from({ length: 2400 }, (_, line) => `line ${line}`).join('\n') + '\n';
  await writeFile(uri('many.ts').fsPath, original);
  git('add', '.');
  git('commit', '-qm', 'many hunks');
  const changed = original.split('\n');
  for (let line = 0; line < 2400; line += 10) changed[line] = `changed ${line}`;
  await writeFile(uri('many.ts').fsPath, changed.join('\n'));
  Object.assign(state(), { workingTreeChanges: [change('many.ts', 5)] });
  const result = await search('');
  expect(result.total).toBe(240);
  expect(new Set(result.items.map(item => item.id)).size).toBe(240);
  expect(result.items[1]?.diff?.modifiedLine).toBe(10);
  expect(result.items.at(-1)?.diff?.modifiedLine).toBe(2390);
});

it('rejects obsolete searches before publishing and forwards repository changes', async () => {
  let release: ((api: GitAPI) => void) | undefined;
  const delayed = new GitChangesProvider(() => new Promise<GitAPI>(done => { release = done; }));
  const update = vi.fn();
  const pending = delayed.search('Needle', update);
  delayed.cancel();
  if (!release) throw new Error('Expected Git initialization');
  release(api);
  await pending;
  expect(update).not.toHaveBeenCalled();
  delayed.dispose();
  const emitter = new vscode.EventEmitter<void>();
  Object.assign(state(), { onDidChange: emitter.event });
  const changed = vi.fn();
  provider.onDidChange(changed);
  await search('Needle');
  emitter.fire();
  expect(changed).toHaveBeenCalledOnce();
  emitter.dispose();
});

it('refreshes live untracked text without restarting for unrelated document edits', async () => {
  Object.assign(state(), { untrackedChanges: [change('live.ts', 7)] });
  await writeFile(uri('live.ts').fsPath, 'oldNeedle\n');
  await search('Needle');
  const changed = vi.fn();
  provider.onDidChange(changed);
  const live = createDocument(uri('live.ts'), true, 'liveNeedle');
  documentChanged.fire({ document: live, contentChanges: [{ text: 'liveNeedle' }] });
  expect(changed).toHaveBeenCalledOnce();
  documentChanged.fire({ document: createDocument(uri('unrelated.ts'), true), contentChanges: [{ text: 'unrelated' }] });
  expect(changed).toHaveBeenCalledOnce();
});
