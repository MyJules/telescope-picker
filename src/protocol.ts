export interface ResultItem {
  id: string;
  path: string;
  root: string;
  matches: number[];
}

export type ClientMessage =
  | { type: 'ready' }
  | { type: 'query'; query: string; requestId: number }
  | { type: 'select'; id: string; requestId: number }
  | { type: 'accept'; id: string; beside: boolean }
  | { type: 'close' };

export type HostMessage =
  | { type: 'init'; query: string; selectedId?: string; workspace: string; vimNavigation: boolean }
  | { type: 'focus' }
  | { type: 'refresh'; workspace: string }
  | { type: 'loading'; requestId: number }
  | { type: 'results'; requestId: number; items: ResultItem[]; total: number; truncated: boolean; indexTruncated: boolean }
  | { type: 'preview'; requestId: number; id: string; html: string; lines: number; note: string }
  | { type: 'error'; scope: 'files' | 'preview' | 'protocol' | 'open'; message: string; requestId?: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!record(value)) return;
  switch (value.type) {
    case 'ready': case 'close': return { type: value.type };
    case 'query':
      if (typeof value.query === 'string' && value.query.length <= 1024 && requestId(value.requestId))
        return { type: 'query', query: value.query, requestId: value.requestId };
      break;
    case 'select':
      if (typeof value.id === 'string' && value.id.length <= 16384 && requestId(value.requestId))
        return { type: 'select', id: value.id, requestId: value.requestId };
      break;
    case 'accept':
      if (typeof value.id === 'string' && value.id.length <= 16384 && typeof value.beside === 'boolean')
        return { type: 'accept', id: value.id, beside: value.beside };
  }
}

export function isHostMessage(value: unknown): value is HostMessage {
  if (!record(value)) return false;
  switch (value.type) {
    case 'focus': return true;
    case 'refresh': return typeof value.workspace === 'string';
    case 'init':
      return typeof value.query === 'string' && (value.selectedId === undefined || typeof value.selectedId === 'string')
        && typeof value.workspace === 'string' && typeof value.vimNavigation === 'boolean';
    case 'loading': return requestId(value.requestId);
    case 'results':
      return requestId(value.requestId) && Number.isSafeInteger(value.total) && typeof value.total === 'number' && value.total >= 0
        && typeof value.truncated === 'boolean' && typeof value.indexTruncated === 'boolean'
        && Array.isArray(value.items) && value.items.length <= 200 && value.items.every(item => {
          if (!record(item) || typeof item.id !== 'string' || typeof item.path !== 'string' || typeof item.root !== 'string')
            return false;
          const length = item.path.length;
          return Array.isArray(item.matches) && item.matches.every(index => requestId(index) && index < length);
        });
    case 'preview':
      return requestId(value.requestId) && typeof value.id === 'string' && typeof value.html === 'string'
        && requestId(value.lines) && value.lines <= 400 && typeof value.note === 'string';
    case 'error':
      return ['files', 'preview', 'protocol', 'open'].includes(String(value.scope)) && typeof value.message === 'string'
        && (value.requestId === undefined || requestId(value.requestId));
    default: return false;
  }
}
