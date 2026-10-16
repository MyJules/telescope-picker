import * as vscode from 'vscode';
import { FileProvider } from './files';
import { LatestRequest } from './latest';
import { EditorPreview, PreviewTooLargeError } from './editorPreview';
import { rankFiles } from './ranking';
import { ContentProvider, type ContentUpdate } from './contents';
import type { ContentMatch, MatchLocation } from './types';

type PickerMode = 'files' | 'contents';
interface ResumeState { query: string; selectedId?: string; mode: PickerMode }
interface FileItem extends vscode.QuickPickItem { id?: string; uri?: string; path?: string; location?: MatchLocation }
interface Session {
  picker: vscode.QuickPick<FileItem>;
  state: ResumeState;
  select(item: FileItem): void;
  accept(beside: boolean, item?: FileItem): Promise<void>;
  close(restoreFocus: boolean): void;
  setMode(mode: PickerMode): Promise<void>;
}

function savedState(value: unknown): ResumeState {
  if (typeof value !== 'object' || value === null) return { query: '', mode: 'files' };
  const query = 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 1024) : '';
  const selectedId = 'selectedId' in value && typeof value.selectedId === 'string' ? value.selectedId : undefined;
  const mode = 'mode' in value && value.mode === 'contents' ? 'contents' : 'files';
  return { query, selectedId, mode };
}

function literalLabel(text: string): string { return text.replace(/\$\(/g, '\\$('); }

export class PickerController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly files = new FileProvider();
  private readonly contents: ContentProvider;
  private resume: ResumeState;
  private finishing: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>
  ) {
    this.resume = savedState(context.workspaceState.get('resume'));
    this.contents = new ContentProvider(this.files, message => this.output.appendLine(message));
  }

  async show(resume = false, mode: PickerMode = 'files', query = ''): Promise<void> {
    await this.finishing;
    if (this.session) {
      if (!resume) await this.session.setMode(mode);
      this.session?.picker.show();
      return;
    }
    const previous = vscode.window.activeTextEditor;
    const column = previous?.viewColumn ?? vscode.ViewColumn.One;
    const picker = vscode.window.createQuickPick<FileItem>();
    const state: ResumeState = resume ? { ...this.resume } : { query, mode };
    const requests = new LatestRequest();
    const subscriptions: vscode.Disposable[] = [];
    const splitButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open beside (Ctrl/Cmd+Enter)'
    };
    let closed = false;
    let accepted = false;
    let opening = false;
    let visible = new Map<string, FileItem>();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let previewedId: string | undefined;
    let pendingSelection: string | undefined;
    let applying = false;
    let resultTitle = 'Telescope Picker';
    let previewError: string | undefined;
    const title = (value: string): void => {
      resultTitle = value;
      const next = previewError ?? value;
      if (picker.title !== next) picker.title = next;
    };
    picker.title = 'Telescope Picker';
    const modeLabel = (): string => state.mode === 'files' ? 'Files' : 'File Contents';
    const configure = (): void => {
      picker.placeholder = `${state.mode === 'files' ? 'Fuzzy file names' : 'Search text within files (ignore case)'} · Enter Open · Ctrl/Cmd+Enter Split · Esc Close`;
      picker.buttons = [{
        iconPath: new vscode.ThemeIcon(state.mode === 'files' ? 'search' : 'files'),
        tooltip: state.mode === 'files' ? 'Search file contents' : 'Find files'
      }];
    };
    configure();
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = false;
    picker.keepScrollPosition = true;
    picker.value = state.query;

    const report = (reason: unknown): string => {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.output.appendLine(message);
      return message;
    };
    const preview = new EditorPreview(previous, column, reason => {
      report(reason);
      if (!closed) {
        previewError = reason instanceof PreviewTooLargeError
          ? 'Large file · Enter to open'
          : 'Preview unavailable · See Output';
        title(resultTitle);
      }
    });
    const status = (message: string): void => {
      visible.clear();
      picker.items = [{ label: message, alwaysShow: true }];
      picker.activeItems = [];
    };
    const select = (item: FileItem | undefined): void => {
      if (closed || opening || !item?.id || visible.get(item.id) !== item) return;
      state.selectedId = item.id;
      if (previewedId === item.id) return;
      if (!applying) pendingSelection = undefined;
      previewError = undefined;
      title(resultTitle);
      previewedId = item.id;
      preview.select(item.uri ?? item.id, item.location);
    };
    const display = (items: FileItem[], empty: string): void => {
      visible = new Map(items.flatMap(item => item.id ? [[item.id, item] as const] : []));
      if (!items.length) status(empty);
      else {
        const active = items.find(item => item.id && item.id === pendingSelection)
          ?? items.find(item => item.id && item.id === state.selectedId) ?? items.find(item => item.id);
        if (active?.id === pendingSelection) pendingSelection = undefined;
        applying = true;
        try {
          picker.items = items;
          picker.activeItems = active ? [active] : [];
          select(active);
        } finally { applying = false; }
      }
    };
    const contentResults = (result: ContentUpdate): void => {
      const groups = new Map<string, ContentMatch[]>();
      for (const match of result.items) {
        const group = groups.get(match.uri);
        if (group) group.push(match);
        else groups.set(match.uri, [match]);
      }
      const items: FileItem[] = [];
      for (const matches of groups.values()) {
        const first = matches[0];
        if (!first) continue;
        items.push({
          kind: vscode.QuickPickItemKind.Separator,
          label: `${literalLabel(first.path)} · ${literalLabel(first.root)} (${matches.length})`
        });
        for (const match of matches.sort((a, b) => a.location.line - b.location.line)) {
          const text = match.location.text;
          const start = Math.max(0, (match.location.matches[0] ?? 0) - 40);
          const excerpt = text.slice(start, start + 400).trim();
          items.push({
            id: match.id, uri: match.uri, path: match.path, location: match.location,
            resourceUri: vscode.Uri.parse(match.uri), iconPath: vscode.ThemeIcon.File,
            label: literalLabel(`${start ? '...' : ''}${excerpt || '(whitespace)'}${start + 400 < text.length ? '...' : ''}`),
            description: `${literalLabel(match.path)}:${match.location.line + 1} · ${literalLabel(match.root)}`,
            alwaysShow: true, buttons: [splitButton]
          });
        }
      }
      title(`Telescope Picker · File Contents · ${result.total} matching lines`
        + (result.total > result.items.length ? ` (showing ${result.items.length})` : '')
        + (result.complete ? ' · Search complete' : ` · Searching roots ${result.searchedRoots}/${result.roots}`)
        + (result.binary ? ` · ${result.binary} binary files skipped` : '')
        + (result.unsupported ? ` · ${result.unsupported} unsupported resources skipped (see Output)` : ''));
      display(items, result.complete ? 'No matching text.' : 'Scanning workspace file contents...');
    };
    const search = async (query: string): Promise<void> => {
      clearTimeout(debounce);
      this.contents.cancel();
      state.query = query;
      pendingSelection = state.selectedId;
      const generation = requests.next();
      preview.suspend();
      previewedId = undefined;
      previewError = undefined;
      picker.busy = true;
      title(`Telescope Picker · ${modeLabel()}`);
      status('Loading workspace files...');
      try {
        if (query.length > 1024) throw new Error('Queries are limited to 1,024 characters.');
        if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a folder or workspace to find files.');
        if (state.mode === 'contents') {
          if (!query.length) {
            status('Type text to search inside workspace files.');
            return;
          }
          await this.contents.search(query, result => {
            if (!closed && requests.isCurrent(generation)) contentResults(result);
          });
          return;
        }
        const indexed = await this.files.getFiles();
        if (closed || !requests.isCurrent(generation)) return;
        const ranked = rankFiles(indexed.files, query);
        const items: FileItem[] = ranked.items.map(file => ({
          id: file.id, uri: file.id, path: file.path, label: literalLabel(file.path), description: literalLabel(file.root),
          resourceUri: vscode.Uri.parse(file.id), iconPath: vscode.ThemeIcon.File, alwaysShow: true, buttons: [splitButton]
        }));
        title(`Telescope Picker · ${ranked.total} results`
          + (ranked.truncated ? ` (showing ${items.length})` : '')
          + (indexed.truncated ? ' · Index limited to 100,000 files' : ''));
        display(items, query.trim() ? 'No matching files.' : 'No workspace files found.');
      } catch (reason) {
        if (!closed && requests.isCurrent(generation) && !(reason instanceof vscode.CancellationError)) {
          status(`Error: ${report(reason)}`);
        }
      } finally {
        if (!closed && requests.isCurrent(generation)) picker.busy = false;
      }
    };
    const schedule = (query: string): void => {
      if (closed || opening) return;
      clearTimeout(debounce);
      requests.cancel();
      this.contents.cancel();
      preview.suspend();
      previewedId = undefined;
      if (state.mode === 'files') { void search(query); return; }
      state.query = query;
      status(query.length ? 'Searching file contents...' : 'Type text to search inside workspace files.');
      picker.busy = Boolean(query.length);
      debounce = setTimeout(() => { void search(query); }, 80);
    };
    const setMode = async (next: PickerMode): Promise<void> => {
      if (closed || opening || next === state.mode) return;
      state.mode = next;
      state.selectedId = undefined;
      configure();
      await search(picker.value);
    };
    const close = (restoreFocus: boolean): void => {
      if (closed) return;
      closed = true;
      this.session = undefined;
      requests.cancel();
      clearTimeout(debounce);
      this.contents.cancel();
      this.files.cancel();
      if (!accepted) this.finishing = preview.finish(restoreFocus).catch(reason => {
        report(reason);
        void vscode.window.showErrorMessage('Telescope Picker could not restore the original editor. See output for details.');
      });
      this.resume = { ...state };
      subscriptions.forEach(subscription => subscription.dispose());
      picker.dispose();
      void vscode.commands.executeCommand('setContext', 'telescopePicker.active', false).then(undefined, reason => {
        report(reason);
        void vscode.window.showErrorMessage('Telescope Picker could not reset its keyboard context.');
      });
      void this.context.workspaceState.update('resume', this.resume).then(undefined, reason => {
        report(reason);
        void vscode.window.showErrorMessage('Telescope Picker could not save its resume state.');
      });
    };
    const accept = async (beside: boolean, candidate?: FileItem): Promise<void> => {
      if (closed || opening) return;
      const item = candidate ?? picker.activeItems[0];
      if (!item?.id || visible.get(item.id) !== item) return;
      opening = true;
      requests.cancel();
      clearTimeout(debounce);
      this.contents.cancel();
      this.files.cancel();
      picker.busy = false;
      picker.enabled = false;
      state.selectedId = item.id;
      try {
        await preview.accept(vscode.Uri.parse(item.uri ?? item.id), beside, item.location);
        if (closed) return;
        accepted = true;
        close(false);
      } catch (reason) {
        if (!closed) {
          report(reason);
          picker.title = 'Could not open file · See Output';
          picker.enabled = true;
          opening = false;
          picker.show();
        }
      }
    };
    const session: Session = { picker, state, select, accept, close, setMode };
    this.session = session;
    subscriptions.push(
      picker.onDidChangeValue(value => {
        if (value !== state.query) schedule(value);
      }),
      picker.onDidChangeActive(items => select(items[0])),
      picker.onDidAccept(() => { void accept(false); }),
      picker.onDidTriggerItemButton(event => { void accept(true, event.item); }),
      picker.onDidTriggerButton(() => { void setMode(state.mode === 'files' ? 'contents' : 'files'); }),
      picker.onDidHide(() => close(true)),
      this.files.onDidChange(() => { if (state.mode === 'files') schedule(picker.value); }),
      this.contents.onDidChange(() => { if (state.mode === 'contents') schedule(picker.value); })
    );
    picker.show();
    const searchReady = search(state.query);
    try {
      await vscode.commands.executeCommand('setContext', 'telescopePicker.active', true);
      if (closed) return;
      await searchReady;
      if (!closed) picker.show();
    } catch (reason) {
      if (!closed) {
        report(reason);
        void vscode.window.showErrorMessage('Could not initialize picker keyboard controls. The file popup is still available.');
        picker.show();
      }
    }
  }

  async openBeside(): Promise<void> { await this.session?.accept(true); }

  navigate(direction: number): boolean {
    const session = this.session;
    if (!session) return false;
    const picker = session.picker;
    const items = picker.items.filter(item => item.id);
    const currentId = picker.activeItems[0]?.id ?? session.state.selectedId;
    const current = items.findIndex(item => item.id === currentId);
    const next = items[Math.max(0, Math.min(items.length - 1, current + direction))];
    if (!next || next.id === currentId) return false;
    picker.activeItems = [next];
    session.select(next);
    return true;
  }

  dispose(): void {
    this.session?.close(false);
    this.contents.dispose();
    this.files.dispose();
  }
}
