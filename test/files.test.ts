import { afterEach, beforeEach, expect, it } from 'vitest';
import { FileProvider } from '../src/files';
import { fileCreated, workspace, Uri } from './vscode';

let provider: FileProvider;
beforeEach(() => {
  workspace.workspaceFolders = [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }];
  workspace.findFiles.mockResolvedValue([Uri.parse('file:///workspace/src/main.cpp')]);
  provider = new FileProvider();
});
afterEach(() => provider.dispose());

it('shares discovery and caches results with default files.exclude semantics', async () => {
  const [first, second] = await Promise.all([provider.getFiles(), provider.getFiles()]);
  expect(first).toBe(second);
  await provider.getFiles();
  expect(workspace.findFiles).toHaveBeenCalledTimes(1);
  expect(workspace.findFiles.mock.calls[0]?.[1]).toBeUndefined();
  expect(first.files[0]?.path).toBe('src/main.cpp');
});
it('invalidates on file creation and discovers again', async () => {
  await provider.getFiles();
  workspace.findFiles.mockResolvedValueOnce([Uri.parse('file:///workspace/new.ts')]);
  fileCreated.fire();
  expect((await provider.getFiles()).files[0]?.path).toBe('new.ts');
  expect(workspace.findFiles).toHaveBeenCalledTimes(2);
});
it('does not cache cancelled in-flight discovery', async () => {
  let resolve: (uris: Uri[]) => void = () => { throw new Error('No pending discovery'); };
  workspace.findFiles.mockImplementationOnce(() => new Promise<Uri[]>(done => { resolve = done; }));
  const pending = provider.getFiles();
  provider.cancel();
  resolve([Uri.parse('file:///workspace/obsolete')]);
  await expect(pending).rejects.toThrow();
  expect((await provider.getFiles()).files[0]?.path).toBe('src/main.cpp');
});
it('deduplicates overlapping roots and distinguishes equal root names', async () => {
  workspace.workspaceFolders.push({ uri: Uri.parse('file:///workspace/nested'), name: 'workspace', index: 1 });
  workspace.findFiles.mockResolvedValue([
    Uri.parse('file:///workspace/src/main.cpp'), Uri.parse('file:///workspace/nested/main.cpp')
  ]);
  const indexed = await provider.getFiles();
  expect(indexed.files).toHaveLength(2);
  expect(new Set(indexed.files.map(file => file.root)).size).toBe(2);
});
