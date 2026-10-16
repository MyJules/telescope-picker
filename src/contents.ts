import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as vscode from 'vscode';
import type { FileProvider } from './files';
import { type IndexedFile, matchContentLine, retainContentMatch } from './ranking';
import type { ContentMatch } from './types';

export interface ContentUpdate {
  items: readonly ContentMatch[];
  total: number;
  scanned: number;
  files: number;
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
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly files: FileProvider,
    private readonly log: (message: string) => void,
    private readonly backend: () => Promise<string> = async () => (await import('@vscode/ripgrep')).rgPath
  ) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.subscriptions = [
      watcher, watcher.onDidChange(() => this.changed.fire()),
      files.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeTextDocument(() => this.changed.fire())
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
      const files = await this.files.discover(token);
      check();
      const state: ContentUpdate = {
        items: [], total: 0, scanned: 0, files: files.length, binary: 0, unsupported: 0, complete: false
      };
      const best: ContentMatch[] = [];
      let lastUpdate = 0;
      const publish = (force = false): void => {
        check();
        if (force || Date.now() - lastUpdate >= 100) {
          lastUpdate = Date.now();
          update({ ...state, items: [...best] });
        }
      };
      const commit = (matches: FileMatches): void => {
        if (matches.invalidEncoding) {
          state.unsupported++;
          this.log(`Content search skipped non-UTF-8 text: ${matches.file.id}`);
        } else {
          state.total += matches.total;
          for (const item of matches.items) retainContentMatch(best, item);
        }
      };
      const collect = (matches: FileMatches, line: number, text: string): void => {
        if (!text.trim()) return;
        const match = matchContentLine(matches.file, query.trim(), line, text);
        if (match) { matches.total++; retainContentMatch(matches.items, match); }
      };
      const pending: IndexedFile[] = [];
      for (const file of files) {
        check();
        const document = vscode.workspace.textDocuments.find(candidate =>
          !candidate.isClosed && candidate.uri.toString() === file.id);
        if (document) {
          const matches: FileMatches = { file, items: [], total: 0, invalidEncoding: false, extraLines: 0 };
          const version = document.version;
          for (let line = 0; line < document.lineCount; line++) {
            if (line % 512 === 0) {
              await new Promise<void>(done => setTimeout(done, 0));
              check();
              if (document.isClosed || document.version !== version)
                throw new Error('A document changed during content search. Type again to refresh results.');
              publish();
            }
            collect(matches, line, document.lineAt(line).text);
          }
          commit(matches);
          state.scanned++;
          publish();
        } else if (vscode.Uri.parse(file.id).scheme === 'file') pending.push(file);
        else {
          state.unsupported++;
          state.scanned++;
          this.log(`Content search requires a filesystem URI or an open text document: ${file.id}`);
        }
      }
      if (pending.length) {
        const executable = await this.backend();
        check();
        let start = 0;
        while (start < pending.length) {
          check();
          const batch: IndexedFile[] = [];
          let characters = executable.length + 256;
          while (start < pending.length && batch.length < 64) {
            const file = pending[start];
            if (!file) break;
            const length = vscode.Uri.parse(file.id).fsPath.length + 3;
            if (batch.length && characters + length > 12_000) break;
            characters += length;
            batch.push(file);
            start++;
          }
          const byPath = new Map(batch.map(file => [pathKey(vscode.Uri.parse(file.id).fsPath), file]));
          const active = new Map<string, FileMatches>();
          const before = state.scanned;
          await this.scan(executable, batch, token, message => {
            if (!record(message) || typeof message.type !== 'string') throw new Error('Invalid content-search response.');
            if (message.type !== 'match' && message.type !== 'end' && message.type !== 'begin') return;
            const data = message.data;
            if (!record(data) || !record(data.path) || typeof data.path.text !== 'string')
              throw new Error('Content search returned an unsupported filename encoding.');
            const key = pathKey(data.path.text);
            const file = byPath.get(key);
            if (!file) throw new Error('Content search returned an unexpected file.');
            if (message.type === 'begin') {
              active.set(key, { file, items: [], total: 0, invalidEncoding: false, extraLines: 0 });
              return;
            }
            const matches = active.get(key);
            if (!matches) throw new Error('Content search returned a file outside its search sequence.');
            if (message.type === 'match') {
              if (!record(data.lines) || typeof data.line_number !== 'number'
                || !Number.isSafeInteger(data.line_number) || data.line_number < 1)
                throw new Error('Invalid content-search line response.');
              if (typeof data.lines.text !== 'string') {
                if (typeof data.lines.bytes !== 'string') throw new Error('Invalid content-search text response.');
                matches.invalidEncoding = true;
              } else {
                const startLine = data.line_number - 1;
                let text = data.lines.text.replace(/\r?\n$/, '');
                if (startLine === 0) text = text.replace(/^\uFEFF/, '');
                const lines = text.split('\r');
                lines.forEach((line, offset) => collect(matches, startLine + matches.extraLines + offset, line));
                matches.extraLines += lines.length - 1;
              }
            } else {
              if (data.binary_offset !== null && data.binary_offset !== undefined) state.binary++;
              else commit(matches);
              active.delete(key);
              state.scanned++;
            }
            publish();
          });
          state.scanned = before + batch.length;
          publish(true);
        }
      }
      check();
      state.complete = true;
      publish(true);
    } finally {
      if (this.cancellation === cancellation) {
        this.cancellation = undefined;
        cancellation.dispose();
      }
    }
  }

  private async scan(
    executable: string, files: readonly IndexedFile[], token: vscode.CancellationToken,
    receive: (message: unknown) => void
  ): Promise<void> {
    const child = spawn(executable, [
      '--json', '--line-buffered', '--no-config', '--no-ignore', '--no-mmap', '--no-unicode', '--threads', '1',
      '--color', 'never', '--', '^.*$', ...files.map(file => vscode.Uri.parse(file.id).fsPath)
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(0, 64_000); });
    const ended = new Promise<{ code?: number | null; error?: Error }>(done => {
      child.once('error', error => done({ error }));
      child.once('close', code => done({ code }));
    });
    const subscription = token.onCancellationRequested(() => child.kill());
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      for await (const line of lines) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const message: unknown = JSON.parse(line);
        receive(message);
      }
      const result = await ended;
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      if (result.error) throw result.error;
      if (result.code !== 0 && result.code !== 1)
        throw new Error(`Content search failed (${result.code}): ${stderr.trim() || 'Backend terminated unexpectedly.'}`);
    } finally {
      subscription.dispose();
      lines.close();
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
