import * as vscode from 'vscode';
import { FileProvider } from './files';
import { LatestRequest } from './latest';
import { pickerHtml } from './html';
import { PreviewService } from './preview';
import { parseClientMessage, type HostMessage, type ResultItem } from './protocol';
import { rankFiles } from './ranking';

interface ResumeState { query: string; selectedId?: string }

function savedState(value: unknown): ResumeState {
  if (typeof value !== 'object' || value === null) return { query: '' };
  const query = 'query' in value && typeof value.query === 'string' ? value.query.slice(0, 1024) : '';
  const selectedId = 'selectedId' in value && typeof value.selectedId === 'string' ? value.selectedId : undefined;
  return { query, selectedId };
}

export class PickerController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly files = new FileProvider();
  private readonly preview = new PreviewService();
  private resume: ResumeState;

  constructor(
    private readonly context: Pick<vscode.ExtensionContext, 'extensionUri' | 'workspaceState'>,
    private readonly output: Pick<vscode.OutputChannel, 'appendLine'>
  ) {
    this.resume = savedState(context.workspaceState.get('resume'));
  }

  show(resume = false): void {
    if (this.panel) {
      this.panel.reveal();
      void this.panel.webview.postMessage({ type: 'focus' } satisfies HostMessage);
      return;
    }
    const previous = vscode.window.activeTextEditor;
    const previousColumn = previous?.viewColumn ?? vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel('telescopePicker', 'Find Files', previousColumn, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media')
      ]
    });
    this.panel = panel;
    let state: ResumeState = resume ? { ...this.resume } : { query: '' };
    let disposed = false;
    let restoreOnClose = true;
    let wasActive = true;
    let opening = false;
    let lastQueryId = -1;
    let lastPreviewId = -1;
    let visible = new Map<string, ResultItem>();
    const queryRequests = new LatestRequest();
    const previewRequests = new LatestRequest();
    let previewCancellation: vscode.CancellationTokenSource | undefined;
    const subscriptions: vscode.Disposable[] = [];

    const post = (message: HostMessage): void => {
      if (!disposed) void panel.webview.postMessage(message);
    };
    const error = (scope: 'files' | 'preview' | 'protocol' | 'open', reason: unknown, requestId?: number): void => {
      const message = reason instanceof Error ? reason.message : String(reason);
      this.output.appendLine(`[${scope}] ${message}`);
      post({ type: 'error', scope, message, requestId });
    };
    const cancelPreview = (): void => {
      previewRequests.cancel();
      previewCancellation?.cancel();
      previewCancellation?.dispose();
      previewCancellation = undefined;
    };
    const restorePrevious = async (): Promise<void> => {
      if (previous && !previous.document.isClosed) {
        await vscode.window.showTextDocument(previous.document, {
          viewColumn: previousColumn, preserveFocus: false
        });
      } else {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      }
    };
    const search = async (query: string, requestId: number): Promise<void> => {
      const generation = queryRequests.next();
      cancelPreview();
      visible.clear();
      post({ type: 'loading', requestId });
      try {
        if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a folder or workspace to find files.');
        const indexed = await this.files.getFiles();
        if (disposed || !queryRequests.isCurrent(generation)) return;
        const ranked = rankFiles(indexed.files, query);
        visible = new Map(ranked.items.map(item => [item.id, item]));
        post({ type: 'results', requestId, ...ranked, indexTruncated: indexed.truncated });
      } catch (reason) {
        if (!disposed && queryRequests.isCurrent(generation) && !(reason instanceof vscode.CancellationError))
          error('files', reason, requestId);
      }
    };
    subscriptions.push(
      panel.onDidChangeViewState(event => { wasActive = event.webviewPanel.active; }),
      this.files.onDidChange(() => {
        queryRequests.cancel();
        cancelPreview();
        visible.clear();
        post({ type: 'refresh', workspace: workspaceLabel() });
      }),
      panel.webview.onDidReceiveMessage(async (raw: unknown) => {
        const message = parseClientMessage(raw);
        if (!message) { error('protocol', new Error('Invalid picker request.')); return; }
        switch (message.type) {
          case 'ready':
            post({ type: 'init', ...state, workspace: workspaceLabel(), vimNavigation: vimNavigation() });
            break;
          case 'query':
            if (message.requestId <= lastQueryId) return;
            lastQueryId = message.requestId;
            state.query = message.query;
            await search(message.query, message.requestId);
            break;
          case 'select': {
            if (message.requestId <= lastPreviewId) return;
            lastPreviewId = message.requestId;
            if (!visible.has(message.id)) { error('preview', new Error('This result is no longer available.'), message.requestId); return; }
            state.selectedId = message.id;
            cancelPreview();
            const generation = previewRequests.next();
            const cancellation = new vscode.CancellationTokenSource();
            previewCancellation = cancellation;
            try {
              await new Promise<void>(resolve => {
                let listener: vscode.Disposable | undefined;
                const timer = setTimeout(() => { listener?.dispose(); resolve(); }, 35);
                listener = cancellation.token.onCancellationRequested(() => {
                  clearTimeout(timer);
                  listener?.dispose();
                  resolve();
                });
              });
              if (cancellation.token.isCancellationRequested) return;
              const preview = await this.preview.load(vscode.Uri.parse(message.id), cancellation.token);
              if (!disposed && previewRequests.isCurrent(generation))
                post({ type: 'preview', requestId: message.requestId, id: message.id, ...preview });
            } catch (reason) {
              if (!disposed && previewRequests.isCurrent(generation) && !(reason instanceof vscode.CancellationError))
                error('preview', reason, message.requestId);
            } finally {
              if (previewCancellation === cancellation) {
                cancellation.dispose();
                previewCancellation = undefined;
              }
            }
            break;
          }
          case 'accept': {
            if (opening) return;
            if (!visible.has(message.id)) { error('open', new Error('This result is no longer available.')); return; }
            opening = true;
            state.selectedId = message.id;
            try {
              await vscode.window.showTextDocument(vscode.Uri.parse(message.id), {
                viewColumn: message.beside ? vscode.ViewColumn.Beside : previousColumn,
                preserveFocus: false, preview: false
              });
              if (!disposed) { restoreOnClose = false; panel.dispose(); }
            } catch (reason) {
              error('open', reason);
              opening = false;
            }
            break;
          }
          case 'close': panel.dispose(); break;
        }
      }),
      panel.onDidDispose(() => {
        disposed = true;
        if (this.panel === panel) this.panel = undefined;
        queryRequests.cancel();
        cancelPreview();
        this.files.cancel();
        this.resume = { ...state };
        void this.context.workspaceState.update('resume', this.resume).then(undefined, reason => {
          this.output.appendLine(`Could not save picker state: ${String(reason)}`);
          void vscode.window.showErrorMessage('Telescope Picker could not save its resume state. See output for details.');
        });
        subscriptions.forEach(subscription => subscription.dispose());
        if (restoreOnClose && wasActive) void restorePrevious().catch(reason => {
          this.output.appendLine(`Could not restore editor focus: ${String(reason)}`);
          void vscode.window.showErrorMessage('Telescope Picker could not restore the previous editor.');
        });
      })
    );
    panel.webview.html = pickerHtml({
      script: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')).toString(),
      style: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'picker.css')).toString(),
      cspSource: panel.webview.cspSource
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.files.dispose();
  }
}

function workspaceLabel(): string {
  return vscode.workspace.workspaceFolders?.map(folder => folder.name).join(' / ') ?? 'No workspace';
}
function vimNavigation(): boolean {
  return vscode.workspace.getConfiguration('telescopePicker').get<boolean>('vimNavigation', false);
}
