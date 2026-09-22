import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { q } from './db.js';
import { AppError } from './rules.js';

export const COOKIE = 'roomiq_session';

export const hashPassword = (plain) => bcrypt.hash(plain, 11);
export const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function issueSession(res, user) {
  const token = jwt.sign(
    { sub: user.id, role: user.role, name: user.name, email: user.email },
    config.jwtSecret,
    { expiresIn: `${config.sessionHours}h` }
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/'
  });
  return token;
}

export const clearSession = (res) => res.clearCookie(COOKIE, { path: '/' });

/** Reads the cookie, then re-reads the user so a deactivated account dies at once. */
export async function requireAuth(req, _res, next) {
  try {
    const raw = req.cookies?.[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!raw) throw new AppError(401, 'NO_SESSION', 'Please sign in.');
    const claims = jwt.verify(raw, config.jwtSecret);
    const { rows } = await q(
      `SELECT id, name, email, role, department, is_active, is_senior, location_id FROM users WHERE id = $1`,
      [claims.sub]
    );
    if (!rows[0] || !rows[0].is_active)
      throw new AppError(401, 'INACTIVE', 'Your account is no longer active.');
    req.user = rows[0];
    next();
  } catch (e) {
    if (e instanceof AppError) return next(e);
    next(new AppError(401, 'BAD_SESSION', 'Session expired. Please sign in again.'));
  }
}

export const isAdmin = (u) => u?.role === 'admin' || u?.role === 'superadmin';
export const isSuperadmin = (u) => u?.role === 'superadmin';

export function requireAdmin(req, _res, next) {
  if (!isAdmin(req.user))
    return next(new AppError(403, 'ADMIN_ONLY', 'This action is restricted to administrators.'));
  next();
}

/** Appointing administrators and changing the offices themselves. */
export function requireSuperadmin(req, _res, next) {
  if (!isSuperadmin(req.user))
    return next(new AppError(403, 'SUPERADMIN_ONLY',
      'Only a super administrator can change offices or appoint their administrators.'));
  next();
}

/**
 * The offices a person administers.
 *
 * `null` means "every office" and is returned for a superadmin — callers treat
 * null as no restriction rather than as an empty list, so a missing scope can
 * never silently narrow to nothing. An ordinary admin appointed to no office
 * gets `[]`, and sees nothing, which is the honest result.
 */
export async function adminLocationIds(user) {
  if (isSuperadmin(user)) return null;
  const { rows } = await q(`SELECT location_id FROM location_admins WHERE user_id = $1`, [user.id]);
  return rows.map((r) => r.location_id);
}

/** Whether this person may decide and manage things in one particular office. */
export async function canAdminister(user, locationId) {
  if (isSuperadmin(user)) return true;
  if (!isAdmin(user) || !locationId) return false;
  const { rows } = await q(
    `SELECT 1 FROM location_admins WHERE user_id = $1 AND location_id = $2`, [user.id, locationId]
  );
  return rows.length > 0;
}

/* ---------------------------------------------------------------------------
   One-click decision links.

   A token stands in for one administrator deciding one booking, so a request
   can be approved straight from the notification email without signing in.
   Deliberately narrow: it names the booking and the admin, carries a distinct
   purpose so it can never be swapped for a session cookie, and expires. Note
   that it is a bearer credential — forwarding the email forwards the power to
   decide, which is why the link only *shows* the request and a human still has
   to press the button.
--------------------------------------------------------------------------- */
const DECIDE_PURPOSE = 'booking-decision';

export const signDecisionToken = (bookingId, adminId) =>
  jwt.sign({ purpose: DECIDE_PURPOSE, bkg: bookingId, sub: adminId },
           config.jwtSecret, { expiresIn: '21d' });

/** Resolves the token to a still-valid administrator, or throws. */
export async function resolveDecisionToken(raw) {
  let claims;
  try { claims = jwt.verify(String(raw || ''), config.jwtSecret); }
  catch { throw new AppError(400, 'BAD_LINK', 'This link is no longer valid. Sign in to decide instead.'); }
  if (claims.purpose !== DECIDE_PURPOSE)
    throw new AppError(400, 'BAD_LINK', 'This link cannot be used to decide a request.');

  const { rows } = await q(
    `SELECT id, name, email, role, is_active FROM users WHERE id = $1`, [claims.sub]
  );
  const admin = rows[0];
  if (!admin || !admin.is_active || admin.role !== 'admin')
    throw new AppError(403, 'NOT_ADMIN', 'That account can no longer approve requests.');

  return { admin, bookingId: claims.bkg };
}
