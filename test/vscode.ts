import { vi } from 'vitest';
import type {
  QuickInputButton, QuickPickItem, Tab, TabGroup, TextDocument, TextDocumentShowOptions,
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
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}
export class Selection extends Range {}
export const TextEditorRevealType = { AtTop: 1, InCenter: 2 };
export const ViewColumn = { One: 1, Beside: -2 };
export class ThemeIcon { constructor(readonly id: string) {} }
export const fileCreated = new EventEmitter<void>();
export const fileDeleted = new EventEmitter<void>();
export const foldersChanged = new EventEmitter<void>();
export const configurationChanged = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
export const tabsChanged = new EventEmitter<void>();
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

export function createDocument(uri: VscodeUri, dirty = false): TextDocument {
  const document: Pick<TextDocument, 'uri' | 'isDirty' | 'isClosed' | 'getText'> = {
    uri, isDirty: dirty, isClosed: false, getText: () => 'const unsaved = 1;'
  };
  return document as TextDocument;
}

export function createEditor(document: TextDocument, column: VscodeColumn = 1): TextEditor {
  const editor: Pick<TextEditor, 'document' | 'viewColumn' | 'selections' | 'visibleRanges' | 'revealRange'> = {
    document, viewColumn: column, selections: [], visibleRanges: [], revealRange: vi.fn()
  };
  return editor as TextEditor;
}

export function resetEditors(): void {
  window.activeTextEditor = undefined;
  window.tabGroups.all = [new MockGroup(1)];
  workspace.textDocuments = [];
  editorSettings.previewEnabled = true;
}
