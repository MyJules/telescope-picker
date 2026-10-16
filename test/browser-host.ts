import { startPicker } from '../src/webview/picker';
import { rankFiles, type IndexedFile } from '../src/ranking';
import type { ClientMessage, HostMessage } from '../src/protocol';

const paths = ['src/main.cpp', 'src/game/Game.cppm', 'CMakeLists.txt',
  ...Array.from({ length: 49_997 }, (_, i) => `src/module${i % 250}/File${i}.cpp`)];
const files: IndexedFile[] = paths.map(path => ({ id: path, path, root: 'demo', name: path.split('/').pop() ?? path }));
const reply = (message: HostMessage): void => { window.postMessage(message, window.location.origin); };
const host = {
  postMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'ready':
        queueMicrotask(() => reply({ type: 'init', query: '', workspace: 'demo (50,000 mock files)', vimNavigation: true }));
        break;
      case 'query':
        reply({ type: 'loading', requestId: message.requestId });
        reply({ type: 'results', requestId: message.requestId, ...rankFiles(files, message.query), indexTruncated: false });
        break;
      case 'select':
        reply({ type: 'preview', id: message.id, requestId: message.requestId, lines: 6,
          html: '<span class="hljs-keyword">int</span> main()\n{\n    <span class="hljs-comment">// Read-only mock preview</span>\n    <span class="hljs-keyword">return</span> <span class="hljs-number">0</span>;\n}\n',
          note: 'Browser mock: real discovery, opening and focus restoration require the Extension Development Host.' });
        break;
      case 'accept':
        reply({ type: 'error', scope: 'open', message: `Mock ${message.beside ? 'split' : 'open'}: ${message.id}` }); break;
      case 'close':
        document.body.textContent = 'Mock picker closed. Reload to reopen.'; break;
    }
  }
};
startPicker(host, document, window);
