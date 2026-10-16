import { describe, expect, it } from 'vitest';
import { compareContentMatches, createContentMatcher, rankFiles, type IndexedFile } from '../src/ranking';
import type { ContentMatch } from '../src/types';

const file = (path: string, root = 'app'): IndexedFile => ({
  id: `${root}:${path}`, path, root, name: path.slice(path.lastIndexOf('/') + 1)
});

describe('literal content matching', () => {
  it('matches contiguous text without case sensitivity and reports UTF-16 character positions', () => {
    const match = createContentMatcher('FUZZY')(file('main.ts'), 8, '\u{1F600} const fuzzyNeedle = 1;');
    expect(match?.location.line).toBe(8);
    expect(match?.location.matches).toEqual([9, 10, 11, 12, 13]);
    expect(createContentMatcher('fzndl')(file('main.ts'), 0, 'const fuzzyNeedle = 1;')).toBeUndefined();
  });
  it('treats regex characters and whitespace literally and highlights every occurrence', () => {
    const match = createContentMatcher(' [a].* ')(file('main.ts'), 0, ' [A].*  [a].* ');
    expect(match?.location.matches).toHaveLength(14);
    expect(createContentMatcher('  ')(file('main.ts'), 0, '  ')).toBeDefined();
    expect(createContentMatcher('x.y')(file('main.ts'), 0, 'xay')).toBeUndefined();
  });
  it('orders all content matches without a result limit', () => {
    const items: ContentMatch[] = [];
    for (let line = 300; line >= 0; line--) {
      const match = createContentMatcher('needle')(file('main.ts'), line, 'needle');
      if (match) items.push(match);
    }
    items.sort(compareContentMatches);
    expect(items).toHaveLength(301);
    expect(items[0]?.location.line).toBe(0);
    expect(items.at(-1)?.location.line).toBe(300);
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
  it('returns all matches and all empty-query results with 50,000 paths', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => file(`src/module${i}/File${i}.ts`));
    const result = rankFiles(many, 'File');
    expect(result.items).toHaveLength(50_000);
    expect(result.total).toBe(50_000);
    expect(new Set(result.items.map(item => item.id)).size).toBe(50_000);
    expect(rankFiles(many, '').items).toHaveLength(50_000);
  });
  it('handles empty queries, spaces, and no matches', () => {
    expect(rankFiles(files, '  ').items).toHaveLength(files.length);
    expect(rankFiles(files, 'impossible_zqx').total).toBe(0);
    expect(rankFiles([], 'main').items).toEqual([]);
  });
});
