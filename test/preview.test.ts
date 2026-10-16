import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { PreviewService, renderPreview } from '../src/preview';
import { workspace } from './vscode';

beforeEach(() => {
  workspace.textDocuments = [];
  workspace.fs.stat.mockResolvedValue({ size: 20 });
  workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('int main() {}'));
});

describe('bounded preview', () => {
  it('highlights C++ modules and escapes HTML and scripts', () => {
    const preview = renderPreview('export module Game;\n// <script>alert(1)</script>', 'Game.cppm');
    expect(preview.html).toContain('hljs-keyword');
    expect(preview.html).not.toContain('<script>');
    expect(preview.html).toContain('&lt;script&gt;');
    expect(preview.lines).toBe(2);
    expect(renderPreview('<img src=x onerror=alert(1)>', 'unknown.zzz').html).toContain('&lt;img');
  });
  it('bounds lines, columns, and multibyte text', () => {
    expect(renderPreview('x\n'.repeat(800), 'a.txt').lines).toBe(400);
    expect(renderPreview('x'.repeat(10_000), 'a.txt').html.length).toBe(2000);
    expect(renderPreview('word '.repeat(40_000), 'a.txt').note).toContain('truncated');
    expect(renderPreview('\u03bb'.repeat(70_000), 'a.txt').html).not.toContain('\ufffd');
    expect(() => renderPreview('a\0b', 'a.bin')).toThrow('Binary');
  });
  it('rejects oversized, binary, invalid encoding, and unavailable files explicitly', async () => {
    const service = new PreviewService();
    const uri = vscode.Uri.parse('file:///workspace/file');
    const token = new vscode.CancellationTokenSource().token;
    workspace.fs.stat.mockResolvedValueOnce({ size: 2 * 1024 * 1024 });
    await expect(service.load(uri, token)).rejects.toThrow('larger');
    workspace.fs.readFile.mockResolvedValueOnce(new Uint8Array([0, 1]));
    await expect(service.load(uri, token)).rejects.toThrow('Binary');
    workspace.fs.readFile.mockResolvedValueOnce(new Uint8Array([255, 254]));
    await expect(service.load(uri, token)).rejects.toThrow('UTF-8');
    workspace.fs.stat.mockRejectedValueOnce(new Error('Unavailable resource'));
    await expect(service.load(uri, token)).rejects.toThrow('Unavailable');
  });
  it('uses unsaved contents without disk reads or opening tabs', async () => {
    const uri = vscode.Uri.parse('file:///workspace/dirty.ts');
    workspace.textDocuments = [{
      uri, isDirty: true, lineCount: 1, getText: () => 'const unsaved = 1;'
    }];
    const preview = await new PreviewService().load(uri, new vscode.CancellationTokenSource().token);
    expect(preview.html).toContain('unsaved');
    expect(preview.note).toContain('Unsaved');
    expect(workspace.fs.readFile).not.toHaveBeenCalled();
  });
  it('stops cancelled reads', async () => {
    const cancellation = new vscode.CancellationTokenSource();
    cancellation.cancel();
    await expect(new PreviewService().load(vscode.Uri.parse('file:///workspace/a'), cancellation.token))
      .rejects.toBeInstanceOf(vscode.CancellationError);
    expect(workspace.fs.stat).not.toHaveBeenCalled();
  });
});
