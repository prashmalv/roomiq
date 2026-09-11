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
      `SELECT id, name, email, role, department, is_active, is_senior FROM users WHERE id = $1`,
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

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin')
    return next(new AppError(403, 'ADMIN_ONLY', 'This action is restricted to administrators.'));
  next();
}
