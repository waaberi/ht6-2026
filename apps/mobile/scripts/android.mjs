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
let adbWasRestarted = false;

const adbSync = (args, timeout = 15000) => {
  const execute = () => spawnSync(adb, args, { env, encoding: 'utf8', timeout });
  let result = execute();
  if (result.error?.code !== 'ETIMEDOUT') return result;

  console.log(`ADB timed out while running "adb ${args.join(' ')}". Restarting the ADB server...`);
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/im', 'adb.exe', '/f'], { stdio: 'ignore', timeout: 5000 });
  } else {
    spawnSync(adb, ['kill-server'], { env, stdio: 'ignore', timeout: 5000 });
  }
  const restart = spawnSync(adb, ['start-server'], { env, encoding: 'utf8', timeout: 15000 });
  if (restart.status !== 0) return restart;
  adbWasRestarted = true;
  result = execute();
  return result;
};

const ninjaIsModern = (candidate) => {
  if (!candidate || !existsSync(candidate)) return false;
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
  const [major, minor] = (result.stdout ?? '').trim().split('.').map(Number);
  return result.status === 0 && (major > 1 || (major === 1 && minor >= 12));
};

const windowsNinja = () => {
  const bundledNinja = join(sdkRoot, 'cmake', '3.22.1', 'bin', 'ninja.exe');
  if (ninjaIsModern(bundledNinja)) return bundledNinja;

  const result = spawnSync('uv', [
    'run', '--isolated', '--with', 'ninja==1.13.0', 'python', '-c',
    'import shutil; print(shutil.which("ninja") or "")',
  ], { encoding: 'utf8' });
  const candidate = (result.stdout ?? '').trim();

  if (result.error || result.status !== 0 || !ninjaIsModern(candidate)) {
    console.error('A long-path-capable Ninja could not be prepared with uv. Run `pnpm bootstrap` and try again.');
    if (result.error) console.error(result.error.message);
    else if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }

  return candidate;
};

if (process.platform === 'win32' && mode === 'install') {
  env.EXPOSURE_NINJA = windowsNinja().replaceAll('\\', '/');
  console.log(`Android Ninja: ${env.EXPOSURE_NINJA}`);
}

const runAdb = (args, description) => {
  const result = adbSync(args, args[0] === 'install' ? 120000 : 15000);
  if (result.status !== 0) {
    console.error(`${description} failed.`);
    console.error(result.error?.message || result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
};

const listedDevices = () => {
  const result = adbSync(['devices']);
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

const bootStatus = (serial) => adbSync(
  ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
);

const emulatorConsoleIsAvailable = (serial) => {
  const result = adbSync(['-s', serial, 'emu', 'avd', 'name']);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return result.status === 0 && !/could not connect to TCP port/i.test(output);
};

const waitForBoot = async () => {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const devices = onlineDevices().sort((left, right) => (
      Number(right.startsWith('emulator-')) - Number(left.startsWith('emulator-'))
    ));
    for (const serial of devices) {
      if (serial.startsWith('emulator-') && !emulatorConsoleIsAvailable(serial)) continue;
      const result = bootStatus(serial);
      if (result.status === 0 && result.stdout.trim() === '1') {
        env.ANDROID_SERIAL = serial;
        console.log(`Android device: ${serial}`);
        return;
      }
    }
    await delay(1000);
  }

  console.error('Android emulator did not finish booting within 3 minutes.');
  process.exit(1);
};

const ensureAndroidDevice = async () => {
  let devices = listedDevices();
  if (adbWasRestarted && !devices.length) {
    console.log('Waiting for the existing Android emulator to reconnect...');
    for (let attempt = 0; attempt < 20 && !devices.length; attempt += 1) {
      await delay(250);
      devices = listedDevices();
    }
  }
  const deviceIsAvailableOrBooting = devices.some(({ serial, state }) => {
    if (serial.startsWith('emulator-')) return emulatorConsoleIsAvailable(serial);
    return state === 'device' && bootStatus(serial).status === 0;
  });
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

const deviceArchitectures = () => {
  const result = adbSync(['shell', 'getprop', 'ro.product.cpu.abilist']);
  const supported = new Set(['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64']);
  const architectures = (result.stdout ?? '')
    .trim()
    .split(',')
    .map((architecture) => architecture.trim())
    .filter((architecture) => supported.has(architecture));

  if (result.status !== 0 || !architectures.length) {
    console.error('Could not determine the Android device architecture.');
    if (result.stderr) console.error(result.stderr.trim());
    process.exit(result.status ?? 1);
  }

  return [...new Set(architectures)].join(',');
};

const expoCli = join(dirname(require.resolve('expo/package.json')), 'bin', 'cli');
const gradleWrapper = join(projectRoot, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

if (!['install', 'dev'].includes(mode)) {
  console.error('Usage: node scripts/android.mjs <install|dev>');
  process.exit(1);
}

console.log(`Android SDK: ${sdkRoot}`);
console.log(`Android JDK: ${javaHome}`);

await ensureAndroidDevice();

const gradleArgs = [
  'app:assembleDebug',
  '-x', 'lint',
  '-x', 'test',
  '--configure-on-demand',
  '--build-cache',
  '-PreactNativeDevServerPort=8081',
  `-PreactNativeArchitectures=${mode === 'install' ? deviceArchitectures() : ''}`,
];
const gradleCommand = process.platform === 'win32'
  ? {
      executable: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', gradleWrapper, ...gradleArgs],
      cwd: join(projectRoot, 'android'),
    }
  : { executable: gradleWrapper, args: gradleArgs, cwd: join(projectRoot, 'android') };
const commands = {
  install: [
    {
      executable: process.execPath,
      args: [expoCli, 'prebuild', '--platform', 'android', '--no-install'],
    },
    gradleCommand,
  ],
  dev: [{
    executable: process.execPath,
    args: [expoCli, 'start', '--dev-client', '--localhost'],
  }],
};

if (mode === 'dev') {
  runAdb(['shell', 'am', 'force-stop', packageName], 'Stopping the stale development session');
  runAdb(['reverse', 'tcp:8081', 'tcp:8081'], 'Forwarding the Metro port');
}

let activeChild;
let shuttingDown = false;
let shutdownExitCode = 0;

const stopActiveChild = (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownExitCode = exitCode;
  if (!activeChild || activeChild.exitCode !== null) process.exit(exitCode);
  activeChild.kill(signal);
  const forceStop = setTimeout(() => activeChild?.kill('SIGKILL'), 5000);
  forceStop.unref();
};

process.on('SIGINT', () => stopActiveChild('SIGINT'));
process.on('SIGTERM', () => stopActiveChild('SIGTERM'));

const openDevelopmentClient = async () => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (activeChild.exitCode !== null) return;
    try {
      const response = await fetch('http://127.0.0.1:8081/status', { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.text()).includes('packager-status:running')) {
        const manifestUrl = 'http://localhost:8081';
        const developmentUrl = `exposure://expo-development-client/?url=${encodeURIComponent(manifestUrl)}`;
        const result = adbSync([
          'shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
          '-d', developmentUrl, `${packageName}/.MainActivity`,
        ]);
        if (result.status !== 0) {
          throw new Error((result.stderr || result.stdout || 'ADB could not open Exposure.').trim());
        }
        console.log('Metro ready. Exposure opened on Android.');
        return;
      }
    } catch (error) {
      if (error.name !== 'TimeoutError' && !error.message.includes('fetch failed')) throw error;
    }
    await delay(250);
  }
  throw new Error('Metro did not become ready on http://127.0.0.1:8081 within 30 seconds.');
};

const run = (index) => {
  if (index >= commands[mode].length) {
    if (mode === 'install') {
      const apk = join(projectRoot, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
      runAdb(['install', '-r', '-d', apk], 'Installing the Android development client');
      runAdb(['shell', 'am', 'force-stop', packageName], 'Stopping the unserved development session');
      console.log(`Installed Android development client: ${apk}`);
    }
    process.exit(0);
  }
  const command = commands[mode][index];
  activeChild = spawn(command.executable, command.args, {
    cwd: command.cwd ?? projectRoot,
    env,
    stdio: 'inherit',
  });
  if (mode === 'dev') {
    openDevelopmentClient().catch((error) => {
      console.error(`Android development client failed to open: ${error.message}`);
      stopActiveChild('SIGTERM', 1);
    });
  }
  activeChild.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(shutdownExitCode);
    if (signal) process.exit(1);
    if (code) process.exit(code);
    run(index + 1);
  });
};

run(0);
