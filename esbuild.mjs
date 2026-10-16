import * as esbuild from 'esbuild';

const builds = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'] },
  { entryPoints: ['test/host/index.ts'], outfile: 'dist/test/host.js', platform: 'node', format: 'cjs', external: ['vscode'] }
];
for (const build of builds) {
  const context = await esbuild.context({ bundle: true, sourcemap: true, target: 'es2022', ...build });
  if (process.argv.includes('--watch')) await context.watch();
  else { await context.rebuild(); await context.dispose(); }
}
