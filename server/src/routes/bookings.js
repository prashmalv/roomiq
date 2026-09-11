import { Router } from 'express';
import { z } from 'zod';
import { q, audit } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { AppError, validateBookingRequest, bookingWindow, nowLocal, repeatDates } from '../lib/rules.js';
import { passCode } from '../lib/passcode.js';
import { queueMail, flushSoon, adminRecipients } from '../lib/mailer.js';

export const bookingsRouter = Router();

export const BOOKING_VIEW = `
  SELECT b.*, r.name AS room_name, r.floor, r.location, r.capacity,
         ctd.n AS contested_n, ctd.people AS contested_people, blk.people AS blocked_people,
         uf.name AS for_name, uf.email AS for_email, uf.department AS for_department,
         uf.is_senior AS for_is_senior,
         ub.name AS by_name, ub.email AS by_email,
         ud.name AS decided_by_name
    FROM bookings b
    JOIN rooms r  ON r.id  = b.room_id
    JOIN users uf ON uf.id = b.booked_for
    JOIN users ub ON ub.id = b.requested_by
    LEFT JOIN users ud ON ud.id = b.decided_by
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n,
             COALESCE(json_agg(json_build_object('id', c.id, 'name', cu.name)), '[]') AS people
        FROM bookings c JOIN users cu ON cu.id = c.booked_for
       WHERE c.status = 'contested' AND c.room_id = b.room_id AND c.slot && b.slot
    ) ctd ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(json_agg(json_build_object('id', k.id, 'name', ku.name, 'status', k.status)), '[]') AS people
        FROM bookings k JOIN users ku ON ku.id = k.booked_for
       WHERE b.status = 'contested' AND k.status IN ('pending','approved')
         AND k.room_id = b.room_id AND k.slot && b.slot
    ) blk ON true`;

export async function loadBooking(id) {
  const { rows } = await q(`${BOOKING_VIEW} WHERE b.id = $1`, [id]);
  return rows[0] || null;
}

export const shape = (b, asAdmin = false) => ({
  id: b.id,
  room: { id: b.room_id, name: b.room_name, floor: b.floor, location: b.location, capacity: b.capacity },
  title: b.title,
  purpose: b.purpose,
  attendees: b.attendees,
  date: b.booking_date,
  start: b.start_time.slice(0, 5),
  end: b.end_time.slice(0, 5),
  status: b.status,
  bookedFor: { id: b.booked_for, name: b.for_name, email: b.for_email,
               department: b.for_department, isSenior: !!b.for_is_senior },
  requestedBy: { id: b.requested_by, name: b.by_name, email: b.by_email },
  decidedBy: b.decided_by_name || null,
  autoApproved: !!b.auto_approved,
  decidedAt: b.decided_at,
  decisionNote: b.decision_note,
  passCode: b.pass_code,
  createdAt: b.created_at,
  ...(asAdmin ? {
    contestedBy: b.contested_people || [],
    blockedBy: b.blocked_people || []
  } : {})
});

const createSchema = z.object({
  roomId: z.string().uuid(),
  title: z.string().trim().min(3).max(120),
  purpose: z.string().trim().max(500).optional().nullable(),
  attendees: z.number().int().min(1).max(500).default(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  bookedFor: z.string().uuid().optional(),  // admin only
  repeat: z.enum(['none', 'daily', 'alternate']).default('none')
});

/** The pending or approved booking standing in the way of this slot, if any. */
async function blockingBooking(roomId, date, start, end) {
  const { rows } = await q(
    `SELECT b.id, b.status, u.name AS for_name, u.is_senior
       FROM bookings b JOIN users u ON u.id = b.booked_for
      WHERE b.room_id = $1 AND b.status IN ('pending','approved')
        AND b.slot && tsrange($2::date + $3::time, $2::date + $4::time, '[)')
      LIMIT 1`,
    [roomId, date, start, end]
  );
  return rows[0] || null;
}

/* ------------------------------------------------------------- create ----- */
bookingsRouter.post('/', requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const body = createSchema.parse(req.body);
    const isAdmin = req.user.role === 'admin';

    if (body.bookedFor && body.bookedFor !== req.user.id && !isAdmin)
      throw new AppError(403, 'ADMIN_ONLY', 'Only an administrator can book on behalf of someone else.');

    const targetId = body.bookedFor || req.user.id;

    const { rows: [target] } = await q(
      `SELECT id, name, email, is_active, is_senior FROM users WHERE id = $1`, [targetId]
    );
    if (!target || !target.is_active) throw new AppError(400, 'NO_USER', 'That employee is not active.');

    const { rows: [room] } = await q(
      `SELECT r.*, (r.restricted = false OR $2 OR ra.user_id IS NOT NULL) AS allowed
         FROM rooms r LEFT JOIN room_access ra ON ra.room_id = r.id AND ra.user_id = $3
        WHERE r.id = $1 AND r.is_active`,
      [body.roomId, isAdmin, targetId]
    );
    if (!room) throw new AppError(404, 'NO_ROOM', 'That room does not exist or is inactive.');
    if (!room.allowed)
      throw new AppError(403, 'ROOM_RESTRICTED', `${room.name} is a restricted room. Ask an admin to allocate it to you.`);
    if (body.attendees > room.capacity)
      throw new AppError(400, 'OVER_CAPACITY', `${room.name} seats ${room.capacity}. Pick a larger room.`);

    validateBookingRequest({
      role: req.user.role,
      booking_date: body.date,
      start_time: body.start,
      end_time: body.end,
      settings
    });

    /* Admin bookings are confirmed on the spot.  Senior leadership requests are
       confirmed too when the policy is on — and "was the room free?" needs no
       separate check: the exclusion constraint only lets the insert succeed if
       the slot was actually clear, so a successful write *is* the proof. */
    const isSenior = !!target.is_senior;
    const autoApproved = !isAdmin && isSenior && !!settings.auto_approve_senior;
    const status = isAdmin || autoApproved ? 'approved' : 'pending';
    // decided_by stays NULL for a system decision — that is what distinguishes
    // "approved by system" from "approved by an administrator".
    const decider = isAdmin ? req.user.id : null;

    // A repeat runs to the end of the week that holds the first date, no further.
    const dates = repeatDates(body.date, body.repeat, settings);
    const created = [];
    const skipped = [];

    for (const date of dates) {
      try {
        validateBookingRequest({
          role: req.user.role, booking_date: date,
          start_time: body.start, end_time: body.end, settings
        });
      } catch (e) {
        skipped.push({ date, reason: e.message });
        continue;
      }

      const insert = (rowStatus, contested) => q(
        `INSERT INTO bookings (room_id, booked_for, requested_by, title, purpose, attendees,
                               booking_date, start_time, end_time, status, decided_by, decided_at,
                               auto_approved, pass_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [body.roomId, targetId, req.user.id, body.title, body.purpose || null, body.attendees,
         date, body.start, body.end, rowStatus,
         contested ? null : decider,
         !contested && rowStatus === 'approved' ? new Date() : null,
         !contested && autoApproved, passCode()]
      );

      try {
        const { rows } = await insert(status, false);
        created.push(await loadBooking(rows[0].id));
      } catch (e) {
        if (e.code !== '23P01') throw e;

        /* The slot is taken. If a senior is asking and the holder is only a
           *pending* request, record the clash as `contested` instead of losing
           it: it sits outside the exclusion constraint, so it takes nothing from
           the person who asked first, but facilities can now see both and choose.
           A confirmed booking is settled and is never contested. */
        const blocker = await blockingBooking(body.roomId, date, body.start, body.end);
        if (isSenior && !isAdmin && blocker && blocker.status === 'pending') {
          const { rows } = await insert('contested', true);
          created.push(await loadBooking(rows[0].id));
        } else {
          skipped.push({
            date,
            reason: `${room.name} is already held for part of ${body.start}–${body.end} on ${date}.`
          });
        }
      }
    }

    if (!created.length) {
      // One date asked for, one date refused — the single-booking 409 as before.
      throw new AppError(409, 'SLOT_TAKEN',
        skipped[0]?.reason || 'That slot is no longer available. Pick another.');
    }

    for (const b of created) {
      const contested = b.status === 'contested';
      await audit(req.user.id,
                  contested ? 'booking.contest'
                  : b.auto_approved ? 'booking.auto_approve'
                  : b.status === 'approved' ? 'booking.allocate' : 'booking.request',
                  'booking', b.id, { room: room.name, date: b.booking_date, start: body.start });

      if (contested) {
        await queueMail('booking_contested_ack', { name: b.for_name, email: b.for_email }, b, b.id);
        for (const a of await adminRecipients())
          await queueMail('booking_contested', a, b, b.id);
      } else if (b.status === 'pending') {
        for (const a of await adminRecipients())
          await queueMail('booking_requested', a, b, b.id);
      } else if (b.auto_approved) {
        await queueMail('booking_auto_approved', { name: b.for_name, email: b.for_email }, b, b.id);
        // Facilities still hear about it — auto-approved is not the same as invisible.
        for (const a of await adminRecipients())
          await queueMail('booking_auto_approved_notice', a, b, b.id);
      } else if (targetId !== req.user.id) {
        await queueMail('booking_allocated', { name: b.for_name, email: b.for_email }, b, b.id);
      }
    }
    flushSoon();

    res.status(201).json({
      booking: shape(created[0]),
      ...(dates.length > 1
        ? { series: { requested: dates.length, created: created.map((b) => shape(b)), skipped } }
        : {})
    });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- my list --- */
bookingsRouter.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const scope = String(req.query.scope || 'upcoming');
    const today = nowLocal().toISODate();
    const where = scope === 'past'
      ? `AND b.booking_date < $2`
      : scope === 'all' ? `AND $2 = $2` : `AND b.booking_date >= $2`;
    const { rows } = await q(
      `${BOOKING_VIEW} WHERE (b.booked_for = $1 OR b.requested_by = $1) ${where}
        ORDER BY b.booking_date ${scope === 'past' ? 'DESC' : 'ASC'}, b.start_time`,
      [req.user.id, today]
    );
    res.json({ bookings: rows.map(shape) });
  } catch (e) { next(e); }
});

bookingsRouter.get('/window', requireAuth, async (req, res, next) => {
  try { res.json(bookingWindow(req.user.role, await getSettings())); } catch (e) { next(e); }
});

bookingsRouter.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const b = await loadBooking(req.params.id);
    if (!b) throw new AppError(404, 'NOT_FOUND', 'Booking not found.');
    if (req.user.role !== 'admin' && b.booked_for !== req.user.id && b.requested_by !== req.user.id)
      throw new AppError(403, 'FORBIDDEN', 'This booking is not yours.');
    res.json({ booking: shape(b, req.user.role === 'admin') });
  } catch (e) { next(e); }
});

/* -------------------------------------------------------------- cancel ---- */
bookingsRouter.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const note = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body || {}).note;
    const b = await loadBooking(req.params.id);
    if (!b) throw new AppError(404, 'NOT_FOUND', 'Booking not found.');

    const isOwner = b.booked_for === req.user.id || b.requested_by === req.user.id;
    if (req.user.role !== 'admin' && !isOwner)
      throw new AppError(403, 'FORBIDDEN', 'This booking is not yours.');
    if (!['pending', 'approved', 'contested'].includes(b.status))
      throw new AppError(400, 'NOT_CANCELLABLE', `This booking is already ${b.status}.`);

    await q(
      `UPDATE bookings SET status='cancelled', decided_by=$2, decided_at=now(), decision_note=$3
        WHERE id=$1`,
      [b.id, req.user.id, note || null]
    );
    const after = await loadBooking(b.id);
    await audit(req.user.id, 'booking.cancel', 'booking', b.id, { note: note || null });

    await queueMail('booking_cancelled', { name: after.for_name, email: after.for_email }, after, after.id);
    if (req.user.role !== 'admin')
      for (const a of await adminRecipients())
        await queueMail('booking_cancelled', a, after, after.id);
    flushSoon();

    res.json({ booking: shape(after) });
  } catch (e) { next(e); }
});
