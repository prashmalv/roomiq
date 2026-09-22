import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { resolveDecisionToken } from '../lib/auth.js';
import { applyDecision, loadBooking, shape } from './bookings.js';
import { AppError } from '../lib/rules.js';

export const decideRouter = Router();

// Unauthenticated and link-bearing, so it is rate limited on its own.
const decideLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

/**
 * Approving from an email, without a session.
 *
 * GET only reads. That is the important part: Outlook, Safe Links and antivirus
 * scanners follow links in mail before a human ever sees them, so a link that
 * decided on GET would approve requests by itself. The decision is a POST that
 * only a button press makes.
 */
decideRouter.get('/:token', decideLimit, async (req, res, next) => {
  try {
    const { admin, bookingId } = await resolveDecisionToken(req.params.token);
    const b = await loadBooking(bookingId);
    if (!b) throw new AppError(404, 'NOT_FOUND', 'That booking no longer exists.');
    res.json({
      booking: shape(b, true),
      admin: { name: admin.name, email: admin.email },
      decidable: ['pending', 'contested', 'waitlisted'].includes(b.status)
    });
  } catch (e) { next(e); }
});

decideRouter.post('/:token', decideLimit, async (req, res, next) => {
  try {
    const body = z.object({
      action: z.enum(['approve', 'reject']),
      note: z.string().trim().max(300).optional()
    }).parse(req.body || {});

    const { admin, bookingId } = await resolveDecisionToken(req.params.token);
    const { booking, promoted } = await applyDecision({
      bookingId,
      decision: body.action === 'approve' ? 'approved' : 'rejected',
      note: body.note,
      actorId: admin.id
    });

    res.json({
      booking: shape(booking, true),
      decidedBy: admin.name,
      ...(promoted ? { reallocatedTo: { name: promoted.for_name, date: promoted.booking_date } } : {})
    });
  } catch (e) { next(e); }
});
