import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wranglerBin = resolve(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function selectMode(args) {
  const modes = ['--local', '--remote', '--preview'].filter((mode) => args.includes(mode));
  if (modes.length !== 1) {
    throw new Error('Choose exactly one target: --local, --remote, or --preview');
  }
  return modes[0];
}

function executeSql({ database, config, mode }, sql) {
  const result = spawnSync(
    process.execPath,
    [
      wranglerBin,
      'd1',
      'execute',
      database,
      mode,
      '--config',
      config,
      '--json',
      '--command',
      sql,
    ],
    { cwd: workerDir, encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Wrangler exited with ${result.status}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Wrangler did not return JSON: ${result.stdout.trim()}`);
  }
}

function resultRows(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

function main() {
  const args = process.argv.slice(2);
  if (!existsSync(wranglerBin)) {
    throw new Error('Wrangler is not installed. Run npm ci in worker/ first.');
  }

  const target = {
    database: readOption(args, '--database', 'sounddrop-db'),
    config: readOption(args, '--config', 'wrangler.jsonc'),
    mode: selectMode(args),
  };
  const columns = resultRows(executeSql(target, 'PRAGMA table_info(download_jobs)'));
  if (columns.length === 0) {
    throw new Error('download_jobs does not exist; apply the base schema before running this repair');
  }

  let chatId = 'present';
  if (!columns.some((column) => column?.name === 'chat_id')) {
    try {
      executeSql(target, 'ALTER TABLE download_jobs ADD COLUMN chat_id INTEGER');
      chatId = 'added';
    } catch (error) {
      // A concurrent repair can win after the PRAGMA check. Only that exact
      // duplicate-column result is safe to treat as already repaired.
      if (!/duplicate column name:\s*chat_id/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
  }
  executeSql(target, 'CREATE INDEX IF NOT EXISTS idx_jobs_chat ON download_jobs(chat_id)');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: target.mode.slice(2),
    database: target.database,
    chat_id: chatId,
    index: 'ensured',
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Telegram schema repair failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
