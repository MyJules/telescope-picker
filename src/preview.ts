import * as vscode from 'vscode';
import hljs from 'highlight.js/lib/common';
import cmake from 'highlight.js/lib/languages/cmake';

hljs.registerLanguage('cmake', cmake);

export const MAX_PREVIEW_BYTES = 128 * 1024;
export const MAX_PREVIEW_LINES = 400;
const MAX_RESOURCE_BYTES = 1024 * 1024;
const MAX_LINE_LENGTH = 2000;

export interface Preview { html: string; lines: number; note: string }

const languages: Record<string, string> = {
  c: 'c', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', cppm: 'cpp', ixx: 'cpp',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
  py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', css: 'css', xml: 'xml',
  html: 'xml', md: 'markdown', yaml: 'yaml', yml: 'yaml', sh: 'bash', sql: 'sql', cmake: 'cmake'
};

export function renderPreview(text: string, path: string, dirty = false): Preview {
  if (text.includes('\0')) throw new Error('Binary files cannot be previewed.');
  const bytes = Buffer.from(text, 'utf8');
  const prefix = new TextDecoder().decode(bytes.subarray(0, MAX_PREVIEW_BYTES), { stream: bytes.length > MAX_PREVIEW_BYTES });
  const sourceLines = prefix.replaceAll('\r\n', '\n').split('\n');
  const lines = sourceLines.slice(0, MAX_PREVIEW_LINES).map(line => line.slice(0, MAX_LINE_LENGTH));
  const bounded = lines.join('\n');
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const language = path.toLowerCase().endsWith('cmakelists.txt') ? 'cmake' : languages[extension];
  const html = language && hljs.getLanguage(language)
    ? hljs.highlight(bounded, { language, ignoreIllegals: true }).value
    : bounded.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const truncated = bytes.length > MAX_PREVIEW_BYTES || sourceLines.length > MAX_PREVIEW_LINES
    || sourceLines.slice(0, MAX_PREVIEW_LINES).some(line => line.length > MAX_LINE_LENGTH);
  return {
    html, lines: lines.length,
    note: [dirty ? 'Unsaved editor contents' : '', truncated ? 'Preview truncated (128 KiB / 400 lines / 2,000 columns)' : '']
      .filter(Boolean).join(' \u00b7 ')
  };
}

export class PreviewService {
  async load(uri: vscode.Uri, token: vscode.CancellationToken): Promise<Preview> {
    const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (open) {
      const lines: string[] = [];
      let length = 0;
      let truncated = open.lineCount > MAX_PREVIEW_LINES;
      for (let line = 0; line < Math.min(open.lineCount, MAX_PREVIEW_LINES) && length <= MAX_PREVIEW_BYTES; line++) {
        const text = open.getText(new vscode.Range(line, 0, line, MAX_LINE_LENGTH + 1));
        truncated ||= text.length > MAX_LINE_LENGTH;
        lines.push(text.slice(0, MAX_LINE_LENGTH));
        length += text.length + 1;
      }
      truncated ||= lines.length < open.lineCount;
      const rendered = renderPreview(lines.join('\n'), uri.path, open.isDirty);
      if (truncated && !rendered.note.includes('truncated'))
        rendered.note += `${rendered.note ? ' \u00b7 ' : ''}Preview truncated (128 KiB / 400 lines / 2,000 columns)`;
      return rendered;
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (stat.size > MAX_RESOURCE_BYTES) throw new Error('File is larger than 1 MiB. Open it to inspect its contents.');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    if (bytes.length > MAX_RESOURCE_BYTES) throw new Error('File grew beyond the 1 MiB preview limit.');
    const prefix = bytes.subarray(0, MAX_PREVIEW_BYTES);
    if (prefix.includes(0)) throw new Error('Binary or UTF-16 files cannot be previewed. Open the file in an editor.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: bytes.length > prefix.length }); }
    catch { throw new Error('This file is not valid UTF-8. Open it in an editor to choose its encoding.'); }
    const rendered = renderPreview(text, uri.path);
    if (bytes.length > MAX_PREVIEW_BYTES && !rendered.note.includes('truncated'))
      rendered.note = 'Preview truncated (128 KiB)';
    return rendered;
  }
}
