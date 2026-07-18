import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { deflateSync } from 'node:zlib';

const API_URL = 'http://127.0.0.1:8000';
const ANALYSIS_TIMEOUT_MS = 45_000;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const assert = (condition, message) => {
  if (!condition) throw new Error(`Exposure analysis contract failed: ${message}`);
};
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
const createAnalysisFixture = () => {
  const width = 321;
  const height = 241;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      const upper = y < 145;
      rows[pixel] = upper ? 72 + Math.round(y * 0.45) : 43 + Math.round((y - 145) * 0.18);
      rows[pixel + 1] = upper ? 126 + Math.round(y * 0.35) : 78 + Math.round((y - 145) * 0.2);
      rows[pixel + 2] = upper ? 158 + Math.round(y * 0.3) : 57;
      if ((x - 259) ** 2 + (y - 42) ** 2 < 20 ** 2) rows.fill(247, pixel, pixel + 3);
      if (((x - 156) / 27) ** 2 + ((y - 137) / 71) ** 2 < 1) {
        rows[pixel] = 220;
        rows[pixel + 1] = 151;
        rows[pixel + 2] = 119;
      }
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
const parseEnv = (path) => Object.fromEntries(readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
  }));

const health = async () => {
  try {
    const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && body.service === 'Exposure' ? body : null;
  } catch {
    return null;
  }
};

const analyze = async () => {
  const image = createAnalysisFixture();
  const checksum = createHash('sha256').update(image).digest('hex');
  const versionId = `network-smoke-${Date.now()}`;
  const form = new FormData();
  form.append('image', new Blob([image], { type: 'image/png' }), 'exposure-network-smoke.png');
  form.append('version_id', versionId);
  form.append('checksum', checksum);
  form.append('exif_json', JSON.stringify({ ISO: 200, Camera: 'Exposure network smoke' }));
  form.append('coaching_json', JSON.stringify({ detail: 'concise', skillLevel: 'enthusiast', desiredMood: 'natural' }));
  form.append('layer_stack_json', JSON.stringify({
    canvasTransform: { rotationDegrees: 0, perspective: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    layers: [],
  }));
  form.append('asset_ids_json', '[]');

  let response;
  try {
    response = await fetch(`${API_URL}/v1/analyze`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return { mode: 'client-timeout', detail: `no response within ${ANALYSIS_TIMEOUT_MS / 1000}s` };
    }
    throw error;
  }

  const responseText = await response.text();
  if (!response.ok) throw new Error(`Exposure analysis endpoint returned ${response.status}: ${responseText.slice(0, 500)}`);
  let body;
  try {
    body = JSON.parse(responseText);
  } catch {
    throw new Error('Exposure analysis endpoint returned invalid JSON.');
  }

  assert(body.versionId === versionId, 'versionId did not round-trip');
  assert(body.checksum === checksum, 'checksum did not round-trip');
  assert(body.deterministicModel === 'exposure-deterministic-2', 'deterministic signal extraction did not run');
  assert(body.metrics && typeof body.metrics === 'object', 'metrics are missing');
  assert(body.metrics.width === 321 && body.metrics.height === 241, 'uploaded image dimensions were not analyzed');
  assert(body.lighting && typeof body.lighting === 'object', 'lighting analysis is missing');
  assert(Array.isArray(body.signals), 'measured signals must be an array');
  assert(Array.isArray(body.issues), 'issues must be an array');
  assert(Array.isArray(body.cameraRecommendations), 'cameraRecommendations must be an array');
  assert(typeof body.summary === 'string' && body.summary.length > 0, 'summary is missing');

  if (typeof body.semanticModel === 'string' && body.semanticModel.length > 0) {
    return { mode: 'semantic', detail: body.semanticModel, issueCount: body.issues.length };
  }
  return {
    mode: 'deterministic-only',
    detail: 'Gemini semantic analysis was unavailable or exceeded the server timeout',
    issueCount: body.issues.length,
  };
};

let api;
let apiOutput = '';
if (!await health()) {
  api = spawn(executable('uv'), [
    '--directory', 'services/api', 'run', 'uvicorn', 'exposure_api.main:app',
    '--env-file', '.env.local', '--host', '127.0.0.1', '--port', '8000',
  ], { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const rememberApiOutput = (chunk) => {
    apiOutput = `${apiOutput}${chunk}`.slice(-16_000);
  };
  api.stdout?.on('data', rememberApiOutput);
  api.stderr?.on('data', rememberApiOutput);
  for (let attempt = 0; attempt < 120 && !await health(); attempt += 1) await delay(250);
}

try {
  const apiHealth = await health();
  if (!apiHealth) throw new Error('Exposure API health check failed.');
  if (!apiHealth.geminiConfigured) throw new Error('Exposure API started without GEMINI_API_KEY.');
  console.log('Exposure API: ok');

  const analysis = await analyze();
  if (analysis.mode === 'semantic') {
    console.log(`Exposure analysis: semantic ok (${analysis.detail}, ${analysis.issueCount} issues)`);
  } else {
    console.error(`Exposure analysis: degraded (${analysis.mode}; ${analysis.detail})`);
    if (apiOutput.trim()) console.error(apiOutput.trim());
    process.exitCode = 1;
  }

  const mobileEnv = parseEnv('apps/mobile/.env.local');
  const supabaseUrl = mobileEnv.EXPO_PUBLIC_SUPABASE_URL;
  const supabaseKey = mobileEnv.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || /your-project/i.test(supabaseUrl) || !supabaseKey || /your-publishable-key/i.test(supabaseKey)) {
    throw new Error('Supabase mobile configuration is missing or still uses placeholders.');
  }
  const cloudResponse = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/settings`, {
    headers: { apikey: supabaseKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!cloudResponse.ok) throw new Error(`Supabase auth endpoint returned ${cloudResponse.status}.`);
  console.log('Supabase auth: ok');

  const serviceEnv = parseEnv('services/api/.env.local');
  const serviceUrl = serviceEnv.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = serviceEnv.SUPABASE_SERVICE_ROLE_KEY || serviceEnv.SUPABASE_SECRET_KEY;
  if (!serviceUrl || !serviceKey) throw new Error('Supabase service configuration is missing.');
  const serviceHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const schemaChecks = [
    ['photos', 'id'],
    ['profiles', 'id,camera_preferences,recommendation_feedback'],
    ['photo_versions', 'id,adjustments'],
    ['analyses', 'id,schema_version,signals'],
  ];
  for (const [table, columns] of schemaChecks) {
    const schemaResponse = await fetch(`${serviceUrl}/rest/v1/${table}?select=${columns}&limit=1`, {
      headers: serviceHeaders,
      signal: AbortSignal.timeout(10000),
    });
    if (!schemaResponse.ok) {
      throw new Error(`Supabase Exposure schema is missing ${table} (${schemaResponse.status}). Apply the linked migrations.`);
    }
  }
  console.log('Supabase schema: ok');

  const bucketResponse = await fetch(`${serviceUrl}/storage/v1/bucket`, {
    headers: serviceHeaders,
    signal: AbortSignal.timeout(10000),
  });
  if (!bucketResponse.ok) throw new Error(`Supabase Storage endpoint returned ${bucketResponse.status}.`);
  const bucketIds = new Set((await bucketResponse.json()).map((bucket) => bucket.id));
  const missingBuckets = ['originals', 'derived', 'layer-assets'].filter((id) => !bucketIds.has(id));
  if (missingBuckets.length) throw new Error(`Supabase Storage is missing: ${missingBuckets.join(', ')}.`);
  console.log('Supabase storage: ok');

  const geminiArguments = [
    '--directory', 'services/api', 'run', '--env-file', '.env.local',
    'python', 'scripts/smoke_gemini.py', '--include-image',
  ];
  if (analysis.mode === 'semantic') geminiArguments.push('--skip-semantic');
  const gemini = spawnSync(executable('uv'), geminiArguments, { stdio: 'inherit' });
  if (gemini.status !== 0) process.exitCode = gemini.status ?? 1;
} finally {
  if (api?.pid) {
    try {
      if (process.platform === 'win32') api.kill('SIGTERM');
      else process.kill(-api.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
