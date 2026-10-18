import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRanking } from '../src/fileRanking';
import { rankFiles, type IndexedFile } from '../src/ranking';

let directory: string;
const services: FileRanking[] = [];
const files: IndexedFile[] = Array.from({ length: 100_000 }, (_, index) => ({
  id: `file:///workspace/src/group-${index % 250}/file-${index}.ts`,
  path: `src/group-${index % 250}/file-${index}.ts`,
  name: `file-${index}.ts`, root: 'workspace'
}));
const service = (path = join(directory, 'worker.cjs')): FileRanking => {
  const ranking = new FileRanking(path);
  services.push(ranking);
  return ranking;
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'telescope-ranking-'));
  await build({
    entryPoints: ['src/fileRankingWorker.ts'], outfile: join(directory, 'worker.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022'
  });
});
afterEach(() => { services.splice(0).forEach(service => service.dispose()); });
afterAll(async () => { await rm(directory, { recursive: true }); });

it('ranks small indexes without needing a worker executable', async () => {
  const input = files.slice(0, 20);
  const result = await service(join(directory, 'missing.cjs')).rank(input, 'file-1');
  expect(result).toEqual(rankFiles(input, 'file-1'));
});

it('preserves ranking and returns every match for 100,000 indexed files off-thread', async () => {
  const ranking = service();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    const start = performance.now();
    const result = await ranking.rank(files, 'file-99');
    const expected = rankFiles(files, 'file-99');
    expect(result.items.map(item => item.id)).toEqual(expected.items.map(item => item.id));
    expect(result.total).toBe(expected.total);
    expect(ticks).toBeGreaterThan(0);
    const warm = performance.now();
    const all = await ranking.rank(files, '');
    expect(all.items).toHaveLength(100_000);
    expect(all.total).toBe(100_000);
    console.log(`100k worker ranking: cold ${(warm - start).toFixed(1)} ms (including direct comparison), warm empty ${(performance.now() - warm).toFixed(1)} ms, event-loop ticks ${ticks}`);
  } finally { clearInterval(timer); }
}, 20_000);

it('coalesces queued queries, rejects obsolete work and reindexes changed file snapshots', async () => {
  const ranking = service();
  const first = ranking.rank(files, 'file');
  const rejectedFirst = expect(first).rejects.toThrow();
  const second = ranking.rank(files, 'file-1');
  const rejectedSecond = expect(second).rejects.toThrow();
  const latest = ranking.rank(files, 'file-99999');
  await rejectedFirst;
  await rejectedSecond;
  expect((await latest).items[0]?.id).toContain('file-99999');
  const updated = files.slice(0, 5000).map(file => ({ ...file, name: 'changed', path: `changed/${file.path}` }));
  expect((await ranking.rank(updated, 'changed')).total).toBe(5000);
}, 20_000);

it('reports worker failures rather than falling back to blocking ranking', async () => {
  await expect(service(join(directory, 'missing.cjs')).rank(files, 'file')).rejects.toThrow();
});

it('cancels outstanding work on disposal', async () => {
  const ranking = service();
  const pending = ranking.rank(files, 'file');
  const rejected = expect(pending).rejects.toThrow();
  ranking.dispose();
  await rejected;
  await expect(ranking.rank(files, '')).rejects.toThrow('disposed');
});
