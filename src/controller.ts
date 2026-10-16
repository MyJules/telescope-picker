import * as vscode from 'vscode';
import { FileProvider } from './files';
import { LatestRequest } from './latest';
import { EditorPreview } from './editorPreview';
import { rankFiles } from './ranking';

interface ResumeState { query: string; selectedId?: string }
interface FileItem extends vscode.QuickPickItem { id?: string; path?: string }
interface Session {
  picker: vscode.QuickPick<FileItem>;
  accept(beside: boolean, item?: FileItem): Promise<void>;
  close(restoreFocus: boolean): void;
}

function savedState(value: unknown): ResumeState {
  if (typeof value !== 'object' || value === null) return { query: '' };
  const query = 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 1024) : '';
  const selectedId = 'selectedId' in value && typeof value.selectedId === 'string' ? value.selectedId : undefined;
  return { query, selectedId };
}

export class PickerController implements vscode.Disposable {
  private session: Session | undefined;
  private readonly files = new FileProvider();
  private resume: ResumeState;
  private finishing: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'workspaceState'>,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>
  ) {
    this.resume = savedState(context.workspaceState.get('resume'));
  }

  async show(resume = false): Promise<void> {
    await this.finishing;
    if (this.session) { this.session.picker.show(); return; }
    const previous = vscode.window.activeTextEditor;
    const column = previous?.viewColumn ?? vscode.ViewColumn.One;
    const picker = vscode.window.createQuickPick<FileItem>();
    const state: ResumeState = resume ? { ...this.resume } : { query: '' };
    const requests = new LatestRequest();
    const subscriptions: vscode.Disposable[] = [];
    const splitButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open beside (Ctrl/Cmd+Enter)'
    };
    let closed = false;
    let accepted = false;
    let opening = false;
    let visible = new Map<string, FileItem>();
    picker.title = 'Telescope Picker';
    picker.placeholder = 'Find files · Enter Open · Ctrl/Cmd+Enter Split · Esc Close';
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
      const message = report(reason);
      if (!closed) picker.title = `Could not preview file: ${message}`;
    });
    const status = (message: string): void => {
      visible.clear();
      picker.items = [{ label: message, alwaysShow: true }];
      picker.activeItems = [];
    };
    const select = (item: FileItem | undefined): void => {
      if (closed || !item?.id || visible.get(item.id) !== item) return;
      state.selectedId = item.id;
      preview.select(item.id);
    };
    const search = async (query: string): Promise<void> => {
      state.query = query;
      const generation = requests.next();
      preview.suspend();
      picker.busy = true;
      status('Loading workspace files...');
      try {
        if (query.length > 1024) throw new Error('Queries are limited to 1,024 characters.');
        if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a folder or workspace to find files.');
        const indexed = await this.files.getFiles();
        if (closed || !requests.isCurrent(generation)) return;
        const ranked = rankFiles(indexed.files, query);
        const items: FileItem[] = ranked.items.map(file => ({
          id: file.id, path: file.path, label: file.path, description: file.root,
          iconPath: new vscode.ThemeIcon('file'), alwaysShow: true, buttons: [splitButton]
        }));
        visible = new Map(items.flatMap(item => item.id ? [[item.id, item] as const] : []));
        picker.title = `Telescope Picker · ${ranked.total} results`
          + (ranked.truncated ? ` (showing ${items.length})` : '')
          + (indexed.truncated ? ' · Index limited to 100,000 files' : '');
        if (!items.length) status(query.trim() ? 'No matching files.' : 'No workspace files found.');
        else {
          picker.items = items;
          const active = items.find(item => item.id === state.selectedId) ?? items[0];
          picker.activeItems = active ? [active] : [];
          select(active);
        }
      } catch (reason) {
        if (!closed && requests.isCurrent(generation) && !(reason instanceof vscode.CancellationError)) {
          status(`Error: ${report(reason)}`);
        }
      } finally {
        if (!closed && requests.isCurrent(generation)) picker.busy = false;
      }
    };
    const close = (restoreFocus: boolean): void => {
      if (closed) return;
      closed = true;
      this.session = undefined;
      requests.cancel();
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
      picker.enabled = false;
      state.selectedId = item.id;
      try {
        await preview.accept(vscode.Uri.parse(item.id), beside);
        if (closed) return;
        accepted = true;
        close(false);
      } catch (reason) {
        if (!closed) {
          picker.title = `Could not open file: ${report(reason)}`;
          picker.enabled = true;
          opening = false;
          picker.show();
        }
      }
    };
    const session: Session = { picker, accept, close };
    this.session = session;
    subscriptions.push(
      picker.onDidChangeValue(query => { void search(query); }),
      picker.onDidChangeActive(items => select(items[0])),
      picker.onDidAccept(() => { void accept(false); }),
      picker.onDidTriggerItemButton(event => { void accept(true, event.item); }),
      picker.onDidHide(() => close(true)),
      this.files.onDidChange(() => { void search(picker.value); })
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

  navigate(direction: number): void {
    const picker = this.session?.picker;
    if (!picker) return;
    const items = picker.items.filter(item => item.id);
    const current = items.indexOf(picker.activeItems[0] ?? { label: '' });
    const next = items[Math.max(0, Math.min(items.length - 1, current + direction))];
    if (next) picker.activeItems = [next];
  }

  dispose(): void {
    this.session?.close(false);
    this.files.dispose();
  }
}
