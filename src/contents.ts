import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import type { FileProvider } from './files';
import { createContentMatcher, type IndexedFile, retainContentMatch } from './ranking';
import { excluded, searchScopes, type SearchScope } from './searchScope';
import type { ContentMatch } from './types';

export interface ContentUpdate {
  items: readonly ContentMatch[];
  total: number;
  searchedRoots: number;
  roots: number;
  binary: number;
  unsupported: number;
  complete: boolean;
}

interface FileMatches {
  file: IndexedFile;
  items: ContentMatch[];
  total: number;
  invalidEncoding: boolean;
  extraLines: number;
  skip: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export class ContentProvider implements vscode.Disposable {
  private cancellation: vscode.CancellationTokenSource | undefined;
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
      vscode.workspace.onDidChangeTextDocument(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('search')) invalidate();
      })
    ];
  }

  cancel(): void {
    this.cancellation?.cancel();
    this.cancellation?.dispose();
    this.cancellation = undefined;
  }

  async search(query: string, update: (value: ContentUpdate) => void): Promise<void> {
    this.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    this.cancellation = cancellation;
    const token = cancellation.token;
    const check = (): void => { if (token.isCancellationRequested) throw new vscode.CancellationError(); };
    try {
      const matchLine = createContentMatcher(query);
      const scopes = searchScopes();
      const executable = scopes.some(scope => scope.folder.uri.scheme === 'file') ? await this.backend() : '';
      check();
      const state: ContentUpdate = {
        items: [], total: 0, searchedRoots: 0, roots: scopes.length, binary: 0, unsupported: 0, complete: false
      };
      const best: ContentMatch[] = [];
      const handled = new Set<string>();
      const dirty = new Set<string>();
      let lastUpdate = 0;
      const publish = (force = false): void => {
        check();
        if (force || Date.now() - lastUpdate >= 50) {
          lastUpdate = Date.now();
          update({ ...state, items: [...best] });
        }
      };
      const collect = (matches: FileMatches, line: number, text: string): void => {
        const match = matchLine(matches.file, line, text);
        if (match) { matches.total++; retainContentMatch(matches.items, match); }
      };
      const commit = (matches: FileMatches): void => {
        if (matches.invalidEncoding) {
          state.unsupported++;
          this.log(`Text search skipped matches with unsupported encoding: ${matches.file.id}`);
        } else {
          state.total += matches.total;
          for (const item of matches.items) retainContentMatch(best, item);
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
          for (let line = 0; line < document.lineCount; line++) {
            if (line % 512 === 0) {
              await new Promise<void>(done => setTimeout(done, 0));
              check();
              if (document.isClosed || document.version !== version)
                throw new Error('A document changed during text search. Type again to refresh results.');
            }
            collect(matches, line, document.lineAt(line).text);
          }
          dirty.add(matches.file.id);
          commit(matches);
          publish();
        }
      }
      for (const scope of scopes) {
        check();
        if (scope.folder.uri.scheme !== 'file') {
          state.unsupported++;
          this.log(`Text search can only search open documents in non-filesystem workspace: ${scope.folder.uri.toString()}`);
        } else {
          const active = new Map<string, FileMatches>();
          await this.run(executable, [
            '--json', '--line-buffered', '--no-config', '--fixed-strings', '--ignore-case', '--crlf',
            '--color', 'never', ...scope.args, '--regexp', query, '--', '.'
          ], scope, token, 10, async text => {
            const message: unknown = JSON.parse(text);
            if (!record(message) || typeof message.type !== 'string') throw new Error('Invalid text-search response.');
            if (message.type !== 'match' && message.type !== 'end' && message.type !== 'begin') return;
            const data = message.data;
            if (!record(data) || !record(data.path) || typeof data.path.text !== 'string')
              throw new Error('Text search returned an unsupported filename encoding.');
            const uri = this.resultUri(scope, data.path.text);
            const id = uri.toString();
            if (message.type === 'begin') {
              const owner = scopes.find(candidate => candidate.folder.uri.toString()
                === vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()) ?? scope;
              const matches = this.fileMatches(uri, owner);
              matches.skip = handled.has(id) || dirty.has(id) || await excluded(uri, owner);
              active.set(id, matches);
              return;
            }
            const matches = active.get(id);
            if (!matches) throw new Error('Text search returned a file outside its search sequence.');
            if (message.type === 'match' && !matches.skip) {
              if (!record(data.lines) || typeof data.line_number !== 'number'
                || !Number.isSafeInteger(data.line_number) || data.line_number < 1)
                throw new Error('Invalid text-search line response.');
              if (typeof data.lines.text !== 'string') {
                if (typeof data.lines.bytes !== 'string') throw new Error('Invalid text-search text response.');
                matches.invalidEncoding = true;
              } else {
                const startLine = data.line_number - 1;
                let lineText = data.lines.text.replace(/\r?\n$/, '');
                if (startLine === 0) lineText = lineText.replace(/^\uFEFF/, '');
                const lines = lineText.split('\r');
                lines.forEach((line, offset) => collect(matches, startLine + matches.extraLines + offset, line));
                matches.extraLines += lines.length - 1;
              }
            } else if (message.type === 'end') {
              if (!matches.skip) {
                handled.add(id);
                if (data.binary_offset !== null && data.binary_offset !== undefined) state.binary++;
                else commit(matches);
              }
              active.delete(id);
            }
            publish();
          });
        }
        state.searchedRoots++;
        publish(true);
      }
      state.complete = true;
      publish(true);
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
        scope, token, 0, path => {
          const id = wanted.get(pathKey(this.resultUri(scope, path).fsPath));
          if (id) found.add(id);
        });
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      for (const document of unknown) this.eligibility.set(document.uri.toString(), found.has(document.uri.toString()));
    }
    return candidates.filter(document => this.eligibility.get(document.uri.toString()));
  }

  private async run(
    executable: string, args: readonly string[], scope: SearchScope, token: vscode.CancellationToken,
    delimiter: number, receive: (text: string) => void | Promise<void>
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
    let pending = Buffer.alloc(0);
    try {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      for await (const chunk of child.stdout) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        if (!Buffer.isBuffer(chunk)) throw new Error('Invalid text-search stream.');
        pending = Buffer.concat([pending, chunk]);
        let start = 0;
        let end: number;
        while ((end = pending.indexOf(delimiter, start)) >= 0) {
          if (token.isCancellationRequested) throw new vscode.CancellationError();
          await receive(decoder.decode(pending.subarray(start, end)));
          start = end + 1;
        }
        pending = pending.subarray(start);
      }
      const result = await ended;
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (result.error) throw result.error;
      if (result.code !== 0 && result.code !== 1)
        throw new Error(`Text search failed (${result.code}): ${stderr.trim() || 'Backend terminated unexpectedly.'}`);
      if (pending.length) throw new Error('Text search returned an incomplete response.');
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
