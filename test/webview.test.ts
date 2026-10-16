// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickerHtml } from '../src/html';
import { startPicker } from '../src/webview/picker';
import type { ClientMessage, HostMessage } from '../src/protocol';

let stop: () => void;
const sent: ClientMessage[] = [];
const result = (id: string) => ({ id, path: `src/${id}.ts`, root: 'app', matches: [4, 5] });
const send = (message: HostMessage): void => { window.dispatchEvent(new MessageEvent('message', { data: message })); };
const key = (key: string, options: KeyboardEventInit = {}): void => {
  document.getElementById('query')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
};
const input = (): HTMLInputElement => document.querySelector('input')!;
const results = (requestId = 1): void => {
  send({ type: 'results', requestId, total: 2, truncated: false, indexTruncated: false, items: [result('a'), result('b')] });
};

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  const html = pickerHtml({ cspSource: 'vscode-webview:', script: 'webview.js', style: 'picker.css' });
  document.documentElement.innerHTML = html;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  });
  stop = startPicker({ postMessage: message => sent.push(message) }, document, window);
  send({ type: 'init', query: '', workspace: 'app', vimNavigation: true });
});
afterEach(() => { stop(); vi.useRealTimers(); });

describe('keyboard and webview interaction', () => {
  it('focuses immediately and preserves input focus during navigation', () => {
    results();
    expect(document.activeElement).toBe(input());
    key('ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe('result-1');
    expect(document.activeElement).toBe(input());
    key('k', { ctrlKey: true });
    expect(input().getAttribute('aria-activedescendant')).toBe('result-0');
    vi.advanceTimersByTime(40);
    expect(sent.at(-1)).toMatchObject({ type: 'select', id: 'a' });
  });
  it('accepts, opens beside and cancels from the keyboard', () => {
    results(); key('Enter'); key('Enter', { ctrlKey: true }); key('Enter', { metaKey: true }); key('Escape');
    expect(sent.slice(-4)).toEqual([
      { type: 'accept', id: 'a', beside: false }, { type: 'accept', id: 'a', beside: true },
      { type: 'accept', id: 'a', beside: true }, { type: 'close' }
    ]);
  });
  it('rejects stale query and preview responses', () => {
    results();
    vi.advanceTimersByTime(40);
    const first = sent.slice().reverse().find(message => message.type === 'select');
    if (first?.type !== 'select') throw new Error('Expected selection');
    key('ArrowDown');
    send({ type: 'preview', requestId: first.requestId, id: 'a', html: 'obsolete', lines: 1, note: '' });
    expect(document.getElementById('preview-code')?.textContent).not.toContain('obsolete');
    input().value = 'new'; input().dispatchEvent(new Event('input'));
    results(1);
    expect(document.querySelectorAll('[role=option]')).toHaveLength(0);
    key('Enter');
    expect(sent.at(-1)?.type).toBe('query');
    send({ type: 'results', requestId: 2, total: 0, truncated: false, indexTruncated: false, items: [] });
    expect(document.getElementById('result-state')?.textContent).toBe('No matching files.');
  });
  it('renders highlighted paths without interpreting filenames as markup', () => {
    send({ type: 'results', requestId: 1, total: 1, truncated: false, indexTruncated: false,
      items: [{ id: 'unsafe', path: '<img src=x>.ts', root: '<b>root</b>', matches: [1, 2, 3] }] });
    expect(document.querySelector('li img')).toBeNull();
    expect(document.querySelector('li mark')?.textContent).toBe('img');
    expect(document.querySelector('li')?.textContent).toContain('<b>root</b>');
  });
  it('resumes selection and supports preview toggling and scrolling', () => {
    send({ type: 'init', query: 'saved', selectedId: 'b', workspace: 'app', vimNavigation: false });
    results(2);
    expect(input().value).toBe('saved');
    expect(input().getAttribute('aria-activedescendant')).toBe('result-1');
    key('p', { altKey: true });
    expect(document.getElementById('preview-pane')?.hidden).toBe(true);
    key('p', { altKey: true });
    expect(document.getElementById('preview-pane')?.hidden).toBe(false);
    key('ArrowDown', { altKey: true });
    expect(document.getElementById('preview-scroll')?.scrollTop).toBe(120);
  });
  it('does not accept or navigate during IME composition', () => {
    results();
    input().dispatchEvent(new CompositionEvent('compositionstart'));
    key('Enter'); key('Escape'); key('ArrowDown');
    expect(sent.some(message => message.type === 'accept' || message.type === 'close')).toBe(false);
    input().dispatchEvent(new CompositionEvent('compositionend'));
    expect(sent.at(-1)?.type).toBe('query');
  });
  it('preserves newer input when workspace invalidation arrives', () => {
    input().value = 'newly typed text';
    input().dispatchEvent(new Event('input'));
    send({ type: 'refresh', workspace: 'updated roots' });
    expect(input().value).toBe('newly typed text');
    expect(sent.at(-1)).toEqual({ type: 'query', query: 'newly typed text', requestId: 3 });
  });
  it('exposes explicit errors and removes interaction handlers on disposal', () => {
    results();
    send({ type: 'error', scope: 'files', requestId: 1, message: 'Workspace unavailable' });
    expect(document.getElementById('error')?.hidden).toBe(false);
    expect(document.getElementById('error')?.textContent).toBe('Workspace unavailable');
    stop();
    const count = sent.length;
    key('ArrowDown');
    vi.advanceTimersByTime(100);
    expect(sent.length).toBe(count);
  });
});
