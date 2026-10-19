import * as vscode from 'vscode';
import { FileProvider } from './files';
import { LatestRequest } from './latest';
import { EditorPreview, PreviewTooLargeError } from './editorPreview';
import { createContentMatcher } from './ranking';
import { FileRanking } from './fileRanking';
import { ContentProvider, type ContentUpdate } from './contents';
import { GitChangesProvider } from './gitChanges';
import type { ContentMatch, DiffTarget, MatchLocation } from './types';

type PickerMode = 'files' | 'contents' | 'currentFile' | 'gitDiffs';
interface ResumeState { query: string; selectedId?: string; mode: PickerMode; documentUri?: string }
interface FileItem extends vscode.QuickPickItem { id?: string; uri?: string; path?: string; location?: MatchLocation; diff?: DiffTarget }
interface Session {
  picker: vscode.QuickPick<FileItem>;
  state: ResumeState;
  select(item: FileItem): void;
  accept(beside: boolean, item?: FileItem): Promise<void>;
  close(restoreFocus: boolean): void;
  setMode(mode: PickerMode, query?: string): Promise<void>;
}

const PAGE_SIZE = 200;

function savedState(value: unknown): ResumeState {
  if (typeof value !== 'object' || value === null) return { query: '', mode: 'files' };
  const query = 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 1024) : '';
  const selectedId = 'selectedId' in value && typeof value.selectedId === 'string' ? value.selectedId : undefined;
  const mode = 'mode' in value && (value.mode === 'contents' || value.mode === 'currentFile' || value.mode === 'gitDiffs') ? value.mode : 'files';
  const documentUri = 'documentUri' in value && typeof value.documentUri === 'string' ? value.documentUri : undefined;
  return { query, selectedId, mode, ...(documentUri ? { documentUri } : {}) };
}

function literalLabel(text: string): string { return text.replace(/\$\(/g, '\\$('); }

function compactPath(path: string, limit = 72): string {
  const characters = Array.from(path);
  return characters.length <= limit ? path : `...${characters.slice(-(limit - 3)).join('')}`;
}

function filename(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }

export class PickerController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly files = new FileProvider();
  private readonly contents: ContentProvider;
  private readonly gitChanges = new GitChangesProvider();
  private readonly fileRanking = new FileRanking();
  private resume: ResumeState;
  private finishing: Promise<void> = Promise.resolve();
  private accepting: Promise<void> | undefined;

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>
  ) {
    this.resume = savedState(context.workspaceState.get('resume'));
    this.contents = new ContentProvider(this.files, message => this.output.appendLine(message));
  }

  async show(resume = false, mode: PickerMode = 'files', query?: string): Promise<void> {
    const started = Date.now();
    this.output.appendLine(`Picker requested: ${resume ? 'resume' : mode}`);
    await this.accepting;
    await this.finishing;
    if (this.session) {
      const session = this.session;
      session.picker.show();
      this.output.appendLine(`Picker shown (existing): ${Date.now() - started} ms`);
      if (!resume) await session.setMode(mode, query);
      return;
    }
    const previous = vscode.window.activeTextEditor;
    const column = previous?.viewColumn ?? vscode.ViewColumn.One;
    const picker = vscode.window.createQuickPick<FileItem>();
    const state: ResumeState = resume ? { ...this.resume } : { query: query ?? '', mode };
    const originalDocumentUri = previous?.document.uri.toString();
    if (state.mode === 'currentFile' && !resume) state.documentUri = originalDocumentUri;
    const requests = new LatestRequest();
    const pageRequests = new LatestRequest();
    const subscriptions: vscode.Disposable[] = [];
    const splitButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open beside (Ctrl/Cmd+Enter)'
    };
    const pathButton = (path: string, root: string): vscode.QuickInputButton => ({
      iconPath: splitButton.iconPath, tooltip: `${path} · ${root}\n${splitButton.tooltip}`
    });
    let closed = false;
    let notifyClosed: (() => void) | undefined;
    const whenClosed = new Promise<void>(resolve => { notifyClosed = resolve; });
    let accepted = false;
    let opening = false;
    let visible = new Map<string, FileItem>();
    let contentRows = new WeakMap<ContentMatch, FileItem>();
    const fileRows = new Map<string, FileItem>();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let previewedId: string | undefined;
    let pendingSelection: string | undefined;
    let applying = false;
    let resetScroll = true;
    let selectionTouched = resume;
    let awaitingNativeSelection = false;
    let resultTitle = 'Telescope Picker';
    let previewError: string | undefined;
    let renderMilliseconds = 0;
    let page = 0;
    let resultCount = 0;
    let renderPage: (() => void) | undefined;
    let searchGeneration = 0;
    const title = (value: string): void => {
      resultTitle = value;
      const next = previewError ?? value;
      if (picker.title !== next) picker.title = next;
    };
    picker.title = 'Telescope Picker';
    const currentFileButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Search current file'
    };
    const gitButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Browse Git changes'
    };
    const previousPageButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('chevron-left'), tooltip: 'Previous page'
    };
    const nextPageButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('chevron-right'), tooltip: 'Next page'
    };
    let modeButtons: vscode.QuickInputButton[] = [];
    const updateButtons = (): void => {
      const buttons = [...modeButtons,
        ...(page > 0 ? [previousPageButton] : []),
        ...((page + 1) * PAGE_SIZE < resultCount ? [nextPageButton] : [])];
      const previous = picker.buttons;
      if (buttons.length !== previous.length || buttons.some((button, index) => button !== previous[index]))
        picker.buttons = buttons;
    };
    const pageItems = <T extends { id: string }>(items: {
      readonly length: number;
      slice(start: number, end: number): readonly T[];
      findIndex(predicate: (item: T) => boolean): number;
    }): readonly T[] => {
      const selectedId = pendingSelection ?? (selectionTouched ? state.selectedId : undefined);
      if (selectedId) {
        const index = items.findIndex(item => item.id === selectedId);
        if (index >= 0) page = Math.floor(index / PAGE_SIZE);
      }
      page = Math.min(page, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
      resultCount = items.length;
      updateButtons();
      return items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    };
    const pageTitle = (): string => resultCount > PAGE_SIZE
      ? ` · Page ${page + 1}/${Math.ceil(resultCount / PAGE_SIZE)} · ${PAGE_SIZE} per page` : '';
    const modeLabel = (): string => state.mode === 'files' ? 'Files'
      : state.mode === 'currentFile' ? 'Current File' : state.mode === 'gitDiffs' ? 'Git Changes' : 'File Contents';
    const configure = (): void => {
      picker.placeholder = `${state.mode === 'files' ? 'Fuzzy file names'
        : state.mode === 'currentFile' ? 'Search current file (ignore case)' : state.mode === 'gitDiffs'
          ? 'All Git hunks · Type to filter (optional)' : 'Search text within files (ignore case)'} · Enter Open · Ctrl/Cmd+Enter Split · Esc Close`;
      modeButtons = [{
        iconPath: new vscode.ThemeIcon(state.mode === 'files' ? 'search' : 'files'),
        tooltip: state.mode === 'files' ? 'Search file contents' : 'Find files'
      }, currentFileButton, gitButton];
      updateButtons();
    };
    configure();
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = false;
    picker.keepScrollPosition = false;
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
      renderPage = undefined;
      page = 0;
      resultCount = 0;
      updateButtons();
      visible.clear();
      picker.items = [{ label: message, alwaysShow: true }];
      picker.activeItems = [];
    };
    const loading = (message: string): void => {
      renderPage = undefined;
      resultCount = 0;
      updateButtons();
      visible.clear();
      if (!picker.items.some(item => item.id)) status(message);
    };
    const select = (item: FileItem | undefined): void => {
      if (closed || opening || !item?.id || visible.get(item.id) !== item) return;
      if (!applying && !awaitingNativeSelection && state.selectedId !== item.id) selectionTouched = true;
      awaitingNativeSelection = false;
      state.selectedId = item.id;
      if (previewedId === item.id) return;
      if (!applying) pendingSelection = undefined;
      previewError = undefined;
      title(resultTitle);
      previewedId = item.id;
      preview.select(item.uri ?? item.id, item.location, item.diff);
    };
    const display = (items: FileItem[], empty: string): void => {
      const previousItems = picker.items;
      items = items.map((item, index) => {
        const previous = item.id ? visible.get(item.id) : previousItems[index];
        return previous && previous.id === item.id && previous.label === item.label
          && previous.description === item.description && previous.uri === item.uri
          && previous.buttons?.[0]?.tooltip === item.buttons?.[0]?.tooltip
          && previous.location?.text === item.location?.text
          && JSON.stringify(previous.diff) === JSON.stringify(item.diff) ? previous : item;
      });
      const unchanged = items.length === previousItems.length && items.every((item, index) => item === previousItems[index]);
      const current = picker.activeItems[0]?.id;
      const retainNativeSelection = current && visible.has(current)
        && previousItems.find(item => item.id)?.id === items.find(item => item.id)?.id;
      visible = new Map(items.flatMap(item => item.id ? [[item.id, item] as const] : []));
      if (!items.length) status(empty);
      else {
        const active = items.find(item => item.id && item.id === pendingSelection)
          ?? (selectionTouched ? items.find(item => item.id && item.id === state.selectedId) : undefined)
          ?? items.find(item => item.id);
        if (active?.id === pendingSelection) pendingSelection = undefined;
        applying = true;
        try {
          picker.keepScrollPosition = !resetScroll && selectionTouched;
          resetScroll = false;
          if (state.mode !== 'files' && !selectionTouched && !pendingSelection) {
            if (!unchanged) {
              if (!retainNativeSelection) {
                awaitingNativeSelection = true;
                picker.activeItems = [];
              }
              picker.items = items;
            }
            return;
          }
          if (!unchanged) picker.items = items;
          if (!unchanged || current !== active?.id) picker.activeItems = active ? [active] : [];
          select(active);
        } finally { applying = false; }
      }
    };
    const contentResults = (result: ContentUpdate): void => {
      const renderStarted = performance.now();
      if (result.page) {
        page = Math.floor(result.page.offset / PAGE_SIZE);
        resultCount = result.page.length;
        updateButtons();
      }
      renderPage = () => {
        if (!result.page) { contentResults(result); return; }
        const generation = searchGeneration;
        const request = pageRequests.next();
        void result.page.load(page * PAGE_SIZE).then(value => {
          if (!closed && !opening && requests.isCurrent(generation) && pageRequests.isCurrent(request))
            contentResults(value);
        }, reason => {
          if (!closed && !opening && requests.isCurrent(generation) && pageRequests.isCurrent(request)
            && !(reason instanceof vscode.CancellationError)) {
            report(reason);
            title('Could not load result page · See Output');
          }
        });
      };
      let ordered = result.items;
      if (state.mode === 'gitDiffs') {
        const groups = new Map<string, ContentMatch[]>();
        for (const match of result.items) {
          const key = JSON.stringify([match.path, match.root]);
          const group = groups.get(key);
          if (group) group.push(match);
          else groups.set(key, [match]);
        }
        ordered = [...groups.values()].flatMap(matches => matches.sort((a, b) =>
          (a.diff?.modifiedLine ?? a.location.line) - (b.diff?.modifiedLine ?? b.location.line)));
      }
      const groups = new Map<string, ContentMatch[]>();
      for (const match of result.page ? result.items : pageItems(ordered)) {
        const key = JSON.stringify([match.diff ? match.path : match.uri, match.root]);
        const group = groups.get(key);
        if (group) group.push(match);
        else groups.set(key, [match]);
      }
      const lineOrdered = state.mode === 'currentFile' || state.mode === 'contents';
      const items: FileItem[] = [];
      for (const matches of groups.values()) {
        const first = matches[0];
        if (!first) continue;
        items.push({
          kind: vscode.QuickPickItemKind.Separator,
          label: `${literalLabel(compactPath(first.path))} · ${literalLabel(compactPath(first.root, 32))} (${matches.length})`
        });
        for (const match of matches.sort((a, b) =>
          (a.diff?.modifiedLine ?? a.location.line) - (b.diff?.modifiedLine ?? b.location.line))) {
          const cached = contentRows.get(match);
          if (cached) { items.push(cached); continue; }
          const text = match.location.text;
          const start = Math.max(0, (match.location.matches[0] ?? 0) - 40);
          const excerpt = text.slice(start, start + 400).trim();
          const item: FileItem = {
            id: match.id, uri: match.uri, path: match.path, location: match.location, diff: match.diff,
            resourceUri: vscode.Uri.parse(match.uri), iconPath: vscode.ThemeIcon.File,
            label: lineOrdered ? literalLabel(compactPath(filename(first.path), 48)) : literalLabel(match.diff?.hunk
              ?? `${match.diff ? match.diff.side === 'added' ? '+ ' : '- ' : ''}${start ? '...' : ''}${excerpt || '(whitespace)'}${start + 400 < text.length ? '...' : ''}`),
            description: lineOrdered
              ? `${match.location.line + 1}: ${literalLabel(`${start ? '...' : ''}${excerpt || '(whitespace)'}${start + 400 < text.length ? '...' : ''}`)}${state.mode === 'contents' ? ` · ${literalLabel(compactPath(match.root, 32))}` : ''}`
              : `${literalLabel(compactPath(match.path))}${match.diff?.metadataOnly ? '' : `:${match.location.line + 1}`} · ${literalLabel(compactPath(match.root, 32))}`,
            alwaysShow: true, buttons: [pathButton(match.path, match.root)]
          };
          contentRows.set(match, item);
          items.push(item);
        }
      }
      title(`Telescope Picker · ${modeLabel()} · ${result.total} ${state.mode === 'gitDiffs' ? 'hunks / changes' : 'matching lines'}`
        + pageTitle()
        + (state.mode === 'gitDiffs' ? ' · Saved Git changes' : '')
        + (result.complete ? ' · Search complete' : ` · Searching roots ${result.searchedRoots}/${result.roots}`)
        + (result.binary ? ` · ${result.binary} binary files${state.mode === 'gitDiffs' ? '' : ' skipped'}` : '')
        + (result.unsupported ? ` · ${result.unsupported} unsupported resources skipped (see Output)` : ''));
      if (items.length || result.complete)
        display(items, state.mode === 'gitDiffs'
          ? state.query ? 'No Git changes match this filter.' : 'No Git changes.' : 'No matching text.');
      renderMilliseconds += performance.now() - renderStarted;
    };
    const search = async (query: string): Promise<void> => {
      const started = performance.now();
      renderMilliseconds = 0;
      clearTimeout(debounce);
      this.contents.cancel();
      this.gitChanges.cancel();
      this.fileRanking.cancel();
      state.query = query;
      pendingSelection = state.selectedId;
      const generation = requests.next();
      searchGeneration = generation;
      pageRequests.cancel();
      preview.suspend();
      previewedId = undefined;
      previewError = undefined;
      picker.busy = true;
      title(`Telescope Picker · ${modeLabel()}`);
      loading('Loading workspace files...');
      try {
        if (query.length > 1024) throw new Error('Queries are limited to 1,024 characters.');
        if (state.mode === 'gitDiffs') {
          await this.gitChanges.search(query, result => {
            if (!closed && requests.isCurrent(generation)) contentResults(result);
          });
          return;
        }
        if (state.mode === 'currentFile') {
          if (!state.documentUri) throw new Error('Open a text editor to search the current file.');
          if (!query.length) {
            status('Type text to search in the current file.');
            return;
          }
          const uri = vscode.Uri.parse(state.documentUri);
          const document = vscode.workspace.textDocuments.find(candidate =>
            !candidate.isClosed && candidate.uri.toString() === state.documentUri)
            ?? await vscode.workspace.openTextDocument(uri);
          if (closed || !requests.isCurrent(generation)) return;
          const version = document.version;
          const path = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
          const file = {
            id: uri.toString(), path, name: path.split('/').at(-1) ?? path,
            root: vscode.workspace.getWorkspaceFolder(uri)?.name ?? 'Current file'
          };
          const matchLine = createContentMatcher(query);
          const items: ContentMatch[] = [];
          for (let line = 0; line < document.lineCount; line++) {
            if (line % 512 === 0) {
              await new Promise<void>(done => setTimeout(done, 0));
              if (closed || !requests.isCurrent(generation)) return;
              if (document.isClosed || document.version !== version)
                throw new Error('Current file changed during search. Type again to refresh results.');
            }
            const match = matchLine(file, line, document.lineAt(line).text);
            if (match) items.push(match);
          }
          if (!closed && requests.isCurrent(generation)) contentResults({
            items, total: items.length, complete: true, roots: 1, searchedRoots: 1, binary: 0, unsupported: 0
          });
          return;
        }
        if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a folder or workspace to find files.');
        if (state.mode === 'contents') {
          if (!query.length) {
            status('Type text to search inside workspace files.');
            return;
          }
          await this.contents.search(query, result => {
            if (!closed && requests.isCurrent(generation)) contentResults(result);
          }, { size: PAGE_SIZE, selectedId: () => pendingSelection ?? (selectionTouched ? state.selectedId : undefined) });
          return;
        }
        const indexed = await this.files.getFiles();
        if (closed || !requests.isCurrent(generation)) return;
        const ranked = await this.fileRanking.rank(indexed.files, query);
        if (closed || !requests.isCurrent(generation)) return;
        const showFiles = (): void => {
          renderPage = showFiles;
          const items: FileItem[] = pageItems(ranked.items).map(file => {
            const slash = file.path.lastIndexOf('/');
            const folder = slash >= 0 ? file.path.slice(0, slash) : '';
            const description = literalLabel(compactPath(`${folder ? `${folder} · ` : ''}${file.root}`));
            const cached = fileRows.get(file.id);
            if (cached?.path === file.path && cached.description === description) return cached;
            const item: FileItem = {
              id: file.id, uri: file.id, path: file.path, label: literalLabel(compactPath(filename(file.path), 48)), description,
              resourceUri: vscode.Uri.parse(file.id), iconPath: vscode.ThemeIcon.File, alwaysShow: true,
              buttons: [pathButton(file.path, file.root)]
            };
            fileRows.set(file.id, item);
            return item;
          });
          title(`Telescope Picker · ${ranked.total} results`
            + pageTitle()
            + (indexed.truncated ? ' · Index limited to 100,000 files' : ''));
          display(items, query.trim() ? 'No matching files.' : 'No workspace files found.');
        };
        showFiles();
      } catch (reason) {
        if (!closed && requests.isCurrent(generation) && !(reason instanceof vscode.CancellationError)) {
          status(`Error: ${report(reason)}`);
        }
      } finally {
        if (!closed && requests.isCurrent(generation)) {
          picker.busy = false;
          if (vscode.workspace.getConfiguration('telescopePicker').get<boolean>('performanceDiagnostics', false))
            this.output.appendLine(`Performance: ${state.mode}, ${(performance.now() - started).toFixed(1)} ms search/update, `
              + `${renderMilliseconds.toFixed(1)} ms content row preparation/dispatch, ${visible.size} results. `
              + 'Excludes native rendering and editor/language-server work.');
        }
      }
    };
    const schedule = (query: string): void => {
      if (closed || opening) return;
      if (query !== state.query) page = 0;
      if (state.mode !== 'files' && query !== state.query) {
        state.selectedId = undefined;
        selectionTouched = false;
        pendingSelection = undefined;
        resetScroll = true;
        picker.keepScrollPosition = false;
      }
      clearTimeout(debounce);
      requests.cancel();
      pageRequests.cancel();
      this.fileRanking.cancel();
      this.contents.cancel();
      this.gitChanges.cancel();
      preview.suspend();
      previewedId = undefined;
      if (state.mode === 'files') {
        state.query = query;
        picker.busy = true;
        loading('Searching workspace files...');
        debounce = setTimeout(() => { void search(query); }, 50);
        return;
      }
      state.query = query;
      loading(state.mode === 'gitDiffs' ? 'Loading Git changes...' : query.length ? 'Searching file contents...' : state.mode === 'currentFile'
          ? 'Type text to search in the current file.' : 'Type text to search inside workspace files.');
      picker.busy = state.mode === 'gitDiffs' || Boolean(query.length);
      debounce = setTimeout(() => { void search(query); }, 80);
    };
    const setMode = async (next: PickerMode, query?: string): Promise<void> => {
      if (next === 'gitDiffs' && query === undefined) query = '';
      if (closed || opening || next === state.mode && (query === undefined || query === picker.value)) return;
      if (next === 'currentFile' && next !== state.mode) state.documentUri = originalDocumentUri;
      state.mode = next;
      page = 0;
      if (query !== undefined) {
        state.query = query;
        picker.value = query;
      }
      state.selectedId = undefined;
      contentRows = new WeakMap<ContentMatch, FileItem>();
      selectionTouched = false;
      pendingSelection = undefined;
      resetScroll = true;
      picker.keepScrollPosition = false;
      configure();
      await Promise.race([search(picker.value), whenClosed]);
    };
    const close = (restoreFocus: boolean): void => {
      if (closed) return;
      closed = true;
      notifyClosed?.();
      this.session = undefined;
      requests.cancel();
      this.fileRanking.cancel();
      clearTimeout(debounce);
      this.contents.cancel();
      this.gitChanges.cancel();
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
    const acceptItem = async (beside: boolean, candidate?: FileItem): Promise<void> => {
      if (closed || opening) return;
      const item = candidate ?? picker.activeItems[0];
      if (!item?.id || visible.get(item.id) !== item) return;
      opening = true;
      requests.cancel();
      this.fileRanking.cancel();
      clearTimeout(debounce);
      this.contents.cancel();
      this.gitChanges.cancel();
      this.files.cancel();
      picker.busy = false;
      picker.enabled = false;
      state.selectedId = item.id;
      try {
        await preview.accept(vscode.Uri.parse(item.uri ?? item.id), beside, item.location, item.diff);
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
    const accept = (beside: boolean, candidate?: FileItem): Promise<void> => {
      if (closed || opening) return Promise.resolve();
      const operation = acceptItem(beside, candidate);
      this.accepting = operation;
      return operation.finally(() => {
        if (this.accepting === operation) this.accepting = undefined;
      });
    };
    const session: Session = {
      picker, state, accept, close, setMode,
      select: item => {
        awaitingNativeSelection = false;
        selectionTouched = true;
        select(item);
      }
    };
    this.session = session;
    subscriptions.push(
      picker.onDidChangeValue(value => {
        if (value !== state.query) schedule(value);
      }),
      picker.onDidChangeActive(items => select(items[0])),
      picker.onDidAccept(() => { void accept(false); }),
      picker.onDidTriggerItemButton(event => { void accept(true, event.item); }),
      picker.onDidTriggerButton(button => {
        if (button === previousPageButton || button === nextPageButton) {
          if (closed || opening || !renderPage) return;
          const next = page + (button === nextPageButton ? 1 : -1);
          if (next < 0 || next * PAGE_SIZE >= resultCount) return;
          page = next;
          pendingSelection = undefined;
          state.selectedId = undefined;
          selectionTouched = false;
          resetScroll = true;
          preview.suspend();
          previewedId = undefined;
          visible.clear();
          renderPage();
          return;
        }
        void setMode(button === currentFileButton ? 'currentFile' : button === gitButton ? 'gitDiffs'
          : state.mode === 'files' ? 'contents' : 'files');
      }),
      picker.onDidHide(() => {
        this.output.appendLine(`Picker hidden: ${state.mode}`);
        if (!opening) close(true);
      }),
      this.files.onDidChange(() => { if (state.mode === 'files') schedule(picker.value); }),
      this.contents.onDidChange(() => { if (state.mode === 'contents') schedule(picker.value); }),
      this.gitChanges.onDidChange(() => { if (state.mode === 'gitDiffs') schedule(picker.value); }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (state.mode === 'currentFile' && event.contentChanges.length
          && event.document.uri.toString() === state.documentUri) schedule(picker.value);
      })
    );
    picker.show();
    this.output.appendLine(`Picker shown: ${Date.now() - started} ms`);
    const searchReady = search(state.query);
    try {
      await vscode.commands.executeCommand('setContext', 'telescopePicker.active', true);
      if (closed) return;
      await Promise.race([searchReady, whenClosed]);
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
    this.gitChanges.dispose();
    this.fileRanking.dispose();
    this.files.dispose();
  }
}
