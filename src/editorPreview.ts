import * as vscode from 'vscode';
import type { MatchLocation } from './types';

const MAX_AUTO_PREVIEW_BYTES = 1024 * 1024;

export class EditorPreview {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private mode: 'active' | 'accepting' | 'accepted' | 'cancelled' = 'active';
  private readonly ownedTabs = new Map<vscode.Tab, boolean>();
  private readonly selections: readonly vscode.Selection[];
  private readonly visibleRange: vscode.Range | undefined;
  private readonly originalWasPreview: boolean;
  private readonly backgroundPreview: vscode.Uri | undefined;
  private replacedBackgroundPreview = false;
  private decoration: vscode.TextEditorDecorationType | undefined;
  private decoratedEditor: vscode.TextEditor | undefined;

  constructor(
    private readonly original: vscode.TextEditor | undefined,
    private readonly column: vscode.ViewColumn,
    private readonly onError: (reason: unknown) => void
  ) {
    this.selections = original ? [...original.selections] : [];
    this.visibleRange = original?.visibleRanges[0];
    const group = vscode.window.tabGroups.all.find(candidate => candidate.viewColumn === column);
    this.originalWasPreview = group?.activeTab?.isPreview ?? false;
    const background = group?.tabs.find(tab => tab.isPreview && tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() !== original?.document.uri.toString());
    this.backgroundPreview = background?.input instanceof vscode.TabInputText ? background.input.uri : undefined;
  }

  select(id: string, location?: MatchLocation): void {
    if (this.mode !== 'active') return;
    this.suspend();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(async () => {
        if (!this.current(generation)) return;
        const uri = vscode.Uri.parse(id);
        let document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === id);
        if (!document) {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!this.current(generation)) return;
          if (stat.size > MAX_AUTO_PREVIEW_BYTES)
            throw new Error('File exceeds the 1 MiB automatic preview limit. Press Enter to open it.');
          document = await vscode.workspace.openTextDocument(uri);
        }
        if (!this.current(generation)) return;
        const selection = location ? this.matchRange(document, location) : undefined;
        const before = new Set(this.tabs());
        const background = this.backgroundPreview?.toString();
        const hadBackground = background && this.tabs().some(tab => this.isTextTab(tab, background));
        try {
          const editor = await vscode.window.showTextDocument(document, {
            viewColumn: this.column, preserveFocus: true, preview: true, ...(selection ? { selection } : {})
          });
          if (location && this.current(generation)) this.highlight(editor, location);
          await this.waitForTabs(() => this.tabs().some(tab => this.isTextTab(tab, id)),
            'Could not confirm the temporary preview tab.');
        } finally {
          for (const tab of this.tabs()) if (!before.has(tab) && this.isTextTab(tab, id))
            this.ownedTabs.set(tab, tab.isPreview);
          if (background && hadBackground
            && !this.tabs().some(tab => this.isTextTab(tab, background))) this.replacedBackgroundPreview = true;
        }
      }, false).catch(reason => {
        if (this.current(generation) && !(reason instanceof vscode.CancellationError)) this.onError(reason);
      });
    }, 35);
  }

  suspend(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.decoration && this.decoratedEditor) this.decoratedEditor.setDecorations(this.decoration, []);
    this.decoratedEditor = undefined;
  }

  async accept(uri: vscode.Uri, beside: boolean, location?: MatchLocation): Promise<void> {
    this.suspend();
    this.mode = 'accepting';
    try {
      await this.enqueue(async () => {
        if (this.mode !== 'accepting') throw new vscode.CancellationError();
        const document = location ? await vscode.workspace.openTextDocument(uri) : undefined;
        const selection = document && location ? this.matchRange(document, location) : undefined;
        if (beside) {
          await this.cleanup();
          await this.restoreBackgroundPreview();
          await this.restore(false);
        }
        if (this.mode !== 'accepting') throw new vscode.CancellationError();
        await vscode.window.showTextDocument(uri, {
          viewColumn: beside ? vscode.ViewColumn.Beside : this.column, preserveFocus: false, preview: false,
          ...(selection ? { selection } : {})
        });
        await this.cleanup(beside ? undefined : uri.toString());
        if (!beside && await this.restoreBackgroundPreview() && this.mode === 'accepting')
          await vscode.window.showTextDocument(uri, {
            viewColumn: this.column, preserveFocus: false, preview: false, ...(selection ? { selection } : {})
          });
        if (this.mode === 'accepting') {
          this.mode = 'accepted';
          this.decoration?.dispose();
          this.decoration = undefined;
        }
      }, false);
    } catch (reason) {
      if (this.mode === 'accepting') this.mode = 'active';
      throw reason;
    }
  }

  finish(restoreFocus: boolean): Promise<void> {
    this.suspend();
    this.mode = 'cancelled';
    return this.enqueue(async () => {
      await this.cleanup();
      await this.restoreBackgroundPreview();
      await this.restore(!restoreFocus);
    }, false).finally(() => {
      this.decoration?.dispose();
      this.decoration = undefined;
    });
  }

  private matchRange(document: vscode.TextDocument, location: MatchLocation): vscode.Range {
    if (location.line >= document.lineCount || document.lineAt(location.line).text !== location.text)
      throw new Error('File contents changed since this match was found. Search again to refresh results.');
    const character = location.matches[0] ?? 0;
    return new vscode.Range(location.line, character, location.line, character);
  }

  private highlight(editor: vscode.TextEditor, location: MatchLocation): void {
    const range = this.matchRange(editor.document, location);
    this.decoration ??= vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'), borderWidth: '1px', borderStyle: 'solid'
    });
    editor.setDecorations(this.decoration, location.matches.map(character =>
      new vscode.Range(location.line, character, location.line, character + 1)));
    this.decoratedEditor = editor;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private current(generation: number): boolean {
    return this.mode === 'active' && generation === this.generation;
  }

  // Editor opens cannot be cancelled; restoration must run after any in-flight open.
  private enqueue(action: () => Promise<void>, report = true): Promise<void> {
    const result = this.tail.then(action);
    this.tail = result.then(undefined, reason => {
      if (report && !(reason instanceof vscode.CancellationError)) this.onError(reason);
    });
    return result;
  }

  private tabs(): readonly vscode.Tab[] {
    return vscode.window.tabGroups.all.find(group => group.viewColumn === this.column)?.tabs ?? [];
  }

  private isTextTab(tab: vscode.Tab, id: string): boolean {
    return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === id;
  }

  private async cleanup(keepId?: string): Promise<void> {
    const tabs = this.tabs().filter(tab => this.ownedTabs.has(tab) && !tab.isDirty
      && !(this.ownedTabs.get(tab) && !tab.isPreview)
      && !(keepId && this.isTextTab(tab, keepId)));
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true))
      throw new Error('Could not close temporary picker preview tabs.');
    if (tabs.length) await this.waitForTabs(() => !this.tabs().some(tab => tabs.includes(tab)),
      'Temporary preview tabs did not close.');
    for (const tab of tabs) this.ownedTabs.delete(tab);
  }

  private async restoreBackgroundPreview(): Promise<boolean> {
    const uri = this.backgroundPreview;
    if (!uri || !this.replacedBackgroundPreview || this.tabs().some(tab => this.isTextTab(tab, uri.toString()))) return false;
    await vscode.window.showTextDocument(uri, { viewColumn: this.column, preserveFocus: true, preview: true });
    await this.waitForTabs(() => this.tabs().some(tab => this.isTextTab(tab, uri.toString())),
      'Could not restore the previous background preview tab.');
    this.replacedBackgroundPreview = false;
    return true;
  }

  private async waitForTabs(condition: () => boolean, message: string): Promise<void> {
    if (condition()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        subscription.dispose();
        if (error) reject(error);
        else resolve();
      };
      const subscription = vscode.window.tabGroups.onDidChangeTabs(() => {
        if (condition()) finish();
      });
      const timer = setTimeout(() => finish(new Error(message)), 5000);
      if (condition()) finish();
    });
  }

  private async restore(preserveFocus: boolean): Promise<void> {
    if (this.original) {
      const document = this.original.document;
      const editor = await vscode.window.showTextDocument(document.uri, {
        viewColumn: this.column, preserveFocus, preview: this.originalWasPreview
      });
      editor.selections = [...this.selections];
      if (this.visibleRange) {
        const center = Math.floor((this.visibleRange.start.line + this.visibleRange.end.line) / 2);
        editor.revealRange(new vscode.Range(center, 0, center, 0), vscode.TextEditorRevealType.InCenter);
      }
    } else if (!preserveFocus) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }
}
