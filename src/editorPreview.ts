import * as vscode from 'vscode';
import type { DiffTarget, MatchLocation } from './types';

const MAX_AUTO_PREVIEW_BYTES = 1024 * 1024;

export class PreviewTooLargeError extends Error {
  constructor() { super('File exceeds the 1 MiB automatic preview limit. Press Enter to open it.'); }
}

export class EditorPreview {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private mode: 'active' | 'accepting' | 'accepted' | 'cancelled' = 'active';
  private readonly ownedTabs = new Map<vscode.Tab, boolean>();
  private readonly selections: readonly vscode.Selection[];
  private readonly visibleRange: vscode.Range | undefined;
  private readonly originalWasPreview: boolean;
  private readonly originalDiff: { original: vscode.Uri; modified: vscode.Uri; title: string } | undefined;
  private readonly backgroundPreview: vscode.Uri | undefined;
  private readonly backgroundDiff: { original: vscode.Uri; modified: vscode.Uri; title: string } | undefined;
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
    const input = group?.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) this.originalDiff = {
      original: input.original, modified: input.modified, title: group?.activeTab?.label ?? 'Diff'
    };
    const background = group?.tabs.find(tab => tab.isPreview && tab.input instanceof vscode.TabInputText
      && tab.input.uri.toString() !== original?.document.uri.toString());
    this.backgroundPreview = background?.input instanceof vscode.TabInputText ? background.input.uri : undefined;
    const diff = group?.tabs.find(tab => tab.isPreview && tab !== group.activeTab && tab.input instanceof vscode.TabInputTextDiff);
    if (diff?.input instanceof vscode.TabInputTextDiff)
      this.backgroundDiff = { original: diff.input.original, modified: diff.input.modified, title: diff.label };
  }

  select(id: string, location?: MatchLocation, diff?: DiffTarget): void {
    if (this.mode !== 'active') return;
    this.suspend();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.enqueue(async () => {
        if (!this.current(generation)) return;
        const uri = vscode.Uri.parse(id);
        let document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === id);
        if (!document && !diff?.metadataOnly) {
          if (uri.scheme !== 'git') {
            const stat = await vscode.workspace.fs.stat(uri);
            if (!this.current(generation)) return;
            if (stat.size > MAX_AUTO_PREVIEW_BYTES) throw new PreviewTooLargeError();
          }
          document = await vscode.workspace.openTextDocument(uri);
          if (document.getText().length > MAX_AUTO_PREVIEW_BYTES) throw new PreviewTooLargeError();
        }
        if (!this.current(generation)) return;
        const selection = document && location && !diff?.metadataOnly ? this.matchRange(document, location) : undefined;
        const before = new Set(this.tabs());
        const hadBackground = this.hasBackgroundPreview();
        try {
          if (diff) await this.openDiff(diff, this.column, true, true);
          else {
            if (!document) throw new Error('Could not load the preview document.');
            const editor = await vscode.window.showTextDocument(document, {
              viewColumn: this.column, preserveFocus: true, preview: true, ...(selection ? { selection } : {})
            });
            if (location && this.current(generation)) this.highlight(editor, location);
          }
          await this.waitForTabs(() => this.tabs().some(tab => this.isPreviewTab(tab, id, diff)),
            'Could not confirm the temporary preview tab.');
        } finally {
          for (const tab of this.tabs()) if (!before.has(tab) && this.isPreviewTab(tab, id, diff))
            this.ownedTabs.set(tab, tab.isPreview);
          if (hadBackground && !this.hasBackgroundPreview()) this.replacedBackgroundPreview = true;
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

  async accept(uri: vscode.Uri, beside: boolean, location?: MatchLocation, diff?: DiffTarget): Promise<void> {
    this.suspend();
    this.mode = 'accepting';
    try {
      await this.enqueue(async () => {
        if (this.mode !== 'accepting') throw new vscode.CancellationError();
        const document = location && !diff?.metadataOnly ? await vscode.workspace.openTextDocument(uri) : undefined;
        const selection = document && location ? this.matchRange(document, location) : undefined;
        if (beside) {
          await this.cleanup();
          await this.restoreBackgroundPreview();
          await this.restore(false);
        }
        if (this.mode !== 'accepting') throw new vscode.CancellationError();
        const open = async (): Promise<void> => {
          const viewColumn = beside ? vscode.ViewColumn.Beside : this.column;
          if (diff) {
            await this.openDiff(diff, viewColumn, false, false);
          } else await vscode.window.showTextDocument(uri, {
            viewColumn, preserveFocus: false, preview: false, ...(selection ? { selection } : {})
          });
        };
        await open();
        await this.cleanup(beside || diff ? undefined : uri.toString(), beside ? undefined : diff);
        if (!beside && await this.restoreBackgroundPreview() && this.mode === 'accepting')
          await open();
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

  private diffUris(diff: DiffTarget): { original: vscode.Uri; modified: vscode.Uri } {
    const empty = vscode.Uri.parse('telescope-picker-empty:/empty');
    return {
      original: diff.emptyLeft ? empty : vscode.Uri.parse(diff.left),
      modified: diff.emptyRight ? empty : vscode.Uri.parse(diff.right)
    };
  }

  private isPreviewTab(tab: vscode.Tab, id: string, diff?: DiffTarget): boolean {
    if (!diff) return this.isTextTab(tab, id);
    const uris = this.diffUris(diff);
    return tab.input instanceof vscode.TabInputTextDiff
      && tab.input.original.toString() === uris.original.toString()
      && tab.input.modified.toString() === uris.modified.toString();
  }

  private async openDiff(diff: DiffTarget, viewColumn: vscode.ViewColumn, preserveFocus: boolean, preview: boolean): Promise<void> {
    const uris = this.diffUris(diff);
    await vscode.commands.executeCommand('vscode.diff', uris.original, uris.modified, diff.title, {
      viewColumn, preserveFocus, preview,
      selection: new vscode.Range(diff.modifiedLine, 0, diff.modifiedLine, 0)
    });
    if (!preview) await this.waitForTabs(() => vscode.window.tabGroups.all.some(group =>
      (viewColumn === vscode.ViewColumn.Beside || group.viewColumn === viewColumn)
      && group.tabs.some(tab => this.isPreviewTab(tab, '', diff) && !tab.isPreview)), 'Could not confirm the opened diff tab.');
  }

  private async cleanup(keepId?: string, keepDiff?: DiffTarget): Promise<void> {
    const tabs = this.tabs().filter(tab => this.ownedTabs.has(tab) && !tab.isDirty
      && !(this.ownedTabs.get(tab) && !tab.isPreview)
      && !(keepId && this.isTextTab(tab, keepId))
      && !(keepDiff && this.isPreviewTab(tab, '', keepDiff)));
    if (tabs.length && !await vscode.window.tabGroups.close(tabs, true))
      throw new Error('Could not close temporary picker preview tabs.');
    if (tabs.length) await this.waitForTabs(() => !this.tabs().some(tab => tabs.includes(tab)),
      'Temporary preview tabs did not close.');
    for (const tab of tabs) this.ownedTabs.delete(tab);
  }

  private async restoreBackgroundPreview(): Promise<boolean> {
    const uri = this.backgroundPreview;
    const diff = this.backgroundDiff;
    if ((!uri && !diff) || !this.replacedBackgroundPreview || this.hasBackgroundPreview()) return false;
    if (diff) await vscode.commands.executeCommand('vscode.diff', diff.original, diff.modified, diff.title,
      { viewColumn: this.column, preserveFocus: true, preview: true });
    else if (uri) await vscode.window.showTextDocument(uri, { viewColumn: this.column, preserveFocus: true, preview: true });
    await this.waitForTabs(() => this.hasBackgroundPreview(), 'Could not restore the previous background preview tab.');
    this.replacedBackgroundPreview = false;
    return true;
  }

  private hasBackgroundPreview(): boolean {
    return this.tabs().some(tab => this.backgroundPreview && this.isTextTab(tab, this.backgroundPreview.toString())
      || this.backgroundDiff && tab.input instanceof vscode.TabInputTextDiff
        && tab.input.original.toString() === this.backgroundDiff.original.toString()
        && tab.input.modified.toString() === this.backgroundDiff.modified.toString());
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
    if (this.originalDiff) {
      await vscode.commands.executeCommand('vscode.diff', this.originalDiff.original, this.originalDiff.modified,
        this.originalDiff.title, { viewColumn: this.column, preserveFocus, preview: this.originalWasPreview });
      const editor = vscode.window.visibleTextEditors.find(editor =>
        editor.viewColumn === this.column && editor.document.uri.toString() === this.original?.document.uri.toString());
      if (editor) this.restoreSelections(editor);
      return;
    }
    if (this.original) {
      const document = this.original.document;
      const editor = await vscode.window.showTextDocument(document.uri, {
        viewColumn: this.column, preserveFocus, preview: this.originalWasPreview
      });
      this.restoreSelections(editor);
    } else if (!preserveFocus) {
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    }
  }

  private restoreSelections(editor: vscode.TextEditor): void {
    editor.selections = [...this.selections];
    if (this.visibleRange) {
      const center = Math.floor((this.visibleRange.start.line + this.visibleRange.end.line) / 2);
      editor.revealRange(new vscode.Range(center, 0, center, 0), vscode.TextEditorRevealType.InCenter);
    }
  }
}
