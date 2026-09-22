import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtLongDate } from '../api.js';
import { Eyebrow, Field, Loading, Notice, StatusChip } from '../components/ui.jsx';

/**
 * Deciding a request straight from the notification email.
 *
 * Reached by a signed link, so there is no session and no sign-in. The link
 * only *opens* this page: the decision itself is a button press, because mail
 * scanners and Safe Links fetch every URL in an email before a person sees it,
 * and a link that decided on open would approve requests by itself.
 */
export default function Decide() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const intent = params.get('action') === 'reject' ? 'reject' : 'approve';

  const [state, setState] = useState({ loading: true });
  const [action, setAction] = useState(intent);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/api/decide/${token}`);
      setState({ loading: false, ...d });
    } catch (e) {
      setState({ loading: false, error: e.message });
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const d = await api.post(`/api/decide/${token}`, {
        action, ...(action === 'reject' ? { note: note.trim() } : {})
      });
      setDone(d);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (state.loading) return <div className="shell page"><Loading label="Opening the request" /></div>;

  if (state.error) {
    return (
      <div className="shell page" style={{ maxWidth: 620 }}>
        <Eyebrow>Approve a request</Eyebrow>
        <h1 style={{ margin: '12px 0 20px' }}>This link cannot be used</h1>
        <Notice tone="bad">{state.error}</Notice>
        <p style={{ marginTop: 20 }}><Link to="/admin/approvals">Sign in and decide there</Link></p>
      </div>
    );
  }

  const b = state.booking;
  const slot = `${b.room.name} · ${fmtLongDate(b.date)} · ${b.start}–${b.end}`;

  if (done) {
    const approved = done.booking.status === 'approved';
    return (
      <div className="shell page" style={{ maxWidth: 620 }}>
        <Eyebrow>{approved ? 'Confirmed' : 'Declined'}</Eyebrow>
        <h1 style={{ margin: '12px 0 20px' }}>
          {approved ? 'Room confirmed' : 'Request declined'}
        </h1>
        <Notice tone={approved ? 'good' : ''}>
          {approved
            ? `${b.bookedFor.name} has the room and has been emailed. ${slot}.`
            : `${b.bookedFor.name} has been told why, and the slot is free again. ${slot}.`}
        </Notice>
        {done.reallocatedTo && (
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Notice>
              {done.reallocatedTo.name} was first on the waiting list, so the slot has gone
              to them automatically.
            </Notice>
          </div>
        )}
        <p className="mono muted" style={{ marginTop: 'var(--s-5)' }}>
          Recorded against {done.decidedBy}. Nothing else needs doing.
        </p>
        <p style={{ marginTop: 20 }}><Link to="/admin/approvals">Open the approvals screen</Link></p>
      </div>
    );
  }

  return (
    <div className="shell page" style={{ maxWidth: 640 }}>
      <Eyebrow>Approve without signing in</Eyebrow>
      <h1 style={{ margin: '12px 0 12px' }}>{b.title}</h1>
      <p style={{ marginBottom: 'var(--s-5)' }}>
        Deciding as <strong>{state.admin.name}</strong>. This came from your notification
        email, so no sign-in is needed — but the decision is final and everyone involved is
        emailed, so check the details first.
      </p>

      <div className="card" style={{ marginBottom: 'var(--s-5)' }}>
        <dl style={{ margin: 0 }}>
          {[
            ['Room', `${b.room.name}${b.room.floor ? `, ${b.room.floor}` : ''}`],
            ['Date', fmtLongDate(b.date)],
            ['Time', `${b.start}–${b.end}`],
            ['Requested for', `${b.bookedFor.name} (${b.bookedFor.department || 'Uneecops'})`],
            ['Attendees', b.attendees],
            ['Purpose', b.purpose || '—']
          ].map(([k, v]) => (
            <div key={k} style={{ borderTop: '1px solid var(--rule)', padding: '10px 0',
                                  display: 'flex', justifyContent: 'space-between', gap: 16 }}>
              <dt className="mono muted">{k}</dt>
              <dd style={{ margin: 0, color: 'var(--ink)', textAlign: 'right' }}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {!state.decidable ? (
        <>
          <Notice tone="bad">
            This request has already been settled — it is {b.status}
            {b.decidedBy ? `, decided by ${b.decidedBy}` : ''}. Nothing further to do.
          </Notice>
          <p style={{ marginTop: 20 }}>
            <StatusChip status={b.status} />
          </p>
        </>
      ) : (
        <>
          <div className="tabs" style={{ marginBottom: 'var(--s-5)' }}>
            <button type="button" className={`tab${action === 'approve' ? ' on' : ''}`}
                    onClick={() => setAction('approve')}>Approve</button>
            <button type="button" className={`tab tab-clash${action === 'reject' ? ' on' : ''}`}
                    onClick={() => setAction('reject')}>Decline</button>
          </div>

          {action === 'reject' && (
            <Field label="Reason (required — it goes into the email)">
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} autoFocus
                     placeholder="Room reserved for the board review that morning" />
            </Field>
          )}

          {error && <Notice tone="bad">{error}</Notice>}

          <button className={action === 'approve' ? 'btn' : 'btn btn-danger'}
                  style={{ marginTop: 'var(--s-4)' }}
                  disabled={busy || (action === 'reject' && note.trim().length < 3)}
                  onClick={submit}>
            {busy ? 'Recording…'
              : action === 'approve' ? 'Approve and notify' : 'Decline and notify'}
          </button>
        </>
      )}
    </div>
  );
}
