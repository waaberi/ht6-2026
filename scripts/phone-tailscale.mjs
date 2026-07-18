import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import process from 'node:process';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const forwardedArgs = process.argv.slice(2);
const expoArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;

const tailscale = spawnSync('tailscale', ['ip', '-4'], { encoding: 'utf8' });
if (tailscale.error) {
  console.error(`Could not run Tailscale: ${tailscale.error.message}`);
  process.exit(1);
}
if (tailscale.status !== 0) process.exit(tailscale.status ?? 1);

const tailscaleAddress = tailscale.stdout
  .split('\n')
  .map((address) => address.trim())
  .find((address) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address));
if (!tailscaleAddress) {
  console.error('Tailscale is not connected. Open Tailscale, sign in, and try again.');
  process.exit(1);
}

const apiUrl = `http://${tailscaleAddress}:8000`;
console.log(`Tailscale ready at ${tailscaleAddress}.`);
console.log('Teammates must install Tailscale and join the same tailnet.');

const portIsOpen = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: tailscaleAddress, port });
  let settled = false;
  const finish = (open) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(open);
  };
  socket.setTimeout(500);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});

for (const [name, port] of [['Exposure API', 8000], ['Metro', 8081]]) {
  if (await portIsOpen(port)) {
    console.error(`${name} port ${port} is already in use at ${tailscaleAddress}. Stop the existing phone stack with Ctrl+C before starting another.`);
    process.exit(1);
  }
}

const env = {
  ...process.env,
  EXPO_PUBLIC_API_URL: apiUrl,
  REACT_NATIVE_PACKAGER_HOSTNAME: tailscaleAddress,
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
  tailscaleAddress,
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
  console.error(`Exposure API did not become ready at ${apiUrl}.`);
  stopChildren(1);
  await new Promise(() => {});
}
console.log(`API ready at ${apiUrl}`);

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
console.log('This workflow does not change Wi-Fi or hotspot settings.');
