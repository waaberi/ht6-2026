import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApiUrl } from './apiConfiguration';

test('uses the launcher-provided API URL by default', () => {
  assert.equal(resolveApiUrl('http://100.117.203.24:8000', ''), 'http://100.117.203.24:8000');
});

test('allows an explicit saved override', () => {
  assert.equal(
    resolveApiUrl('http://100.117.203.24:8000', ' http://api.example.test/ '),
    'http://api.example.test',
  );
});

test('returns an empty URL when neither source is configured', () => {
  assert.equal(resolveApiUrl(undefined, '  '), '');
});
