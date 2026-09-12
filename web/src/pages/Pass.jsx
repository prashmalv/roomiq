import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtLongDate } from '../api.js';
import { Eyebrow, Loading, Notice, StatusChip } from '../components/ui.jsx';

/**
 * Proof of booking. Deliberately public and read-only — the point is to hold a
 * phone up to whoever is already in the room.
 */
export default function Pass() {
  const { code } = useParams();
  const [pass, setPass] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get(`/api/pass/${encodeURIComponent(code)}`)
      .then((d) => setPass(d.pass))
      .catch((e) => setError(e.message));
  }, [code]);

  if (error) {
    return (
      <div className="shell page" style={{ maxWidth: 620 }}>
        <Eyebrow>Booking pass</Eyebrow>
        <h1 style={{ margin: '12px 0 20px' }}>Pass not found</h1>
        <Notice tone="bad">{error}</Notice>
        <p style={{ marginTop: 20 }}><Link to="/">Back to UneeRooms</Link></p>
      </div>
    );
  }
  if (!pass) return <div className="shell page"><Loading label="Loading pass" /></div>;

  const active = pass.status === 'approved';

  return (
    <div className="shell page" style={{ paddingBottom: 'var(--s-8)' }}>
      <div className="pass-card">
        <div className="band" style={{ padding: 'var(--s-6) var(--s-5)' }}>
          <Eyebrow>Room booking pass</Eyebrow>
          <h1 style={{ color: 'var(--paper)', marginTop: 12, fontSize: 'clamp(30px,5vw,46px)' }}>
            {pass.room}
          </h1>
          <p style={{ marginTop: 10, marginBottom: 0 }}>
            {pass.floor || pass.location || 'Uneecops Technologies'}
          </p>
        </div>

        <div style={{ padding: 'var(--s-5)' }}>
          <dl className="dl">
            <dt>Date</dt><dd>{fmtLongDate(pass.date)}</dd>
            <dt>Time</dt><dd className="num">{pass.start} – {pass.end}</dd>
            <dt>Reserved by</dt><dd>{pass.holder}{pass.department ? ` · ${pass.department}` : ''}</dd>
            <dt>Meeting</dt><dd>{pass.title}</dd>
            <dt>Party size</dt><dd className="num">{pass.attendees}</dd>
            <dt>Status</dt><dd><StatusChip status={pass.status} /></dd>
            {pass.approvedBy && (<><dt>Approved by</dt><dd>{pass.approvedBy}</dd></>)}
            <dt>Pass code</dt><dd className="pass-code">{pass.code}</dd>
          </dl>

          <hr className="rule" style={{ margin: 'var(--s-5) 0' }} />

          {active ? (
            <Notice tone="good">
              This slot is confirmed for {pass.holder}. Anyone else using the room during
              these hours should vacate it.
            </Notice>
          ) : (
            <Notice tone="bad">
              This booking is {pass.status}. It does not entitle anyone to the room.
            </Notice>
          )}

          <div className="btn-row no-print" style={{ marginTop: 'var(--s-5)' }}>
            <button className="btn btn-sec btn-sm" onClick={() => window.print()}>Print</button>
            <Link className="btn btn-sec btn-sm" to="/" style={{ textDecoration: 'none' }}>Open UneeRooms</Link>
          </div>
        </div>
      </div>

      <p className="mono muted no-print" style={{ marginTop: 'var(--s-5)' }}>
        Verified against the UneeRooms booking register · pass codes are unique and cannot be edited
      </p>
    </div>
  );
}
