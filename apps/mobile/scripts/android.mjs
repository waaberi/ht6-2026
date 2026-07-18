import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const mode = process.argv[2];
const projectRoot = new URL('..', import.meta.url).pathname;

const executable = (root, name) => root && existsSync(join(root, 'bin', name));
const firstDirectory = (candidates, requiredPath) => candidates.find((candidate) => candidate && existsSync(join(candidate, requiredPath)));

const sdkRoot = firstDirectory([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  join(homedir(), 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
], join('platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb'));

if (!sdkRoot) {
  console.error('Android SDK not found. Install it with Android Studio or set ANDROID_HOME.');
  process.exit(1);
}

const javaName = process.platform === 'win32' ? 'java.exe' : 'java';
const androidStudioJdks = process.platform === 'darwin'
  ? [
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      join(homedir(), 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
    ]
  : [
      join(homedir(), '.local', 'share', 'JetBrains', 'Toolbox', 'apps', 'android-studio', 'jbr'),
      join(homedir(), 'android-studio', 'jbr'),
      '/opt/android-studio/jbr',
    ];

const javaCandidates = [...androidStudioJdks, process.env.JAVA_HOME].filter(Boolean);
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
const packageName = 'com.ht62026.exposure';

const runAdb = (args, description) => {
  const result = spawnSync(adb, args, { env, encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`${description} failed.`);
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
};

const expoCli = join(projectRoot, 'node_modules', 'expo', 'bin', 'cli');
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

if (mode === 'dev') {
  runAdb(['shell', 'am', 'force-stop', packageName], 'Stopping the stale development session');
  runAdb(['reverse', 'tcp:8081', 'tcp:8081'], 'Forwarding the Metro port');
}

let activeChild;
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
    if (signal) process.exit(1);
    if (code) process.exit(code);
    run(index + 1);
  });
};

run(0);
