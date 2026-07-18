import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const mode = process.argv[2];
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

const executable = (root, name) => root && existsSync(join(root, 'bin', name));
const firstDirectory = (candidates, requiredPath) => candidates.find((candidate) => candidate && existsSync(join(candidate, requiredPath)));

const sdkRoot = firstDirectory([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk')
    : undefined,
  join(homedir(), 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
], join('platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));

if (!sdkRoot) {
  console.error('Android SDK not found. Install it with Android Studio or set ANDROID_HOME.');
  process.exit(1);
}

const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
const androidStudioJdks = process.platform === 'win32'
  ? [
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, 'Android', 'Android Studio', 'jbr')
        : undefined,
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr')
        : undefined,
    ]
  : process.platform === 'darwin'
  ? [
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      join(homedir(), 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
    ]
  : [
      join(homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'apps', 'android-studio', 'jbr'),
      join(homedir(), 'android-studio', 'jbr'),
      '/opt/android-studio/jbr',
    ];

const javaCandidates = [process.env.JAVA_HOME, ...androidStudioJdks].filter(Boolean);
const javaHome = javaCandidates.find((candidate) => {
  if (!executable(candidate, javaName)) return false;
  const result = spawnSync(join(candidate, 'bin', javaName), ['-version'], { encoding: 'utf8' });
  const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.match(/version "(\d+)/)?.[1];
  return version === '17' || version === '21';
});

if (!javaHome) {
  console.error('JDK 17 or 21 not found. Install Android Studio and use its bundled JDK.');
  process.exit(1);
}

const env = {
  ...process.env,
  ANDROID_HOME: sdkRoot,
  ANDROID_SDK_ROOT: sdkRoot,
  JAVA_HOME: javaHome,
  PATH: [
    join(javaHome, 'bin'),
    join(sdkRoot, 'platform-tools'),
    join(sdkRoot, 'emulator'),
    process.env.PATH ?? '',
  ].join(delimiter),
};
const adb = join(sdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const emulator = join(sdkRoot, 'emulator', process.platform === 'win32' ? 'emulator.exe' : 'emulator');
const packageName = 'com.ht62026.exposure';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const listedDevices = () => {
  const result = spawnSync(adb, ['devices'], { env, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state]) => ({ serial, state }));
};

const onlineDevices = () => listedDevices()
  .filter(({ state }) => state === 'device')
  .map(({ serial }) => serial);

const waitForBoot = async () => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const devices = onlineDevices();
    const serial = devices.find((candidate) => candidate.startsWith('emulator-')) ?? devices[0];
    if (serial) {
      env.ANDROID_SERIAL = serial;
      const result = spawnSync(adb, ['shell', 'getprop', 'sys.boot_completed'], { env, encoding: 'utf8' });
      if (result.status === 0 && result.stdout.trim() === '1') return;
    }
    await delay(1000);
  }

  console.error('Android emulator did not finish booting within 3 minutes.');
  process.exit(1);
};

const ensureAndroidDevice = async () => {
  const devices = listedDevices();
  const deviceIsAvailableOrBooting = devices.some(({ serial, state }) => (
    serial.startsWith('emulator-') || state === 'device'
  ));
  if (!deviceIsAvailableOrBooting) {
    const result = spawnSync(emulator, ['-list-avds'], { env, encoding: 'utf8' });
    const avds = result.stdout.split('\n').map((name) => name.trim()).filter(Boolean);
    const requestedAvd = process.env.EXPOSURE_ANDROID_AVD;
    const avd = requestedAvd
      ? avds.find((candidate) => candidate === requestedAvd)
      : avds.find((candidate) => candidate === 'Exposure_Pixel_8_API_35') ?? avds[0];

    if (!avd) {
      console.error('No Android emulator is configured. Create one in Android Studio Device Manager.');
      process.exit(1);
    }

    console.log(`Starting Android emulator: ${avd}`);
    const emulatorProcess = spawn(emulator, ['-avd', avd], {
      env,
      detached: true,
      stdio: 'ignore',
    });
    emulatorProcess.unref();
  }

  console.log('Waiting for Android to finish booting...');
  await waitForBoot();
};

const runAdb = (args, description) => {
  const result = spawnSync(adb, args, { env, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${description} failed.`);
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
};

const expoCli = join(dirname(require.resolve('expo/package.json')), 'bin', 'cli');
const commands = {
  install: [
    ['prebuild', '--platform', 'android', '--no-install'],
    ['run:android', '--variant', 'debug', '--no-bundler'],
  ],
  dev: [['start', '--dev-client', '--android', '--localhost']],
};

if (!(mode in commands)) {
  console.error('Usage: node scripts/android.mjs <install|dev>');
  process.exit(1);
}

console.log(`Android SDK: ${sdkRoot}`);
console.log(`Android JDK: ${javaHome}`);

await ensureAndroidDevice();

if (mode === 'dev') {
  runAdb(['shell', 'am', 'force-stop', packageName], 'Stopping the stale development session');
  runAdb(['reverse', 'tcp:8081', 'tcp:8081'], 'Forwarding the Metro port');
}

let activeChild;
let shuttingDown = false;

const stopActiveChild = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!activeChild || activeChild.exitCode !== null) process.exit(0);
  activeChild.kill(signal);
  const forceStop = setTimeout(() => activeChild?.kill('SIGKILL'), 5000);
  forceStop.unref();
};

process.on('SIGINT', () => stopActiveChild('SIGINT'));
process.on('SIGTERM', () => stopActiveChild('SIGTERM'));

const run = (index) => {
  if (index >= commands[mode].length) {
    if (mode === 'install') runAdb(['shell', 'am', 'force-stop', packageName], 'Stopping the unserved development session');
    process.exit(0);
  }
  activeChild = spawn(process.execPath, [expoCli, ...commands[mode][index]], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });
  activeChild.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(0);
    if (signal) process.exit(1);
    if (code) process.exit(code);
    run(index + 1);
  });
};

run(0);
