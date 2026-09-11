import { Router } from 'express';
import { q } from '../lib/db.js';
import { AppError } from '../lib/rules.js';

export const passRouter = Router();

/**
 * The booking pass. Deliberately unauthenticated and read-only: its whole job
 * is to be shown to whoever is sitting in the room by mistake. The code is
 * unguessable and the payload carries no email address, no purpose and no
 * other booking — just enough to settle the argument.
 */
passRouter.get('/:code', async (req, res, next) => {
  try {
    const code = String(req.params.code).toUpperCase();
    const { rows } = await q(
      `SELECT b.booking_date, b.start_time, b.end_time, b.status, b.title, b.attendees,
              b.pass_code, b.decided_at,
              r.name AS room_name, r.floor, r.location,
              u.name AS holder_name, u.department AS holder_department,
              d.name AS approved_by
         FROM bookings b
         JOIN rooms r ON r.id = b.room_id
         JOIN users u ON u.id = b.booked_for
         LEFT JOIN users d ON d.id = b.decided_by
        WHERE b.pass_code = $1`,
      [code]
    );
    const b = rows[0];
    if (!b) throw new AppError(404, 'NO_PASS', 'No booking matches this pass code.');

    res.json({
      pass: {
        code: b.pass_code,
        status: b.status,
        room: b.room_name,
        floor: b.floor,
        location: b.location,
        date: b.booking_date,
        start: b.start_time.slice(0, 5),
        end: b.end_time.slice(0, 5),
        title: b.title,
        attendees: b.attendees,
        holder: b.holder_name,
        department: b.holder_department,
        approvedBy: b.approved_by,
        approvedAt: b.decided_at
      }
    });
  } catch (e) { next(e); }
});
