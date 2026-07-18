import { copyFileSync, constants, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ensureEnvironmentFile = (example, destination) => {
  const sourcePath = join(workspaceRoot, example);
  const destinationPath = join(workspaceRoot, destination);

  if (existsSync(destinationPath)) {
    console.log(`Keeping existing ${destination}`);
    return;
  }

  copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  console.log(`Created ${destination}`);
};

const run = (command, args) => {
  const usesWindowsCommandShim = process.platform === 'win32' && command === 'pnpm';
  const executable = usesWindowsCommandShim
    ? (process.env.ComSpec ?? 'cmd.exe')
    : (process.platform === 'win32' ? `${command}.exe` : command);
  const commandArgs = usesWindowsCommandShim
    ? ['/d', '/s', '/c', 'pnpm.cmd', ...args]
    : args;
  const result = spawnSync(executable, commandArgs, {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
};

ensureEnvironmentFile('apps/mobile/.env.example', 'apps/mobile/.env.local');
ensureEnvironmentFile('apps/mobile/.env.example', 'apps/mobile/.env.production');
ensureEnvironmentFile('services/api/.env.example', 'services/api/.env.local');
ensureEnvironmentFile('services/api/.env.example', 'services/api/.env.production');
run('pnpm', ['install']);
run('uv', ['--directory', 'services/api', 'sync']);

console.log('\nSetup complete. Start an emulator, run `pnpm android` once, then use `pnpm dev`.');
