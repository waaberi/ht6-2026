import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiUrl } from './apiConfiguration';

test('uses the launcher-provided API URL before every persisted configuration', () => {
  assert.equal(
    resolveApiUrl(
      'http://developer-tailnet-host.test:8000',
      'http://configured-host.test:8000',
      'http://saved-host.test:8000',
    ),
    'http://developer-tailnet-host.test:8000',
  );
});

test('uses the configured URL when there is no launcher URL', () => {
  assert.equal(
    resolveApiUrl(undefined, ' http://configured-host.test:8000/ ', 'http://saved-host.test:8000'),
    'http://configured-host.test:8000',
  );
});

test('uses a saved fallback only when the launcher and environment have no URL', () => {
  assert.equal(resolveApiUrl(undefined, undefined, ' http://api.example.test/ '), 'http://api.example.test');
});

test('returns an empty URL when no source is configured', () => {
  assert.equal(resolveApiUrl(undefined, undefined, '  '), '');
});
