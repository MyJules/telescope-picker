import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { pickerHtml } from '../src/html';

const root = new URL('..', import.meta.url);
await build({
  absWorkingDir: fileURLToPath(root), entryPoints: ['test/browser-host.ts'],
  outfile: 'dist/browser-host.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022'
});
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(pickerHtml({ script: '/browser-host.js', style: '/picker.css', cspSource: "'self'" }));
      return;
    }
    const files: Record<string, [string, string]> = {
      '/browser-host.js': ['dist/browser-host.js', 'text/javascript'],
      '/picker.css': ['media/picker.css', 'text/css']
    };
    const file = files[request.url ?? ''];
    if (!file) { response.writeHead(404).end('Not found'); return; }
    response.setHeader('Content-Type', file[1]);
    if (request.url === '/picker.css') {
      response.end(`${await readFile(new URL('test/browser-theme.css', root), 'utf8')}\n${await readFile(new URL(file[0], root), 'utf8')}`);
      return;
    }
    response.end(await readFile(new URL(file[0], root)));
  })().catch(reason => {
    console.error(reason);
    response.writeHead(500).end('Preview server failed. See terminal output.');
  });
});
server.listen(4173, '127.0.0.1', () => console.log('Mock picker: http://127.0.0.1:4173'));
