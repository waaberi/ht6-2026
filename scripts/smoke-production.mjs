import { createHash } from 'node:crypto';
import process from 'node:process';
import { deflateSync } from 'node:zlib';

const apiUrl = process.env.EXPOSURE_PRODUCTION_API_URL?.trim().replace(/\/$/, '');
const accessToken = process.env.EXPOSURE_PRODUCTION_ACCESS_TOKEN?.trim();
const fail = (message) => { throw new Error(`Exposure production smoke failed: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };

if (!apiUrl) fail('set EXPOSURE_PRODUCTION_API_URL.');
if (!accessToken) fail('set EXPOSURE_PRODUCTION_ACCESS_TOKEN to a current Auth0 access token for the Exposure API.');

let parsedUrl;
try {
  parsedUrl = new URL(apiUrl);
} catch {
  fail('EXPOSURE_PRODUCTION_API_URL is not a valid URL.');
}
if (parsedUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsedUrl.hostname)) {
  fail('the production API must use HTTPS.');
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const pngChunk = (type, data) => {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([label, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, label, data, checksum]);
};
const fixture = () => {
  const width = 96;
  const height = 64;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      rows[pixel] = 45 + Math.round(150 * x / width);
      rows[pixel + 1] = 70 + Math.round(100 * y / height);
      rows[pixel + 2] = 115;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};
const analysisForm = () => {
  const image = fixture();
  const form = new FormData();
  form.append('image', new Blob([image], { type: 'image/png' }), 'production-smoke.png');
  form.append('version_id', `production-smoke-${Date.now()}`);
  form.append('checksum', createHash('sha256').update(image).digest('hex'));
  form.append('coaching_json', JSON.stringify({ detail: 'concise', skillLevel: 'enthusiast' }));
  return form;
};

const healthResponse = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
assert(healthResponse.ok, `/health returned ${healthResponse.status}.`);
const health = await healthResponse.json();
assert(health.service === 'Exposure', '/health is not an Exposure API.');
assert(health.authRequired === true, 'authentication is not required.');
assert(health.authConfigured === true, 'Auth0 authentication is not configured.');
assert(health.geminiConfigured === true, 'Gemini is not configured.');
assert(health.database === 'mongodb-atlas', 'MongoDB Atlas is not the configured database.');
assert(health.databaseConnected === true, 'MongoDB Atlas is not connected.');

const unsigned = await fetch(`${apiUrl}/v1/analyze`, {
  method: 'POST',
  body: analysisForm(),
  signal: AbortSignal.timeout(15_000),
});
assert(unsigned.status === 401, `unsigned /v1/analyze returned ${unsigned.status}, expected 401.`);

const signed = await fetch(`${apiUrl}/v1/analyze`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
  body: analysisForm(),
  signal: AbortSignal.timeout(45_000),
});
const signedText = await signed.text();
assert(signed.ok, `signed /v1/analyze returned ${signed.status}: ${signedText.slice(0, 240)}`);
let analysis;
try {
  analysis = JSON.parse(signedText);
} catch {
  fail('signed /v1/analyze returned invalid JSON.');
}
assert(typeof analysis.semanticModel === 'string' && analysis.semanticModel.length > 0, 'Gemini semantic analysis did not complete.');
assert(analysis.deterministicModel === 'exposure-deterministic-2', 'deterministic analysis did not complete.');

console.log(`Exposure production API: auth and semantic analysis ok (${analysis.semanticModel})`);
