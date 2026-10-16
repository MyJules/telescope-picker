import { expect, it } from 'vitest';
import { LatestRequest } from '../src/latest';

it('invalidates obsolete and cancelled work', () => {
  const latest = new LatestRequest();
  const first = latest.next();
  const second = latest.next();
  expect(latest.isCurrent(first)).toBe(false);
  expect(latest.isCurrent(second)).toBe(true);
  latest.cancel();
  expect(latest.isCurrent(second)).toBe(false);
});
