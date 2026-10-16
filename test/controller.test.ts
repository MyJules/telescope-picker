import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import { commands, createDocument, fileCreated, MockQuickPick, resetEditors, window, workspace, Uri } from './vscode';

class State implements vscode.Memento {
  readonly saved: unknown[] = [];
  keys(): readonly string[] { return []; }
  get<T>(_key: string): T | undefined;
  get<T>(_key: string, defaultValue: T): T;
  get<T>(_key: string, defaultValue?: T): T | undefined { return defaultValue; }
  async update(_key: string, value: unknown): Promise<void> { this.saved.push(value); }
}
let controller: PickerController;
let picker: MockQuickPick;
let state: State;
let original: vscode.TextEditor;
const log = vi.fn();
const waitResults = async (): Promise<void> => {
  await vi.waitFor(() => expect(picker.items[0]?.id).toBe('file:///workspace/src/main.cpp'));
};

beforeEach(async () => {
  resetEditors();
  workspace.workspaceFolders = [{ uri: Uri.parse('file:///workspace'), name: 'workspace', index: 0 }];
  workspace.findFiles.mockResolvedValue([
    Uri.parse('file:///workspace/src/main.cpp'), Uri.parse('file:///workspace/src/other.cpp')
  ]);
  workspace.fs.stat.mockResolvedValue({ size: 20 });
  const document = createDocument(vscode.Uri.parse('file:///workspace/original.ts'), true);
  workspace.textDocuments.push(document);
  original = await window.showTextDocument(document, { viewColumn: 1, preview: false });
  window.showTextDocument.mockClear();
  state = new State();
  controller = new PickerController({ workspaceState: state }, { appendLine: log });
  await controller.show();
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
});
afterEach(() => controller.dispose());

it('uses a native popup without creating or focusing a preview panel', async () => {
  await controller.show();
  expect(window.createQuickPick).toHaveBeenCalledTimes(1);
  expect(window.createWebviewPanel).not.toHaveBeenCalled();
  expect(commands.executeCommand.mock.calls.some(call => call[0].includes('preview'))).toBe(false);
  expect(picker.ignoreFocusOut).toBe(true);
});
it('previews in the original editor while preserving popup focus', async () => {
  await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledWith(
    expect.objectContaining({ uri: expect.anything() }), { viewColumn: 1, preserveFocus: true, preview: true }));
  expect(window.activeTextEditor?.document.uri.toString()).toBe('file:///workspace/src/main.cpp');
});
it('restores the original document and saves resume state on Escape', async () => {
  picker.hide();
  await vi.waitFor(() => expect(window.activeTextEditor?.document).toBe(original.document));
  expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'telescopePicker.active', false);
  expect(state.saved).toEqual([{ query: '', selectedId: 'file:///workspace/src/main.cpp' }]);
  expect(original.document.isDirty).toBe(true);
});
it('accepts beside and restores the original file on the left', async () => {
  await controller.openBeside();
  expect(window.showTextDocument).toHaveBeenLastCalledWith(
    expect.objectContaining({ toString: expect.any(Function) }), { viewColumn: -2, preserveFocus: false, preview: false });
  expect(window.tabGroups.all[0]?.activeTab?.document).toBe(original.document);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
});
it('supports ordinary acceptance and the per-item split button', async () => {
  const item = picker.items[1];
  if (!item) throw new Error('Expected second file');
  picker.split(item);
  await vi.waitFor(() => expect(picker.dispose).toHaveBeenCalled());
  expect(window.activeTextEditor?.document.uri.toString()).toBe(item.id);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
});
it('only opens items from the current result set', async () => {
  picker.activeItems = [{ label: 'private', id: 'file:///private/secret' }];
  await controller.openBeside();
  expect(window.showTextDocument).not.toHaveBeenCalled();
});
it('drops stale query results and preserves newer input during invalidation', async () => {
  picker.value = 'obsolete';
  picker.value = 'main';
  await waitResults();
  expect(picker.items).toHaveLength(1);
  fileCreated.fire();
  await waitResults();
  expect(picker.value).toBe('main');
});
it('resumes the last query and selection before a preview has loaded', async () => {
  picker.value = 'other';
  await vi.waitFor(() => expect(picker.items[0]?.id).toBe('file:///workspace/src/other.cpp'));
  picker.hide();
  await controller.show(true);
  picker = window.createQuickPick.mock.results.at(-1)?.value ?? new MockQuickPick();
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/other.cpp');
  expect(picker.value).toBe('other');
});
it('supports Vim-style navigation', () => {
  controller.navigate(1);
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/other.cpp');
  controller.navigate(-1);
  expect(picker.activeItems[0]?.id).toBe('file:///workspace/src/main.cpp');
});
it('surfaces discovery and opening failures without losing the popup', async () => {
  workspace.findFiles.mockRejectedValueOnce(new Error('Discovery unavailable'));
  fileCreated.fire();
  await vi.waitFor(() => expect(picker.items[0]?.label).toContain('Discovery unavailable'));
  picker.value = 'main';
  await waitResults();
  window.showTextDocument.mockRejectedValueOnce(new Error('File deleted'));
  picker.accept();
  await vi.waitFor(() => expect(picker.title).toContain('File deleted'));
  expect(picker.enabled).toBe(true);
});
