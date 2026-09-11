import { Router } from 'express';
import { DateTime } from 'luxon';
import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { config } from '../config.js';
import {
  AppError, bookingWindow, daySlots, freeIntervals,
  minToHHMM, timeToMin, ceilToSlot, nowLocal
} from '../lib/rules.js';
import { visibleRooms } from './rooms.js';

export const availabilityRouter = Router();

const BLOCKING = `('pending','approved')`;

/* What a non-admin is allowed to learn about someone else's booking:
   that the slot is taken, and nothing more. Admins see the holder. */
function project(b, user) {
  const own = b.booked_for === user.id || b.requested_by === user.id;
  const base = {
    id: b.id, start: b.start_time.slice(0, 5), end: b.end_time.slice(0, 5), status: b.status
  };
  if (user.role === 'admin' || own)
    return { ...base, title: b.title, holder: b.for_name, holder_email: b.for_email,
             department: b.for_department, attendees: b.attendees, mine: own,
             pass_code: own || user.role === 'admin' ? b.pass_code : undefined };
  return { ...base, title: null, holder: null, mine: false };
}

async function bookingsBetween(from, to, roomIds = null) {
  const { rows } = await q(
    `SELECT b.*, u.name AS for_name, u.email AS for_email, u.department AS for_department
       FROM bookings b JOIN users u ON u.id = b.booked_for
      WHERE b.status IN ${BLOCKING}
        AND b.booking_date BETWEEN $1 AND $2
        AND ($3::uuid[] IS NULL OR b.room_id = ANY($3))
      ORDER BY b.booking_date, b.start_time`,
    [from, to, roomIds]
  );
  return rows;
}

/* -------------------------------------------------------------- one day ---- */
availabilityRouter.get('/day', requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const date = String(req.query.date || nowLocal().toISODate());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'BAD_DATE', 'date must be YYYY-MM-DD');

    const rooms = await visibleRooms(req.user);
    const all = await bookingsBetween(date, date);
    const grid = daySlots(settings);
    const isToday = date === nowLocal().toISODate();
    const nowMin = isToday ? nowLocal().hour * 60 + nowLocal().minute : -1;

    const out = rooms.map((r) => {
      const mine = all.filter((b) => b.room_id === r.id);
      const busy = mine.map((b) => ({ start_time: b.start_time, end_time: b.end_time }));
      const free = freeIntervals(settings, busy, { minStartMin: isToday ? ceilToSlot(nowMin, settings.slot_minutes) : null });
      const freeMinutes = free.reduce((a, f) => a + (f.end - f.start), 0);
      return {
        room: { id: r.id, name: r.name, floor: r.floor, location: r.location,
                capacity: r.capacity, amenities: r.amenities, restricted: r.restricted,
                can_book: r.can_book },
        bookings: mine.map((b) => project(b, req.user)),
        free: free.map((f) => ({ start: minToHHMM(f.start), end: minToHHMM(f.end) })),
        freeMinutes,
        slots: grid.map((s) => {
          const hit = mine.find((b) => timeToMin(b.start_time) < s.end && timeToMin(b.end_time) > s.start);
          const past = isToday && s.end <= nowMin;
          return {
            start: minToHHMM(s.start),
            end: minToHHMM(s.end),
            state: past ? 'past' : hit ? (hit.status === 'pending' ? 'held' : 'booked') : 'free',
            bookingId: hit?.id || null
          };
        })
      };
    });

    res.json({ date, window: bookingWindow(req.user.role, settings), rooms: out });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------ one month ---- */
availabilityRouter.get('/month', requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const month = String(req.query.month || nowLocal().toFormat('yyyy-MM'));
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError(400, 'BAD_MONTH', 'month must be YYYY-MM');

    const first = DateTime.fromISO(`${month}-01`, { zone: config.timezone });
    const last = first.endOf('month');
    const rooms = (await visibleRooms(req.user)).filter((r) => r.can_book);
    const roomFilter = req.query.roomId ? [String(req.query.roomId)] : null;
    const scope = roomFilter ? rooms.filter((r) => r.id === roomFilter[0]) : rooms;

    const all = await bookingsBetween(first.toISODate(), last.toISODate(), roomFilter);
    const grid = daySlots(settings);
    const w = bookingWindow(req.user.role, settings);
    const today = nowLocal().toISODate();

    const days = [];
    for (let d = first; d <= last; d = d.plus({ days: 1 })) {
      const date = d.toISODate();
      const closed = !settings.allow_weekend && d.weekday === 7;
      const bookable = !closed && date >= w.minDate && date <= w.maxDate;
      const dayBookings = all.filter((b) => b.booking_date === date);

      let freeSlots = 0;
      for (const r of scope) {
        const busy = dayBookings.filter((b) => b.room_id === r.id);
        for (const s of grid)
          if (!busy.some((b) => timeToMin(b.start_time) < s.end && timeToMin(b.end_time) > s.start)) freeSlots++;
      }
      const totalSlots = grid.length * scope.length;
      const ratio = totalSlots ? freeSlots / totalSlots : 0;

      days.push({
        date,
        isToday: date === today,
        weekday: d.weekday,
        closed,
        bookable,
        outsideWindow: date > w.maxDate,
        totalSlots, freeSlots,
        bookings: dayBookings.length,
        pending: dayBookings.filter((b) => b.status === 'pending').length,
        state: closed ? 'closed'
             : !bookable ? 'locked'
             : ratio === 0 ? 'full'
             : ratio < 0.35 ? 'busy'
             : ratio < 0.8 ? 'partial'
             : 'open'
      });
    }

    res.json({ month, window: w, rooms: scope.map((r) => ({ id: r.id, name: r.name })), days });
  } catch (e) { next(e); }
});

/* ---------------------------------------------------------- suggestions ---- */
/**
 * The dashboard's reason for existing: instead of hunting through a calendar,
 * the user is handed the next slots that actually fit their meeting.
 *
 * Ranking: soonest first, then the smallest room that still seats the party
 * (so a two-person catch-up does not consume the 24-seater), then core hours.
 * Results are diversified — at most two per room and four per day — so the list
 * reads as real choice rather than one room repeated eight times.
 */
availabilityRouter.get('/suggestions', requireAuth, async (req, res, next) => {
  try {
    const settings = await getSettings();
    const duration = Math.max(settings.slot_minutes, Number(req.query.duration || 60));
    const attendees = Number(req.query.attendees || 1);
    const limit = Math.min(Number(req.query.limit || 8), 24);
    const roomId = req.query.roomId ? String(req.query.roomId) : null;

    if (duration > settings.max_booking_minutes)
      throw new AppError(400, 'TOO_LONG', `Maximum booking length is ${settings.max_booking_minutes} minutes.`);

    const w = bookingWindow(req.user.role, settings);
    const rooms = (await visibleRooms(req.user))
      .filter((r) => r.can_book && r.capacity >= attendees && (!roomId || r.id === roomId));
    if (!rooms.length)
      return res.json({ suggestions: [], note: `No bookable room seats ${attendees}.` });

    const start = DateTime.max(nowLocal(), DateTime.fromISO(w.minDate, { zone: config.timezone }));
    const horizon = 14; // scan two weeks — plenty for "when can I get a room"
    const from = start.toISODate();
    const to = DateTime.min(start.plus({ days: horizon }), DateTime.fromISO(w.maxDate, { zone: config.timezone })).toISODate();
    const all = await bookingsBetween(from, to, rooms.map((r) => r.id));

    const step = settings.slot_minutes;
    const nowMin = nowLocal().hour * 60 + nowLocal().minute;
    const suggestions = [];

    for (let i = 0; i <= horizon; i++) {
      const d = start.plus({ days: i });
      const date = d.toISODate();
      if (date > to) break;
      if (!settings.allow_weekend && d.weekday === 7) continue;

      for (const r of rooms) {
        const busy = all
          .filter((b) => b.room_id === r.id && b.booking_date === date)
          .map((b) => ({ start_time: b.start_time, end_time: b.end_time }));
        const free = freeIntervals(settings, busy, {
          minStartMin: i === 0 ? ceilToSlot(nowMin + 10, step) : null
        });
        for (const f of free) {
          for (let s = f.start; s + duration <= f.end; s += step) {
            const midday = Math.abs(s - 660) / 660;              // 11:00 is the sweet spot
            const slack = (r.capacity - attendees) / Math.max(r.capacity, 1);
            suggestions.push({
              roomId: r.id, roomName: r.name, floor: r.floor, capacity: r.capacity,
              date, start: minToHHMM(s), end: minToHHMM(s + duration),
              dayLabel: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toFormat('EEE d LLL'),
              score: i * 100 + midday * 12 + slack * 18 + (s / 1440) * 4
            });
            if (suggestions.length > 4000) break;
          }
        }
      }
      if (suggestions.filter((s) => s.date <= date).length >= 200) break;
    }

    suggestions.sort((a, b) => a.score - b.score);

    const perRoom = new Map(), perDay = new Map();
    const picked = [];
    for (const s of suggestions) {
      if ((perRoom.get(s.roomId) || 0) >= 2) continue;
      if ((perDay.get(s.date) || 0) >= 4) continue;
      perRoom.set(s.roomId, (perRoom.get(s.roomId) || 0) + 1);
      perDay.set(s.date, (perDay.get(s.date) || 0) + 1);
      picked.push(s);
      if (picked.length >= limit) break;
    }
    // If diversity starved the list, top it up from the raw ranking.
    for (const s of suggestions) {
      if (picked.length >= limit) break;
      if (!picked.includes(s)) picked.push(s);
    }

    res.json({
      duration, attendees,
      suggestions: picked.map(({ score, ...rest }) => rest)
    });
  } catch (e) { next(e); }
});
