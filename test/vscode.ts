import { vi } from 'vitest';
import type { TextDocument } from 'vscode';

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  event = (listener: (event: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(event: T): void { this.listeners.forEach(listener => { void listener(event); }); }
  dispose(): void { this.listeners.clear(); }
}

export class CancellationError extends Error {}
export class CancellationTokenSource {
  private readonly cancelled = new EventEmitter<void>();
  readonly token = { isCancellationRequested: false, onCancellationRequested: this.cancelled.event };
  cancel(): void { this.token.isCancellationRequested = true; this.cancelled.fire(); }
  dispose(): void { this.cancelled.dispose(); }
}
export class Uri {
  constructor(private readonly value: string) {}
  static parse(value: string): Uri { return new Uri(value); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(`${base.toString()}/${parts.join('/')}`); }
  get path(): string { return new URL(this.value).pathname; }
  toString(): string { return this.value; }
}
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
export class Range {
  constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {}
}
export const ViewColumn = { One: 1, Beside: -2 };
export const fileCreated = new EventEmitter<void>();
export const fileDeleted = new EventEmitter<void>();
export const foldersChanged = new EventEmitter<void>();
export const configurationChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const workspace = {
  workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
  textDocuments: [] as Pick<TextDocument, 'uri' | 'isDirty' | 'lineCount' | 'getText'>[],
  createFileSystemWatcher: () => ({
    onDidCreate: fileCreated.event, onDidDelete: fileDeleted.event, dispose: vi.fn()
  }),
  onDidChangeWorkspaceFolders: foldersChanged.event,
  onDidChangeConfiguration: configurationChanged.event,
  findFiles: vi.fn(async (_include: unknown, _exclude?: unknown, _max?: number, _token?: unknown) =>
    [Uri.parse('file:///workspace/src/main.cpp')]),
  asRelativePath: (uri: Uri) => uri.path.replace('/workspace/', ''),
  getWorkspaceFolder: (uri: Uri) => workspace.workspaceFolders
    .filter(folder => uri.toString().startsWith(`${folder.uri.toString()}/`))
    .sort((a, b) => b.uri.toString().length - a.uri.toString().length)[0],
  getConfiguration: () => ({ get: () => false }),
  fs: {
    stat: vi.fn(async () => ({ size: 20 })),
    readFile: vi.fn<() => Promise<Uint8Array>>(async () => new TextEncoder().encode('int main() { return 0; }'))
  }
};
export class MockPanel {
  active = true;
  private readonly disposed = new EventEmitter<void>();
  private readonly viewState = new EventEmitter<{ webviewPanel: MockPanel }>();
  private readonly received = new EventEmitter<unknown>();
  readonly webview = {
    html: '', cspSource: 'vscode-webview:',
    postMessage: vi.fn(async (_message: unknown) => true),
    asWebviewUri: (uri: Uri) => uri,
    onDidReceiveMessage: this.received.event
  };
  onDidDispose = this.disposed.event;
  onDidChangeViewState = this.viewState.event;
  reveal = vi.fn();
  dispose(): void { this.disposed.fire(); }
  receive(message: unknown): void { this.received.fire(message); }
  deactivate(): void { this.active = false; this.viewState.fire({ webviewPanel: this }); }
}
export const window = {
  activeTextEditor: undefined as { document: { isClosed: boolean }; viewColumn: number } | undefined,
  createWebviewPanel: vi.fn(() => new MockPanel()),
  showTextDocument: vi.fn(async (_uri: unknown, _options: unknown) => undefined),
  showErrorMessage: vi.fn(async (_message: string) => undefined)
};
export const commands = { executeCommand: vi.fn(async (_command: string) => undefined) };
