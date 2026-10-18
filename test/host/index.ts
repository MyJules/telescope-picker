import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { FileProvider } from '../../src/files';
import { EditorPreview } from '../../src/editorPreview';
import { FileRanking } from '../../src/fileRanking';
import { GitChangesProvider, type GitAPI } from '../../src/gitChanges';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  const configuration = vscode.workspace.getConfiguration('workbench');
  const previous = configuration.get<string | null>('iconTheme');
  try {
    await configuration.update('iconTheme', process.env.TELESCOPE_TEST_ICON_THEME ?? 'picker-test-icons', vscode.ConfigurationTarget.Global);
    const extension = vscode.extensions.getExtension('jules.jules-telescope-picker');
    assert.ok(extension);
    await extension.activate();
    const ranking = new FileRanking(join(extension.extensionPath, 'dist', 'fileRankingWorker.js'));
    try {
      const files = Array.from({ length: 100_000 }, (_, index) => ({
        id: `file:///ranking/file-${index}.ts`, path: `file-${index}.ts`, name: `file-${index}.ts`, root: 'ranking'
      }));
      assert.equal((await ranking.rank(files, '')).items.length, 100_000, 'Packaged worker returns every indexed file');
      assert.equal((await ranking.rank(files, 'file-99999')).items[0]?.id, 'file:///ranking/file-99999.ts',
        'Packaged worker reuses its index for warm queries');
    } finally { ranking.dispose(); }
    const ordered = await vscode.workspace.openTextDocument({
      content: 'export function lineOrderNeedle() {}\n// gap\nlineOrderNeedle\nconst lineOrderNeedle = 1;',
      language: 'typescript'
    });
    await vscode.window.showTextDocument(ordered, { preview: false });
    await vscode.commands.executeCommand('telescopePicker.searchCurrentFile', 'lineOrderNeedle');
    await until(() => vscode.window.activeTextEditor?.document === ordered
      && vscode.window.activeTextEditor.selection.start.line === 0, 'Current-file earliest line is selected first');
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await until(() => vscode.window.activeTextEditor?.document === ordered
      && vscode.window.activeTextEditor.selection.start.line === 2, 'Native Down follows source order instead of exact-label ranking');
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await until(() => vscode.window.activeTextEditor?.document === ordered
      && vscode.window.activeTextEditor.selection.start.line === 3, 'Native Down reaches the next source line');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await until(() => vscode.window.activeTextEditor?.document === ordered
      && vscode.window.activeTextEditor.selection.start.line === 0, 'Current-file cancellation restores initial selection');
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    const orderRoot = vscode.workspace.workspaceFolders?.[0];
    assert.ok(orderRoot);
    const orderPath = join(orderRoot.uri.fsPath, 'single-file-order.ts');
    try {
      await writeFile(orderPath, 'export function workspaceLineOrderNeedle() {}\n// gap\nworkspaceLineOrderNeedle\nconst workspaceLineOrderNeedle = 1;\n');
      await vscode.commands.executeCommand('telescopePicker.searchContents', 'workspaceLineOrderNeedle');
      await until(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/single-file-order.ts') === true
        && vscode.window.activeTextEditor.selection.start.line === 0, 'Single-file workspace contents preview the earliest line');
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await until(() => vscode.window.activeTextEditor?.selection.start.line === 2,
        'Native Down in single-file workspace results follows source order');
      await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await until(() => vscode.window.activeTextEditor?.selection.start.line === 3,
        'Single-file workspace results reach the next source line');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.commands.executeCommand('telescopePicker.files');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await rm(orderPath);
    }
    await checkPicker();
    await checkGitDiffs();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('telescopePicker.configureShortcuts'), 'Shortcut configuration command is registered');
    await vscode.commands.executeCommand('telescopePicker.configureShortcuts');
  } finally {
    await configuration.update('iconTheme', previous, vscode.ConfigurationTarget.Global);
  }
}

async function checkGitDiffs(): Promise<void> {
  type Repository = GitAPI['repositories'][number] & { status(): Promise<void> };
  type API = GitAPI & { openRepository(root: vscode.Uri): Promise<Repository | null> };
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): API }>('vscode.git');
  assert.ok(extension, 'Built-in Git extension is available');
  const api = (await extension.activate()).getAPI(1);
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'Git fixture requires a workspace folder');
  const directory = await mkdtemp(join(folder.uri.fsPath, 'telescope-git-host-'));
  const git = (...args: string[]): void => {
    execFileSync(api.git.path, args, { cwd: directory, stdio: 'pipe' });
  };
  const provider = new GitChangesProvider();
  try {
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Picker Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'core.autocrlf', 'false');
    const context = Array.from({ length: 12 }, (_, line) => `// unchanged ${line}`).join('\n');
    await writeFile(join(directory, 'changed.ts'), `const gitRemovedNeedle = 1;\n${context}\nconst gitRemovedTail = 7;\n`);
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await writeFile(join(directory, 'changed.ts'), `const gitStagedNeedle = 2;\n${context}\nconst gitRemovedTail = 7;\n`);
    git('add', '.');
    await writeFile(join(directory, 'changed.ts'), `const gitWorkingNeedle = 3;\n${context}\nconst gitWorkingTail = 8;\n`);
    await writeFile(join(directory, 'untracked.ts'), 'const gitUntrackedNeedle = 4;\n');
    const repository = await api.openRepository(vscode.Uri.file(directory));
    assert.ok(repository, 'Git API opens the isolated fixture repository');
    await repository.status();
    for (const needle of ['gitRemovedNeedle', 'gitWorkingNeedle', 'gitUntrackedNeedle']) {
      let found = 0;
      await provider.search(needle, update => { if (update.complete) found = update.total; });
      assert.equal(found, 1, `Public Git API search finds ${needle}`);
    }
    let allHunks = 0;
    await provider.search('', update => { if (update.complete) allHunks = update.total; });
    assert.equal(allHunks, 4, 'An empty query lists all staged, unstaged and untracked hunks immediately');
    await vscode.commands.executeCommand('telescopePicker.searchGitDiffs');
    await until(() => vscode.window.visibleTextEditors.some(editor =>
      editor.document.uri.scheme === 'git' && editor.document.getText().includes('gitRemovedNeedle')),
    'Opening the Git browser immediately previews the first native diff');
    assert.ok(vscode.window.tabGroups.all.some(group => group.activeTab?.isPreview
      && group.activeTab.input instanceof vscode.TabInputTextDiff), 'Native diff appears before pressing Enter');
    assert.equal(await vscode.commands.executeCommand('telescopePicker.next'), true);
    await until(() => vscode.window.tabGroups.all.some(group => group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.input.modified.scheme === 'file'), 'Navigating previews the next hunk as a native diff');
    const workingDiff = vscode.window.tabGroups.all.find(group =>
      group.activeTab?.input instanceof vscode.TabInputTextDiff && group.activeTab.input.modified.scheme === 'file')?.activeTab;
    assert.equal(await vscode.commands.executeCommand('telescopePicker.next'), true);
    await until(() => vscode.window.visibleTextEditors.some(editor => editor.document.uri.scheme === 'file'
      && editor.document.uri.path.endsWith('/changed.ts') && editor.selection.start.line === 13),
    'The next hunk jumps to its exact line in the existing native diff');
    assert.ok(vscode.window.tabGroups.all.some(group => group.activeTab === workingDiff),
      'Hunks in the same file reuse the same native diff tab');
    assert.equal(await vscode.commands.executeCommand('telescopePicker.previous'), true);
    assert.equal(await vscode.commands.executeCommand('telescopePicker.previous'), true);
    await until(() => vscode.window.tabGroups.all.some(group => group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.input.modified.scheme === 'git'), 'Navigating back previews the staged hunk');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => vscode.window.tabGroups.all.some(group =>
      group.activeTab?.input instanceof vscode.TabInputTextDiff && !group.activeTab.isPreview), 'Enter pins the native diff editor');
    const diff = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => tab.input instanceof vscode.TabInputTextDiff && tab.label.includes('Staged'));
    assert.ok(diff?.input instanceof vscode.TabInputTextDiff, 'Staged diff uses the native tab type');
    assert.equal(diff.input.original.scheme, 'git');
    assert.equal(diff.input.modified.scheme, 'git', 'Staged diff compares HEAD to index, not working tree');
    const historicalUri = diff.input.original.toString();
    await vscode.commands.executeCommand('telescopePicker.searchGitDiffs', 'gitUntrackedNeedle');
    assert.ok(vscode.window.tabGroups.all.every(group => group.tabs.every(tab =>
      !(tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === historicalUri))),
    'Accepting a native diff closes its temporary historical text preview');
    const samePath = (path: string): boolean => process.platform === 'win32'
      ? path.toLowerCase() === join(directory, 'untracked.ts').toLowerCase()
      : path === join(directory, 'untracked.ts');
    await until(() => vscode.window.visibleTextEditors.some(editor =>
      editor.document.uri.scheme === 'file' && samePath(editor.document.uri.fsPath)), 'Untracked line preview');
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await until(() => vscode.window.tabGroups.all.some(group => group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.label.includes('Staged')), 'Cancelling Git search restores the original native diff tab');
    await vscode.commands.executeCommand('telescopePicker.searchGitDiffs', 'gitUntrackedNeedle');
    await until(() => vscode.window.visibleTextEditors.some(editor =>
      editor.document.uri.scheme === 'file' && samePath(editor.document.uri.fsPath)), 'Untracked preview after diff restoration');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => vscode.window.tabGroups.all.some(group =>
      group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.input.original.scheme === 'telescope-picker-empty'), 'Untracked diff uses an empty original side');
    git('add', '.');
    git('commit', '-qm', 'saved fixture');
    git('checkout', '-qb', 'other');
    await writeFile(join(directory, 'changed.ts'), 'const theirsConflictNeedle = 5;\n');
    git('commit', '-qam', 'theirs');
    git('checkout', '-q', 'main');
    await writeFile(join(directory, 'changed.ts'), 'const oursConflictNeedle = 6;\n');
    git('commit', '-qam', 'ours');
    assert.throws(() => git('merge', 'other'), 'Fixture creates a real merge conflict');
    await repository.status();
    await vscode.commands.executeCommand('telescopePicker.searchGitDiffs', 'gitWorkingNeedle');
    await until(() => vscode.window.tabGroups.all.some(group =>
      group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.input.original.query.includes(':1')), 'Conflicts preview the native merge-base diff');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(() => vscode.window.tabGroups.all.some(group =>
      group.activeTab?.input instanceof vscode.TabInputTextDiff
      && group.activeTab.input.original.query.includes(':1')), 'Conflict result opens a native merge-base diff');
    console.log('Git checks passed: public Git API, staged/unstaged/untracked/conflict text, historical previews, diff restoration, native diff editors.');
  } finally {
    provider.dispose();
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(directory, { recursive: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function checkPicker(): Promise<void> {
  const extension = vscode.extensions.getExtension('jules.jules-telescope-picker');
  assert.ok(extension, 'Development extension is registered');
  await extension.activate();
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
      await vscode.workspace.getConfiguration('workbench').update('iconTheme', 'vs-seti', vscode.ConfigurationTarget.Global);
      assert.equal(editorAt(vscode.ViewColumn.One)?.document.uri.toString(), second.id,
        'Switching from image to font icons preserves the preview');
      assert.equal(await vscode.commands.executeCommand('telescopePicker.previous'), true);
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === first.id,
        'Navigation still works after an active icon-theme change');
      await vscode.workspace.getConfiguration('workbench').update('iconTheme',
        process.env.TELESCOPE_TEST_ICON_THEME ?? 'picker-test-icons', vscode.ConfigurationTarget.Global);
      assert.equal(await vscode.commands.executeCommand('telescopePicker.next'), true);
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === second.id,
        'Navigation still works after restoring the image icon theme');
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
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.viewColumn === vscode.ViewColumn.One,
      'Original editor is active before current-file search captures its target');
      await vscode.commands.executeCommand('telescopePicker.searchCurrentFile', 'UNSAVED preview fixture 137');
      await until(() => editorAt(vscode.ViewColumn.One)?.document === document
        && editorAt(vscode.ViewColumn.One)?.selection.start.line === 137,
      'Current-file mode searches live unsaved contents and previews the exact matching line');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.selections.every((selection, i) => selection.isEqual(selections[i]!)),
      'Current-file cancel restores original selections');
      await vscode.commands.executeCommand('telescopePicker.resume');
      await until(() => editorAt(vscode.ViewColumn.One)?.document === document
        && editorAt(vscode.ViewColumn.One)?.selection.start.line === 137,
      'Resume restores current-file mode and its target document');
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await until(() => vscode.window.activeTextEditor?.document === document
        && vscode.window.activeTextEditor.selections.every((selection, i) => selection.isEqual(selections[i]!)),
      'Current-file resume cancellation restores original selections');
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

      const filters = vscode.workspace.getConfiguration('telescopePicker');
      const originalInclude = filters.get<string[]>('include');
      const originalExclude = filters.get<string[]>('exclude');
      try {
        await filters.update('include', ['z-content.ts'], vscode.ConfigurationTarget.Global);
        await filters.update('exclude', [], vscode.ConfigurationTarget.Global);
        const filteredFiles = await provider.getFiles();
        assert.deepEqual(filteredFiles.files.map(file => file.path), ['z-content.ts'],
          'Persistent include filters apply to real filename discovery');
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
        await vscode.commands.executeCommand('telescopePicker.searchContents', 'const');
        await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === diskContent.id,
          'Persistent include filters apply to content search and skip dirty files outside the included folder');
        await filters.update('include', ['sample.ts'], vscode.ConfigurationTarget.Global);
        await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() !== diskContent.id,
          'Changing persistent filters refreshes an open content picker');
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await filters.update('exclude', ['sample.ts'], vscode.ConfigurationTarget.Global);
        assert.equal((await provider.getFiles()).files.length, 0, 'Exclude filters win over include filters');
      } finally {
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await filters.update('include', originalInclude, vscode.ConfigurationTarget.Global);
        await filters.update('exclude', originalExclude, vscode.ConfigurationTarget.Global);
      }

      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preview: false });
      await vscode.commands.executeCommand('telescopePicker.searchContents', 'nativeOrderNeedle');
      const nativeFirst = indexed.files.find(file => file.path === 'zz-native-a.ts');
      assert.ok(nativeFirst);
      await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === nativeFirst.id,
        'Content preview follows stable file labels rather than ranking changing code excerpts');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === nativeFirst.id
        && activeTab(vscode.ViewColumn.One)?.isPreview === false,
      'Enter opens the same native-ranked first result that was previewed');

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
        && vscode.window.activeTextEditor.selections.length === selections.length
        && vscode.window.activeTextEditor.selections.every((selection, i) => selection.isEqual(selections[i]!)),
      'Cancel after grouped resume restores the original editor');

      const cleanOriginal = await vscode.window.showTextDocument(vscode.Uri.joinPath(firstRoot.uri, 'hidden.ignored'), {
        viewColumn: vscode.ViewColumn.One, preview: true
      });
      const cleanOriginalUri = cleanOriginal.document.uri.toString();
      await until(() => vscode.window.activeTextEditor?.document.uri.toString() === cleanOriginalUri
        && activeTab(vscode.ViewColumn.One)?.isPreview === true, 'Original unpinned preview is active before opening picker');
      const previewErrors: unknown[] = [];
      const cleanPreview = new EditorPreview(cleanOriginal, vscode.ViewColumn.One, reason => previewErrors.push(reason));
      try {
        cleanPreview.select(first.id);
        await until(() => editorAt(vscode.ViewColumn.One)?.document.uri.toString() === first.id,
          'Clean original preview is replaced during navigation');
        await cleanPreview.finish(true);
        await until(() => vscode.window.activeTextEditor?.document.uri.toString() === cleanOriginalUri
          && activeTab(vscode.ViewColumn.One)?.isPreview === true, 'Cancel restores an original unpinned preview');
        assert.deepEqual(previewErrors, []);
      } finally { await cleanPreview.finish(true); }
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One });
      const restore = new vscode.WorkspaceEdit();
      restore.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), originalText);
      assert.ok(await vscode.workspace.applyEdit(restore));
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    console.log('Extension-host checks passed: native file-resource icons and active image/font theme switching, native popup, multi-root/exclusions, current-editor preview, dirty contents, cancel/selection/scroll restoration, background/unpinned preview restoration, temporary-tab cleanup, resume, Enter pinning, split, query-specific text search, dirty-text matching, exact-line acceptance, grouped-result navigation/resume.');
  } finally { provider.dispose(); }
}
