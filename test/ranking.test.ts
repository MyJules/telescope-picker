import { describe, expect, it } from 'vitest';
import { matchContentLine, rankFiles, retainContentMatch, RESULT_LIMIT, type IndexedFile } from '../src/ranking';
import type { ContentMatch } from '../src/types';

const file = (path: string, root = 'app'): IndexedFile => ({
  id: `${root}:${path}`, path, root, name: path.slice(path.lastIndexOf('/') + 1)
});

describe('streaming content relevance', () => {
  it('finds fuzzy subsequences, rejects cross-line/nonmatches and reports UTF-16 character positions', () => {
    const match = matchContentLine(file('main.ts'), 'fzndl', 8, '\u{1F600} const fuzzyNeedle = 1;');
    expect(match?.location.line).toBe(8);
    expect(match?.location.matches.map(index => match.location.text[index]).join('').toLowerCase()).toBe('fzndl');
    expect(matchContentLine(file('main.ts'), 'missing', 0, 'const value = 1;')).toBeUndefined();
  });
  it('retains the best 200, not merely the first 200 encountered', () => {
    const items: ContentMatch[] = [];
    for (let line = 300; line >= 0; line--) {
      const match = matchContentLine(file('main.ts'), 'needle', line, 'needle');
      if (match) retainContentMatch(items, match);
    }
    expect(items).toHaveLength(200);
    expect(items[0]?.location.line).toBe(0);
    expect(items.at(-1)?.location.line).toBe(199);
  });
});
const files = [
  file('src/game/Game.cppm'), file('src/main.cpp'), file('CMakeLists.txt'),
  file('src/main/helpers.cpp'), file('vendor/main.cpp'), file('src/main.cpp', 'second')
];

describe('file relevance benchmark', () => {
  it.each([
    ['Game', 'src/game/Game.cppm'], ['srcmain', 'src/main.cpp'],
    ['cmakelists', 'CMakeLists.txt'], ['gamecpp', 'src/game/Game.cppm']
  ])('ranks %s first', (query, path) => {
    expect(rankFiles(files, query).items[0]?.path).toBe(path);
  });
  it('prefers basename matches over directory matches', () => {
    const items = rankFiles(files, 'main').items;
    expect(items[0]?.path).toBe('src/main.cpp');
    expect(items.findIndex(item => item.path === 'src/main/helpers.cpp')).toBeGreaterThan(0);
  });
  it('returns exact highlighted characters and distinguishes roots', () => {
    const items = rankFiles(files, 'main').items.filter(item => item.path === 'src/main.cpp');
    expect(items).toHaveLength(2);
    expect(new Set(items.map(item => item.id)).size).toBe(2);
    for (const item of items) expect(item.matches.map(index => item.path[index]).join('')).toBe('main');
  });
  it('caps rendered results, not total matches, with 50,000 paths', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => file(`src/module${i}/File${i}.ts`));
    const result = rankFiles(many, 'File');
    expect(result.items).toHaveLength(RESULT_LIMIT);
    expect(result.total).toBe(50_000);
    expect(result.truncated).toBe(true);
  });
  it('handles empty queries, spaces, and no matches', () => {
    expect(rankFiles(files, '  ').items).toHaveLength(files.length);
    expect(rankFiles(files, 'impossible_zqx').total).toBe(0);
    expect(rankFiles([], 'main').items).toEqual([]);
  });
});
