import { isHostMessage, type ClientMessage, type ResultItem } from '../protocol';

export interface Host { postMessage(message: ClientMessage): void }

export function startPicker(host: Host, document: Document, window: Window & typeof globalThis): () => void {
  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing picker element: ${id}`);
    return found as T;
  }
  const input = element<HTMLInputElement>('query');
  const results = element<HTMLUListElement>('results');
  const resultState = element('result-state');
  const count = element('count');
  const error = element('error');
  const previewCode = element('preview-code');
  const previewNote = element('preview-note');
  const previewTitle = element('preview-title');
  const gutter = element('line-numbers');
  const previewScroll = element('preview-scroll');
  const toggle = element<HTMLButtonElement>('toggle-preview');
  const narrowLayout = window.matchMedia('(max-width: 700px)');
  let items: ResultItem[] = [];
  let selected = -1;
  let desiredId: string | undefined;
  let queryId = 0;
  let previewId = 0;
  let vimNavigation = false;
  let composing = false;
  let previewVisible: boolean | undefined;

  const focus = (): void => { input.focus(); };
  const clearPreview = (note: string): void => {
    previewCode.textContent = '';
    gutter.textContent = '';
    previewNote.textContent = note;
    previewTitle.textContent = 'Preview';
    previewScroll.scrollTop = 0;
    previewScroll.scrollLeft = 0;
  };
  const query = (): void => {
    queryId++;
    previewId++;
    items = [];
    selected = -1;
    results.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    error.hidden = true;
    clearPreview('Select a file to preview it.');
    host.postMessage({ type: 'query', query: input.value, requestId: queryId });
  };
  const select = (index: number): void => {
    if (!items.length) return;
    selected = Math.max(0, Math.min(items.length - 1, index));
    const item = items[selected];
    if (!item) return;
    desiredId = item.id;
    Array.from(results.children).forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
    const active = results.children[selected];
    if (active) {
      input.setAttribute('aria-activedescendant', active.id);
      if ('scrollIntoView' in active) active.scrollIntoView({ block: 'nearest' });
    }
    const requestId = ++previewId;
    clearPreview('Loading preview...');
    previewTitle.textContent = item.path;
    host.postMessage({ type: 'select', id: item.id, requestId });
  };
  const render = (): void => {
    results.replaceChildren(...items.map((item, index) => {
      const row = document.createElement('li');
      row.id = `result-${index}`;
      row.role = 'option';
      row.dataset.index = String(index);
      row.setAttribute('aria-label', `${item.path}, workspace ${item.root}`);
      row.title = `${item.path} (${item.root})`;
      const path = document.createElement('span');
      path.className = 'path';
      const matches = new Set(item.matches);
      for (let start = 0; start < item.path.length;) {
        const matched = matches.has(start);
        let end = start + 1;
        while (end < item.path.length && matches.has(end) === matched) end++;
        const part = document.createElement(matched ? 'mark' : 'span');
        part.textContent = item.path.slice(start, end);
        path.append(part);
        start = end;
      }
      const root = document.createElement('span');
      root.className = 'root';
      root.textContent = item.root;
      row.append(path, root);
      return row;
    }));
    const remembered = items.findIndex(item => item.id === desiredId);
    select(remembered >= 0 ? remembered : 0);
  };
  const showPreview = (): void => {
    const currentlyHidden = element('preview-pane').hidden
      || (previewVisible === undefined && narrowLayout.matches);
    previewVisible = currentlyHidden;
    const picker = document.querySelector('.picker');
    picker?.classList.toggle('force-preview', previewVisible);
    picker?.classList.toggle('no-preview', !previewVisible);
    element('preview-pane').hidden = !previewVisible;
    toggle.setAttribute('aria-pressed', String(previewVisible));
  };
  const accept = (beside: boolean): void => {
    const item = items[selected];
    if (item) host.postMessage({ type: 'accept', id: item.id, beside });
  };
  const onInput = (): void => { if (!composing) query(); };
  const onCompositionStart = (): void => { composing = true; };
  const onCompositionEnd = (): void => { composing = false; query(); };
  const onKey = (event: KeyboardEvent): void => {
    if (event.isComposing || composing) return;
    const key = event.key;
    if (key === 'Escape') { event.preventDefault(); host.postMessage({ type: 'close' }); }
    else if (event.altKey && key.toLowerCase() === 'p') { event.preventDefault(); showPreview(); }
    else if (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
      event.preventDefault();
      previewScroll.scrollTop += key === 'ArrowDown' ? 120 : -120;
    } else if (key === 'ArrowDown' || key === 'ArrowUp'
      || (vimNavigation && event.ctrlKey && ['j', 'k'].includes(key.toLowerCase()))) {
      event.preventDefault();
      select(selected + (key === 'ArrowDown' || key.toLowerCase() === 'j' ? 1 : -1));
      focus();
    } else if ((key === 'PageDown' || key === 'PageUp') && event.target === input) {
      event.preventDefault(); select(selected + (key === 'PageDown' ? 10 : -10));
    } else if (key === 'Enter' && event.target !== toggle) {
      event.preventDefault(); accept(event.ctrlKey || event.metaKey);
    }
  };
  const onClick = (event: MouseEvent): void => {
    const target = event.target;
    if (!(target instanceof window.HTMLElement)) return;
    const row = target.closest<HTMLElement>('[data-index]');
    if (row) { select(Number(row.dataset.index)); focus(); }
  };
  const onDoubleClick = (event: MouseEvent): void => {
    if (event.target instanceof window.HTMLElement && event.target.closest('[data-index]')) accept(false);
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (!isHostMessage(event.data)) {
      error.textContent = 'Invalid response from the picker extension. Close and reopen the picker.';
      error.hidden = false;
      return;
    }
    const message = event.data;
    switch (message.type) {
      case 'init':
        input.value = message.query;
        desiredId = message.selectedId;
        vimNavigation = message.vimNavigation;
        element('workspace').textContent = message.workspace;
        query(); focus(); break;
      case 'focus': focus(); break;
      case 'refresh':
        element('workspace').textContent = message.workspace;
        query(); break;
      case 'loading':
        if (message.requestId !== queryId) return;
        resultState.hidden = false;
        resultState.textContent = 'Loading workspace files...';
        results.setAttribute('aria-busy', 'true');
        count.textContent = 'Loading...';
        break;
      case 'results':
        if (message.requestId !== queryId) return;
        results.setAttribute('aria-busy', 'false');
        items = message.items;
        resultState.hidden = items.length > 0;
        resultState.textContent = input.value.trim() ? 'No matching files.' : 'No workspace files found.';
        count.textContent = `${message.total} results${message.truncated ? ` (showing ${items.length})` : ''}`
          + (message.indexTruncated ? ' · Index limited to 100,000 files' : '');
        render(); break;
      case 'preview':
        if (message.requestId !== previewId || message.id !== items[selected]?.id) return;
        // Only the extension's escaped highlight.js output crosses this boundary.
        previewCode.innerHTML = message.html;
        gutter.textContent = Array.from({ length: message.lines }, (_, i) => String(i + 1)).join('\n');
        previewNote.textContent = message.note;
        break;
      case 'error':
        if (message.scope === 'preview') {
          if (message.requestId !== previewId) return;
          clearPreview(message.message);
        } else {
          if (message.scope === 'files' && message.requestId !== queryId) return;
          if (message.scope === 'files') {
            results.setAttribute('aria-busy', 'false');
            resultState.hidden = false;
            resultState.textContent = 'Files could not be loaded.';
            count.textContent = 'Error';
          }
          error.textContent = message.message;
          error.hidden = false;
        }
    }
  };
  const onToggle = (): void => { showPreview(); };
  const onLayout = (): void => {
    if (previewVisible === undefined) toggle.setAttribute('aria-pressed', String(!narrowLayout.matches));
  };
  input.addEventListener('input', onInput);
  input.addEventListener('compositionstart', onCompositionStart);
  input.addEventListener('compositionend', onCompositionEnd);
  document.addEventListener('keydown', onKey);
  results.addEventListener('click', onClick);
  results.addEventListener('dblclick', onDoubleClick);
  toggle.addEventListener('click', onToggle);
  window.addEventListener('message', onMessage);
  narrowLayout.addEventListener('change', onLayout);
  onLayout();
  focus();
  host.postMessage({ type: 'ready' });
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionstart', onCompositionStart);
    input.removeEventListener('compositionend', onCompositionEnd);
    document.removeEventListener('keydown', onKey);
    results.removeEventListener('click', onClick);
    results.removeEventListener('dblclick', onDoubleClick);
    toggle.removeEventListener('click', onToggle);
    window.removeEventListener('message', onMessage);
    narrowLayout.removeEventListener('change', onLayout);
  };
}
