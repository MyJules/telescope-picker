import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FileProvider } from '../../src/files';
import { PreviewService } from '../../src/preview';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

function pickerOpen(): boolean {
  return vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputWebview && tab.label === 'Find Files'));
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('local.telescope-picker');
  assert.ok(extension, 'Development extension is registered');
  await extension.activate();
  const provider = new FileProvider();
  try {
    const indexed = await provider.getFiles();
    assert.equal(indexed.files.filter(file => file.path === 'sample.ts').length, 2, 'Both roots are indexed');
    assert.ok(indexed.files.some(file => file.root === 'First'));
    assert.ok(indexed.files.some(file => file.root === 'Second'));
    assert.ok(indexed.files.every(file => !file.path.endsWith('.ignored')), 'files.exclude is respected');
    const first = indexed.files.find(file => file.root === 'First' && file.path === 'sample.ts');
    assert.ok(first);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(first.id));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const original = document.getText();
    const tabsBefore = vscode.window.tabGroups.all.flatMap(group => group.tabs).length;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), '// unsaved preview fixture\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const preview = await new PreviewService().load(document.uri, cancellation.token);
      assert.ok(preview.note.includes('Unsaved'));
      assert.ok(preview.html.includes('unsaved preview fixture'));
      assert.ok(document.isDirty);
      assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).length, tabsBefore, 'Preview creates no tabs');
      const selection = new vscode.Selection(0, 2, 0, 5);
      editor.selection = selection;
      await vscode.commands.executeCommand('telescopePicker.files');
      await until(pickerOpen, 'Picker tab opens');
      await vscode.commands.executeCommand('telescopePicker.files');
      assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
        tab.input instanceof vscode.TabInputWebview && tab.label === 'Find Files').length, 1, 'Panel is reused');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await until(() => !pickerOpen() && vscode.window.activeTextEditor?.document === document, 'Previous editor restored');
      assert.ok(vscode.window.activeTextEditor?.selection.isEqual(selection), 'Original selection is preserved');
      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(pickerOpen, 'Resume reopens the picker');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await until(() => !pickerOpen(), 'Picker closes');
      const restore = new vscode.WorkspaceEdit();
      restore.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), original);
      assert.ok(await vscode.workspace.applyEdit(restore));
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally { cancellation.dispose(); }
    console.log('Extension-host checks passed: multi-root, exclusions, dirty preview, no preview tabs, lifecycle, focus and resume.');
  } finally { provider.dispose(); }
}
