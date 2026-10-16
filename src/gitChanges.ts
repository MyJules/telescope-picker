import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { basename, relative } from 'node:path';
import { open } from 'node:fs/promises';
import { createContentMatcher } from './ranking';
import type { ContentUpdate } from './contents';
import type { ContentMatch, DiffTarget } from './types';

interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: number;
}
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    readonly untrackedChanges: readonly GitChange[];
    readonly mergeChanges: readonly GitChange[];
    readonly onDidChange: vscode.Event<void>;
  };
}
export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension { readonly enabled: boolean; getAPI(version: 1): GitAPI }
type ChangeKind = 'Staged' | 'Unstaged' | 'Untracked' | 'Conflict';
const enum Status {
  IndexAdded = 1, IndexDeleted = 2, Deleted = 6, Untracked = 7,
  AddedByUs = 12, AddedByThem = 13, BothAdded = 16, BothDeleted = 17
}
export interface DiffLine { side: 'added' | 'removed'; line: number; text: string; modifiedLine: number }
export interface DiffHunk { header: string; lines: DiffLine[]; addedCount?: number }

export function parseDiffHunks(patch: string): DiffHunk[] {
  const result: DiffHunk[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const text of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      if (oldRemaining || newRemaining) throw new Error('Git returned an incomplete diff hunk.');
      oldLine = Number(hunk[1]) - 1;
      newLine = Number(hunk[3]) - 1;
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      result.push({ header: text, lines: [] });
    } else if (oldRemaining || newRemaining) {
      const lines = result.at(-1)?.lines;
      if (!lines) throw new Error('Git returned a diff without a hunk header.');
      if (text.startsWith('-') && oldRemaining) {
        lines.push({ side: 'removed', line: oldLine++, text: text.slice(1).replace(/\r$/, ''), modifiedLine: Math.max(0, newLine) });
        oldRemaining--;
      } else if (text.startsWith('+') && newRemaining) {
        lines.push({ side: 'added', line: newLine, text: text.slice(1).replace(/\r$/, ''), modifiedLine: newLine++ });
        newRemaining--;
      } else if (text.startsWith(' ')) {
        oldLine++; newLine++; oldRemaining--; newRemaining--;
      } else if (!text.startsWith('\\')) {
        throw new Error('Git returned an unsupported diff hunk.');
      }
    }
  }
  if (oldRemaining || newRemaining) throw new Error('Git returned an incomplete diff.');
  return result;
}

async function gitAPI(): Promise<GitAPI> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) throw new Error('VS Code Git support is unavailable. Enable the built-in Git extension.');
  const git = await extension.activate();
  if (!git.enabled) throw new Error('VS Code Git support is disabled. Enable Git to browse changes.');
  return git.getAPI(1);
}

export class GitChangesProvider implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly repositories = new Map<GitRepository, vscode.Disposable>();
  private api: GitAPI | undefined;
  private connecting: Promise<GitAPI> | undefined;
  private generation = 0;
  private child: ReturnType<typeof execFile> | undefined;
  private disposed = false;

  constructor(private readonly connect: () => Promise<GitAPI> = gitAPI) {}

  cancel(): void {
    this.generation++;
    this.child?.kill();
    this.child = undefined;
  }

  private async getAPI(): Promise<GitAPI> {
    if (this.api) return this.api;
    this.connecting ??= this.connect();
    let api: GitAPI;
    try { api = await this.connecting; }
    finally { this.connecting = undefined; }
    if (this.disposed) throw new vscode.CancellationError();
    if (this.api) return this.api;
    this.api = api;
    const watch = (repository: GitRepository): void => {
      if (!this.repositories.has(repository)) this.repositories.set(repository,
        repository.state.onDidChange(() => this.changed.fire()));
    };
    api.repositories.forEach(watch);
    this.subscriptions.push(api.onDidOpenRepository(repository => { watch(repository); this.changed.fire(); }),
      api.onDidCloseRepository(repository => {
        this.repositories.get(repository)?.dispose();
        this.repositories.delete(repository);
        this.changed.fire();
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length || event.document.uri.scheme !== 'file') return;
        const canonical = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
        const path = canonical(event.document.uri.fsPath);
        if (api.repositories.some(repository => [...repository.state.untrackedChanges, ...repository.state.workingTreeChanges]
          .some(change => change.status === Status.Untracked && canonical(change.uri.fsPath) === path)))
          this.changed.fire();
      }));
    return api;
  }

  private patch(api: GitAPI, repository: GitRepository, change: GitChange, kind: ChangeKind, generation: number): Promise<string> {
    const paths = [...new Set([change.originalUri.fsPath, change.uri.fsPath])];
    const args = ['--no-pager', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv',
      '--no-color', '--find-renames', '--unified=3', '--inter-hunk-context=0'];
    if (kind === 'Staged') args.push('--cached');
    if (kind === 'Conflict') args.push('--base');
    args.push('--', ...paths);
    return new Promise<string>((resolve, reject) => {
      const child = execFile(api.git.path, args, {
        cwd: repository.rootUri.fsPath, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (this.child === child) this.child = undefined;
        if (generation !== this.generation) reject(new vscode.CancellationError());
        else if (error) reject(new Error(`Git diff failed in ${repository.rootUri.fsPath}: ${stderr || error.message}`));
        else resolve(stdout);
      });
      this.child = child;
    });
  }

  async search(query: string, update: (result: ContentUpdate) => void): Promise<void> {
    this.cancel();
    const generation = this.generation;
    const matchLine = query ? createContentMatcher(query) : undefined;
    const api = await this.getAPI();
    if (generation !== this.generation) return;
    if (!api.repositories.length) throw new Error('No Git repositories are open. Open a repository and wait for Source Control to initialize.');
    const items: ContentMatch[] = [];
    let binary = 0;
    let searchedRoots = 0;
    for (const repository of api.repositories) {
      const mergeUris = new Set(repository.state.mergeChanges.map(change => change.uri.toString()));
      const changes: [ChangeKind, readonly GitChange[]][] = [
        ['Staged', [...repository.state.indexChanges]], ['Unstaged', [...repository.state.workingTreeChanges]],
        ['Untracked', [...repository.state.untrackedChanges]], ['Conflict', [...repository.state.mergeChanges]]
      ];
      const seen = new Set<string>();
      for (const [kind, entries] of changes) for (const change of entries) {
        if (generation !== this.generation) return;
        if (kind !== 'Conflict' && mergeUris.has(change.uri.toString())) continue;
        const key = `${kind}:${change.uri}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Git reports untracked files in workingTreeChanges in some API versions.
        const actualKind = change.status === Status.Untracked ? 'Untracked' : kind;
        if (kind === 'Untracked' && seen.has(`Unstaged:${change.uri}`)) continue;
        const path = relative(repository.rootUri.fsPath, change.uri.fsPath).replaceAll('\\', '/');
        const root = `${basename(repository.rootUri.fsPath)} · ${actualKind} · ${repository.rootUri.fsPath}`;
        const addedConflict = actualKind === 'Conflict'
          && [Status.AddedByUs, Status.AddedByThem, Status.BothAdded].includes(change.status);
        const left = api.toGitUri(change.originalUri,
          actualKind === 'Staged' ? 'HEAD' : actualKind === 'Conflict' ? ':1' : '');
        const right = actualKind === 'Staged' ? api.toGitUri(change.uri, '') : change.uri;
        const fileInfo = { id: right.toString(), path, root, name: basename(path) };
        const pathMatches = path.toLowerCase().includes(query.toLowerCase());
        let hunks: DiffHunk[] = [];
        let metadata = 'File change (no text hunks)';
        if (actualKind === 'Untracked' || addedConflict) {
          const file = await open(change.uri.fsPath, 'r');
          let binaryFile: boolean;
          try {
            if ((await file.stat()).size > 64 * 1024 * 1024)
              throw new Error(`Git diff text loading is limited to 64 MiB per file: ${path}`);
            const bytes = Buffer.alloc(8192);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff;
            binaryFile = !utf16 && bytes.subarray(0, bytesRead).includes(0);
          } finally { await file.close(); }
          if (generation !== this.generation) return;
          if (binaryFile) { binary++; metadata = 'Binary file change'; }
          else {
            const document = await vscode.workspace.openTextDocument(change.uri);
            const text = document.getText();
            if (text.includes('\0')) { binary++; metadata = 'Binary file change'; }
            else {
              const count = document.lineCount - (/[\r\n]$/.test(text) ? 1 : 0);
              if (matchLine && !pathMatches) {
                let matched = false;
                for (let line = 0; line < count; line++) {
                  if (line % 512 === 0) {
                    await new Promise<void>(done => setTimeout(done, 0));
                    if (generation !== this.generation) return;
                  }
                  if (matchLine(fileInfo, line, document.lineAt(line).text)) { matched = true; break; }
                }
                if (!matched) continue;
              }
              if (text.length) hunks = [{
                header: `@@ -0,0 +1,${count} @@`, addedCount: count,
                lines: [{ side: 'added', line: 0, text: document.lineAt(0).text, modifiedLine: 0 }]
              }];
              else metadata = 'Empty file';
            }
          }
        } else {
          const patch = await this.patch(api, repository, change, actualKind, generation);
          if (/^Binary files .* differ$/m.test(patch)) { binary++; metadata = 'Binary file change'; }
          else hunks = parseDiffHunks(patch);
        }
        if (generation !== this.generation) return;
        for (const hunk of hunks.length ? hunks : [{ header: metadata, lines: [] }]) {
          const line = hunk.lines.find(line => line.side === 'added') ?? hunk.lines[0]
            ?? { side: 'added', line: 0, modifiedLine: 0, text: '' };
          if (matchLine && !pathMatches && hunk.addedCount === undefined
            && !hunk.lines.some(line => matchLine(fileInfo, line.line, line.text))) continue;
          const uri = line.side === 'removed' ? left : right;
          const added = hunk.addedCount ?? hunk.lines.filter(line => line.side === 'added').length;
          const removed = hunk.lines.filter(line => line.side === 'removed').length;
          const diff: DiffTarget = {
            left: left.toString(), right: right.toString(), title: `${path} (${actualKind})`,
            side: line.side, modifiedLine: line.modifiedLine,
            emptyLeft: actualKind === 'Untracked' || (actualKind === 'Staged' && change.status === Status.IndexAdded) || addedConflict,
            emptyRight: [Status.IndexDeleted, Status.Deleted, Status.BothDeleted].includes(change.status),
            hunk: hunk.lines.length ? `${hunk.header} · +${added} / -${removed} · ${line.text.slice(0, 160)}` : metadata,
            metadataOnly: !hunk.lines.length
          };
          items.push({
            id: JSON.stringify([repository.rootUri.toString(), actualKind, path, hunk.header]),
            uri: uri.toString(), path, root, location: { line: line.line, text: line.text, matches: [] }, diff
          });
        }
        update({ items: [...items], total: items.length, complete: false,
          roots: api.repositories.length, searchedRoots, binary, unsupported: 0 });
      }
      searchedRoots++;
    }
    if (generation === this.generation) update({ items, total: items.length, complete: true,
      roots: api.repositories.length, searchedRoots, binary, unsupported: 0 });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.repositories.forEach(subscription => subscription.dispose());
    this.changed.dispose();
  }
}
