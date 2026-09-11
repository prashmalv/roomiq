import { q } from './db.js';
import { hashPassword } from './auth.js';
import { config } from '../config.js';

/**
 * First-run safety net: an empty users table means a fresh deployment, so create
 * the administrator from app settings. Idempotent and a no-op on every later
 * boot, which keeps `az webapp ssh` out of the go-live runbook.
 */
export async function ensureAdmin() {
  const { rows } = await q(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n > 0) return false;
  await q(
    `INSERT INTO users (name, email, password_hash, role, department)
     VALUES ($1,$2,$3,'admin','Admin & Facilities')
     ON CONFLICT (email) DO NOTHING`,
    ['Facilities Admin', config.seedAdminEmail, await hashPassword(config.seedAdminPassword)]
  );
  console.log(`[bootstrap] created first administrator: ${config.seedAdminEmail}`);
  return true;
}
