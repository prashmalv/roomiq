import { DateTime } from 'luxon';
import { config } from '../config.js';

export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

export const nowLocal = () => DateTime.now().setZone(config.timezone);
export const todayISO = () => nowLocal().toISODate();

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};
export const minToHHMM = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
export const timeToMin = toMin;

/**
 * The booking horizon.
 *
 *  employee — the current calendar month plus the next one.  In September you
 *             may book September and October; November is closed.  The window
 *             rolls forward on the 1st automatically, it is not "60 days".
 *  admin    — any day up to `admin_window_months` ahead (default one year).
 */
export function bookingWindow(role, settings, from = nowLocal()) {
  const minDate = from.toISODate();
  const maxDate =
    role === 'admin'
      ? from.plus({ months: settings.admin_window_months }).toISODate()
      : from.plus({ months: settings.employee_window_months - 1 }).endOf('month').toISODate();
  return { minDate, maxDate, role };
}

/** Slot grid for one day, e.g. 08:00 → 20:00 every 30 minutes. */
export function daySlots(settings) {
  const start = toMin(settings.work_start);
  const end = toMin(settings.work_end);
  const step = settings.slot_minutes;
  const out = [];
  for (let m = start; m + step <= end; m += step) out.push({ start: m, end: m + step });
  return out;
}

/**
 * Every rule a booking must satisfy before it reaches the database.  The
 * database still owns overlap; this owns policy.
 */
export function validateBookingRequest({ role, booking_date, start_time, end_time, settings }) {
  const w = bookingWindow(role, settings);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(booking_date))
    throw new AppError(400, 'BAD_DATE', 'Booking date must be YYYY-MM-DD.');

  if (booking_date < w.minDate)
    throw new AppError(400, 'PAST_DATE', 'You cannot book a date in the past.');

  if (booking_date > w.maxDate) {
    throw new AppError(
      403,
      'OUTSIDE_WINDOW',
      role === 'admin'
        ? `Admins can book up to ${w.maxDate}.`
        : `Employees can only book up to ${w.maxDate} (this month and next). Ask an admin for a later date.`,
      { maxDate: w.maxDate }
    );
  }

  const s = toMin(start_time);
  const e = toMin(end_time);
  const ws = toMin(settings.work_start);
  const we = toMin(settings.work_end);

  if (Number.isNaN(s) || Number.isNaN(e))
    throw new AppError(400, 'BAD_TIME', 'Start and end time must be HH:MM.');
  if (e <= s) throw new AppError(400, 'BAD_RANGE', 'End time must be after start time.');
  if (s % settings.slot_minutes !== 0 || e % settings.slot_minutes !== 0)
    throw new AppError(400, 'BAD_GRID', `Times must align to ${settings.slot_minutes}-minute slots.`);
  if (s < ws || e > we)
    throw new AppError(
      400,
      'OUTSIDE_HOURS',
      `Rooms are bookable between ${settings.work_start.slice(0, 5)} and ${settings.work_end.slice(0, 5)}.`
    );
  if (e - s > settings.max_booking_minutes)
    throw new AppError(
      400,
      'TOO_LONG',
      `A single booking cannot exceed ${settings.max_booking_minutes / 60} hours.`
    );

  const dt = DateTime.fromISO(booking_date, { zone: config.timezone });
  if (!settings.allow_weekend && dt.weekday === 7)
    throw new AppError(400, 'WEEKEND', 'Sunday bookings are disabled. An admin can enable them in settings.');

  if (booking_date === w.minDate && e <= nowLocal().hour * 60 + nowLocal().minute)
    throw new AppError(400, 'PAST_TIME', 'That slot has already passed today.');

  return true;
}

/** Merge booked ranges into the free intervals left in a working day. */
export function freeIntervals(settings, busy, { minStartMin = null } = {}) {
  const ws = toMin(settings.work_start);
  const we = toMin(settings.work_end);
  const ranges = busy
    .map((b) => ({ s: toMin(b.start_time), e: toMin(b.end_time) }))
    .sort((a, b) => a.s - b.s);

  const free = [];
  let cursor = minStartMin != null ? Math.max(ws, minStartMin) : ws;
  for (const r of ranges) {
    if (r.s > cursor) free.push({ start: cursor, end: Math.min(r.s, we) });
    cursor = Math.max(cursor, r.e);
  }
  if (cursor < we) free.push({ start: cursor, end: we });
  return free.filter((f) => f.end - f.start >= settings.slot_minutes);
}

/** Round a minute-of-day up to the next slot boundary. */
export const ceilToSlot = (m, step) => Math.ceil(m / step) * step;

/**
 * Self-registration policy.
 *
 * The domain allow-list is the whole gate: anyone holding a working Uneecops
 * mailbox is by definition staff, so there is nothing further to verify and no
 * approval queue to staff.  Both the switch and the list live in `settings`,
 * so closing sign-up or adding a domain is a settings change, not a release.
 */
export function assertCanRegister(email, settings) {
  if (!settings.allow_self_registration)
    throw new AppError(403, 'REGISTRATION_CLOSED',
      'Self sign-up is turned off. Ask facilities to create your account.');

  const domains = (settings.allowed_email_domains || []).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!domains.length)
    throw new AppError(403, 'REGISTRATION_CLOSED',
      'No work email domain is approved for sign-up yet. Ask facilities to create your account.');

  const at = String(email).lastIndexOf('@');
  const domain = at === -1 ? '' : String(email).slice(at + 1).toLowerCase();
  if (!domains.includes(domain))
    throw new AppError(400, 'BAD_DOMAIN',
      `Use your work email address. Only ${domains.map((d) => `@${d}`).join(' and ')} can sign up here.`,
      { domains });

  return domain;
}

export const REPEAT_MODES = ['none', 'daily', 'alternate'];

/**
 * Recurring bookings, capped at the calendar week holding the first date.
 *
 * The cap is the point, not a limitation: a standing weekly booking made months
 * out would sit on slots nobody can plan around, so a repeat runs from the date
 * chosen to the Sunday of that same week and no further.  `alternate` steps two
 * days at a time from the first date. Sundays drop out unless `allow_weekend`.
 */
export function repeatDates(firstISO, mode, settings) {
  if (!mode || mode === 'none') return [firstISO];
  if (!REPEAT_MODES.includes(mode))
    throw new AppError(400, 'BAD_REPEAT', 'Repeat must be none, daily or alternate.');

  const start = DateTime.fromISO(firstISO, { zone: config.timezone });
  if (!start.isValid) throw new AppError(400, 'BAD_DATE', 'Booking date must be YYYY-MM-DD.');

  const step = mode === 'alternate' ? 2 : 1;
  const weekEnd = start.endOf('week');        // Luxon weeks run Monday → Sunday
  const out = [];
  for (let d = start; d <= weekEnd; d = d.plus({ days: step })) {
    if (!settings.allow_weekend && d.weekday === 7) continue;
    out.push(d.toISODate());
  }
  return out;
}
