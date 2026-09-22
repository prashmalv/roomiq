import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { q, audit } from '../lib/db.js';
import { requireAuth, requireAdmin, hashPassword, adminLocationIds, isSuperadmin } from '../lib/auth.js';
import { getSettings, updateSettings } from '../lib/settings.js';
import { AppError, nowLocal } from '../lib/rules.js';
import { queueMail, flushSoon, flushOutbox, verifyDeliveries } from '../lib/mailer.js';
import { BOOKING_VIEW, loadBooking, shape, applyDecision } from './bookings.js';
import { publicUser } from './auth.js';
import { sheet, workbookBuffer, sendWorkbook, readSheet } from '../lib/spreadsheet.js';
import { todayISO } from '../lib/rules.js';

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
    // null means every office (a superadmin); a list narrows to those offices.
    const scope = await adminLocationIds(req.user);
    const only = req.query.location ? String(req.query.location) : null;

    const { rows } = await q(
      `${BOOKING_VIEW}
        WHERE ($1::text[] IS NULL OR b.status = ANY($1))
          AND ($2::date  IS NULL OR b.booking_date >= $2)
          AND ($3::date  IS NULL OR b.booking_date <= $3)
          AND ($4::text  IS NULL OR uf.name ILIKE $4 OR r.name ILIKE $4 OR b.title ILIKE $4)
          AND ($5::boolean IS NULL OR uf.is_senior = $5)
          AND ($6::uuid[] IS NULL OR br.location_id = ANY($6))
          AND ($7::uuid   IS NULL OR br.location_id = $7)
        ORDER BY (b.status = 'pending') DESC,
                 (b.status = 'pending' AND uf.is_senior) DESC,
                 b.booking_date, b.start_time
        LIMIT 500`,
      [status, from, to, search, senior, scope, only]
    );
    res.json({ bookings: rows.map((r) => shape(r, true)) });
  } catch (e) { next(e); }
});

async function decide(req, res, next, decision) {
  try {
    const note = z.object({ note: z.string().trim().max(300).optional() })
      .parse(req.body || {}).note;
    const { booking, promoted } = await applyDecision({
      bookingId: req.params.id, decision, note, actorId: req.user.id
    });
    res.json({
      booking: shape(booking, true),
      ...(promoted ? { reallocatedTo: { name: promoted.for_name, date: promoted.booking_date } } : {})
    });
  } catch (e) { next(e); }
}

adminRouter.post('/bookings/:id/approve', (req, res, next) => decide(req, res, next, 'approved'));
adminRouter.post('/bookings/:id/reject',  (req, res, next) => decide(req, res, next, 'rejected'));

/* =============================================================== rooms ==== */
const roomSchema = z.object({
  name: z.string().trim().min(2).max(60),
  branch_id: z.string().uuid(),
  location: z.string().trim().max(120).optional().nullable(),
  floor: z.string().trim().max(40).optional().nullable(),
  capacity: z.number().int().min(1).max(1000),
  amenities: z.array(z.string().trim().max(40)).max(12).default([]),
  restricted: z.boolean().default(false),
  is_active: z.boolean().default(true)
});

adminRouter.get('/rooms', async (req, res, next) => {
  try {
    const scope = await adminLocationIds(req.user);
    const { rows } = await q(
      `SELECT r.*,
              br.name AS branch_name, br.location_id,
              loc.name AS location_name, loc.city AS location_city,
              COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'email', u.email))
                       FILTER (WHERE u.id IS NOT NULL), '[]') AS allocated
         FROM rooms r
         LEFT JOIN branches br ON br.id = r.branch_id
         LEFT JOIN locations loc ON loc.id = br.location_id
         LEFT JOIN room_access ra ON ra.room_id = r.id
         LEFT JOIN users u ON u.id = ra.user_id
        WHERE ($1::uuid[] IS NULL OR br.location_id = ANY($1))
        GROUP BY r.id, br.name, br.location_id, loc.name, loc.city, loc.sort_order
        ORDER BY loc.sort_order NULLS LAST, loc.name NULLS LAST, br.name NULLS LAST, r.floor NULLS LAST, r.name`
    , [scope]);
    res.json({ rooms: rows, scoped: scope !== null });
  } catch (e) { next(e); }
});

/** The branches an administrator may put a room in. */
adminRouter.get('/branches', async (req, res, next) => {
  try {
    const scope = await adminLocationIds(req.user);
    const { rows } = await q(
      `SELECT br.id, br.name, br.address, loc.id AS location_id, loc.name AS location_name, loc.city
         FROM branches br JOIN locations loc ON loc.id = br.location_id
        WHERE br.is_active AND loc.is_active
          AND ($1::uuid[] IS NULL OR loc.id = ANY($1))
        ORDER BY loc.sort_order, loc.name, br.name`,
      [scope]
    );
    res.json({ branches: rows });
  } catch (e) { next(e); }
});

/** Resolves a branch and refuses it if the caller does not administer its office. */
async function branchInScope(user, branchId) {
  const { rows } = await q(
    `SELECT br.id, br.name, br.location_id, loc.name AS location_name
       FROM branches br JOIN locations loc ON loc.id = br.location_id
      WHERE br.id = $1`, [branchId]
  );
  const br = rows[0];
  if (!br) throw new AppError(404, 'NO_BRANCH', 'That branch does not exist.');
  const scope = await adminLocationIds(user);
  if (scope !== null && !scope.includes(br.location_id))
    throw new AppError(403, 'NOT_YOUR_OFFICE',
      `You do not administer ${br.location_name}, so you cannot put rooms there.`);
  return br;
}

adminRouter.post('/rooms', async (req, res, next) => {
  try {
    const b = roomSchema.parse(req.body);
    await branchInScope(req.user, b.branch_id);
    const { rows } = await q(
      `INSERT INTO rooms (name, location, floor, capacity, amenities, restricted, is_active, branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.name, b.location, b.floor, b.capacity, b.amenities, b.restricted, b.is_active, b.branch_id]
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
    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const role = ['employee', 'admin'].includes(String(req.query.role)) ? String(req.query.role) : null;
    const senior = req.query.senior === undefined ? null : req.query.senior === 'true';
    const active = req.query.active === undefined ? null : req.query.active === 'true';
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    const where = `WHERE ($1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1 OR u.department ILIKE $1)
                     AND ($2::text IS NULL OR u.role = $2)
                     AND ($3::boolean IS NULL OR u.is_senior = $3)
                     AND ($4::boolean IS NULL OR u.is_active = $4)`;
    const args = [search, role, senior, active];

    const { rows } = await q(
      `SELECT u.id, u.name, u.email, u.role, u.department, u.is_active, u.is_senior, u.created_at,
              count(b.id) FILTER (WHERE b.status IN ('pending','approved')
                                    AND b.booking_date >= current_date)::int AS upcoming
         FROM users u LEFT JOIN bookings b ON b.booked_for = u.id
         ${where}
        GROUP BY u.id ORDER BY u.role, u.name
        LIMIT $5`,
      [...args, limit]
    );
    // Total ignores the limit, so the UI can say when a search needs narrowing.
    const { rows: [{ n }] } = await q(`SELECT count(*)::int AS n FROM users u ${where}`, args);

    res.json({ users: rows, total: n, shown: rows.length, limit });
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
      auto_approve_senior: z.boolean().optional(),
      auto_approve_all: z.boolean().optional()
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
      `SELECT id, booking_id, kind, to_email, to_name, subject, status, attempts, last_error, created_at, sent_at,
              verified_at, provider_id
         FROM email_outbox ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ mails: rows });
  } catch (e) { next(e); }
});

/* One message in full, so "what exactly did they get sent?" is answerable
   without going to the database. */
adminRouter.get('/outbox/:id', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT id, booking_id, kind, to_email, to_name, subject, body_text, body_html,
              status, attempts, last_error, provider_id, created_at, sent_at, verified_at
         FROM email_outbox WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'No such message.');
    res.json({ mail: rows[0] });
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
         (SELECT count(*) FROM bookings WHERE status='waitlisted'
                                          AND booking_date >= current_date)::int              AS waitlisted,
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

/* ============================================================== exports === */
/* Facilities asked to be able to keep their own reports, so every register the
   screens show can be pulled as a real spreadsheet with the same filters. */

const HEAD_FILL_HELP = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A3D6E' } };

const STATUS_LABEL = {
  pending: 'Awaiting decision', approved: 'Confirmed', rejected: 'Declined',
  cancelled: 'Cancelled', contested: 'Contested', waitlisted: 'On waiting list'
};

adminRouter.get('/export/bookings.xlsx', async (req, res, next) => {
  try {
    const status = req.query.status ? String(req.query.status).split(',') : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const search = req.query.q ? `%${String(req.query.q).trim()}%` : null;
    const senior = req.query.senior === undefined ? null : req.query.senior === 'true';

    const { rows } = await q(
      `${BOOKING_VIEW}
        WHERE ($1::text[] IS NULL OR b.status = ANY($1))
          AND ($2::date  IS NULL OR b.booking_date >= $2)
          AND ($3::date  IS NULL OR b.booking_date <= $3)
          AND ($4::text  IS NULL OR uf.name ILIKE $4 OR r.name ILIKE $4 OR b.title ILIKE $4)
          AND ($5::boolean IS NULL OR uf.is_senior = $5)
        ORDER BY b.booking_date DESC, b.start_time
        LIMIT 20000`,
      [status, from, to, search, senior]
    );

    const buf = await workbookBuffer((wb) => {
      sheet(wb, 'Bookings', [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Start', key: 'start', width: 8 },
        { header: 'End', key: 'end', width: 8 },
        { header: 'Hours', key: 'hours', width: 8, numFmt: '0.0' },
        { header: 'Room', key: 'room', width: 20 },
        { header: 'Floor', key: 'floor', width: 14 },
        { header: 'Booked for', key: 'who', width: 24 },
        { header: 'Department', key: 'dept', width: 18 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Senior leadership', key: 'senior', width: 17 },
        { header: 'Meeting', key: 'title', width: 30 },
        { header: 'Purpose', key: 'purpose', width: 34 },
        { header: 'Attendees', key: 'attendees', width: 10 },
        { header: 'Status', key: 'status', width: 18 },
        { header: 'Decided by', key: 'decided', width: 22 },
        { header: 'Decided at', key: 'decided_at', width: 20 },
        { header: 'Reason / note', key: 'note', width: 34 },
        { header: 'Requested by', key: 'by', width: 22 },
        { header: 'Requested at', key: 'created', width: 20 },
        { header: 'Pass code', key: 'pass', width: 14 }
      ], rows.map((b) => ({
        date: b.booking_date,
        start: b.start_time.slice(0, 5),
        end: b.end_time.slice(0, 5),
        hours: (Date.parse(`1970-01-01T${b.end_time}Z`) - Date.parse(`1970-01-01T${b.start_time}Z`)) / 3600000,
        room: b.room_name,
        floor: b.floor || b.location || '',
        who: b.for_name,
        dept: b.for_department || '',
        email: b.for_email,
        senior: b.for_is_senior ? 'Yes' : 'No',
        title: b.title,
        purpose: b.purpose || '',
        attendees: b.attendees,
        status: STATUS_LABEL[b.status] || b.status,
        // A system decision has no person against it; say so rather than blank.
        decided: b.auto_approved ? 'System' : b.decided_by_name || '',
        decided_at: b.decided_at ? new Date(b.decided_at).toISOString().slice(0, 16).replace('T', ' ') : '',
        note: b.decision_note || '',
        by: b.by_name,
        created: new Date(b.created_at).toISOString().slice(0, 16).replace('T', ' '),
        pass: b.pass_code
      })));
    });

    await audit(req.user.id, 'export.bookings', 'booking', null, { rows: rows.length, from, to });
    sendWorkbook(res, `uneerooms-bookings-${todayISO()}.xlsx`, buf);
  } catch (e) { next(e); }
});

adminRouter.get('/export/rooms.xlsx', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT r.*,
              (SELECT count(*) FROM bookings b WHERE b.room_id = r.id AND b.status='approved')::int AS confirmed,
              COALESCE(string_agg(u.name, ', ' ORDER BY u.name), '') AS allocated
         FROM rooms r
         LEFT JOIN room_access ra ON ra.room_id = r.id
         LEFT JOIN users u ON u.id = ra.user_id
        GROUP BY r.id ORDER BY r.floor NULLS LAST, r.name`
    );
    const buf = await workbookBuffer((wb) => {
      sheet(wb, 'Rooms', [
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Capacity', key: 'capacity', width: 10 },
        { header: 'Floor', key: 'floor', width: 16 },
        { header: 'Location', key: 'location', width: 26 },
        { header: 'Amenities', key: 'amenities', width: 34 },
        { header: 'Restricted', key: 'restricted', width: 11 },
        { header: 'Allocated to', key: 'allocated', width: 34 },
        { header: 'Active', key: 'active', width: 9 },
        { header: 'Confirmed bookings', key: 'confirmed', width: 18 }
      ], rows.map((r) => ({
        name: r.name, capacity: r.capacity, floor: r.floor || '', location: r.location || '',
        amenities: (r.amenities || []).join(', '),
        restricted: r.restricted ? 'Yes' : 'No',
        allocated: r.allocated, active: r.is_active ? 'Yes' : 'No', confirmed: r.confirmed
      })));
    });
    await audit(req.user.id, 'export.rooms', 'room', null, { rows: rows.length });
    sendWorkbook(res, `uneerooms-rooms-${todayISO()}.xlsx`, buf);
  } catch (e) { next(e); }
});

adminRouter.get('/export/people.xlsx', async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT u.*,
              count(b.id) FILTER (WHERE b.status IN ('pending','approved')
                                    AND b.booking_date >= current_date)::int AS upcoming,
              count(b.id) FILTER (WHERE b.status = 'approved')::int AS confirmed_total
         FROM users u LEFT JOIN bookings b ON b.booked_for = u.id
        GROUP BY u.id ORDER BY u.role, u.name`
    );
    const buf = await workbookBuffer((wb) => {
      sheet(wb, 'People', [
        { header: 'Name', key: 'name', width: 24 },
        { header: 'Email', key: 'email', width: 32 },
        { header: 'Department', key: 'dept', width: 20 },
        { header: 'Role', key: 'role', width: 14 },
        { header: 'Senior leadership', key: 'senior', width: 17 },
        { header: 'Active', key: 'active', width: 9 },
        { header: 'Upcoming bookings', key: 'upcoming', width: 17 },
        { header: 'Confirmed to date', key: 'confirmed', width: 17 },
        { header: 'Joined', key: 'joined', width: 12 }
      ], rows.map((u) => ({
        name: u.name, email: u.email, dept: u.department || '',
        role: u.role === 'admin' ? 'Administrator' : 'Employee',
        senior: u.is_senior ? 'Yes' : 'No', active: u.is_active ? 'Yes' : 'No',
        upcoming: u.upcoming, confirmed: u.confirmed_total,
        joined: new Date(u.created_at).toISOString().slice(0, 10)
      })));
    });
    await audit(req.user.id, 'export.people', 'user', null, { rows: rows.length });
    sendWorkbook(res, `uneerooms-people-${todayISO()}.xlsx`, buf);
  } catch (e) { next(e); }
});

/* ========================================================= bulk rooms ===== */
const ROOM_TEMPLATE_COLUMNS = [
  { header: 'Office', key: 'office', width: 16 },
  { header: 'Branch', key: 'branch', width: 22 },
  { header: 'Name', key: 'name', width: 24 },
  { header: 'Capacity', key: 'capacity', width: 10 },
  { header: 'Floor', key: 'floor', width: 16 },
  { header: 'Location', key: 'location', width: 26 },
  { header: 'Amenities', key: 'amenities', width: 36 },
  { header: 'Restricted', key: 'restricted', width: 11 }
];

adminRouter.get('/rooms/template.xlsx', async (req, res, next) => {
  try {
    const buf = await workbookBuffer((wb) => {
      sheet(wb, 'Rooms', ROOM_TEMPLATE_COLUMNS, [
        { office: 'Noida', branch: 'Q Tower', name: 'Ganga', capacity: 8, floor: '2nd floor',
          location: 'Sector 68', amenities: 'TV screen, Whiteboard', restricted: 'No' },
        { office: 'Bangalore', branch: 'Bhive Workspace', name: 'Cauvery', capacity: 20,
          floor: '3rd floor', location: 'Hosur Road',
          amenities: 'Video conferencing, Whiteboard, Speakerphone', restricted: 'Yes' }
      ]);
      // Instructions travel with the file, because whoever fills it in is not
      // necessarily the person who was shown the screen.
      const help = wb.addWorksheet('How to fill this in');
      help.columns = [{ width: 18 }, { width: 86 }];
      [
        ['Column', 'What to put'],
        ['Office', 'Required. The city office, exactly as it appears in UneeRooms — Noida, Delhi, Bangalore, Kolkata, Bhubaneswar, Vijayawada, Coimbatore, Dubai, Singapore, Keller.'],
        ['Branch', 'Required. The building within that office, e.g. "Q Tower". It must already exist — a super administrator adds branches on the Offices screen.'],
        ['Name', 'Required. The room name staff will recognise. Must be unique — a name that already exists is skipped, never overwritten.'],
        ['Capacity', 'Required. Whole number of seats, 1 to 1000. A request for more attendees than this is refused.'],
        ['Floor', 'Optional, free text, e.g. "2nd floor".'],
        ['Location', 'Optional, free text, e.g. "Head Office — Noida".'],
        ['Amenities', 'Optional. Separate with commas, e.g. "TV screen, Whiteboard". Up to 12.'],
        ['Restricted', 'Yes or No. Yes means only people it is allocated to can book it — allocate them afterwards on the Rooms screen.'],
        ['', ''],
        ['Rows', 'Delete the two example rows before uploading. Blank rows are ignored.'],
        ['Result', 'Nothing is overwritten. After uploading you get a row-by-row report of what was created and what was skipped.']
      ].forEach((r, i) => {
        const row = help.addRow(r);
        if (i === 0) { row.font = { bold: true, color: { argb: 'FFFFFFFF' } }; row.fill = HEAD_FILL_HELP; }
        row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      });
    });
    sendWorkbook(res, 'uneerooms-room-template.xlsx', buf);
  } catch (e) { next(e); }
});

const YES = new Set(['yes', 'y', 'true', '1', 'restricted']);

adminRouter.post('/rooms/import',
  express.raw({ type: () => true, limit: '5mb' }),
  async (req, res, next) => {
    try {
      if (!req.body || !req.body.length)
        throw new AppError(400, 'NO_FILE', 'No file was received. Pick an .xlsx file and try again.');

      let parsed;
      try { parsed = await readSheet(req.body); }
      catch { throw new AppError(400, 'BAD_FILE', 'That file could not be read as a spreadsheet. Use the template.'); }

      if (!parsed.length)
        throw new AppError(400, 'EMPTY', 'The sheet has no rows below the header.');
      if (parsed.length > 500)
        throw new AppError(400, 'TOO_MANY', `That sheet has ${parsed.length} rows. Upload at most 500 at a time.`);

      // Resolve office/branch names once; the sheet refers to them by name
      // because nobody is going to paste uuids into Excel.
      const { rows: branchRows } = await q(
        `SELECT br.id, br.name AS branch, br.location_id, loc.name AS office
           FROM branches br JOIN locations loc ON loc.id = br.location_id
          WHERE br.is_active AND loc.is_active`
      );
      const byName = new Map(
        branchRows.map((b) => [`${b.office}||${b.branch}`.toLowerCase(), b])
      );
      const scope = await adminLocationIds(req.user);

      const created = [], skipped = [];
      for (const r of parsed) {
        const name = (r.name || '').trim();
        const capacity = Number(r.capacity);
        const office = (r.office || '').trim();
        const branchName = (r.branch || '').trim();

        if (!name || name.length < 2) { skipped.push({ row: r.row, name, reason: 'Name is missing or too short.' }); continue; }
        if (name.length > 60) { skipped.push({ row: r.row, name, reason: 'Name is longer than 60 characters.' }); continue; }
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
          skipped.push({ row: r.row, name, reason: `Capacity "${r.capacity || ''}" is not a whole number between 1 and 1000.` });
          continue;
        }
        if (!office || !branchName) {
          skipped.push({ row: r.row, name, reason: 'Office and Branch are both required.' });
          continue;
        }
        const branch = byName.get(`${office}||${branchName}`.toLowerCase());
        if (!branch) {
          skipped.push({ row: r.row, name, reason: `No branch "${branchName}" in office "${office}".` });
          continue;
        }
        if (scope !== null && !scope.includes(branch.location_id)) {
          skipped.push({ row: r.row, name, reason: `You do not administer ${office}.` });
          continue;
        }
        const amenities = (r.amenities || '').split(',').map((a) => a.trim()).filter(Boolean).slice(0, 12);

        try {
          const { rows } = await q(
            `INSERT INTO rooms (name, location, floor, capacity, amenities, restricted, branch_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name`,
            [name, (r.location || '').trim() || null, (r.floor || '').trim() || null,
             capacity, amenities, YES.has(String(r.restricted || '').trim().toLowerCase()), branch.id]
          );
          created.push({ row: r.row, id: rows[0].id, name: rows[0].name });
        } catch (e) {
          if (e.code === '23505') skipped.push({ row: r.row, name, reason: 'A room with that name already exists.' });
          else throw e;
        }
      }

      await audit(req.user.id, 'room.import', 'room', null,
                  { created: created.length, skipped: skipped.length });
      res.json({ read: parsed.length, created, skipped });
    } catch (e) { next(e); }
  });
