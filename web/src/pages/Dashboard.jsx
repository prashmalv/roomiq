import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, bookingFlash, durationLabel, fmtLongDate, todayISO } from '../api.js';
import { useAuth, isAdminRole } from '../auth.jsx';
import { Eyebrow, KPI, Loading, Notice, StatusChip } from '../components/ui.jsx';
import DayGrid from '../components/DayGrid.jsx';
import BookDialog from '../components/BookDialog.jsx';

const DURATIONS = [30, 45, 60, 90, 120, 180];

export default function Dashboard() {
  const { user, settings } = useAuth();
  const isAdmin = isAdminRole(user.role);
  const today = todayISO();

  const [duration, setDuration] = useState(60);
  const [attendees, setAttendees] = useState(4);
  const [rooms, setRooms] = useState([]);
  const [suggestions, setSuggestions] = useState(null);
  const [day, setDay] = useState(null);
  const [mine, setMine] = useState([]);
  const [stats, setStats] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [offices, setOffices] = useState([]);
  const [office, setOffice] = useState('');
  const [flash, setFlash] = useState('');

  const loadAll = useCallback(async () => {
    const [r, d, m] = await Promise.all([
      api.get(`/api/rooms${office ? `?location=${office}` : ''}`),
      api.get(`/api/availability/day?date=${today}${office ? `&location=${office}` : ''}`),
      api.get('/api/bookings/mine?scope=upcoming')
    ]);
    setRooms(r.rooms); setDay(d); setMine(m.bookings);
    if (isAdmin) api.get('/api/admin/stats').then((s) => setStats(s.stats)).catch(() => {});
  }, [today, isAdmin, office]);

  const loadSuggestions = useCallback(async () => {
    setSuggestions(null);
    const s = await api.get(`/api/availability/suggestions?duration=${duration}&attendees=${attendees}${office ? `&location=${office}` : ''}`);
    setSuggestions(s.suggestions);
  }, [duration, attendees, office]);

  // The office list drives the picker; a person's own office is preselected so
  // the page opens where they actually sit.
  useEffect(() => {
    api.get('/api/locations')
      .then((d) => {
        setOffices(d.locations);
        if (user.locationId) {
          const mine = d.locations.find((l) => l.id === user.locationId);
          if (mine) setOffice(mine.id);
        }
      })
      .catch(() => {});
  }, [user.locationId]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { loadSuggestions(); }, [loadSuggestions]);

  // "Now" comes from the server's slot states, not the browser clock — a laptop
  // on the wrong timezone must not change what the dashboard claims is free.
  const freeNow = useMemo(() => {
    if (!day) return 0;
    return day.rooms.filter((r) => {
      if (!r.room.can_book) return false;
      const next = r.slots.find((s) => s.state !== 'past');
      return next?.state === 'free';
    }).length;
  }, [day]);

  const bookableCount = day ? day.rooms.filter((r) => r.room.can_book).length : 0;
  const myPending = mine.filter((b) => b.status === 'pending').length;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  const afterBooking = async (booking, series) => {
    setDialog(null);
    setFlash(bookingFlash(booking, series));
    await loadAll(); await loadSuggestions();
  };

  return (
    <>
      <section className="band">
        <div className="shell">
          <Eyebrow>{fmtLongDate(today)} · Conference rooms</Eyebrow>
          <h1 className="hero" style={{ marginTop: 14 }}>{greeting}, {user.name.split(' ')[0]}.</h1>
          <p style={{ marginTop: 16 }}>
            {freeNow > 0
              ? `${freeNow} of ${bookableCount} rooms are free at this moment. The slots below already fit your meeting — pick one and it is booked.`
              : 'Every room is occupied right now. The next free slots are listed below.'}
          </p>
        </div>
      </section>

      <div className="shell page">
        {flash && (
          <div style={{ marginBottom: 'var(--s-5)' }}>
            <Notice tone="good">{flash}</Notice>
          </div>
        )}

        <KPI
          items={[
            { label: 'Free right now', value: day ? `${freeNow}/${bookableCount}` : '—', context: 'rooms available this minute' },
            { label: 'My upcoming', value: mine.length, context: `${myPending} awaiting approval` },
            isAdmin
              ? { label: 'Approval queue', value: stats?.pending ?? '—', context: 'requests needing a decision' }
              : { label: 'Booking horizon', value: 2, context: 'this month and next' },
            { label: isAdmin ? 'Confirmed today' : 'Rooms', value: isAdmin ? (stats?.today_confirmed ?? '—') : (rooms.filter((r) => r.can_book).length || '—'),
              context: isAdmin ? 'meetings on the floor today' : 'bookable meeting rooms' }
          ]}
        />

        {/* ------------------------------------------------ suggestions ---- */}
        <section className="section">
          <div className="section-head">
            <h2>Next slots that fit</h2>
            <Eyebrow mute>Suggested — no searching required</Eyebrow>
          </div>

          <div className="filters" style={{ marginBottom: 'var(--s-5)' }}>
            <label className="field"><span>Duration</span>
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.filter((d) => d <= settings.max_booking_minutes)
                  .map((d) => <option key={d} value={d}>{durationLabel(d)}</option>)}
              </select>
            </label>
            <label className="field"><span>Office</span>
              <select value={office} onChange={(e) => setOffice(e.target.value)}>
                <option value="">Every office</option>
                {offices.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}{l.rooms ? ` — ${l.rooms} room${l.rooms === 1 ? '' : 's'}` : ' — no rooms'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field"><span>Attendees</span>
              <input type="number" min="1" max="200" value={attendees}
                     onChange={(e) => setAttendees(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <Link className="btn btn-sec btn-sm" to="/calendar" style={{ textDecoration: 'none' }}>
              Browse the calendar instead
            </Link>
          </div>

          {suggestions === null ? <Loading label="Finding slots" /> : suggestions.length === 0 ? (
            <Notice>No room seats {attendees} for {durationLabel(duration)} in the next two weeks. Try a shorter meeting or fewer attendees.</Notice>
          ) : (
            <div className="tiles">
              {suggestions.map((s) => (
                <div className="tile" key={`${s.roomId}-${s.date}-${s.start}`}>
                  <Eyebrow>{s.dayLabel}</Eyebrow>
                  <div className="when">{s.start} – {s.end}</div>
                  <div className="meta">
                    <strong style={{ color: 'var(--ink)' }}>{s.roomName}</strong> · {s.capacity} seats
                    {s.floor ? ` · ${s.floor}` : ''}
                  </div>
                  <button
                    className="btn btn-sm"
                    onClick={() => setDialog({ roomId: s.roomId, date: s.date, start: s.start, end: s.end, attendees })}
                  >
                    {isAdmin ? 'Book this slot' : 'Request this slot'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* -------------------------------------------------- today grid --- */}
        <section className="section">
          <div className="section-head">
            <h2>Today, room by room</h2>
            <Eyebrow mute>{settings.work_start}–{settings.work_end} · {settings.slot_minutes} minute slots</Eyebrow>
          </div>
          {!day ? <Loading /> : (
            <DayGrid
              rooms={day.rooms}
              isAdmin={isAdmin}
              onPick={(room, slot) =>
                setDialog({ roomId: room.id, date: today, start: slot.start, end: slot.end, attendees })}
            />
          )}
        </section>

        {/* ------------------------------------------------- my bookings --- */}
        <section className="section">
          <div className="section-head">
            <h2>Your next bookings</h2>
            <Link to="/bookings" className="eyebrow" style={{ textDecoration: 'none' }}>See all</Link>
          </div>
          {mine.length === 0 ? (
            <p className="muted">Nothing booked yet. Pick one of the suggested slots above.</p>
          ) : (
            <div className="table-wrap stack">
              <table className="stack-sm">
                <thead>
                  <tr><th>Room</th><th>Date</th><th>Time</th><th>Meeting</th><th>Status</th><th className="right">Pass</th></tr>
                </thead>
                <tbody>
                  {mine.slice(0, 5).map((b) => (
                    <tr key={b.id}>
                      <td data-label="Room">{b.room.name}</td>
                      <td data-label="Date">{fmtLongDate(b.date)}</td>
                      <td data-label="Time">{b.start}–{b.end}</td>
                      <td data-label="Meeting">{b.title}</td>
                      <td data-label="Status"><StatusChip status={b.status} /></td>
                      <td className="right" data-label="Pass">
                        {b.status === 'approved'
                          ? <Link to={`/pass/${b.passCode}`}>Open pass</Link>
                          : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {dialog && (
        <BookDialog prefill={dialog} rooms={rooms} onClose={() => setDialog(null)} onBooked={afterBooking} />
      )}
    </>
  );
}
