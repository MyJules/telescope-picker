import fuzzysort, { type KeysResult, type Result, type SnapshotKeys } from 'fuzzysort';
import type { ContentMatch, ResultItem } from './types';

export interface IndexedFile {
  id: string;
  path: string;
  root: string;
  name: string;
}

const snapshots = new WeakMap<readonly IndexedFile[], SnapshotKeys<IndexedFile>>();

export function createContentMatcher(query: string): (file: IndexedFile, line: number, text: string) => ContentMatch | undefined {
  if (!query.length || /[\r\n\0]/.test(query)) throw new Error('Enter a nonempty, single-line text query without NUL characters.');
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return (file, line, text) => {
    const matches: number[] = [];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null)
      for (let index = match.index; index < match.index + match[0].length; index++) matches.push(index);
    if (!matches.length) return undefined;
    return {
      id: JSON.stringify([file.id, line]), uri: file.id, path: file.path, root: file.root,
      location: { line, text, matches }
    };
  };
}

export function compareContentMatches(a: ContentMatch, b: ContentMatch): number {
  return a.path.localeCompare(b.path) || a.uri.localeCompare(b.uri) || a.location.line - b.location.line;
}

function keyMatches(result: KeysResult<IndexedFile>): [Result, Result] {
  const [name, path] = result;
  if (!name || !path) throw new Error('The matcher returned an incomplete result.');
  return [name, path];
}

export function rankFiles(files: readonly IndexedFile[], query: string, includeMatches = true): {
  items: ResultItem[]; total: number;
} {
  const needle = query.trim();
  if (!needle) {
    return {
      items: files.map(file => ({ id: file.id, path: file.path, root: file.root, matches: [] })),
      total: files.length
    };
  }
  let snapshot = snapshots.get(files);
  if (!snapshot) {
    snapshot = fuzzysort.snapshot(files, { keys: ['name', 'path'] });
    snapshots.set(files, snapshot);
  }
  const results = fuzzysort.go(needle, snapshot, {
    limit: files.length,
    threshold: 0
  });
  const ordered = [...results].sort((a, b) =>
    b.score - a.score || a.obj.path.length - b.obj.path.length || a.obj.id.localeCompare(b.obj.id));
  return {
    items: ordered.map(result => {
      const file = result.obj;
      if (!includeMatches) return { id: file.id, path: file.path, root: file.root, matches: [] };
      const [name, path] = keyMatches(result);
      const useName = name.score >= path.score && name.score > 0;
      const match = useName ? name : path;
      const offset = useName ? file.path.length - file.name.length : 0;
      return { id: file.id, path: file.path, root: file.root, matches: match.indexes.map(index => index + offset) };
    }),
    total: results.total
  };
}
