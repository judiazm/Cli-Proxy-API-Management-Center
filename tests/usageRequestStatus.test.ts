import { expect, test } from 'bun:test';
import { requestStatusKey } from '@/features/usage/logic/requestStatus';

test('recorded response codes remain distinct without assigning infrastructure blame', () => {
  expect(requestStatusKey({ failed: true, status_code: 429 })).toBe('usage.status_rate_limit');
  expect(requestStatusKey({ failed: true, status_code: 401 })).toBe('usage.status_auth_rejection');
  expect(requestStatusKey({ failed: true, status_code: 403 })).toBe('usage.status_auth_rejection');
  expect(requestStatusKey({ failed: true, status_code: 503 })).toBe('usage.status_http_5xx');
  expect(requestStatusKey({ failed: true, status_code: 400 })).toBe('usage.status_http_4xx');
  expect(requestStatusKey({ failed: true, status_code: 0 })).toBe('usage.status_no_http');
  expect(requestStatusKey({ failed: false, status_code: 200 })).toBe('usage.status_ok');
  expect(requestStatusKey({ failed: true, status_code: 200 })).toBe('usage.status_failed');
});
