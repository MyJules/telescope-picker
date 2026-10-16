import * as vscode from 'vscode';
import type { IndexedFile } from './ranking';
import { searchFilters } from './searchFilters';

const INDEX_LIMIT = 100_000;

export class FileProvider implements vscode.Disposable {
  private cache: { files: IndexedFile[]; truncated: boolean } | undefined;
  private pending: Promise<{ files: IndexedFile[]; truncated: boolean }> | undefined;
  private cancellation: vscode.CancellationTokenSource | undefined;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.subscriptions.push(watcher,
      watcher.onDidCreate(() => this.invalidate()),
      watcher.onDidDelete(() => this.invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('files.exclude') || event.affectsConfiguration('telescopePicker.include')
          || event.affectsConfiguration('telescopePicker.exclude')) this.invalidate();
      }));
  }

  private invalidate(): void {
    this.cancel();
    this.cache = undefined;
    this.changed.fire();
  }

  cancel(): void {
    this.cancellation?.cancel();
    this.cancellation?.dispose();
    this.cancellation = undefined;
    this.pending = undefined;
  }

  async getFiles(): Promise<{ files: IndexedFile[]; truncated: boolean }> {
    if (this.cache) return this.cache;
    if (this.pending) return this.pending;
    const cancellation = new vscode.CancellationTokenSource();
    this.cancellation = cancellation;
    const promise = this.discover(cancellation.token, INDEX_LIMIT + 1).then(all => {
      if (cancellation.token.isCancellationRequested) throw new vscode.CancellationError();
      const result = { files: all.slice(0, INDEX_LIMIT), truncated: all.length > INDEX_LIMIT };
      this.cache = result;
      return result;
    }).finally(() => {
      if (this.cancellation === cancellation) {
        cancellation.dispose();
        this.cancellation = undefined;
        this.pending = undefined;
      }
    });
    this.pending = promise;
    return promise;
  }

  async discover(token: vscode.CancellationToken, maxPerRoot?: number): Promise<IndexedFile[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const filters = new Map(folders.map(folder => [folder.uri.toString(), searchFilters(folder)]));
    const groups = await Promise.all(folders.map(async folder => {
      const filter = filters.get(folder.uri.toString());
      if (!filter) throw new Error('Workspace search filters are unavailable.');
      const custom = filter.includes.length > 0 || filter.excludes.length > 0;
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'), undefined, custom ? undefined : maxPerRoot, token);
      return uris.flatMap(uri => {
        const owner = vscode.workspace.getWorkspaceFolder(uri) ?? folder;
        const ownerFilter = filters.get(owner.uri.toString()) ?? filter;
        if (!ownerFilter.allows(uri)) return [];
        const path = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
        const duplicateName = folders.filter(candidate => candidate.name === owner.name).length > 1;
        const root = duplicateName ? `${owner.name} (${owner.uri.toString(true)})` : owner.name;
        return [{ id: uri.toString(), path, root, name: path.slice(path.lastIndexOf('/') + 1) }];
      });
    }));
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const unique = new Map(groups.flat().map(file => [file.id, file]));
    return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  }

  dispose(): void {
    this.cancel();
    this.changed.dispose();
    this.subscriptions.forEach(subscription => subscription.dispose());
  }
}
