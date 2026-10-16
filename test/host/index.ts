import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FileProvider } from '../../src/files';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

function editorAt(column: vscode.ViewColumn): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(editor => editor.viewColumn === column);
}

function activeTab(column: vscode.ViewColumn): vscode.Tab | undefined {
  return vscode.window.tabGroups.all.find(group => group.viewColumn === column)?.activeTab;
}

function assertNoPickerTabs(): void {
  assert.ok(vscode.window.tabGroups.all.every(group => group.tabs.every(tab =>
    !(tab.input instanceof vscode.TabInputWebview))), 'No picker webview tabs are created');
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.telescope-picker');
  assert.ok(extension, 'Development extension is registered');
  await extension.activate();
  const iconFont = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extension.extensionUri, 'resources', 'seti.woff'));
  assert.equal(Buffer.from(iconFont.subarray(0, 4)).toString(), 'wOFF', 'Bundled file-icon font is available');
  const provider = new FileProvider();
  try {
    const indexed = await provider.getFiles();
    assert.equal(indexed.files.filter(file => file.path === 'sample.ts').length, 2, 'Both roots are indexed');
    assert.ok(indexed.files.every(file => !file.path.endsWith('.ignored')), 'files.exclude is respected');
    const first = indexed.files.find(file => file.root === 'First' && file.path === 'sample.ts');
    const second = indexed.files.find(file => file.root === 'Second' && file.path === 'sample.ts');
    const diskContent = indexed.files.find(file => file.root === 'Second' && file.path === 'z-content.ts');
    assert.ok(first);
    assert.ok(second);
    assert.ok(diskContent);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(first.id));
    const originalText = document.getText();
    let editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0),
      Array.from({ length: 200 }, (_, i) => `// unsaved preview fixture ${i}`).join('\n') + '\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const unsavedText = document.getText();
    const firstRoot = vscode.workspace.workspaceFolders?.find(folder => folder.name === 'First');
    assert.ok(firstRoot);
    await vscode.window.showTextDocument(vscode.Uri.joinPath(firstRoot.uri, 'hidden.ignored'), {
      viewColumn: vscode.ViewColumn.One, preview: true
    });
    editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
    const selections = [new vscode.Selection(100, 2, 100, 5), new vscode.Selection(101, 0, 101, 4)];
    editor.selections = selections;
    editor.revealRange(new vscode.Range(80, 0, 90, 0), vscode.TextEditorRevealType.AtTop);
    await new Promise(resolve => setTimeout(resolve, 60));
    const topLine = editor.visibleRanges[0]?.start.line;
    const bottomLine = editor.visibleRanges[0]?.end.line;
    const sourceGroup = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One);
    const baselineTabs = sourceGroup?.tabs.map(tab => ({
      uri: tab.input instanceof vscode.TabInputText ? tab.input.uri.toString() : tab.label, preview: tab.isPreview
    })) ?? [];
    try {
      await vscode.commands.executeCommand('telescopePicker.files');
      await vscode.commands.executeCommand('telescopePicker.next');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === second.id, 'Selection previews in the original editor group');
      assert.equal(document.getText(), unsavedText, 'Preview does not alter unsaved contents');
      assert.ok(document.isDirty);
      assertNoPickerTabs();
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => {
        const tabs = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One)?.tabs ?? [];
        const current = vscode.window.activeTextEditor;
        return current?.document === document && current.selections.length === selections.length
          && current.selections.every((selection, i) => selection.isEqual(selections[i]!))
          && baselineTabs.every(before => tabs.some(tab =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === before.uri));
      }, 'Cancel restores the original editor, selections and pre-existing background preview');
      const restored = vscode.window.activeTextEditor;
      assert.ok(restored);
      assert.equal(restored.selections.length, selections.length);
      assert.ok(restored.selections.every((selection, i) => selection.isEqual(selections[i]!)));
      if (topLine !== undefined) await until(() => {
        const actual = editorAt(vscode.ViewColumn.One)?.visibleRanges[0]?.start.line;
        return actual !== undefined && Math.abs(actual - topLine) <= 1;
      }, 'Original scroll position restored within one line').catch(reason => {
          throw new Error(`Scroll restoration expected ${topLine}-${bottomLine}, actual ${editorAt(vscode.ViewColumn.One)?.visibleRanges[0]?.start.line}-${editorAt(vscode.ViewColumn.One)?.visibleRanges[0]?.end.line}`,
            { cause: reason });
        });
      const remaining = vscode.window.tabGroups.all.find(group => group.viewColumn === vscode.ViewColumn.One)?.tabs ?? [];
      assert.equal(remaining.length, baselineTabs.length, JSON.stringify({
        message: 'Cancel leaves no temporary preview tabs', before: baselineTabs,
        after: remaining.map(tab => ({
          uri: tab.input instanceof vscode.TabInputText ? tab.input.uri.toString() : tab.label, preview: tab.isPreview, dirty: tab.isDirty
        }))
      }));
      assert.ok(baselineTabs.every(before => remaining.some(tab =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === before.uri)),
      'Pre-existing background preview tabs are restored');

      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === second.id, 'Resume restores the previous selection');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => activeTab(vscode.ViewColumn.One)?.isPreview === false
        && vscode.window.activeTextEditor?.document.uri.toString() === second.id, 'Enter pins the accepted preview');

      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === second.id, 'Preview before split');
      await vscode.commands.executeCommand('telescopePicker.openBeside');
      await until(() => vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.Two, 'Accept beside');
      assert.equal(editorAt(vscode.ViewColumn.One)?.document, document, 'Split restores the original file on the left');
      assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), second.id);
      assert.equal(document.getText(), unsavedText);
      assertNoPickerTabs();

      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      await vscode.commands.executeCommand('telescopePicker.searchContents', 'UNSAVED preview fixture 137');
      await until(() => editorAt(vscode.ViewColumn.One)?.document === document
        && editorAt(vscode.ViewColumn.One)?.selection.start.line === 137,
      'Text search previews a case-insensitive literal match in unsaved text at the matching line');
      assert.equal(document.getText(), unsavedText, 'Content previews do not alter dirty contents');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.selections.length === selections.length
        && vscode.window.activeTextEditor.selections.every((selection, i) => selection.isEqual(selections[i]!)),
      'Cancelling a content search restores the original selections');
      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(() => editorAt(vscode.ViewColumn.One)?.selection.start.line === 137,
        'Resume restores content mode and query');
      await vscode.commands.executeCommand('telescopePicker.openBeside');
      await until(() => vscode.window.activeTextEditor?.viewColumn === vscode.ViewColumn.Two
        && vscode.window.activeTextEditor.document === document
        && vscode.window.activeTextEditor.selection.start.line === 137,
      'Content acceptance opens the exact matching line beside');
      assert.ok(editorAt(vscode.ViewColumn.One)?.selections.every((selection, i) => selection.isEqual(selections[i]!)));

      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      await vscode.commands.executeCommand('telescopePicker.searchContents', 'diskContentNeedle');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === diskContent.id
        && editorAt(vscode.ViewColumn.One)?.selection.start.line === 0,
      'Packaged backend finds an exact text match in on-disk workspace contents');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === diskContent.id
        && activeTab(vscode.ViewColumn.One)?.isPreview === false
        && vscode.window.activeTextEditor.selection.start.line === 0,
      'Content acceptance pins the selected file at the matching line');

      const groupOriginal = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      groupOriginal.selections = selections;
      await vscode.commands.executeCommand('telescopePicker.searchContents', 'const');
      await until(() => editorAt(vscode.ViewColumn.One)?.document === document
        && editorAt(vscode.ViewColumn.One)?.selection.start.line === 200,
      'Grouped search selects a matching line, not the first file heading');
      await until(async () => Boolean(await vscode.commands.executeCommand('telescopePicker.next')),
        'Next match becomes available in streamed groups');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === second.id,
        'Navigation skips the next file heading');
      await until(async () => Boolean(await vscode.commands.executeCommand('telescopePicker.next')),
        'Third file group becomes available');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === diskContent.id,
        'Navigation reaches the third file group');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.selections.length === selections.length
        && vscode.window.activeTextEditor.selections.every((selection, i) => selection.isEqual(selections[i]!)),
      'Cancelling grouped search restores the original selections');
      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === diskContent.id,
        'Resume restores a matching line in a later file group');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.selections.length === selections.length,
      'Cancel after grouped resume restores the original editor');

      const cleanOriginal = await vscode.window.showTextDocument(vscode.Uri.joinPath(firstRoot.uri, 'hidden.ignored'), {
        viewColumn: vscode.ViewColumn.One, preview: true
      });
      const cleanOriginalUri = cleanOriginal.document.uri.toString();
      await vscode.commands.executeCommand('telescopePicker.files');
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === first.id,
        'Clean original preview is replaced during navigation');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === cleanOriginalUri
        && activeTab(vscode.ViewColumn.One)?.isPreview === true, 'Cancel restores an original unpinned preview');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      const restore = new vscode.WorkspaceEdit();
      restore.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), originalText);
      assert.ok(await vscode.workspace.applyEdit(restore));
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    console.log('Extension-host checks passed: native popup, multi-root/exclusions, current-editor preview, dirty contents, cancel/selection/scroll restoration, background/unpinned preview restoration, temporary-tab cleanup, resume, Enter pinning, split, query-specific text search, dirty-text matching, exact-line acceptance, bundled icon font and grouped-result navigation/resume.');
  } finally { provider.dispose(); }
}
