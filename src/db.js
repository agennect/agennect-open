import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || './data/registry.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

try {
  sqliteVec.load(db);
} catch (e) {
  console.error('Failed to load sqlite-vec extension:', e.message);
  throw e;
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function stripSqlLineComments(sql) {
  // Drop everything after `--` on each line. Does NOT understand string
  // literals — fine here because our migrations have no `--` inside strings.
  return sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

function runMigrationFile(path, { tolerateDuplicateColumn = false } = {}) {
  const rawSql = readFileSync(join(__dirname, path), 'utf8');
  if (!tolerateDuplicateColumn) {
    db.exec(rawSql);
    return;
  }
  // SQLite has no `ADD COLUMN IF NOT EXISTS`. Run each statement individually
  // and swallow only the specific "duplicate column" error. Strip line
  // comments first so we don't split on a `;` that lives inside one.
  const statements = stripSqlLineComments(rawSql)
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const stmt of statements) {
    try {
      db.exec(stmt + ';');
    } catch (e) {
      if (/duplicate column/i.test(e.message)) continue;
      console.error(`migration statement failed: ${stmt}`);
      throw e;
    }
  }
}

export function migrate() {
  runMigrationFile('../migrations/001_init.sql');

  const dims = parseInt(process.env.EMBEDDING_DIMS || '1024');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings
    USING vec0(embedding float[${dims}])
  `);

  runMigrationFile('../migrations/002_proxy.sql', { tolerateDuplicateColumn: true });
  runMigrationFile('../migrations/003_auth_audit.sql');
  runMigrationFile('../migrations/004_webhooks.sql');
  runMigrationFile('../migrations/005_users.sql', { tolerateDuplicateColumn: true });
  runMigrationFile('../migrations/006_webhook_pause.sql', { tolerateDuplicateColumn: true });

  console.log('✓ Database migrated (001 + 002 + 003 + 004 + 005 + 006)');
}

migrate();
