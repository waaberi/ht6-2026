import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hotspotAddress = '10.42.0.1';
const apiUrl = `http://${hotspotAddress}:8000`;
const forwardedArgs = process.argv.slice(2);
const expoArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;

const hotspotIsReady = () => {
  const result = spawnSync('ip', ['-4', '-o', 'address', 'show', 'dev', 'ap0'], {
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout.includes(`${hotspotAddress}/24`);
};

if (!hotspotIsReady()) {
  console.log('Starting the uottawashed hotspot...');
  const result = spawnSync('uottawashed', ['on'], { stdio: 'inherit' });
  if (result.error) {
    console.error(`Could not start uottawashed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Waiting for the hotspot at 10.42.0.1...');
for (let attempt = 0; attempt < 120 && !hotspotIsReady(); attempt += 1) {
  await delay(1000);
}
if (!hotspotIsReady()) {
  console.error('uottawashed did not become ready within 2 minutes.');
  process.exit(1);
}

console.log('Hotspot ready. Teammates can connect to uottawashed.');

const env = {
  ...process.env,
  EXPO_PUBLIC_API_URL: apiUrl,
  REACT_NATIVE_PACKAGER_HOSTNAME: hotspotAddress,
};
const children = [];
let stopping = false;

const signalChildGroup = (child, signal) => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

const stopChildren = (exitCode = 0, signal = 'SIGTERM') => {
  if (stopping) return;
  stopping = true;
  for (const child of children) signalChildGroup(child, signal);
  const forceStop = setTimeout(() => {
    for (const child of children) signalChildGroup(child, 'SIGKILL');
    process.exit(exitCode);
  }, 5000);
  forceStop.unref();
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  }))).then(() => process.exit(exitCode));
};

const watchChild = (child, name) => {
  children.push(child);
  child.on('error', (error) => {
    console.error(`${name} failed to start: ${error.message}`);
    stopChildren(1);
  });
  child.on('exit', (code, signal) => {
    setTimeout(() => {
      if (!stopping) {
        if (code === 0 && !signal) {
          stopChildren(0);
          return;
        }
        console.error(`${name} stopped unexpectedly${signal ? ` (${signal})` : ''}.`);
        stopChildren(code ?? 1);
      }
    }, 100);
  });
};

process.on('SIGINT', () => stopChildren(0, 'SIGINT'));
process.on('SIGTERM', () => stopChildren(0, 'SIGTERM'));

const api = spawn(executable('uv'), [
  '--directory',
  'services/api',
  'run',
  'uvicorn',
  'exposure_api.main:app',
  '--reload',
  '--env-file',
  '.env.local',
  '--host',
  hotspotAddress,
], {
  cwd: workspaceRoot,
  env,
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});
watchChild(api, 'Exposure API');

let apiReady = false;
for (let attempt = 0; attempt < 120 && !apiReady; attempt += 1) {
  if (api.exitCode !== null) break;
  try {
    const response = await fetch(`${apiUrl}/health`);
    apiReady = response.ok;
  } catch {
    // The reload server may still be creating its worker.
  }
  if (!apiReady) await delay(250);
}
if (!apiReady) {
  console.error('Exposure API did not become ready at http://10.42.0.1:8000.');
  stopChildren(1);
  await new Promise(() => {});
}
console.log('API ready at http://10.42.0.1:8000');

const expo = spawn(executable('pnpm'), [
  '--filter',
  'exposure',
  'exec',
  'expo',
  'start',
  '--go',
  '--lan',
  ...expoArgs,
], {
  cwd: workspaceRoot,
  env,
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});
watchChild(expo, 'Expo Go server');

console.log('Scan the Expo Go QR code below. Press Ctrl+C when finished.');
console.log('The hotspot stays on afterward; run `uottawashed off` to restore normal Wi-Fi performance.');
