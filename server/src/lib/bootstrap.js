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

/**
 * Carry administrators across the introduction of offices.
 *
 * Before offices existed an administrator saw everything; afterwards they see
 * only the offices they are appointed to. Left alone, an upgrade would scope
 * every existing administrator to nowhere and quietly empty their screens —
 * which is exactly what happened the first time this shipped. Idempotent: it
 * does nothing once there is a superadmin and no orphaned administrator.
 */
export async function ensureOfficeRoles() {
  // 1. Somebody has to be able to appoint the others.
  const { rows: [{ n: supers }] } = await q(
    `SELECT count(*)::int AS n FROM users WHERE role = 'superadmin' AND is_active`
  );
  if (supers === 0) {
    const { rowCount } = await q(
      `UPDATE users SET role = 'superadmin' WHERE email = $1 AND is_active`,
      [config.seedAdminEmail]
    );
    if (rowCount) {
      console.log(`[bootstrap] promoted ${config.seedAdminEmail} to super administrator`);
    } else {
      // No bootstrap account either: promote the longest-standing administrator
      // rather than leave the instance with nobody who can appoint anyone.
      const { rows } = await q(
        `UPDATE users SET role = 'superadmin'
          WHERE id = (SELECT id FROM users WHERE role = 'admin' AND is_active
                       ORDER BY created_at LIMIT 1)
          RETURNING email`
      );
      if (rows[0]) console.log(`[bootstrap] promoted ${rows[0].email} to super administrator`);
    }
  }

  // 2. An administrator appointed nowhere administers nothing, so give the
  //    ones who predate offices the office their rooms are actually in.
  const { rows: orphans } = await q(
    `SELECT u.id, u.email FROM users u
      WHERE u.role = 'admin' AND u.is_active
        AND NOT EXISTS (SELECT 1 FROM location_admins la WHERE la.user_id = u.id)`
  );
  if (!orphans.length) return false;

  const { rows: [busiest] } = await q(
    `SELECT l.id, l.name FROM locations l
       LEFT JOIN branches br ON br.location_id = l.id
       LEFT JOIN rooms r ON r.branch_id = br.id
      WHERE l.is_active
      GROUP BY l.id, l.name, l.sort_order
      ORDER BY count(r.id) DESC, l.sort_order
      LIMIT 1`
  );
  if (!busiest) return false;

  for (const o of orphans) {
    await q(
      `INSERT INTO location_admins (location_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [busiest.id, o.id]
    );
  }
  console.log(`[bootstrap] appointed ${orphans.length} existing administrator(s) to ${busiest.name}`);
  return true;
}
