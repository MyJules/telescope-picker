import { describe, expect, it } from 'vitest';
import { isHostMessage, parseClientMessage } from '../src/protocol';
import { LatestRequest } from '../src/latest';

describe('message validation', () => {
  it.each([null, [], {}, { type: 'query', query: 'a', requestId: NaN },
    { type: 'select', id: 'a', requestId: -1 }, { type: 'accept', id: 'a', beside: 'yes' },
    { type: 'query', query: 'x'.repeat(1025), requestId: 0 }])('rejects malformed requests: %j', message => {
    expect(parseClientMessage(message)).toBeUndefined();
  });
  it('accepts only valid requests', () => {
    expect(parseClientMessage({ type: 'query', query: 'main', requestId: 1 }))
      .toEqual({ type: 'query', query: 'main', requestId: 1 });
    expect(parseClientMessage({ type: 'accept', id: 'file:///main', beside: true })?.type).toBe('accept');
  });
  it('validates result highlighting bounds and response shape', () => {
    const response = { type: 'results', requestId: 1, total: 1, truncated: false, indexTruncated: false,
      items: [{ id: 'file:///a', path: 'a', root: 'root', matches: [0] }] };
    expect(isHostMessage(response)).toBe(true);
    expect(isHostMessage({ ...response, items: [{ ...response.items[0], matches: [2] }] })).toBe(false);
    expect(isHostMessage({ type: 'preview', requestId: 1, id: 'a', html: '', note: '', lines: -1 })).toBe(false);
  });
});

it('invalidates obsolete and cancelled work', () => {
  const latest = new LatestRequest();
  const first = latest.next();
  const second = latest.next();
  expect(latest.isCurrent(first)).toBe(false);
  expect(latest.isCurrent(second)).toBe(true);
  latest.cancel();
  expect(latest.isCurrent(second)).toBe(false);
});
