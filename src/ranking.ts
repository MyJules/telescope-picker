import fuzzysort, { type KeysResult, type Result, type SnapshotKeys } from 'fuzzysort';
import type { ContentMatch, ResultItem } from './types';

export interface IndexedFile {
  id: string;
  path: string;
  root: string;
  name: string;
}

export const RESULT_LIMIT = 200;
const snapshots = new WeakMap<readonly IndexedFile[], SnapshotKeys<IndexedFile>>();

export function matchContentLine(file: IndexedFile, query: string, line: number, text: string): ContentMatch | undefined {
  // Explicit preparation avoids the matcher's unbounded string-target cache during streaming scans.
  const match = fuzzysort.single(query, fuzzysort.prepare(text));
  if (!match) return undefined;
  return {
    id: JSON.stringify([file.id, line]), uri: file.id, path: file.path, root: file.root,
    location: { line, text, matches: [...match.indexes] }, score: match.score
  };
}

export function retainContentMatch(items: ContentMatch[], match: ContentMatch): void {
  const compare = (a: ContentMatch, b: ContentMatch): number =>
    b.score - a.score || a.path.localeCompare(b.path) || a.uri.localeCompare(b.uri) || a.location.line - b.location.line;
  const last = items.at(-1);
  if (items.length === RESULT_LIMIT && last && compare(match, last) >= 0) return;
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = items[middle];
    if (current && compare(match, current) >= 0) low = middle + 1;
    else high = middle;
  }
  items.splice(low, 0, match);
  if (items.length > RESULT_LIMIT) items.pop();
}

function keyMatches(result: KeysResult<IndexedFile>): [Result, Result] {
  const [name, path] = result;
  if (!name || !path) throw new Error('The matcher returned an incomplete result.');
  return [name, path];
}

export function rankFiles(files: readonly IndexedFile[], query: string): {
  items: ResultItem[]; total: number; truncated: boolean;
} {
  const needle = query.trim();
  if (!needle) {
    return {
      items: files.slice(0, RESULT_LIMIT).map(file => ({ id: file.id, path: file.path, root: file.root, matches: [] })),
      total: files.length, truncated: files.length > RESULT_LIMIT
    };
  }
  let snapshot = snapshots.get(files);
  if (!snapshot) {
    snapshot = fuzzysort.snapshot(files, { keys: ['name', 'path'] });
    snapshots.set(files, snapshot);
  }
  const results = fuzzysort.go(needle, snapshot, {
    limit: RESULT_LIMIT,
    threshold: 0
  });
  const ordered = [...results].sort((a, b) =>
    b.score - a.score || a.obj.path.length - b.obj.path.length || a.obj.id.localeCompare(b.obj.id));
  return {
    items: ordered.map(result => {
      const file = result.obj;
      const [name, path] = keyMatches(result);
      const useName = name.score >= path.score && name.score > 0;
      const match = useName ? name : path;
      const offset = useName ? file.path.length - file.name.length : 0;
      return { id: file.id, path: file.path, root: file.root, matches: match.indexes.map(index => index + offset) };
    }),
    total: results.total,
    truncated: results.total > results.length
  };
}
