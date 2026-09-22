import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { q, audit } from '../lib/db.js';
import { checkPassword, hashPassword, issueSession, clearSession, requireAuth } from '../lib/auth.js';
import { AppError, assertCanRegister, bookingWindow } from '../lib/rules.js';
import { getSettings } from '../lib/settings.js';
import { config } from '../config.js';
import { queueMail, flushSoon } from '../lib/mailer.js';

export const authRouter = Router();

const loginLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
// Sign-up is cheap to abuse and rare to use legitimately, so it is far tighter
// than sign-in. Outside production the cap is loosened: the smoke suite creates
// several accounts per run and would otherwise lock itself out after two runs.
const registerLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.env === 'production' ? 10 : 200,
  standardHeaders: true,
  legacyHeaders: false
});

authRouter.post('/login', loginLimit, async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    }).parse(req.body);

    const { rows } = await q(
      `SELECT * FROM users WHERE email = $1`, [body.email.trim().toLowerCase()]
    );
    const user = rows[0];
    // Same message either way — never reveal whether the address exists.
    if (!user || !user.is_active || !(await checkPassword(body.password, user.password_hash)))
      throw new AppError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');

    issueSession(res, user);
    await audit(user.id, 'login', 'user', user.id);
    res.json({ user: publicUser(user) });
  } catch (e) { next(e); }
});

/* Public, so the sign-in screen can offer the right thing before anyone is known. */
authRouter.get('/registration', async (_req, res, next) => {
  try {
    const s = await getSettings();
    res.json({ open: !!s.allow_self_registration, domains: s.allowed_email_domains || [] });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- register --- */
authRouter.post('/register', registerLimit, async (req, res, next) => {
  try {
    const body = z.object({
      name: z.string().trim().min(2, 'Tell us your full name.').max(80),
      email: z.string().email(),
      department: z.string().trim().max(60).optional().nullable(),
      password: z.string().min(8, 'Choose a password of at least 8 characters.').max(200)
    }).parse(req.body);

    const settings = await getSettings();
    const email = body.email.trim().toLowerCase();
    assertCanRegister(email, settings);

    let user;
    try {
      const { rows } = await q(
        `INSERT INTO users (name, email, password_hash, role, department)
         VALUES ($1,$2,$3,'employee',$4)
         RETURNING id, name, email, role, department, is_active, is_senior`,
        [body.name, email, await hashPassword(body.password), body.department || null]
      );
      user = rows[0];
    } catch (e) {
      if (e.code === '23505')
        throw new AppError(409, 'DUPLICATE', 'An account already exists for that email. Try signing in instead.');
      throw e;
    }

    // Signing them straight in is the point of self-service; the domain was the gate.
    issueSession(res, user);
    await audit(user.id, 'user.register', 'user', user.id, { email });
    await queueMail('account_registered', { name: user.name, email: user.email }, { for_email: user.email });
    flushSoon();

    res.status(201).json({ user: publicUser(user) });
  } catch (e) { next(e); }
});

authRouter.post('/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      user: publicUser(req.user),
      window: bookingWindow(req.user.role, settings),
      settings: {
        org_name: settings.org_name,
        work_start: settings.work_start.slice(0, 5),
        work_end: settings.work_end.slice(0, 5),
        slot_minutes: settings.slot_minutes,
        max_booking_minutes: settings.max_booking_minutes,
        allow_weekend: settings.allow_weekend,
        employee_window_months: settings.employee_window_months,
        admin_window_months: settings.admin_window_months,
        auto_approve_senior: settings.auto_approve_senior,
        auto_approve_all: settings.auto_approve_all
      }
    });
  } catch (e) { next(e); }
});

authRouter.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const body = z.object({
      current: z.string().min(1),
      next: z.string().min(8, 'New password must be at least 8 characters.')
    }).parse(req.body);

    const { rows } = await q(`SELECT password_hash FROM users WHERE id = $1`, [req.user.id]);
    if (!(await checkPassword(body.current, rows[0].password_hash)))
      throw new AppError(400, 'BAD_PASSWORD', 'Your current password is incorrect.');

    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`,
            [req.user.id, await hashPassword(body.next)]);
    await audit(req.user.id, 'password.change', 'user', req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, department: u.department,
  isSenior: !!u.is_senior
});
