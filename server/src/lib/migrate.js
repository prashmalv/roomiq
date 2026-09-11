import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = await readFile(join(here, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] schema applied');
}

if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
