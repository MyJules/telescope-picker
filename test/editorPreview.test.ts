import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { EditorPreview } from '../src/editorPreview';
import { createDocument, editorSettings, resetEditors, window, workspace } from './vscode';

let preview: EditorPreview;
let original: vscode.TextEditor;
const errors = vi.fn();
const target = 'file:///workspace/target.ts';

beforeEach(async () => {
  vi.useFakeTimers();
  resetEditors();
  workspace.fs.stat.mockResolvedValue({ size: 20 });
  original = await window.showTextDocument(createDocument(vscode.Uri.parse('file:///workspace/original.ts'), true), {
    viewColumn: 1, preview: false
  });
  original.selections = [new vscode.Selection(10, 2, 10, 5), new vscode.Selection(20, 0, 20, 1)];
  Object.assign(original, { visibleRanges: [new vscode.Range(8, 0, 40, 0)] });
  window.showTextDocument.mockClear();
  preview = new EditorPreview(original, vscode.ViewColumn.One, errors);
});
afterEach(async () => { await preview.finish(false); vi.useRealTimers(); });

it('debounces navigation and previews only the latest selection with focus preserved', async () => {
  preview.select('file:///workspace/old.ts');
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  expect(window.showTextDocument).toHaveBeenCalledTimes(1);
  expect(window.activeTextEditor?.document.uri.toString()).toBe(target);
  expect(window.showTextDocument.mock.calls[0]?.[1]).toEqual({ viewColumn: 1, preserveFocus: true, preview: true });
});
it('reveals content matches and removes theme-based highlights when the query changes', async () => {
  const document = createDocument(vscode.Uri.parse(target), true, '// heading\nconst fuzzyNeedle = 1;');
  workspace.textDocuments.push(document);
  const location = { line: 1, text: document.lineAt(1).text, matches: [6, 8, 11] };
  preview.select(target, location);
  await vi.advanceTimersByTimeAsync(40);
  const editor = window.activeTextEditor;
  expect(editor?.selection.start).toMatchObject({ line: 1, character: 6 });
  expect(editor?.setDecorations).toHaveBeenCalledWith(expect.anything(), [
    new vscode.Range(1, 6, 1, 7), new vscode.Range(1, 8, 1, 9), new vscode.Range(1, 11, 1, 12)
  ]);
  expect(editor?.revealRange).toHaveBeenCalledWith(
    new vscode.Range(1, 6, 1, 6), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  preview.suspend();
  expect(editor?.setDecorations).toHaveBeenLastCalledWith(expect.anything(), []);
  await preview.finish(true);
  const decoration = window.createTextEditorDecorationType.mock.results.at(-1)?.value;
  expect(decoration?.dispose).toHaveBeenCalled();
});
it.each([false, true])('opens the exact matched line, including beside=%s', async beside => {
  const document = createDocument(vscode.Uri.parse(target), true, '// heading\nconst fuzzyNeedle = 1;');
  workspace.textDocuments.push(document);
  const location = { line: 1, text: document.lineAt(1).text, matches: [6, 8, 11] };
  await preview.accept(document.uri, beside, location);
  expect(window.activeTextEditor?.selection.start).toMatchObject({ line: 1, character: 6 });
  expect(window.activeTextEditor?.viewColumn).toBe(beside ? 2 : 1);
  if (beside) expect(window.tabGroups.all[0]?.activeTab?.document).toBe(original.document);
});
it('rejects changed content locations instead of navigating to a stale line', async () => {
  const document = createDocument(vscode.Uri.parse(target), true, 'changed');
  workspace.textDocuments.push(document);
  const location = { line: 0, text: 'original', matches: [0] };
  preview.select(target, location);
  await vi.advanceTimersByTimeAsync(40);
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('contents changed') }));
  expect(window.showTextDocument).not.toHaveBeenCalled();
  await expect(preview.accept(document.uri, false, location)).rejects.toThrow('contents changed');
  expect(window.showTextDocument).not.toHaveBeenCalled();
});
it('restores document, dirty state, selections and visible range and closes temporary tabs', async () => {
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.finish(true);
  expect(window.activeTextEditor?.document).toBe(original.document);
  expect(window.activeTextEditor?.document.isDirty).toBe(true);
  expect(window.activeTextEditor?.selections).toEqual(original.selections);
  expect(window.activeTextEditor?.revealRange).toHaveBeenCalledWith(new vscode.Range(24, 0, 24, 0), vscode.TextEditorRevealType.InCenter);
  expect(window.tabGroups.all[0]?.tabs.map(tab => tab.document.uri.toString())).toEqual([original.document.uri.toString()]);
});
it('cannot reopen a stale selection after cancel during an uncancellable editor open', async () => {
  const show = window.showTextDocument.getMockImplementation();
  if (!show) throw new Error('Missing mock editor implementation');
  let complete: () => void = () => { throw new Error('No pending editor open'); };
  window.showTextDocument.mockImplementationOnce(async (document, options) => {
    await new Promise<void>(resolve => { complete = resolve; });
    return show(document, options);
  });
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  const finished = preview.finish(true);
  complete();
  await finished;
  expect(window.activeTextEditor?.document).toBe(original.document);
  expect(window.tabGroups.all[0]?.tabs).toHaveLength(1);
});
it('does not show an obsolete file when its document load completes late', async () => {
  let complete: (document: vscode.TextDocument) => void = () => { throw new Error('No pending document'); };
  workspace.openTextDocument.mockImplementationOnce(() => new Promise<vscode.TextDocument>(resolve => { complete = resolve; }));
  preview.select('file:///workspace/old.ts');
  await vi.advanceTimersByTimeAsync(40);
  preview.select(target);
  complete(createDocument(vscode.Uri.parse('file:///workspace/old.ts')));
  await vi.advanceTimersByTimeAsync(40);
  expect(window.showTextDocument).toHaveBeenCalledTimes(1);
  expect(window.activeTextEditor?.document.uri.toString()).toBe(target);
});
it('does not let an obsolete preview failure replace the current selection status', async () => {
  let fail: (reason: Error) => void = () => { throw new Error('No pending document load'); };
  workspace.openTextDocument.mockImplementationOnce(() => new Promise<vscode.TextDocument>((_resolve, reject) => { fail = reject; }));
  preview.select('file:///workspace/obsolete.ts');
  await vi.advanceTimersByTimeAsync(40);
  preview.select(target);
  fail(new Error('Obsolete read failed'));
  await vi.advanceTimersByTimeAsync(40);
  expect(errors).not.toHaveBeenCalled();
  expect(window.activeTextEditor?.document.uri.toString()).toBe(target);
});
it('leaves pre-existing tabs and user-pinned or dirty preview tabs alone', async () => {
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  const tab = window.tabGroups.all[0]?.tabs.find(candidate => candidate.document.uri.toString() === target);
  if (!tab) throw new Error('Expected preview tab');
  tab.isPreview = false;
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs).toContain(tab);
});
it('preserves dirty preview contents on cancel', async () => {
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  const tab = window.tabGroups.all[0]?.activeTab;
  if (!tab) throw new Error('Expected preview tab');
  Object.assign(tab.document, { isDirty: true });
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs).toContain(tab);
  expect(tab.document.getText()).toContain('unsaved');
});
it('preserves target tabs that were already open before previewing', async () => {
  const existing = await window.showTextDocument(createDocument(vscode.Uri.parse(target)), { viewColumn: 1, preview: false });
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs.some(tab => tab.document === existing.document)).toBe(true);
});
it('restores an unrelated background preview that native tab replacement displaced', async () => {
  const background = await window.showTextDocument(createDocument(vscode.Uri.parse('file:///workspace/background.ts')), { viewColumn: 1, preview: true });
  await window.showTextDocument(original.document, { viewColumn: 1, preview: false });
  preview = new EditorPreview(original, 1, errors);
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  expect(window.tabGroups.all[0]?.tabs.some(tab => tab.document === background.document)).toBe(false);
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs.some(tab => tab.document.uri.toString() === background.document.uri.toString())).toBe(true);
  expect(window.activeTextEditor?.document).toBe(original.document);
});
it('restores an original unpinned preview without pinning it', async () => {
  resetEditors();
  const editor = await window.showTextDocument(createDocument(vscode.Uri.parse('file:///workspace/initial.ts')), { viewColumn: 1, preview: true });
  preview = new EditorPreview(editor, 1, errors);
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.activeTab?.document).toBe(editor.document);
  expect(window.tabGroups.all[0]?.activeTab?.isPreview).toBe(true);
});
it('reopens an original preview document that VS Code closed when replacing its tab', async () => {
  resetEditors();
  const editor = await window.showTextDocument(createDocument(vscode.Uri.parse('file:///workspace/initial.ts')), { viewColumn: 1, preview: true });
  preview = new EditorPreview(editor, 1, errors);
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  Object.assign(editor.document, { isClosed: true });
  await preview.finish(true);
  expect(window.activeTextEditor?.document.uri.toString()).toBe(editor.document.uri.toString());
  expect(window.activeTextEditor?.document.isClosed).toBe(false);
  expect(window.tabGroups.all[0]?.activeTab?.isPreview).toBe(true);
});
it('cleans previews when no text editor was initially open', async () => {
  resetEditors();
  preview = new EditorPreview(undefined, 1, errors);
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs).toHaveLength(0);
});
it('cleans created tabs even when native preview mode is disabled', async () => {
  editorSettings.previewEnabled = false;
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.finish(true);
  expect(window.tabGroups.all[0]?.tabs).toHaveLength(1);
});
it('pins accepted files instead of restoring the original document', async () => {
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.accept(vscode.Uri.parse(target), false);
  expect(window.activeTextEditor?.document.uri.toString()).toBe(target);
  expect(window.tabGroups.all[0]?.activeTab?.isPreview).toBe(false);
});
it('restores the left editor before accepting beside', async () => {
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  await preview.accept(vscode.Uri.parse(target), true);
  expect(window.tabGroups.all[0]?.activeTab?.document).toBe(original.document);
  expect(window.tabGroups.all[0]?.tabs).toHaveLength(1);
  expect(window.activeTextEditor?.viewColumn).toBe(2);
});
it('uses unsaved open documents without reading from disk', async () => {
  const document = createDocument(vscode.Uri.parse(target), true);
  workspace.textDocuments.push(document);
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  expect(workspace.fs.stat).not.toHaveBeenCalled();
  expect(window.activeTextEditor?.document).toBe(document);
});
it('reports oversized and unavailable resources without replacing the editor', async () => {
  workspace.fs.stat.mockResolvedValueOnce({ size: 2 * 1024 * 1024 });
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('1 MiB') }));
  expect(window.showTextDocument).not.toHaveBeenCalled();
  workspace.fs.stat.mockRejectedValueOnce(new Error('File deleted'));
  preview.select(target);
  await vi.advanceTimersByTimeAsync(40);
  expect(errors).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'File deleted' }));
});
