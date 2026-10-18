import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { rankFiles, type IndexedFile } from './ranking';
import type { ResultItem } from './types';

interface RankedFiles { items: ResultItem[]; total: number }
interface Request {
  id: number;
  files: readonly IndexedFile[];
  query: string;
  resolve(result: RankedFiles): void;
  reject(reason: Error): void;
}
interface Response { id: number; order?: Uint32Array; total?: number; error?: string }

export class FileRanking implements vscode.Disposable {
  private worker: Worker | undefined;
  private indexed: readonly IndexedFile[] | undefined;
  private active: Request | undefined;
  private queued: Request | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly workerPath = join(__dirname, 'fileRankingWorker.js')) {}

  cancel(): void {
    this.generation++;
    this.active?.reject(new vscode.CancellationError());
    this.queued?.reject(new vscode.CancellationError());
    this.queued = undefined;
  }

  async rank(files: readonly IndexedFile[], query: string): Promise<RankedFiles> {
    if (this.disposed) throw new Error('File ranking has been disposed.');
    this.cancel();
    // Small lists avoid worker startup and serialization overhead.
    if (files.length < 5000) return rankFiles(files, query);
    return new Promise<RankedFiles>((resolve, reject) => {
      const request = { id: this.generation, files, query, resolve, reject };
      if (this.active) this.queued = request;
      else this.start(request);
    });
  }

  private start(request: Request): void {
    this.active = request;
    try {
      if (!this.worker) {
        const worker = new Worker(this.workerPath);
        this.worker = worker;
        worker.on('message', (response: Response) => {
          if (this.worker !== worker) return;
          const active = this.active;
          if (!active || response.id !== active.id) { this.fail(new Error('Unexpected file-ranking response.')); return; }
          if (active.id === this.generation) {
            if (response.error) active.reject(new Error(`File ranking failed: ${response.error}`));
            else if (!(response.order instanceof Uint32Array) || response.total !== response.order.length)
              active.reject(new Error('Invalid file-ranking response.'));
            else {
              try {
                const items = Array.from(response.order, index => {
                  const file = active.files[index];
                  if (!file) throw new Error('File-ranking response references an invalid index.');
                  return { id: file.id, path: file.path, root: file.root, matches: [] };
                });
                active.resolve({ items, total: response.total });
              } catch (reason) {
                active.reject(reason instanceof Error ? reason : new Error(String(reason)));
              }
            }
          }
          this.active = undefined;
          const next = this.queued;
          this.queued = undefined;
          if (next) this.start(next);
        });
        worker.on('error', reason => { if (this.worker === worker) this.fail(reason); });
        worker.on('exit', code => {
          if (this.worker === worker) this.fail(new Error(`File-ranking worker exited unexpectedly (${code}).`));
        });
      }
      this.worker.postMessage({
        id: request.id, query: request.query,
        ...(this.indexed === request.files ? {} : { files: request.files })
      });
      this.indexed = request.files;
    } catch (reason) { this.fail(reason instanceof Error ? reason : new Error(String(reason))); }
  }

  private fail(reason: Error): void {
    const worker = this.worker;
    this.worker = undefined;
    this.indexed = undefined;
    this.active?.reject(reason);
    this.queued?.reject(reason);
    this.active = undefined;
    this.queued = undefined;
    if (worker) void worker.terminate();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.fail(new vscode.CancellationError());
  }
}
