import { spawn } from 'node:child_process';
import process from 'node:process';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const executable = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const children = [];
let stopping = false;

const stopGroup = (child, signal) => {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};

const stop = (code = 0, signal = 'SIGTERM') => {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => stopGroup(child, signal));
  const force = setTimeout(() => {
    children.forEach((child) => stopGroup(child, 'SIGKILL'));
    process.exit(code);
  }, 5000);
  force.unref();
  Promise.all(children.map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  }))).then(() => process.exit(code));
};

const apiIsReady = async () => {
  try {
    const response = await fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    return response.ok && body.service === 'Exposure';
  } catch {
    return false;
  }
};

process.on('SIGINT', () => stop(0, 'SIGINT'));
process.on('SIGTERM', () => stop(0, 'SIGTERM'));

if (!await apiIsReady()) {
  const api = spawn(executable('uv'), [
    '--directory', 'services/api', 'run', 'uvicorn', 'exposure_api.main:app',
    '--reload', '--env-file', '.env.local', '--host', '127.0.0.1', '--port', '8000',
  ], { detached: process.platform !== 'win32', stdio: 'inherit' });
  children.push(api);
  api.once('error', (error) => {
    console.error(`Exposure API failed to start: ${error.message}`);
    stop(1);
  });
  for (let attempt = 0; attempt < 120 && !await apiIsReady(); attempt += 1) await delay(250);
  if (!await apiIsReady()) {
    console.error('Exposure API did not become ready on http://127.0.0.1:8000.');
    stop(1);
    await new Promise(() => {});
  }
  console.log('Exposure API ready.');
} else {
  console.log('Using the Exposure API already running on port 8000.');
}

const mobile = spawn(executable('pnpm'), ['--filter', 'exposure', 'run', 'dev:android'], {
  detached: process.platform !== 'win32',
  stdio: 'inherit',
});
children.push(mobile);
mobile.once('error', (error) => {
  console.error(`Android development server failed to start: ${error.message}`);
  stop(1);
});
mobile.once('exit', (code, signal) => {
  if (!stopping) stop(signal ? 1 : code ?? 0);
});
