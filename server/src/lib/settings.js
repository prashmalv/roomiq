import { q } from './db.js';

let cache = null;
let cachedAt = 0;

export async function getSettings(force = false) {
  if (!force && cache && Date.now() - cachedAt < 30_000) return cache;
  const { rows } = await q(`SELECT * FROM settings WHERE id = true`);
  cache = rows[0];
  cachedAt = Date.now();
  return cache;
}

export async function updateSettings(patch) {
  const allowed = [
    'org_name', 'work_start', 'work_end', 'slot_minutes',
    'employee_window_months', 'admin_window_months',
    'max_booking_minutes', 'allow_weekend',
    'allow_self_registration', 'allowed_email_domains', 'auto_approve_senior',
    'auto_approve_all'
  ];
  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (!keys.length) return getSettings(true);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await q(`UPDATE settings SET ${sets}, updated_at = now() WHERE id = true`,
          keys.map((k) => patch[k]));
  return getSettings(true);
}
