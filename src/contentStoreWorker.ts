import { parentPort } from 'node:worker_threads';
import type { IndexedFile } from './ranking';
import type { ContentMatch } from './types';
import { ContentParser, type FileMatches } from './contentParser';
import type { ParsedFile } from './contentStore';

type Request = { id: number } & (
  { type: 'document'; query: string; file: IndexedFile; startLine: number; lines: string[]; complete: boolean }
  | { type: 'page'; offset: number; size: number; selectedId?: string }
  | { type: 'parse'; query: string; lines: string[] }
  | { type: 'commit'; path: string; file?: IndexedFile }
);

const port = parentPort;
if (!port) throw new Error('Content-store worker requires a parent port.');
const files: { file: IndexedFile; items: ContentMatch[] }[] = [];
let unsorted = false;
let length = 0;
let parser: ContentParser | undefined;
const completed = new Map<string, FileMatches>();
const documents = new Map<string, FileMatches>();

port.on('message', (request: Request) => {
  try {
    if (request.type === 'parse') {
      parser ??= new ContentParser(request.query);
      const results: ParsedFile[] = [];
      for (const line of request.lines) {
        const event = parser.parse(line);
        if (event?.type !== 'end') continue;
        completed.set(event.path, event.matches);
        results.push({
          path: event.path, total: event.matches.total, binary: event.binary,
          invalidEncoding: event.matches.invalidEncoding
        });
      }
      port.postMessage({ id: request.id, files: results });
      return;
    }
    if (request.type === 'commit') {
      const matches = completed.get(request.path);
      if (!matches) throw new Error('Missing parsed content file.');
      completed.delete(request.path);
      if (request.file) {
        for (const item of matches.items) {
          item.id = JSON.stringify([request.file.id, item.location.line]);
          item.uri = request.file.id;
          item.path = request.file.path;
          item.root = request.file.root;
        }
        files.push({ file: request.file, items: matches.items });
        length += matches.items.length;
        unsorted = true;
      }
      port.postMessage({ id: request.id });
      return;
    }
    if (request.type === 'document') {
      const contentParser = parser ??= new ContentParser(request.query);
      let matches = documents.get(request.file.id);
      if (!matches) {
        matches = { file: request.file, items: [], total: 0, invalidEncoding: false, extraLines: 0, skip: false };
        documents.set(request.file.id, matches);
      }
      request.lines.forEach((line, index) => contentParser.collect(matches, request.startLine + index, line));
      if (request.complete) {
        files.push({ file: request.file, items: matches.items });
        length += matches.items.length;
        unsorted = true;
        documents.delete(request.file.id);
      }
      port.postMessage({
        id: request.id,
        files: [{ path: request.file.id, total: matches.total, binary: false, invalidEncoding: false }]
      });
      return;
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0
      || !Number.isSafeInteger(request.size) || request.size <= 0)
      throw new Error('Invalid content result page.');
    if (unsorted) {
      files.sort((a, b) => a.file.path.localeCompare(b.file.path) || a.file.id.localeCompare(b.file.id));
      unsorted = false;
    }
    let offset = Math.min(request.offset, Math.max(0, Math.ceil(length / request.size) - 1) * request.size);
    if (request.selectedId) {
      let start = 0;
      for (const file of files) {
        const index = file.items.findIndex(item => item.id === request.selectedId);
        if (index >= 0) { offset = Math.floor((start + index) / request.size) * request.size; break; }
        start += file.items.length;
      }
    }
    const items: ContentMatch[] = [];
    let start = 0;
    for (const file of files) {
      if (start >= offset + request.size) break;
      for (let index = Math.max(0, offset - start); index < Math.min(file.items.length, offset + request.size - start); index++) {
        const item = file.items[index];
        if (item) items.push(item);
      }
      start += file.items.length;
    }
    port.postMessage({ id: request.id, page: { items, offset, length } });
  } catch (reason) {
    port.postMessage({ id: request.id, error: reason instanceof Error ? reason.message : String(reason) });
  }
});
