import { q } from './db.js';
import { hashPassword } from './auth.js';
import { config } from '../config.js';

/**
 * First-run safety net: an empty users table means a fresh deployment, so create
 * the super administrator from app settings. Idempotent and a no-op on every
 * later boot, which keeps `az webapp ssh` out of the go-live runbook.
 *
 * Superadmin rather than admin: an ordinary administrator is scoped to the
 * offices they are appointed to, and the very first account has nobody to
 * appoint it, so it would be able to see nothing at all.
 */
export async function ensureAdmin() {
  const { rows } = await q(`SELECT count(*)::int AS n FROM users`);
  if (rows[0].n > 0) return false;
  await q(
    `INSERT INTO users (name, email, password_hash, role, department)
     VALUES ($1,$2,$3,'superadmin','Admin & Facilities')
     ON CONFLICT (email) DO NOTHING`,
    ['Facilities Admin', config.seedAdminEmail, await hashPassword(config.seedAdminPassword)]
  );
  console.log(`[bootstrap] created super administrator: ${config.seedAdminEmail}`);
  return true;
}
