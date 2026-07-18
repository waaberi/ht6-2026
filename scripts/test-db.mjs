import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const supabase = join(
  workspaceRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase',
);

const run = (args) => spawnSync(supabase, args, {
  cwd: workspaceRoot,
  stdio: 'inherit',
});

let status = 0;
try {
  for (const args of [['start'], ['db', 'reset'], ['test', 'db']]) {
    const result = run(args);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      status = result.status ?? 1;
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  status = 1;
} finally {
  const stopResult = run(['stop']);
  if (stopResult.status !== 0 && status === 0) status = stopResult.status ?? 1;
}

process.exit(status);
