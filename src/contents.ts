import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FileProvider } from './files';
import { compareContentMatches, type IndexedFile } from './ranking';
import { excluded, searchScopes, type SearchScope } from './searchScope';
import type { ContentMatch } from './types';
import { ContentStore, type StoredPage } from './contentStore';
import { ContentParser, type FileMatches } from './contentParser';

export interface ContentUpdate {
  items: readonly ContentMatch[];
  page?: {
    offset: number;
    length: number;
    load(offset: number): Promise<ContentUpdate>;
  };
  total: number;
  searchedRoots: number;
  roots: number;
  binary: number;
  unsupported: number;
  complete: boolean;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export class ContentProvider implements vscode.Disposable {
  private cancellation: vscode.CancellationTokenSource | undefined;
  private store: ContentStore | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly eligibility = new Map<string, boolean>();
  readonly onDidChange = this.changed.event;

  constructor(
    files: Pick<FileProvider, 'onDidChange'>,
    private readonly log: (message: string) => void,
    private readonly backend: () => Promise<string> = async () => (await import('@vscode/ripgrep')).rgPath
  ) {
    const invalidate = (): void => { this.eligibility.clear(); this.changed.fire(); };
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.subscriptions = [
      watcher, watcher.onDidChange(invalidate), files.onDidChange(invalidate),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length && vscode.workspace.getWorkspaceFolder(event.document.uri))
          this.changed.fire();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('search')) invalidate();
      })
    ];
  }

  cancel(): void {
    this.cancellation?.cancel();
    this.cancellation?.dispose();
    this.cancellation = undefined;
    this.store?.dispose();
    this.store = undefined;
  }

  async search(query: string, update: (value: ContentUpdate) => void, paging?: {
    size: number;
    selectedId(): string | undefined;
  }): Promise<void> {
    this.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    this.cancellation = cancellation;
    const token = cancellation.token;
    const store = paging ? new ContentStore() : undefined;
    this.store = store;
    const check = (): void => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
    try {
      const parser = new ContentParser(query);
      const scopes = searchScopes();
      const executable = scopes.some(scope => scope.folder.uri.scheme === 'file') ? await this.backend() : '';
      check();
      const state: ContentUpdate = {
        items: [], total: 0, searchedRoots: 0, roots: scopes.length, binary: 0, unsupported: 0, complete: false
      };
      const found: ContentMatch[] = [];
      let unsorted = false;
      const handled = new Set<string>();
      const dirty = new Set<string>();
      let lastUpdate = 0;
      let offset = 0;
      const storedUpdate = async (requested: number): Promise<ContentUpdate> => {
        if (!store || !paging) throw new Error('Paged content storage is unavailable.');
        const page: StoredPage = await store.page(requested, paging.size, paging.selectedId());
        check();
        offset = page.offset;
        return {
          ...state, items: page.items,
          page: { offset: page.offset, length: page.length, load: storedUpdate }
        };
      };
      const publish = async (force = false): Promise<void> => {
        check();
        if (force || unsorted && (lastUpdate === 0 || Date.now() - lastUpdate >= (state.total > 5000 ? 250 : 100))) {
          lastUpdate = Date.now();
          if (store) {
            unsorted = false;
            update(await storedUpdate(offset));
            return;
          }
          if (unsorted) {
            found.sort(compareContentMatches);
            state.items = [...found];
            unsorted = false;
          }
          update({ ...state });
        }
      };
      const commit = async (matches: FileMatches): Promise<void> => {
        if (matches.invalidEncoding) {
          state.unsupported++;
          this.log(`Text search skipped matches with unsupported encoding: ${matches.file.id}`);
        } else {
          state.total += matches.total;
          if (matches.items.length) {
            for (const item of matches.items) found.push(item);
            unsorted = true;
          }
        }
      };
      for (const scope of scopes) {
        check();
        const candidates = vscode.workspace.textDocuments.filter(document =>
          !document.isClosed && (document.isDirty || scope.folder.uri.scheme !== 'file')
          && vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === scope.folder.uri.toString());
        const documents = await this.eligibleDocuments(scope, candidates, executable, token);
        for (const document of documents) {
          check();
          const matches = this.fileMatches(document.uri, scope);
          const version = document.version;
          for (let start = 0; start < document.lineCount; start += 512) {
            await new Promise<void>(done => setTimeout(done, 0));
            check();
            if (document.isClosed || document.version !== version)
              throw new Error('A document changed during text search. Type again to refresh results.');
            const end = Math.min(start + 512, document.lineCount);
            if (store) {
              const lines = Array.from({ length: end - start }, (_, index) => document.lineAt(start + index).text);
              const complete = end === document.lineCount;
              const total = await store.document(query, matches.file, start, lines, complete);
              if (complete) {
                state.total += total;
                if (total) unsorted = true;
              }
            } else {
              for (let line = start; line < end; line++) parser.collect(matches, line, document.lineAt(line).text);
            }
          }
          dirty.add(matches.file.id);
          if (!store) await commit(matches);
          await publish();
        }
      }
      for (const scope of scopes) {
        check();
        if (scope.folder.uri.scheme !== 'file') {
          state.unsupported++;
          this.log(`Text search can only search open documents in non-filesystem workspace: ${scope.folder.uri.toString()}`);
        } else {
          await this.run(executable, [
            '--json', '--line-buffered', '--no-config', '--fixed-strings', '--ignore-case', '--crlf',
            '--color', 'never', ...scope.args, '--regexp', query, '--', '.'
          ], scope, token, 10, async lines => {
            if (store) {
              for (const result of await store.parse(query, lines)) {
                check();
                const uri = this.resultUri(scope, result.path);
                const id = uri.toString();
                const owner = scopes.find(candidate => candidate.folder.uri.toString()
                  === vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()) ?? scope;
                const skip = handled.has(id) || dirty.has(id) || await excluded(uri, owner);
                let file: IndexedFile | undefined;
                if (!skip) {
                  handled.add(id);
                  if (result.binary) state.binary++;
                  else if (result.invalidEncoding) {
                    state.unsupported++;
                    this.log(`Text search skipped matches with unsupported encoding: ${id}`);
                  } else {
                    file = this.fileMatches(uri, owner).file;
                    state.total += result.total;
                    if (result.total) unsorted = true;
                  }
                }
                await store.commit(result.path, file);
              }
              await publish();
              return;
            }
            for (const text of lines) {
              const event = parser.parse(text);
              if (!event) continue;
              const uri = this.resultUri(scope, event.path);
              const id = uri.toString();
              const matches = event.matches;
              if (event.type === 'begin') {
                const owner = scopes.find(candidate => candidate.folder.uri.toString()
                  === vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()) ?? scope;
                matches.file = this.fileMatches(uri, owner).file;
                matches.skip = handled.has(id) || dirty.has(id) || await excluded(uri, owner);
              } else if (!matches.skip) {
                handled.add(id);
                if (event.binary) state.binary++;
                else await commit(matches);
              }
            }
            await publish();
          }, store ? 128 : 1);
        }
        state.searchedRoots++;
        await publish(true);
      }
      state.complete = true;
      await publish(true);
    } catch (reason) {
      store?.dispose();
      if (this.store === store) this.store = undefined;
      throw reason;
    } finally {
      if (this.cancellation === cancellation) {
        this.cancellation = undefined;
        cancellation.dispose();
      }
    }
  }

  private fileMatches(uri: vscode.Uri, scope: SearchScope): FileMatches {
    const path = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
    return {
      file: { id: uri.toString(), path, root: scope.label, name: path.slice(path.lastIndexOf('/') + 1) },
      items: [], total: 0, invalidEncoding: false, extraLines: 0, skip: false
    };
  }

  private resultUri(scope: SearchScope, path: string): vscode.Uri {
    const absolute = resolve(scope.folder.uri.fsPath, path);
    const inside = relative(scope.folder.uri.fsPath, absolute);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`))
      throw new Error('Text search returned a file outside the workspace root.');
    return vscode.Uri.file(absolute);
  }

  private async eligibleDocuments(
    scope: SearchScope, documents: readonly vscode.TextDocument[], executable: string, token: vscode.CancellationToken
  ): Promise<vscode.TextDocument[]> {
    const candidates: vscode.TextDocument[] = [];
    for (const document of documents) if (!await excluded(document.uri, scope)) candidates.push(document);
    if (scope.folder.uri.scheme !== 'file') return candidates;
    const unknown = candidates.filter(document => !this.eligibility.has(document.uri.toString()));
    if (unknown.length) {
      const wanted = new Map(unknown.map(document => [pathKey(document.uri.fsPath), document.uri.toString()]));
      const found = new Set<string>();
      // Cache only live-document eligibility; never enumerate the workspace through findFiles per query.
      await this.run(executable, ['--files', '--null', '--no-config', ...scope.args, '--', '.'],
        scope, token, 0, paths => {
          for (const path of paths) {
            const id = wanted.get(pathKey(this.resultUri(scope, path).fsPath));
            if (id) found.add(id);
          }
        });
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      for (const document of unknown) this.eligibility.set(document.uri.toString(), found.has(document.uri.toString()));
    }
    return candidates.filter(document => this.eligibility.get(document.uri.toString()));
  }

  private async run(
    executable: string, args: readonly string[], scope: SearchScope, token: vscode.CancellationToken,
    delimiter: number, receive: (texts: readonly string[]) => void | Promise<void>, batchSize = 1
  ): Promise<void> {
    const child = spawn(executable, args, { cwd: scope.folder.uri.fsPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 64_000); });
    const ended = new Promise<{ code?: number | null; error?: Error }>(done => {
      child.once('error', error => done({ error }));
      child.once('close', code => done({ code }));
    });
    const subscription = token.onCancellationRequested(() => child.kill());
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const fragments: Buffer[] = [];
    let batch: string[] = [];
    let yieldAt = performance.now() + 8;
    try {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      for await (const chunk of child.stdout) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid text-search stream.');
        let start = 0;
        let end: number;
        while ((end = chunk.indexOf(delimiter, start)) >= 0) {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          const part = chunk.subarray(start, end);
          if (fragments.length) fragments.push(part);
          const response = fragments.length ? Buffer.concat(fragments) : part;
          fragments.length = 0;
          batch.push(decoder.decode(response));
          if (batch.length >= batchSize) {
            await receive(batch);
            batch = [];
          }
          start = end + 1;
          if (performance.now() >= yieldAt) {
            await new Promise<void>(done => setTimeout(done, 0));
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            yieldAt = performance.now() + 8;
          }
        }
        if (start < chunk.length) fragments.push(chunk.subarray(start));
        if (batch.length) { await receive(batch); batch = []; }
      }
      const result = await ended;
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (result.error) throw result.error;
      if (result.code !== 0 && result.code !== 1)
        throw new Error(`Text search failed (${result.code}): ${stderr.trim() || 'Backend terminated unexpectedly.'}`);
      if (fragments.length) throw new Error('Text search returned an incomplete response.');
    } finally {
      subscription.dispose();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await ended;
    }
  }

  dispose(): void {
    this.cancel();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.changed.dispose();
  }
}
