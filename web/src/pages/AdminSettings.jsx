import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Eyebrow, Field, KPI, Loading, Notice } from '../components/ui.jsx';

export default function AdminSettings() {
  const [settings, setSettings] = useState(null);
  const [stats, setStats] = useState(null);
  const [util, setUtil] = useState([]);
  const [mails, setMails] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [s, st, ob] = await Promise.all([
      api.get('/api/admin/settings'), api.get('/api/admin/stats'), api.get('/api/admin/outbox')
    ]);
    setSettings({
      ...s.settings,
      work_start: s.settings.work_start.slice(0, 5),
      work_end: s.settings.work_end.slice(0, 5),
      // The array is edited as one comma-separated line, then split on save.
      domains_text: (s.settings.allowed_email_domains || []).join(', ')
    });
    setStats(st.stats); setUtil(st.utilisation); setMails(ob.mails);
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setSettings((s) => ({
    ...s,
    [k]: e.target.type === 'checkbox' ? e.target.checked
       : e.target.type === 'number' ? Number(e.target.value) : e.target.value
  }));

  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api.patch('/api/admin/settings', {
        org_name: settings.org_name,
        work_start: settings.work_start,
        work_end: settings.work_end,
        slot_minutes: Number(settings.slot_minutes),
        employee_window_months: Number(settings.employee_window_months),
        admin_window_months: Number(settings.admin_window_months),
        max_booking_minutes: Number(settings.max_booking_minutes),
        allow_weekend: !!settings.allow_weekend,
        allow_self_registration: !!settings.allow_self_registration,
        allowed_email_domains: String(settings.domains_text || '')
          .split(',').map((d) => d.trim().replace(/^@/, '').toLowerCase()).filter(Boolean),
        auto_approve_senior: !!settings.auto_approve_senior
      });
      setFlash('Policy saved. It applies to every new booking from now on.');
      await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const flush = async () => {
    const r = await api.post('/api/admin/outbox/flush');
    setFlash(
      `Mail queue processed — ${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed.` +
      (r.checked ? ` Delivery checked on ${r.checked}: ${r.confirmed} confirmed, ${r.bounced} not delivered.` : '')
    );
    await load();
  };

  if (!settings) return <div className="shell page"><Loading /></div>;
  const maxUtil = Math.max(1, ...util.map((u) => Number(u.hours)));

  return (
    <div className="shell page">
      <Eyebrow>Configuration</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Settings and health</h1>

      <div className="section">
        <KPI items={[
          { label: 'Pending', value: stats.pending,
            context: stats.pending_senior
              ? `${stats.pending_senior} from senior leadership`
              : 'requests awaiting a decision' },
          { label: 'Confirmed today', value: stats.today_confirmed, context: 'meetings on the floor' },
          { label: 'Next 7 days', value: stats.next7, context: 'bookings held or confirmed' },
          { label: 'Mail delivered', value: stats.mail_delivered ?? 0,
            context: stats.mail_failed
              ? `${stats.mail_failed} could not be delivered`
              : 'confirmed by the provider' }
        ]} />
      </div>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      <div className="split section">
        <section>
          <div className="section-head"><h2>Booking policy</h2></div>
          <form onSubmit={save}>
            <Field label="Organisation name"><input value={settings.org_name} onChange={set('org_name')} /></Field>
            <div className="grid-2">
              <Field label="Bookable from"><input type="time" step="1800" value={settings.work_start} onChange={set('work_start')} /></Field>
              <Field label="Bookable until"><input type="time" step="1800" value={settings.work_end} onChange={set('work_end')} /></Field>
            </div>
            <div className="grid-2">
              <Field label="Slot length">
                <select value={settings.slot_minutes} onChange={set('slot_minutes')}>
                  <option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>60 minutes</option>
                </select>
              </Field>
              <Field label="Longest single booking (minutes)">
                <input type="number" min="30" max="720" step="30" value={settings.max_booking_minutes} onChange={set('max_booking_minutes')} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Employee horizon (months incl. current)">
                <input type="number" min="1" max="12" value={settings.employee_window_months} onChange={set('employee_window_months')} />
              </Field>
              <Field label="Admin horizon (months ahead)">
                <input type="number" min="1" max="24" value={settings.admin_window_months} onChange={set('admin_window_months')} />
              </Field>
            </div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, marginBottom: 18 }}>
              <input type="checkbox" checked={!!settings.allow_weekend} onChange={set('allow_weekend')} style={{ width: 16, height: 16 }} />
              Allow Sunday bookings
            </label>
            <p className="mono muted" style={{ marginBottom: 16 }}>
              Employee horizon 2 means the current calendar month plus the next one — in
              September that is September and October, and it rolls forward on the 1st.
            </p>

            <div className="section-head" style={{ marginTop: 'var(--s-6)' }}><h2>Who can sign up</h2></div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, marginBottom: 18 }}>
              <input type="checkbox" checked={!!settings.allow_self_registration}
                     onChange={set('allow_self_registration')} style={{ width: 16, height: 16 }} />
              Let employees create their own account
            </label>
            <Field label="Accepted email domains (comma separated)">
              <input value={settings.domains_text} onChange={set('domains_text')}
                     placeholder="uneecops.in, uneecops.com" />
            </Field>
            <p className="mono muted" style={{ marginBottom: 16 }}>
              Only these domains can sign up, and the check runs on the server — a bare
              domain each, no “@”. Turning sign-up off leaves account creation to this
              screen and the People screen; nobody already registered is affected.
            </p>

            <div className="section-head" style={{ marginTop: 'var(--s-6)' }}><h2>Senior leadership</h2></div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, marginBottom: 18 }}>
              <input type="checkbox" checked={!!settings.auto_approve_senior}
                     onChange={set('auto_approve_senior')} style={{ width: 16, height: 16 }} />
              Confirm senior leadership requests automatically when the room is free
            </label>
            <p className="mono muted" style={{ marginBottom: 16 }}>
              With this on, a request from anyone marked senior leadership on the People
              screen is confirmed the moment it is made, provided nothing else holds the
              slot. It shows in the register as <strong>approved by system</strong> and
              facilities are emailed. A slot already held by someone else's pending request
              is not free: that request is refused rather than displacing the person
              waiting. With this off, leadership requests still sort to the top of the
              approvals queue and keep their own tab.
            </p>

            <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button>
          </form>
        </section>

        <aside>
          <div className="section-head"><h2>Room use</h2></div>
          <Eyebrow mute>Confirmed hours, last 30 days</Eyebrow>
          <div style={{ marginTop: 'var(--s-4)' }}>
            {util.map((u) => (
              <div key={u.name} style={{ borderTop: '1px solid var(--rule)', padding: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span style={{ color: 'var(--ink)' }}>{u.name}</span>
                  <span className="num mono">{Number(u.hours).toFixed(1)} h</span>
                </div>
                <div style={{ height: 4, background: 'var(--rule-2)', marginTop: 6 }}>
                  <i style={{ display: 'block', height: '100%', background: 'var(--cat-1)',
                              width: `${(Number(u.hours) / maxUtil) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mono muted" style={{ marginTop: 'var(--s-4)' }}>
            Source: UneeRooms booking register
          </p>
        </aside>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Notification log</h2>
          <button className="btn btn-sec btn-sm" onClick={flush}>Process queue now</button>
        </div>
        <p>
          Mail is written to the outbox first and sent second, so nothing is lost if the
          transport is down. <strong>Delivered</strong> means the provider confirmed the
          recipient's mail server accepted it, not merely that we handed it over;
          <strong> skipped</strong> means no transport is configured.
        </p>
        {!mails ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Recipient</th><th>Subject</th><th>Type</th><th>Status</th><th>Queued</th></tr></thead>
              <tbody>
                {mails.slice(0, 25).map((m) => (
                  <tr key={m.id}>
                    <td>{m.to_name || m.to_email}<div className="mono muted">{m.to_email}</div></td>
                    <td>{m.subject}</td>
                    <td className="mono muted">{m.kind}</td>
                    <td>
                      <span className="mono" style={{ letterSpacing: '0.14em', textTransform: 'uppercase',
                        color: m.status === 'sent' ? 'var(--good)' : m.status === 'failed' ? 'var(--bad)' : 'var(--ink-3)' }}>
                        {m.status === 'sent' && m.verified_at ? 'delivered' : m.status}
                      </span>
                      {m.status === 'sent' && !m.verified_at && m.provider_id && (
                        <div className="mono muted">accepted, awaiting confirmation</div>
                      )}
                      {m.last_error && <div className="mono muted">{m.last_error}</div>}
                    </td>
                    <td className="mono muted">{new Date(m.created_at).toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
