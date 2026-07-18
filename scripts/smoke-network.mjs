import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const parseEnv = (path) => Object.fromEntries(readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line && !line.trimStart().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
  }));

const health = async () => {
  try {
    const response = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && body.service === 'Exposure' ? body : null;
  } catch {
    return null;
  }
};

let api;
if (!await health()) {
  api = spawn(executable('uv'), [
    '--directory', 'services/api', 'run', 'uvicorn', 'exposure_api.main:app',
    '--env-file', '.env.local', '--host', '127.0.0.1', '--port', '8000',
  ], { detached: process.platform !== 'win32', stdio: 'ignore' });
  for (let attempt = 0; attempt < 120 && !await health(); attempt += 1) await delay(250);
}

try {
  const apiHealth = await health();
  if (!apiHealth) throw new Error('Exposure API health check failed.');
  if (!apiHealth.geminiConfigured) throw new Error('Exposure API started without GEMINI_API_KEY.');
  console.log('Exposure API: ok');

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

  const gemini = spawnSync(executable('uv'), [
    '--directory', 'services/api', 'run', '--env-file', '.env.local',
    'python', 'scripts/smoke_gemini.py', '--include-image',
  ], { stdio: 'inherit' });
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
