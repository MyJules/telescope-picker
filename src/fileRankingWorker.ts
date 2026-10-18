import { parentPort } from 'node:worker_threads';
import { rankFiles, type IndexedFile } from './ranking';

interface Request { id: number; files?: IndexedFile[]; query: string }
const port = parentPort;
if (!port) throw new Error('File ranking must run in a worker thread.');
let files: IndexedFile[] = [];
let indexes = new Map<string, number>();
port.on('message', (request: Request) => {
  try {
    if (request.files) {
      files = request.files;
      indexes = new Map(files.map((file, index) => [file.id, index]));
    }
    const result = rankFiles(files, request.query, false);
    const order = Uint32Array.from(result.items, item => {
      const index = indexes.get(item.id);
      if (index === undefined) throw new Error('Ranked file is missing from the index.');
      return index;
    });
    port.postMessage({ id: request.id, order, total: result.total }, [order.buffer]);
  } catch (reason) {
    port.postMessage({ id: request.id, error: reason instanceof Error ? reason.message : String(reason) });
  }
});
