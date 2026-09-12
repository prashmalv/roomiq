import { Router } from 'express';
import { z } from 'zod';
import { q, audit } from '../lib/db.js';
import { requireAuth, requireAdmin, hashPassword } from '../lib/auth.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { AppError, nowLocal } from '../lib/rules.js';
import { queueMail, flushSoon, flushOutbox, verifyDeliveries } from '../lib/mailer.js';
import { BOOKING_VIEW, loadBooking, shape } from './bookings.js';
import { publicUser } from './auth.js';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

/* =========================================================== approvals ==== */
adminRouter.get('/bookings', async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).split(',') : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    // ?senior=true is the dedicated leadership queue; absent means everyone.
    const senior = req.query.senior === undefined ? null : req.query.senior === 'true';

    const { rows } = await q(
      `${BOOKING_VIEW}
        WHERE ($1::text[] IS NULL OR b.status = ANY($1))
          AND ($2::date  IS NULL OR b.booking_date >= $2)
          AND ($3::date  IS NULL OR b.booking_date <= $3)
          AND ($4::text  IS NULL OR uf.name ILIKE $4 OR r.name ILIKE $4 OR b.title ILIKE $4)
          AND ($5::boolean IS NULL OR uf.is_senior = $5)
        ORDER BY (b.status = 'pending') DESC,
                 (b.status = 'pending' AND uf.is_senior) DESC,
                 b.booking_date, b.start_time
        LIMIT 500`,
      [status, from, to, search, senior]
    );
    res.json({ bookings: rows.map((r) => shape(r, true)) });
  } catch (e) { next(e); }
});

async function decide(req, res, next, decision) {
  try {
    const note = z.object({ note: z.string().trim().max(300).optional() })
      .parse(req.body || {}).note;
    const b = await loadBooking(req.params.id);
    if (!b) throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
    if (!['pending', 'contested'].includes(b.status))
      throw new AppError(400, 'NOT_PENDING', `This request is already ${b.status}.`);
    if (decision === 'rejected' && !note)
      throw new AppError(400, 'NOTE_REQUIRED', 'Please give a reason so the requester knows why.');

    try {
      await q(
        `UPDATE bookings SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4 WHERE id=$1`,
        [b.id, decision, req.user.id, note || null]
      );
    } catch (e) {
      if (e.code !== '23P01') throw e;
      // Approving a contested request cannot evict the holder silently: the
      // admin has to settle the request that is actually holding the slot.
      if (b.status === 'contested')
        throw new AppError(409, 'STILL_HELD',
          'This slot is still held by the request that was filed first. Decline or cancel that one, then approve this.');
      throw new AppError(409, 'SLOT_TAKEN', 'Another confirmed booking now overlaps this slot.');
    }

    const after = await loadBooking(b.id);
    await audit(req.user.id, `booking.${decision}`, 'booking', b.id,
                { note: note || null, from: b.status });
    await queueMail(decision === 'approved' ? 'booking_approved' : 'booking_rejected',
                    { name: after.for_name, email: after.for_email }, after, after.id);

    /* Confirming the request that held the slot settles the argument: any
       contested request waiting on the same slot can never be met, so it is
       closed here rather than left to rot in the queue. */
    if (decision === 'approved' && b.status === 'pending') {
      const { rows: losers } = await q(
        `UPDATE bookings SET status='rejected', decided_by=$1, decided_at=now(),
                decision_note=$2
          WHERE status='contested' AND room_id=$3 AND slot && $4
          RETURNING id`,
        [req.user.id,
         'The slot was confirmed for the request that was filed first.',
         b.room_id, b.slot]
      );
      for (const l of losers) {
        const lost = await loadBooking(l.id);
        await audit(req.user.id, 'booking.contest_closed', 'booking', l.id, { winner: b.id });
        await queueMail('booking_rejected', { name: lost.for_name, email: lost.for_email }, lost, lost.id);
      }
    }

    flushSoon();
    res.json({ booking: shape(after, true) });
  } catch (e) { next(e); }
}

adminRouter.post('/bookings/:id/approve', (req, res, next) => decide(req, res, next, 'approved'));
adminRouter.post('/bookings/:id/reject',  (req, res, next) => decide(req, res, next, 'rejected'));

/* =============================================================== rooms ==== */
const roomSchema = z.object({
  name: z.string().trim().min(2).max(60),
  location: z.string().trim().max(120).optional().nullable(),
  floor: z.string().trim().max(40).optional().nullable(),
  capacity: z.number().int().min(1).max(1000),
  amenities: z.array(z.string().trim().max(40)).max(12).default([]),
  restricted: z.boolean().default(false),
  is_active: z.boolean().default(true)
});

adminRouter.get('/rooms', async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT r.*,
              COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
                       FILTER (WHERE u.id IS NOT NULL), '[]') AS allocated
         FROM rooms r
         LEFT JOIN room_access ra ON ra.room_id = r.id
         LEFT JOIN users u ON u.id = ra.user_id
        GROUP BY r.id ORDER BY r.floor NULLS LAST, r.name`
    );
    res.json({ rooms: rows });
  } catch (e) { next(e); }
});

adminRouter.post('/rooms', async (req, res, next) => {
  try {
    const b = roomSchema.parse(req.body);
    const { rows } = await q(
      `INSERT INTO rooms (name, location, floor, capacity, amenities, restricted, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.location, b.floor, b.capacity, b.amenities, b.restricted, b.is_active]
    );
    await audit(req.user.id, 'room.create', 'room', rows[0].id, { name: b.name });
    res.status(201).json({ room: rows[0] });
  } catch (e) {
    if (e.code === '23505') return next(new AppError(409, 'DUPLICATE', 'A room with that name already exists.'));
    next(e);
  }
});

adminRouter.patch('/rooms/:id', async (req, res, next) => {
  try {
    const b = roomSchema.partial().parse(req.body);
    const keys = Object.keys(b);
    if (!keys.length) throw new AppError(400, 'EMPTY', 'Nothing to update.');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(
      `UPDATE rooms SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...keys.map((k) => b[k])]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Room not found.');
    await audit(req.user.id, 'room.update', 'room', req.params.id, b);
    res.json({ room: rows[0] });
  } catch (e) { next(e); }
});

/* Allocating a room to a person = granting standing access to a restricted room. */
adminRouter.post('/rooms/:id/access', async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    await q(
      `INSERT INTO room_access (room_id, user_id, granted_by) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [req.params.id, userId, req.user.id]
    );
    await audit(req.user.id, 'room.access.grant', 'room', req.params.id, { userId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

adminRouter.delete('/rooms/:id/access/:userId', async (req, res, next) => {
  try {
    await q(`DELETE FROM room_access WHERE room_id=$1 AND user_id=$2`,
            [req.params.id, req.params.userId]);
    await audit(req.user.id, 'room.access.revoke', 'room', req.params.id, { userId: req.params.userId });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* =============================================================== users ==== */
adminRouter.get('/users', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT u.id, u.name, u.email, u.role, u.department, u.is_active, u.is_senior, u.created_at,
              count(b.id) FILTER (WHERE b.status IN ('pending','approved')
                                    AND b.booking_date >= current_date)::int AS upcoming
         FROM users u LEFT JOIN bookings b ON b.booked_for = u.id
        GROUP BY u.id ORDER BY u.role, u.name`
    );
    res.json({ users: rows });
  } catch (e) { next(e); }
});

adminRouter.post('/users', async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(80),
      email: z.string().email(),
      role: z.enum(['employee', 'admin']).default('employee'),
      department: z.string().trim().max(60).optional().nullable(),
      is_senior: z.boolean().default(false),
      password: z.string().min(8).optional()
    }).parse(req.body);

    const temp = b.password || `Uneecops@${Math.floor(1000 + Math.random() * 9000)}`;
    const { rows } = await q(
      `INSERT INTO users (name, email, password_hash, role, department, is_senior)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, email, role, department, is_active, is_senior`,
      [b.name, b.email.toLowerCase(), await hashPassword(temp), b.role, b.department || null, b.is_senior]
    );
    await audit(req.user.id, 'user.create', 'user', rows[0].id,
                { email: b.email, role: b.role, is_senior: b.is_senior });
    await queueMail('account_created', { name: b.name, email: b.email.toLowerCase() },
                    { for_email: b.email.toLowerCase(), temp_password: temp, role: b.role });
    flushSoon();
    res.status(201).json({ user: rows[0], tempPassword: b.password ? undefined : temp });
  } catch (e) {
    if (e.code === '23505') return next(new AppError(409, 'DUPLICATE', 'That email already has an account.'));
    next(e);
  }
});

adminRouter.patch('/users/:id', async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      role: z.enum(['employee', 'admin']).optional(),
      department: z.string().trim().max(60).nullable().optional(),
      is_active: z.boolean().optional(),
      is_senior: z.boolean().optional(),
      password: z.string().min(8).optional()
    }).parse(req.body);

    if (req.params.id === req.user.id && (b.role === 'employee' || b.is_active === false))
      throw new AppError(400, 'SELF_LOCKOUT', 'You cannot remove your own admin access.');

    const patch = { ...b };
    if (patch.password) { patch.password_hash = await hashPassword(patch.password); delete patch.password; }
    const keys = Object.keys(patch);
    if (!keys.length) throw new AppError(400, 'EMPTY', 'Nothing to update.');

    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(
      `UPDATE users SET ${sets} WHERE id = $1
       RETURNING id, name, email, role, department, is_active, is_senior`,
      [req.params.id, ...keys.map((k) => patch[k])]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    await audit(req.user.id, 'user.update', 'user', req.params.id, { ...b, password: undefined });
    res.json({ user: rows[0] });
  } catch (e) { next(e); }
});

/* ============================================================ settings ==== */
adminRouter.get('/settings', async (_req, res, next) => {
  try { res.json({ settings: await getSettings(true) }); } catch (e) { next(e); }
});

adminRouter.patch('/settings', async (req, res, next) => {
  try {
    const b = z.object({
      org_name: z.string().trim().min(2).max(120).optional(),
      work_start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      work_end: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      slot_minutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(),
      employee_window_months: z.number().int().min(1).max(12).optional(),
      admin_window_months: z.number().int().min(1).max(24).optional(),
      max_booking_minutes: z.number().int().min(30).max(720).optional(),
      allow_weekend: z.boolean().optional(),
      allow_self_registration: z.boolean().optional(),
      allowed_email_domains: z.array(
        z.string().trim().toLowerCase()
         .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a bare domain such as uneecops.in — no @ and no spaces.')
      ).max(10).optional(),
      auto_approve_senior: z.boolean().optional()
    }).parse(req.body);
    const settings = await updateSettings(b);
    await audit(req.user.id, 'settings.update', 'settings', 'singleton', b);
    res.json({ settings });
  } catch (e) { next(e); }
});

/* ========================================================== mail + stats == */
adminRouter.get('/outbox', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT id, kind, to_email, to_name, subject, status, attempts, last_error, created_at, sent_at,
              verified_at, provider_id
         FROM email_outbox ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ mails: rows });
  } catch (e) { next(e); }
});

adminRouter.post('/outbox/flush', async (_req, res, next) => {
  try {
    const flushed = await flushOutbox(100);
    // Ask the provider what actually became of recent messages, so "sent" on
    // this screen means delivered rather than merely handed over.
    const verified = await verifyDeliveries(100);
    res.json({ ...flushed, ...verified });
  } catch (e) { next(e); }
});

adminRouter.get('/stats', async (_req, res, next) => {
  try {
    const today = nowLocal().toISODate();
    const { rows: [s] } = await q(
      `SELECT
         (SELECT count(*) FROM bookings WHERE status='pending')::int                       AS pending,
         (SELECT count(*) FROM bookings b JOIN users u ON u.id = b.booked_for
           WHERE b.status='pending' AND u.is_senior)::int                                  AS pending_senior,
         (SELECT count(*) FROM bookings WHERE status='contested')::int                      AS contested,
         (SELECT count(*) FROM bookings WHERE status='approved' AND booking_date = $1)::int AS today_confirmed,
         (SELECT count(*) FROM bookings WHERE status IN ('pending','approved')
                                          AND booking_date BETWEEN $1 AND ($1::date + 6))::int AS next7,
         (SELECT count(*) FROM rooms WHERE is_active)::int                                  AS rooms,
         (SELECT count(*) FROM users WHERE is_active)::int                                  AS users,
         (SELECT count(*) FROM email_outbox WHERE status='failed')::int                     AS mail_failed,
         (SELECT count(*) FROM email_outbox WHERE status='sent' AND verified_at IS NOT NULL)::int AS mail_delivered`,
      [today]
    );
    const { rows: byRoom } = await q(
      `SELECT r.name,
              COALESCE(sum(EXTRACT(EPOCH FROM (b.end_time - b.start_time))/3600)
                       FILTER (WHERE b.status='approved'), 0)::numeric(10,1) AS hours
         FROM rooms r
         LEFT JOIN bookings b ON b.room_id = r.id
              AND b.booking_date BETWEEN ($1::date - 29) AND $1
        WHERE r.is_active GROUP BY r.name ORDER BY hours DESC`,
      [today]
    );
    res.json({ stats: s, utilisation: byRoom });
  } catch (e) { next(e); }
});

adminRouter.get('/whoami', (req, res) => res.json({ user: publicUser(req.user) }));
