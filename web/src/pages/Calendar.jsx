import { useCallback, useEffect, useState } from 'react';
import { addMonths, api, bookingFlash, fmtLongDate, fmtMonth, monthOf, parseISO, todayISO } from '../api.js';
import { useAuth, isAdminRole } from '../auth.jsx';
import { Eyebrow, Loading, Notice } from '../components/ui.jsx';
import DayGrid from '../components/DayGrid.jsx';
import BookDialog from '../components/BookDialog.jsx';

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function Calendar() {
  const { user, window: win, settings } = useAuth();
  const isAdmin = isAdminRole(user.role);

  const [month, setMonth] = useState(monthOf(todayISO()));
  const [date, setDate] = useState(todayISO());
  const [monthData, setMonthData] = useState(null);
  const [day, setDay] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [flash, setFlash] = useState('');

  useEffect(() => { api.get('/api/rooms').then((d) => setRooms(d.rooms)); }, []);

  const loadMonth = useCallback(async (m) => {
    setMonthData(null);
    setMonthData(await api.get(`/api/availability/month?month=${m}`));
  }, []);
  const loadDay = useCallback(async (d) => {
    setDay(null);
    setDay(await api.get(`/api/availability/day?date=${d}`));
  }, []);

  useEffect(() => { loadMonth(month); }, [month, loadMonth]);
  useEffect(() => { loadDay(date); }, [date, loadDay]);

  const minMonth = monthOf(win.minDate);
  const maxMonth = monthOf(win.maxDate);
  const lead = (parseISO(`${month}-01`).getDay() + 6) % 7;   // Monday-first

  const afterBooking = async (b, series) => {
    setDialog(null);
    setFlash(bookingFlash(b, series));
    await Promise.all([loadMonth(month), loadDay(date)]);
  };

  return (
    <div className="shell page">
      <Eyebrow>Availability</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Room calendar</h1>
      <p style={{ marginTop: 12 }}>
        {isAdmin
          ? `You can book any day up to ${win.maxDate}. Employees are limited to this month and next.`
          : `You can book from today to ${win.maxDate} — this month and next. Later dates have to be allocated by an admin.`}
      </p>

      {flash && <div style={{ margin: 'var(--s-5) 0' }}><Notice tone="good">{flash}</Notice></div>}

      <section className="section">
        <div className="section-head">
          <h2>{fmtMonth(month)}</h2>
          <div className="btn-row">
            <button className="btn btn-sec btn-sm" disabled={month <= minMonth}
                    onClick={() => setMonth(addMonths(month, -1))}>← Previous</button>
            <button className="btn btn-sec btn-sm" disabled={month >= maxMonth}
                    onClick={() => setMonth(addMonths(month, 1))}>Next →</button>
          </div>
        </div>

        {!monthData ? <Loading label="Loading month" /> : (
          <>
            <div className="cal">
              {WEEK.map((w) => <div className="cal-h" key={w}>{w}</div>)}
              {Array.from({ length: lead }).map((_, i) => <div className="cal-d" key={`b${i}`} style={{ background: 'var(--rule-2)' }} />)}
              {monthData.days.map((d) => {
                const pct = d.totalSlots ? Math.round((d.freeSlots / d.totalSlots) * 100) : 0;
                return (
                  <button
                    key={d.date}
                    className={`cal-d state-${d.state}${d.isToday ? ' today' : ''}${d.date === date ? ' sel' : ''}`}
                    disabled={!d.bookable}
                    onClick={() => setDate(d.date)}
                    title={d.closed ? 'Closed' : !d.bookable ? 'Outside your booking window' : `${pct}% free`}
                  >
                    <div className="d">{Number(d.date.slice(-2))}</div>
                    <div className="f">
                      {d.closed ? 'CLOSED' : d.outsideWindow ? 'LOCKED' : !d.bookable ? 'PAST' : `${pct}% FREE`}
                      {d.pending > 0 ? ` · ${d.pending}P` : ''}
                    </div>
                    {d.bookable && !d.closed && <div className="bar"><i style={{ width: `${100 - pct}%` }} /></div>}
                  </button>
                );
              })}
            </div>
            <div className="legend">
              <span><i style={{ background: 'var(--paper)' }} />Open</span>
              <span><i style={{ background: 'var(--cat-3)', borderColor: 'var(--cat-3)' }} />Filling up</span>
              <span><i style={{ background: 'var(--bad)', borderColor: 'var(--bad)' }} />Fully booked</span>
              <span><i style={{ background: 'var(--rule-2)', borderColor: 'var(--rule-2)' }} />Past, closed, or beyond your window</span>
              <span>The bar shows how much of the day is already taken · P = pending requests</span>
            </div>
          </>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{fmtLongDate(date)}</h2>
          <Eyebrow mute>{settings.work_start}–{settings.work_end}</Eyebrow>
          {/* Picking a slot in the grid prefills the time; this opens the same
              dialog on the day being viewed, for people who would rather type. */}
          <button className="btn btn-sm" style={{ marginLeft: 'auto' }}
                  disabled={!rooms.length} onClick={() => setDialog({ date })}>
            Book a room
          </button>
        </div>
        {!day ? <Loading label="Loading day" /> : (
          <>
            <span className="scroll-hint">Swipe the grid sideways to see the rest of the day</span>
            <DayGrid
              rooms={day.rooms}
              isAdmin={isAdmin}
              onPick={(room, slot) => setDialog({ roomId: room.id, date, start: slot.start, end: slot.end })}
            />
          </>
        )}
      </section>

      {dialog && (
        <BookDialog prefill={dialog} rooms={rooms} onClose={() => setDialog(null)} onBooked={afterBooking} />
      )}
    </div>
  );
}
