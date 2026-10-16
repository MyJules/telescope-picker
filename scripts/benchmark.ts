import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { rankFiles, type IndexedFile } from '../src/ranking';

const files: IndexedFile[] = Array.from({ length: 50_000 }, (_, index) => {
  const name = `File${index}.cpp`;
  return { id: `file:///benchmark/${index}`, path: `src/module${index % 250}/${name}`, name, root: 'benchmark' };
});
const queries = ['file', 'module12', 'f123', 'srcmod', 'File49999.cpp'];
for (const query of queries) rankFiles(files, query);
const times: number[] = [];
for (let run = 0; run < 20; run++) for (const query of queries) {
  const start = performance.now();
  const result = rankFiles(files, query);
  times.push(performance.now() - start);
  if (result.items.length !== result.total) throw new Error('Filename matches were truncated');
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, memoryGiB: Math.round(totalmem() / 1024 ** 3),
  paths: files.length, samples: times.length, p50ms: times[Math.floor(times.length * .5)],
  p95ms: times[Math.floor(times.length * .95)], maxMs: times.at(-1),
  scope: 'Unlimited warm host ranking only; excludes native popup rendering, IPC, filesystem discovery, and picker startup'
}, null, 2));
if ((times[Math.floor(times.length * .95)] ?? Infinity) > 50) process.exitCode = 1;
