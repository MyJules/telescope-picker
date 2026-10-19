import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { IndexedFile } from './ranking';
import type { ContentMatch } from './types';

export interface StoredPage {
  items: ContentMatch[];
  offset: number;
  length: number;
}

export interface ParsedFile { path: string; total: number; binary: boolean; invalidEncoding: boolean }
interface Response { id: number; page?: StoredPage; files?: ParsedFile[]; error?: string }

export class ContentStore implements vscode.Disposable {
  private readonly worker: Worker;
  private readonly pending = new Map<number, {
    resolve(response: Response): void;
    reject(reason: Error): void;
  }>();
  private sequence = 0;
  private failure: Error | undefined;

  constructor(workerPath = join(__dirname, 'contentStoreWorker.js')) {
    this.worker = new Worker(workerPath);
    this.worker.on('message', (response: Response) => {
      const request = this.pending.get(response.id);
      if (!request) { this.fail(new Error('Unexpected content-store response.')); return; }
      this.pending.delete(response.id);
      if (response.error) request.reject(new Error(`Content result storage failed: ${response.error}`));
      else request.resolve(response);
    });
    this.worker.on('error', reason => this.fail(reason));
    this.worker.on('exit', code => {
      if (!this.failure) this.fail(new Error(`Content-store worker exited unexpectedly (${code}).`));
    });
  }

  async document(query: string, file: IndexedFile, startLine: number, lines: readonly string[], complete: boolean): Promise<number> {
    const response = await this.request({ type: 'document', query, file, startLine, lines, complete });
    const result = response.files?.[0];
    if (!result) throw new Error('Invalid live-document search response.');
    return result.total;
  }

  async parse(query: string, lines: readonly string[]): Promise<ParsedFile[]> {
    const response = await this.request({ type: 'parse', query, lines });
    if (!response.files) throw new Error('Invalid content parser response.');
    return response.files;
  }

  async commit(path: string, file?: IndexedFile): Promise<void> {
    await this.request({ type: 'commit', path, file });
  }

  async page(offset: number, size: number, selectedId?: string): Promise<StoredPage> {
    const { page } = await this.request({ type: 'page', offset, size, selectedId });
    if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.length)
      || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.length < page.items.length
      || page.items.length > size)
      throw new Error('Invalid content-store page response.');
    return page;
  }

  private request(message: Record<string, unknown>): Promise<Response> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...message, id }); }
      catch (reason) { this.fail(reason instanceof Error ? reason : new Error(String(reason))); }
    });
  }

  private fail(reason: Error): void {
    if (this.failure) return;
    this.failure = reason;
    for (const request of this.pending.values()) request.reject(reason);
    this.pending.clear();
    void this.worker.terminate();
  }

  dispose(): void { this.fail(new vscode.CancellationError()); }
}
