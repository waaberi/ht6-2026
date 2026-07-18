import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiUrl } from './apiConfiguration';

test('uses the launcher-provided API URL by default', () => {
  assert.equal(resolveApiUrl('http://developer-tailnet-host.test:8000', ''), 'http://developer-tailnet-host.test:8000');
});

test('does not let a stale saved URL override launcher configuration', () => {
  assert.equal(
    resolveApiUrl('http://developer-tailnet-host.test:8000', ' http://10.0.2.2:8000 '),
    'http://developer-tailnet-host.test:8000',
  );
});

test('uses a saved override only when the app has no configured URL', () => {
  assert.equal(resolveApiUrl(undefined, ' http://api.example.test/ '), 'http://api.example.test');
});

test('returns an empty URL when neither source is configured', () => {
  assert.equal(resolveApiUrl(undefined, '  '), '');
});
