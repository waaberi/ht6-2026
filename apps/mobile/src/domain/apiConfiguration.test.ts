import assert from 'node:assert/strict';
import test from 'node:test';

import { apiErrorMessage, resolveApiUrl } from './apiConfiguration';

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

test('API errors expose a concise FastAPI detail instead of raw JSON', () => {
  assert.equal(apiErrorMessage('{"detail":"The image is too large."}', 413), 'The image is too large.');
  assert.equal(apiErrorMessage('Gateway unavailable', 502), 'Gateway unavailable');
  assert.equal(apiErrorMessage('', 500), 'Exposure service returned 500');
});

test('API errors turn Gemini configuration failures into actionable app copy', () => {
  assert.equal(
    apiErrorMessage('{"detail":"GEMINI_API_KEY is required for Nano Banana generative layers"}', 503),
    'AI generation is not configured. Restart the Exposure API after adding its Gemini key.',
  );
  assert.equal(
    apiErrorMessage('{"detail":"The configured Gemini project has no available image-generation quota."}', 503),
    'AI generation is unavailable for this Gemini project. Enable image-generation quota in Google AI Studio, then try again.',
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

test('rejects build placeholders and malformed endpoints', () => {
  assert.equal(resolveApiUrl(undefined, 'https://replace-with-exposure-api.example.com', undefined), '');
  assert.equal(resolveApiUrl(undefined, 'api.internal:8000', undefined), '');
});
