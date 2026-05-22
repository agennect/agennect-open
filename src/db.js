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

export function migrate() {
  const sql = readFileSync(
    join(__dirname, '../migrations/001_init.sql'),
    'utf8'
  );
  db.exec(sql);

  const dims = parseInt(process.env.EMBEDDING_DIMS || '1024');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_embeddings
    USING vec0(embedding float[${dims}])
  `);

  console.log('✓ Database migrated');
}

migrate();
