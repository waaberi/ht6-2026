import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const children = [];
let stopping = false;

// Node refuses to spawn a Windows batch shim such as pnpm.cmd directly (it throws
// `spawn EINVAL`), so route those through cmd.exe the way scripts/setup.mjs does.
// Native binaries like uv.exe can still be spawned directly.
const spawnTool = (command, args, options) => {
  if (isWindows && command === 'pnpm') {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args], options);
  }
  return spawn(isWindows ? `${command}.exe` : command, args, options);
};

const stopGroup = (child, signal) => {
  if (!child?.pid) return;
  try {
    // On Windows there are no POSIX process groups; taskkill /t tears down the whole
    // subtree (cmd.exe -> pnpm -> metro, or uv -> uvicorn) so nothing is orphaned.
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
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
  const api = spawnTool('uv', [
    '--directory', 'services/api', 'run', 'uvicorn', 'exposure_api.main:app',
    '--reload', '--env-file', '.env.local', '--host', '127.0.0.1', '--port', '8000',
  ], { detached: !isWindows, stdio: 'inherit' });
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

const mobile = spawnTool('pnpm', ['--filter', 'exposure', 'run', 'dev:android'], {
  detached: !isWindows,
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
