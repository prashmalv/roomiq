import { useState } from 'react';
import { api } from '../api.js';
import { useAuth, isAdminRole } from '../auth.jsx';
import { Eyebrow, Field, Notice } from '../components/ui.jsx';

/**
 * Your own account. The password change goes through /api/auth/change-password,
 * which re-checks the current password server-side — an administrator changing
 * their own password uses exactly this path, not the admin reset route.
 */
export default function Profile() {
  const { user, settings } = useAuth();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const mismatch = form.confirm.length > 0 && form.next !== form.confirm;
  const tooShort = form.next.length > 0 && form.next.length < 8;
  const reused = form.next.length > 0 && form.next === form.current;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(''); setFlash('');
    try {
      await api.post('/api/auth/change-password', { current: form.current, next: form.next });
      setForm({ current: '', next: '', confirm: '' });
      setFlash('Password changed. It applies the next time you sign in.');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <div className="shell page">
      <Eyebrow>Your account</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Profile</h1>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      <div className="split section">
        <section>
          <div className="section-head"><h2>Change password</h2></div>
          <p style={{ marginBottom: 'var(--s-5)' }}>
            You need your current password to set a new one, so a signed-in session left
            open on a shared machine cannot be used to lock you out of your own account.
          </p>
          <form onSubmit={submit} style={{ maxWidth: 420 }}>
            <Field label="Current password">
              <input type="password" value={form.current} onChange={set('current')}
                     required autoComplete="current-password" />
            </Field>
            <Field label="New password (min 8 characters)">
              <input type="password" value={form.next} onChange={set('next')}
                     required minLength={8} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password">
              <input type="password" value={form.confirm} onChange={set('confirm')}
                     required autoComplete="new-password" />
            </Field>
            {tooShort && <Notice tone="bad">Use at least 8 characters.</Notice>}
            {mismatch && <Notice tone="bad">Both new passwords must match.</Notice>}
            {reused && <Notice tone="bad">Choose a password different from your current one.</Notice>}
            <button className="btn" style={{ marginTop: 8 }}
                    disabled={busy || mismatch || tooShort || reused || !form.current}>
              {busy ? 'Changing…' : 'Change password'}
            </button>
          </form>
        </section>

        <aside className="card">
          <Eyebrow>Signed in as</Eyebrow>
          <h3 style={{ margin: '10px 0 18px' }}>{user.name}</h3>
          <dl style={{ margin: 0 }}>
            {[
              ['Email', user.email],
              ['Role', user.role === 'superadmin' ? 'Super administrator'
                       : user.role === 'admin' ? 'Administrator' : 'Employee'],
              ['Department', user.department || '—'],
              ['Senior leadership', user.isSenior ? 'Yes' : 'No']
            ].map(([k, v]) => (
              <div key={k} style={{ borderTop: '1px solid var(--rule)', padding: '10px 0',
                                    display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <dt className="mono muted">{k}</dt>
                <dd style={{ margin: 0, color: 'var(--ink)', textAlign: 'right' }}>{v}</dd>
              </div>
            ))}
          </dl>
          {user.isSenior && (
            <p className="mono muted" style={{ marginTop: 'var(--s-4)' }}>
              {settings?.auto_approve_senior
                ? 'Your requests are confirmed automatically whenever the room is free.'
                : 'Your requests are shown to facilities ahead of the general queue.'}
            </p>
          )}
          {isAdminRole(user.role) && (
            <p className="mono muted" style={{ marginTop: 'var(--s-4)' }}>
              Resetting someone else's password is on the People screen.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
