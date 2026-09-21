import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, bookingFlash, fmtLongDate } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Eyebrow, Loading, Modal, Notice, StatusChip, Field } from '../components/ui.jsx';
import BookDialog from '../components/BookDialog.jsx';

export default function MyBookings() {
  const { user } = useAuth();
  const [scope, setScope] = useState('upcoming');
  const [bookings, setBookings] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [cancelling, setCancelling] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [newBooking, setNewBooking] = useState(false);

  const load = useCallback(async () => {
    setBookings(null);
    const d = await api.get(`/api/bookings/mine?scope=${scope}`);
    setBookings(d.bookings);
  }, [scope]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/api/rooms').then((d) => setRooms(d.rooms)); }, []);

  const doCancel = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.post(`/api/bookings/${cancelling.id}/cancel`, { note: note.trim() || undefined });
      setCancelling(null); setNote('');
      setFlash(r.reallocatedTo
        ? `Booking cancelled. ${r.reallocatedTo.name} was first on the waiting list, so the room has gone to them automatically and everyone has been emailed.`
        : 'Booking cancelled. The slot is free again and everyone involved has been emailed.');
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="shell page">
      <Eyebrow>Your reservations</Eyebrow>
      <h1 style={{ marginTop: 12 }}>My bookings</h1>
      <p style={{ marginTop: 12 }}>
        Every confirmed booking carries a pass. If someone is already sitting in the room,
        open the pass and show it — it names the room, the slot and you. If a meeting falls
        through, <strong>release</strong> the room: anyone waiting for that slot gets it
        automatically, earliest request first.
      </p>

      <div className="filters" style={{ marginTop: 'var(--s-6)' }}>
        <label className="field"><span>Show</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">Everything</option>
          </select>
        </label>
        <button className="btn btn-sm" onClick={() => setNewBooking(true)}>
          {user.role === 'admin' ? 'New allocation' : 'New request'}
        </button>
      </div>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}

      <section className="section">
        {!bookings ? <Loading /> : bookings.length === 0 ? (
          <p className="muted">Nothing here yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Room</th><th>Date</th><th>Time</th><th>Meeting</th>
                  <th>Status</th><th>Decision</th><th className="right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td>{b.room.name}<div className="mono muted">{b.room.floor || b.room.location}</div></td>
                    <td>{fmtLongDate(b.date)}</td>
                    <td>{b.start}–{b.end}</td>
                    <td>
                      {b.title}
                      {b.bookedFor.id !== user.id && <div className="mono muted">for {b.bookedFor.name}</div>}
                      {b.requestedBy.id !== user.id && <div className="mono muted">by {b.requestedBy.name}</div>}
                    </td>
                    <td>
                      <StatusChip status={b.status} />
                      {b.status === 'waitlisted' && (
                        <div className="mono muted">number {b.waitlistPosition} in the queue</div>
                      )}
                      {b.autoApproved && <div className="mono" style={{ color: 'var(--cat-2)' }}>by system</div>}
                    </td>
                    <td className="mono muted">
                      {b.decidedBy ? `${b.decidedBy}` : '—'}
                      {b.decisionNote ? <div>{b.decisionNote}</div> : null}
                    </td>
                    <td className="right">
                      <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                        {b.status === 'approved' && (
                          <Link className="btn btn-sec btn-sm" to={`/pass/${b.passCode}`}
                                style={{ textDecoration: 'none' }}>Pass</Link>
                        )}
                        {['pending', 'approved', 'contested', 'waitlisted'].includes(b.status) && (
                          <button className="btn btn-danger btn-sm" onClick={() => setCancelling(b)}>
                            {b.status === 'approved' ? 'Release' : b.status === 'waitlisted' ? 'Leave queue' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {cancelling && (
        <Modal
          title="Cancel this booking?"
          eyebrow={`${cancelling.room.name} · ${cancelling.date} · ${cancelling.start}–${cancelling.end}`}
          onClose={() => { setCancelling(null); setError(''); }}
          footer={
            <>
              <button className="btn btn-sec" onClick={() => setCancelling(null)}>Keep it</button>
              <button className="btn btn-danger" onClick={doCancel} disabled={busy}>
                {busy ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </>
          }
        >
          <p>
            {cancelling.status === 'approved'
              ? 'The room is released immediately. If anyone is on the waiting list for this slot, the earliest of them gets it automatically and is emailed.'
              : cancelling.status === 'waitlisted'
                ? 'You will be taken off the waiting list for this slot. Nothing else changes.'
                : 'The slot is released immediately and a cancellation email goes out.'}
          </p>
          <Field label="Reason (optional)">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
                   placeholder="Meeting moved to next week" />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
        </Modal>
      )}

      {newBooking && (
        <BookDialog
          prefill={null}
          rooms={rooms}
          onClose={() => setNewBooking(false)}
          onBooked={async (b, series) => { setNewBooking(false); setFlash(bookingFlash(b, series)); await load(); }}
        />
      )}
    </div>
  );
}
