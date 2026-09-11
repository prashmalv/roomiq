import { useCallback, useEffect, useState } from 'react';
import { api, fmtLongDate, todayISO } from '../api.js';
import { Eyebrow, Field, Loading, Modal, Notice, StatusChip } from '../components/ui.jsx';

export default function AdminApprovals() {
  // 'leadership' is the same queue narrowed to senior people — the point is that
  // a leadership request cannot be lost in a long list of ordinary ones.
  const [queue, setQueue] = useState('all');
  const [status, setStatus] = useState('pending');
  const [from, setFrom] = useState(todayISO());
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  const [counts, setCounts] = useState({ pending: 0, pending_senior: 0, contested: 0 });
  const [reject, setReject] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setRows(null);
    const qs = new URLSearchParams();
    if (status !== 'all') qs.set('status', status);
    if (from) qs.set('from', from);
    if (search.trim()) qs.set('q', search.trim());
    if (queue === 'leadership') qs.set('senior', 'true');
    if (queue === 'clashes') { qs.set('status', 'contested'); qs.delete('from'); }
    const [d, st] = await Promise.all([
      api.get(`/api/admin/bookings?${qs}`),
      api.get('/api/admin/stats').catch(() => null)
    ]);
    setRows(d.bookings);
    if (st) setCounts(st.stats);
  }, [status, from, search, queue]);

  useEffect(() => { load(); }, [load]);

  const approve = async (b) => {
    setBusy(true); setError('');
    try {
      await api.post(`/api/admin/bookings/${b.id}/approve`);
      setFlash(`Approved — ${b.room.name}, ${b.date} ${b.start}–${b.end}. ${b.bookedFor.name} has been emailed.`);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const doReject = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/api/admin/bookings/${reject.id}/reject`, { note: note.trim() });
      setReject(null); setNote('');
      setFlash('Request declined and the requester notified.');
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="shell page">
      <Eyebrow>Facilities workflow</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Approvals</h1>
      <p style={{ marginTop: 12 }}>
        Every employee request lands here holding its slot, so nobody else can take the
        same time while you decide. Approving or declining emails the requester.
        Senior leadership requests are pinned to the top of the queue and have their own
        tab, so they cannot scroll out of sight. A row in <strong>red</strong> means two
        live requests want the same slot — decide that one before the rest.
      </p>

      <div className="tabs" style={{ marginTop: 'var(--s-6)' }}>
        <button type="button" className={`tab${queue === 'all' ? ' on' : ''}`}
                onClick={() => setQueue('all')}>
          All requests
          {counts.pending > 0 && <span className="tab-n">{counts.pending}</span>}
        </button>
        <button type="button" className={`tab tab-senior${queue === 'leadership' ? ' on' : ''}`}
                onClick={() => setQueue('leadership')}>
          Senior leadership
          {counts.pending_senior > 0 && <span className="tab-n">{counts.pending_senior}</span>}
        </button>
        <button type="button" className={`tab tab-clash${queue === 'clashes' ? ' on' : ''}`}
                onClick={() => setQueue('clashes')}>
          Clashes
          {counts.contested > 0 && <span className="tab-n">{counts.contested}</span>}
        </button>
      </div>

      <div className="filters" style={{ marginTop: 'var(--s-4)' }}>
        <label className="field"><span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Declined</option>
            <option value="contested">Contested</option>
            <option value="cancelled">Cancelled</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="field"><span>From date</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field" style={{ minWidth: 220 }}><span>Search</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Person, room or meeting" />
        </label>
      </div>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      <section className="section">
        {!rows ? <Loading /> : rows.length === 0 ? (
          <p className="muted">
            {queue === 'leadership'
              ? 'No senior leadership requests match these filters.'
              : queue === 'clashes'
                ? 'No slot is being contested. Nothing to arbitrate.'
                : 'Nothing matches these filters. The queue is clear.'}
          </p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requested for</th><th>Room</th><th>Date</th><th>Time</th>
                  <th>Meeting</th><th>Status</th><th className="right">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}
                      className={b.contestedBy?.length ? 'row-clash'
                               : b.bookedFor.isSenior ? 'row-senior' : undefined}>
                    <td>
                      {b.bookedFor.name}
                      {b.bookedFor.isSenior && <span className="chip chip-senior">Senior leadership</span>}
                      <div className="mono muted">{b.bookedFor.department || '—'} · {b.bookedFor.email}</div>
                      {b.requestedBy.id !== b.bookedFor.id && (
                        <div className="mono muted">filed by {b.requestedBy.name}</div>
                      )}
                    </td>
                    <td>{b.room.name}<div className="mono muted">{b.room.floor || b.room.location}</div></td>
                    <td>{fmtLongDate(b.date)}</td>
                    <td>{b.start}–{b.end}</td>
                    <td>
                      {b.title}
                      {b.purpose && <div className="mono muted">{b.purpose}</div>}
                      <div className="mono muted">{b.attendees} attendees</div>
                      {b.contestedBy?.length > 0 && (
                        <div className="clash-note">
                          Senior leadership ({b.contestedBy.map((c) => c.name).join(', ')}) has
                          also asked for this slot. Approving this closes theirs.
                        </div>
                      )}
                      {b.status === 'contested' && b.blockedBy?.length > 0 && (
                        <div className="clash-note">
                          Held by {b.blockedBy.map((k) => `${k.name} (${k.status})`).join(', ')} —
                          settle that request before approving this one.
                        </div>
                      )}
                    </td>
                    <td>
                      <StatusChip status={b.status} />
                      {b.autoApproved && (
                        <div className="mono" style={{ color: 'var(--cat-2)', marginTop: 4 }}>
                          Approved by system
                        </div>
                      )}
                      {b.decisionNote && <div className="mono muted">{b.decisionNote}</div>}
                    </td>
                    <td className="right">
                      {b.status === 'pending' || b.status === 'contested' ? (
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sm" disabled={busy} onClick={() => approve(b)}>Approve</button>
                          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setReject(b)}>Decline</button>
                        </div>
                      ) : (
                        <span className="mono muted">
                          {b.autoApproved ? 'System · senior leadership' : b.decidedBy || '—'}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {reject && (
        <Modal
          title="Decline this request"
          eyebrow={`${reject.bookedFor.name} · ${reject.room.name} · ${reject.date} ${reject.start}–${reject.end}`}
          onClose={() => { setReject(null); setError(''); }}
          footer={
            <>
              <button className="btn btn-sec" onClick={() => setReject(null)}>Back</button>
              <button className="btn btn-danger" onClick={doReject} disabled={busy || note.trim().length < 3}>
                {busy ? 'Declining…' : 'Decline and notify'}
              </button>
            </>
          }
        >
          <p>The reason goes into the email, so write something the requester can act on.</p>
          <Field label="Reason">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus
                   placeholder="Room reserved for the board review that morning" />
          </Field>
          {error && <Notice tone="bad">{error}</Notice>}
        </Modal>
      )}
    </div>
  );
}
