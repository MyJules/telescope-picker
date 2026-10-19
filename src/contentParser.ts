import { createContentMatcher, type IndexedFile } from './ranking';
import type { ContentMatch } from './types';

export interface FileMatches {
  file: IndexedFile;
  items: ContentMatch[];
  total: number;
  invalidEncoding: boolean;
  extraLines: number;
  skip: boolean;
}

type FileEvent = { type: 'begin' | 'end'; path: string; matches: FileMatches; binary: boolean };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class ContentParser {
  private readonly active = new Map<string, FileMatches>();
  private readonly matchLine: ReturnType<typeof createContentMatcher>;

  constructor(query: string) { this.matchLine = createContentMatcher(query); }

  collect(matches: FileMatches, line: number, text: string): void {
    const match = this.matchLine(matches.file, line, text);
    if (match) { matches.total++; matches.items.push(match); }
  }

  parse(text: string): FileEvent | undefined {
    const message: unknown = JSON.parse(text);
    if (!record(message) || typeof message.type !== 'string') throw new Error('Invalid text-search response.');
    if (message.type !== 'match' && message.type !== 'end' && message.type !== 'begin') return;
    const data = message.data;
    if (!record(data) || !record(data.path) || typeof data.path.text !== 'string')
      throw new Error('Text search returned an unsupported filename encoding.');
    const path = data.path.text;
    if (message.type === 'begin') {
      const matches: FileMatches = {
        file: { id: path, path, name: path, root: '' },
        items: [], total: 0, invalidEncoding: false, extraLines: 0, skip: false
      };
      this.active.set(path, matches);
      return { type: 'begin', path, matches, binary: false };
    }
    const matches = this.active.get(path);
    if (!matches) throw new Error('Text search returned a file outside its search sequence.');
    if (message.type === 'match' && !matches.skip) {
      if (!record(data.lines) || typeof data.line_number !== 'number'
        || !Number.isSafeInteger(data.line_number) || data.line_number < 1)
        throw new Error('Invalid text-search line response.');
      if (typeof data.lines.text !== 'string') {
        if (typeof data.lines.bytes !== 'string') throw new Error('Invalid text-search text response.');
        matches.invalidEncoding = true;
      } else {
        const startLine = data.line_number - 1;
        let lineText = data.lines.text.replace(/\r?\n$/, '');
        if (startLine === 0) lineText = lineText.replace(/^\uFEFF/, '');
        const lines = lineText.split('\r');
        lines.forEach((line, offset) => this.collect(matches, startLine + matches.extraLines + offset, line));
        matches.extraLines += lines.length - 1;
      }
    } else if (message.type === 'end') {
      this.active.delete(path);
      return { type: 'end', path, matches, binary: data.binary_offset !== null && data.binary_offset !== undefined };
    }
    return;
  }
}
