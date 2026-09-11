import pg from 'pg';
import { config } from '../config.js';

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Date objects — the app
// deals in office wall-clock, never in instants.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool(config.db);

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export const q = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function audit(actorId, action, entity, entityId, detail = {}) {
  try {
    await q(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5)`,
      [actorId, action, entity, entityId, detail]
    );
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}
