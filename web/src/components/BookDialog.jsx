import { useEffect, useMemo, useState } from 'react';
import { api, addMinutes, fmtDate, fmtLongDate, minutesBetween } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Modal, Field, Notice } from './ui.jsx';

const DURATIONS = [30, 45, 60, 90, 120, 180, 240];

export default function BookDialog({ prefill, rooms, onClose, onBooked }) {
  const { user, window: win, settings } = useAuth();
  const isAdmin = user.role === 'admin';

  const [form, setForm] = useState(() => ({
    roomId: prefill?.roomId || rooms.find((r) => r.can_book)?.id || '',
    date: prefill?.date || win.minDate,
    start: prefill?.start || '10:00',
    duration: prefill?.start && prefill?.end ? minutesBetween(prefill.start, prefill.end) : 60,
    title: '',
    purpose: '',
    attendees: prefill?.attendees || 2,
    bookedFor: '',
    repeat: 'none'
  }));
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Set when the slot is taken but joining the queue is possible.
  const [offerWaitlist, setOfferWaitlist] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api.get('/api/admin/users').then((d) => setPeople(d.users.filter((u) => u.is_active))).catch(() => {});
  }, [isAdmin]);

  // A <select> reports type 'select-one', so keying off the input type alone
  // left duration as a string. Numeric fields are named rather than sniffed.
  const NUMERIC = new Set(['duration', 'attendees']);
  const set = (k) => (e) => {
    const v = e.target.type === 'number' || NUMERIC.has(k) ? Number(e.target.value) : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const startOptions = useMemo(() => {
    const out = [];
    const [ws, we] = [settings.work_start, settings.work_end];
    for (let t = ws; minutesBetween(t, we) >= settings.slot_minutes; t = addMinutes(t, settings.slot_minutes))
      out.push(t);
    return out;
  }, [settings]);

  /* Mirrors repeatDates() on the server: from the chosen date to the Sunday of
     that same week, stepping one day or two. Shown so nobody has to guess how
     many bookings the button is about to make. */
  const series = useMemo(() => {
    if (form.repeat === 'none') return [form.date];
    const step = form.repeat === 'alternate' ? 2 : 1;
    const first = new Date(`${form.date}T00:00:00`);
    const mondayIndex = (first.getDay() + 6) % 7;          // 0 = Monday … 6 = Sunday
    const lastOfWeek = new Date(first);
    lastOfWeek.setDate(first.getDate() + (6 - mondayIndex));
    const out = [];
    for (const d = new Date(first); d <= lastOfWeek; d.setDate(d.getDate() + step)) {
      if (!settings.allow_weekend && d.getDay() === 0) continue;
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    return out;
  }, [form.date, form.repeat, settings.allow_weekend]);

  const end = addMinutes(form.start, form.duration);
  const room = rooms.find((r) => r.id === form.roomId);
  const overCapacity = room && form.attendees > room.capacity;

  const submit = async (e, waitlist = false) => {
    e.preventDefault();
    setBusy(true); setError(''); if (!waitlist) setOfferWaitlist(false);
    try {
      const res = await api.post('/api/bookings', {
        roomId: form.roomId,
        title: form.title.trim(),
        purpose: form.purpose.trim() || null,
        attendees: Number(form.attendees),
        date: form.date,
        start: form.start,
        end,
        repeat: form.repeat,
        ...(waitlist ? { waitlist: true } : {}),
        ...(isAdmin && form.bookedFor ? { bookedFor: form.bookedFor } : {})
      });
      onBooked(res.booking, res.series);
    } catch (err) {
      setError(err.message);
      setOfferWaitlist(!!err.canWaitlist);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAdmin ? 'Allocate a room' : 'Request a room'}
      eyebrow={isAdmin ? 'Confirmed immediately' : 'Goes to an admin for approval'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-sec" onClick={onClose}>Cancel</button>
          <button type="submit" form="book-form" className="btn" disabled={busy || overCapacity}>
            {busy ? 'Submitting…'
              : series.length > 1 ? `${isAdmin ? 'Confirm' : 'Request'} ${series.length} bookings`
              : isAdmin ? 'Confirm booking' : 'Send request'}
          </button>
        </>
      }
    >
      <form id="book-form" onSubmit={submit}>
        <Field label="Room">
          <select value={form.roomId} onChange={set('roomId')} required>
            {rooms.map((r) => (
              <option key={r.id} value={r.id} disabled={!r.can_book}>
                {r.name} — {r.capacity} seats{r.floor ? `, ${r.floor}` : ''}
                {r.can_book ? '' : ' (restricted)'}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid-2">
          <Field label="Date">
            <input type="date" value={form.date} min={win.minDate} max={win.maxDate}
                   onChange={set('date')} required />
          </Field>
          <Field label="Attendees">
            <input type="number" min="1" max={room?.capacity || 500} value={form.attendees}
                   onChange={set('attendees')} required />
          </Field>
        </div>

        <div className="grid-2">
          <Field label="Start">
            <select value={form.start} onChange={set('start')}>
              {startOptions.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Duration">
            <select value={form.duration} onChange={set('duration')}>
              {DURATIONS.filter((d) => d <= settings.max_booking_minutes).map((d) => (
                <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} hr`}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Repeat (this week only)">
          <select value={form.repeat} onChange={set('repeat')}>
            <option value="none">Just this date</option>
            <option value="daily">Every day to the end of this week</option>
            <option value="alternate">Alternate days to the end of this week</option>
          </select>
        </Field>

        <Field label="Meeting title">
          <input value={form.title} onChange={set('title')} minLength={3} maxLength={120}
                 placeholder="e.g. Gujarat DICT solution review" required />
        </Field>

        <Field label="Purpose (optional)">
          <textarea value={form.purpose} onChange={set('purpose')} maxLength={500}
                    placeholder="Anything the approver should know" />
        </Field>

        {isAdmin && (
          <Field label="Book on behalf of">
            <select value={form.bookedFor} onChange={set('bookedFor')}>
              <option value="">Myself ({user.name})</option>
              {people.filter((p) => p.id !== user.id).map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {p.department || 'Uneecops'}</option>
              ))}
            </select>
          </Field>
        )}

        <p className="mono" style={{ color: 'var(--ink-3)', marginBottom: 12 }}>
          {form.repeat === 'none'
            ? `${fmtLongDate(form.date)} · ${form.start}–${end}`
            : `${series.length} booking${series.length === 1 ? '' : 's'}, ${form.start}–${end} · ` +
              series.map((d) => fmtDate(d)).join(' · ')}
        </p>
        {form.repeat !== 'none' && (
          <p className="mono" style={{ color: 'var(--ink-3)', marginBottom: 12 }}>
            A repeat stops at the end of this week. Any date whose slot is already taken is
            skipped and reported — the rest still go through.
          </p>
        )}

        {overCapacity && <Notice tone="bad">{room.name} seats {room.capacity}. Choose a larger room.</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        {offerWaitlist && (
          <div style={{ marginBottom: 12 }}>
            <p className="mono muted" style={{ marginBottom: 8 }}>
              You can wait for it instead. Nothing is reserved, but if the holder releases
              the room it goes to whoever joined the list first — automatically.
            </p>
            <button type="button" className="btn btn-sec btn-sm" disabled={busy}
                    onClick={(e) => submit(e, true)}>
              {busy ? 'Joining…' : 'Join the waiting list'}
            </button>
          </div>
        )}
        {!isAdmin && (
          <p className="mono" style={{ color: 'var(--ink-3)', marginTop: 12 }}>
            You can book up to {win.maxDate}. Later dates need an admin.
          </p>
        )}
      </form>
    </Modal>
  );
}
