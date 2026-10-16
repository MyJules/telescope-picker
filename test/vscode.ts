import { vi } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix } from 'node:path';
import type {
  Position as VscodePosition, Range as VscodeRange, QuickInputButton, QuickPickItem, Tab, TabGroup, TextDocument, TextDocumentShowOptions, TextLine,
  TextEditor, Uri as VscodeUri, ViewColumn as VscodeColumn
} from 'vscode';

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
export class FileSystemError extends Error {
  constructor(readonly code: string) { super(code); }
  static FileNotFound(): FileSystemError { return new FileSystemError('FileNotFound'); }
}
export class CancellationTokenSource {
  private readonly cancelled = new EventEmitter<void>();
  readonly token = { isCancellationRequested: false, onCancellationRequested: this.cancelled.event };
  cancel(): void { this.token.isCancellationRequested = true; this.cancelled.fire(); }
  dispose(): void { this.cancelled.dispose(); }
}
export class Uri {
  constructor(private readonly value: string) {}
  static parse(value: string): Uri { return new Uri(value); }
  static file(value: string): Uri { return new Uri(pathToFileURL(value).href); }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    const url = new URL(base.toString());
    url.pathname = posix.join(url.pathname, ...parts);
    return new Uri(url.href);
  }
  get path(): string { return decodeURIComponent(new URL(this.value).pathname); }
  get scheme(): string { return new URL(this.value).protocol.slice(0, -1); }
  get fsPath(): string { return fileURLToPath(this.value); }
  toString(): string { return this.value; }
}
export class RelativePattern { constructor(readonly base: unknown, readonly pattern: string) {} }
export class Position implements VscodePosition {
  constructor(readonly line: number, readonly character: number) {}
  compareTo(other: VscodePosition): number { return this.line - other.line || this.character - other.character; }
  isBefore(other: VscodePosition): boolean { return this.compareTo(other) < 0; }
  isBeforeOrEqual(other: VscodePosition): boolean { return this.compareTo(other) <= 0; }
  isAfter(other: VscodePosition): boolean { return this.compareTo(other) > 0; }
  isAfterOrEqual(other: VscodePosition): boolean { return this.compareTo(other) >= 0; }
  isEqual(other: VscodePosition): boolean { return this.compareTo(other) === 0; }
  translate(lineOrChange: number | { lineDelta?: number; characterDelta?: number } = 0, characterDelta = 0): Position {
    return typeof lineOrChange === 'number' ? new Position(this.line + lineOrChange, this.character + characterDelta)
      : new Position(this.line + (lineOrChange.lineDelta ?? 0), this.character + (lineOrChange.characterDelta ?? 0));
  }
  with(lineOrChange: number | { line?: number; character?: number } = {}, character = this.character): Position {
    return typeof lineOrChange === 'number' ? new Position(lineOrChange, character)
      : new Position(lineOrChange.line ?? this.line, lineOrChange.character ?? this.character);
  }
}
export class Range implements VscodeRange {
  readonly start: Position;
  readonly end: Position;
  constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
  get isEmpty(): boolean { return this.start.isEqual(this.end); }
  get isSingleLine(): boolean { return this.start.line === this.end.line; }
  contains(value: VscodePosition | VscodeRange): boolean {
    return 'start' in value ? this.contains(value.start) && this.contains(value.end)
      : this.start.isBeforeOrEqual(value) && this.end.isAfterOrEqual(value);
  }
  isEqual(other: VscodeRange): boolean { return this.start.isEqual(other.start) && this.end.isEqual(other.end); }
  intersection(other: VscodeRange): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start.line, start.character, end.line, end.character);
  }
  union(other: VscodeRange): Range {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start.line, start.character, end.line, end.character);
  }
  with(startOrChange: VscodePosition | { start?: VscodePosition; end?: VscodePosition } = {}, end = this.end): Range {
    const start = 'line' in startOrChange ? startOrChange : startOrChange.start ?? this.start;
    const finish = 'line' in startOrChange ? end : startOrChange.end ?? this.end;
    return new Range(start.line, start.character, finish.line, finish.character);
  }
}
export class Selection extends Range {
  get anchor(): Position { return this.start; }
  get active(): Position { return this.end; }
  get isReversed(): boolean { return false; }
}
export const TextEditorRevealType = { AtTop: 1, InCenter: 2, InCenterIfOutsideViewport: 3 };
export const ViewColumn = { One: 1, Beside: -2 };
export class ThemeIcon { constructor(readonly id: string) {} }
export class ThemeColor { constructor(readonly id: string) {} }
export const fileCreated = new EventEmitter<void>();
export const fileChanged = new EventEmitter<void>();
export const documentChanged = new EventEmitter<void>();
export const fileDeleted = new EventEmitter<void>();
export const foldersChanged = new EventEmitter<void>();
export const configurationChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const tabsChanged = new EventEmitter<void>();
export const settings = new Map<string, unknown>();
export const workspace = {
  workspaceFolders: [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }],
  textDocuments: [] as TextDocument[],
  openTextDocument: vi.fn(async (uri: VscodeUri): Promise<TextDocument> => {
    const existing = workspace.textDocuments.find(document => !document.isClosed && document.uri.toString() === uri.toString());
    if (existing) return existing;
    const document = createDocument(uri);
    workspace.textDocuments.push(document);
    return document;
  }),
  createFileSystemWatcher: () => ({
    onDidCreate: fileCreated.event, onDidDelete: fileDeleted.event, onDidChange: fileChanged.event, dispose: vi.fn()
  }),
  onDidChangeWorkspaceFolders: foldersChanged.event,
  onDidChangeConfiguration: configurationChanged.event,
  onDidChangeTextDocument: documentChanged.event,
  findFiles: vi.fn(async (_include: unknown, _exclude?: unknown, _max?: number, _token?: unknown) =>
    [Uri.parse('file:///workspace/src/main.cpp')]),
  asRelativePath: (uri: Pick<VscodeUri, 'path' | 'toString'>): string => {
    const folder = workspace.getWorkspaceFolder(uri);
    return folder ? uri.path.slice(folder.uri.path.length + 1) : uri.path;
  },
  getWorkspaceFolder: (uri: Pick<VscodeUri, 'path' | 'toString'>) => workspace.workspaceFolders
    .filter(folder => uri.toString().startsWith(`${folder.uri.toString()}/`))
    .sort((a, b) => b.uri.toString().length - a.uri.toString().length)[0],
  getConfiguration: (section?: string, uri?: VscodeUri) => ({
    get: <T>(key: string, fallback?: T): T | undefined => {
      const name = `${section}.${key}`;
      const scoped = `${uri?.toString()}|${name}`;
      return settings.has(scoped) ? settings.get(scoped) as T
        : settings.has(name) ? settings.get(name) as T : fallback;
    }
  }),
  fs: {
    stat: vi.fn(async (_uri: VscodeUri) => ({ size: 20 })),
    readFile: vi.fn<() => Promise<Uint8Array>>(async () => new TextEncoder().encode('int main() { return 0; }'))
  }
};
type MockItem = QuickPickItem & { id?: string; path?: string };
export class MockQuickPick {
  title = '';
  placeholder = '';
  ignoreFocusOut = false;
  matchOnDescription = false;
  keepScrollPosition = false;
  enabled = true;
  busy = false;
  items: readonly MockItem[] = [];
  buttons: readonly QuickInputButton[] = [];
  private currentValue = '';
  private active: readonly MockItem[] = [];
  private readonly valueChanged = new EventEmitter<string>();
  private readonly activeChanged = new EventEmitter<readonly MockItem[]>();
  private readonly accepted = new EventEmitter<void>();
  private readonly hidden = new EventEmitter<void>();
  private readonly itemButton = new EventEmitter<{ item: MockItem }>();
  private readonly button = new EventEmitter<void>();
  onDidChangeValue = this.valueChanged.event;
  onDidChangeActive = this.activeChanged.event;
  onDidAccept = this.accepted.event;
  onDidHide = this.hidden.event;
  onDidTriggerItemButton = this.itemButton.event;
  onDidTriggerButton = this.button.event;
  get value(): string { return this.currentValue; }
  set value(value: string) { this.currentValue = value; this.valueChanged.fire(value); }
  get activeItems(): readonly MockItem[] { return this.active; }
  set activeItems(items: readonly MockItem[]) { this.active = items; this.activeChanged.fire(items); }
  show = vi.fn();
  dispose = vi.fn();
  hide(): void { this.hidden.fire(); }
  accept(): void { this.accepted.fire(); }
  split(item: MockItem): void { this.itemButton.fire({ item }); }
  preview(): void { this.button.fire(); }
}
export const window = {
  activeTextEditor: undefined as TextEditor | undefined,
  createWebviewPanel: vi.fn(),
  createQuickPick: vi.fn(() => new MockQuickPick()),
  createTextEditorDecorationType: vi.fn(() => ({ key: 'match', dispose: vi.fn() })),
  tabGroups: {
    all: [] as MockGroup[],
    onDidChangeTabs: tabsChanged.event,
    get activeTabGroup(): MockGroup {
      const group = this.all.find(candidate => candidate.isActive) ?? this.all[0];
      if (!group) throw new Error('No mock editor group');
      return group;
    },
    close: vi.fn(async (tabs: readonly Tab[], _preserveFocus?: boolean) => {
      for (const group of window.tabGroups.all) {
        group.tabs = group.tabs.filter(tab => !tabs.includes(tab));
        if (group.activeTab && tabs.includes(group.activeTab)) group.activeTab = group.tabs[0];
      }
      return true;
    })
  },
  showTextDocument: vi.fn(async (
    documentOrUri: TextDocument | VscodeUri, options: TextDocumentShowOptions
  ): Promise<TextEditor> => {
    const document = 'getText' in documentOrUri ? documentOrUri : await workspace.openTextDocument(documentOrUri);
    if (!workspace.textDocuments.includes(document)) workspace.textDocuments.push(document);
    const column = options.viewColumn === ViewColumn.Beside
      ? window.tabGroups.activeTabGroup.viewColumn + 1 : options.viewColumn ?? 1;
    let group = window.tabGroups.all.find(candidate => candidate.viewColumn === column);
    if (!group) { group = new MockGroup(column); window.tabGroups.all.push(group); }
    let tab = group.tabs.find(candidate => candidate.input.uri.toString() === document.uri.toString());
    if (!tab) {
      if (options.preview && editorSettings.previewEnabled) group.tabs = group.tabs.filter(candidate => !candidate.isPreview || candidate.isDirty);
      tab = new MockTab(document, group, Boolean(options.preview && editorSettings.previewEnabled));
      group.tabs.push(tab);
    } else if (options.preview === false) tab.isPreview = false;
    group.activeTab = tab;
    for (const candidate of window.tabGroups.all) candidate.isActive = candidate === group;
    const editor = createEditor(document, column);
    if (options.selection) editor.selections = [new Selection(options.selection.start.line,
      options.selection.start.character, options.selection.end.line, options.selection.end.character)];
    window.activeTextEditor = editor;
    return editor;
  }),
  showErrorMessage: vi.fn(async (_message: string) => undefined)
};
export const commands = { executeCommand: vi.fn(async (_command: string, ..._args: unknown[]) => undefined) };

export class TabInputText { constructor(readonly uri: VscodeUri) {} }
export class MockGroup implements TabGroup {
  isActive = true;
  activeTab: MockTab | undefined;
  tabs: MockTab[] = [];
  constructor(readonly viewColumn: VscodeColumn) {}
}
export class MockTab implements Tab {
  readonly input: TabInputText;
  readonly label: string;
  isActive = true;
  isPinned = false;
  get isDirty(): boolean { return this.document.isDirty; }
  constructor(readonly document: TextDocument, readonly group: MockGroup, public isPreview: boolean) {
    this.input = new TabInputText(document.uri);
    this.label = document.uri.path;
  }
}
export const editorSettings = { previewEnabled: true };

export function createDocument(uri: VscodeUri, dirty = false, text = 'const unsaved = 1;'): TextDocument {
  const lines = text.split(/\r\n|\r|\n/);
  const document: Pick<TextDocument, 'uri' | 'isDirty' | 'isClosed' | 'getText' | 'lineCount' | 'lineAt' | 'version'> = {
    uri, isDirty: dirty, isClosed: false, getText: () => text, lineCount: lines.length, version: 1,
    lineAt: (position: number | VscodePosition): TextLine => {
      const index = typeof position === 'number' ? position : position.line;
      const line = lines[index];
      if (line === undefined) throw new Error('Line outside document');
      return {
        text: line, lineNumber: index, range: new Range(index, 0, index, line.length),
        rangeIncludingLineBreak: new Range(index, 0, index + 1, 0),
        firstNonWhitespaceCharacterIndex: line.search(/\S/), isEmptyOrWhitespace: !line.trim()
      };
    }
  };
  return document as TextDocument;
}

export function createEditor(document: TextDocument, column: VscodeColumn = 1): TextEditor {
  const editor: Pick<TextEditor, 'document' | 'viewColumn' | 'selection' | 'selections' | 'visibleRanges' | 'revealRange' | 'setDecorations'> = {
    document, viewColumn: column, selections: [], visibleRanges: [], revealRange: vi.fn(), setDecorations: vi.fn(),
    get selection() { return this.selections[0] ?? new Selection(0, 0, 0, 0); },
    set selection(value) { this.selections = [value]; }
  };
  return editor as TextEditor;
}

export function resetEditors(): void {
  window.activeTextEditor = undefined;
  window.tabGroups.all = [new MockGroup(1)];
  workspace.textDocuments = [];
  editorSettings.previewEnabled = true;
  settings.clear();
}
