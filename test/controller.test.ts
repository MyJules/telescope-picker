import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { PickerController } from '../src/controller';
import type { HostMessage } from '../src/protocol';
import { MockPanel, window, workspace, Uri } from './vscode';

class State implements vscode.Memento {
  readonly saved: unknown[] = [];
  keys(): readonly string[] { return []; }
  get<T>(_key: string): T | undefined;
  get<T>(_key: string, defaultValue: T): T;
  get<T>(_key: string, defaultValue?: T): T | undefined { return defaultValue; }
  async update(_key: string, value: unknown): Promise<void> { this.saved.push(value); }
}
let controller: PickerController;
let panel: MockPanel;
let state: State;
const log = vi.fn();
const messages = (): HostMessage[] => panel.webview.postMessage.mock.calls.map(call => call[0]).filter(
  (message): message is HostMessage => typeof message === 'object' && message !== null && 'type' in message);
const waitResults = async (): Promise<void> => {
  await vi.waitFor(() => expect(messages().some(message => message.type === 'results')).toBe(true));
};
beforeEach(() => {
  workspace.textDocuments = [];
  workspace.findFiles.mockResolvedValue([Uri.parse('file:///workspace/src/main.cpp')]);
  workspace.fs.stat.mockResolvedValue({ size: 20 });
  workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('int main() {}'));
  window.activeTextEditor = { document: { isClosed: false }, viewColumn: 1 };
  state = new State();
  controller = new PickerController({ extensionUri: vscode.Uri.parse('file:///extension'), workspaceState: state }, { appendLine: log });
  controller.show();
  panel = window.createWebviewPanel.mock.results.at(-1)?.value ?? new MockPanel();
});
afterEach(() => controller.dispose());

it('reuses its panel and restores the original editor on Escape', async () => {
  controller.show();
  expect(window.createWebviewPanel).toHaveBeenCalledTimes(1);
  expect(panel.reveal).toHaveBeenCalled();
  panel.receive({ type: 'close' });
  await vi.waitFor(() => expect(window.showTextDocument).toHaveBeenCalledWith(
    window.activeTextEditor?.document, { viewColumn: 1, preserveFocus: false }));
  expect(state.saved).toEqual([{ query: '' }]);
});
it('previews without opening tabs, then accepts beside without focus restoration', async () => {
  panel.receive({ type: 'query', query: 'main', requestId: 1 });
  await waitResults();
  panel.receive({ type: 'select', id: 'file:///workspace/src/main.cpp', requestId: 1 });
  await vi.waitFor(() => expect(messages().some(message => message.type === 'preview')).toBe(true));
  expect(window.showTextDocument).not.toHaveBeenCalled();
  panel.receive({ type: 'accept', id: 'file:///workspace/src/main.cpp', beside: true });
  await vi.waitFor(() => expect(state.saved.length).toBe(1));
  expect(window.showTextDocument).toHaveBeenCalledTimes(1);
  expect(window.showTextDocument.mock.calls[0]?.[1]).toEqual({ viewColumn: -2, preserveFocus: false, preview: false });
});
it('does not permit URIs outside visible results', () => {
  panel.receive({ type: 'accept', id: 'file:///private/secret', beside: false });
  expect(window.showTextDocument).not.toHaveBeenCalled();
  expect(messages().at(-1)).toMatchObject({ type: 'error', scope: 'open' });
});
it('keeps the latest query and cancels stale previews and work on close', async () => {
  panel.receive({ type: 'query', query: 'obsolete', requestId: 1 });
  panel.receive({ type: 'query', query: 'main', requestId: 2 });
  await waitResults();
  expect(messages().filter(message => message.type === 'results').map(message => message.requestId)).toEqual([2]);
  let resolve: (bytes: Uint8Array) => void = () => { throw new Error('No pending preview'); };
  workspace.fs.readFile.mockImplementationOnce(() => new Promise<Uint8Array>(done => { resolve = done; }));
  panel.receive({ type: 'select', id: 'file:///workspace/src/main.cpp', requestId: 1 });
  await vi.waitFor(() => expect(workspace.fs.readFile).toHaveBeenCalled());
  panel.receive({ type: 'query', query: 'missing', requestId: 3 });
  resolve(new TextEncoder().encode('obsolete preview'));
  await new Promise(done => setTimeout(done, 0));
  expect(messages().some(message => message.type === 'preview')).toBe(false);
  panel.receive({ type: 'close' });
  const count = panel.webview.postMessage.mock.calls.length;
  await new Promise(done => setTimeout(done, 0));
  expect(panel.webview.postMessage).toHaveBeenCalledTimes(count);
});
it('resumes the last query and selection', async () => {
  panel.receive({ type: 'query', query: 'main', requestId: 1 });
  await waitResults();
  panel.receive({ type: 'select', id: 'file:///workspace/src/main.cpp', requestId: 1 });
  panel.receive({ type: 'close' });
  controller.show(true);
  panel = window.createWebviewPanel.mock.results.at(-1)?.value ?? new MockPanel();
  panel.receive({ type: 'ready' });
  expect(messages().at(-1)).toMatchObject({ type: 'init', query: 'main', selectedId: 'file:///workspace/src/main.cpp' });
  expect(workspace.fs.readFile).not.toHaveBeenCalled();
});
it('surfaces file and opening failures and leaves the picker usable', async () => {
  workspace.findFiles.mockRejectedValueOnce(new Error('Discovery unavailable'));
  panel.receive({ type: 'query', query: '', requestId: 1 });
  await vi.waitFor(() => expect(messages().at(-1)).toMatchObject({ type: 'error', scope: 'files', message: 'Discovery unavailable' }));
  panel.receive({ type: 'query', query: '', requestId: 2 });
  await waitResults();
  window.showTextDocument.mockRejectedValueOnce(new Error('File deleted'));
  panel.receive({ type: 'accept', id: 'file:///workspace/src/main.cpp', beside: false });
  await vi.waitFor(() => expect(messages().at(-1)).toMatchObject({ type: 'error', scope: 'open', message: 'File deleted' }));
  expect(state.saved).toHaveLength(0);
});
