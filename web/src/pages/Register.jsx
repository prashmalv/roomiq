import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Eyebrow, Field, Loading, Logo, Notice } from '../components/ui.jsx';

/**
 * Self-service sign-up. The domain allow-list is the only gate, and it is
 * enforced on the server — this page mirrors it so the rule is visible before
 * someone types an address that will be refused.
 */
export default function Register() {
  const { user, loading, register } = useAuth();
  const loc = useLocation();
  const [policy, setPolicy] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', department: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/auth/registration')
      .then(setPolicy)
      .catch(() => setPolicy({ open: false, domains: [] }));
  }, []);

  if (loading) return <div className="shell"><Loading /></div>;
  if (user) return <Navigate to={loc.state?.from || '/'} replace />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const domains = policy?.domains || [];
  const emailDomain = form.email.includes('@') ? form.email.split('@').pop().toLowerCase() : '';
  const domainOk = !emailDomain || domains.includes(emailDomain);
  const mismatch = form.confirm.length > 0 && form.password !== form.confirm;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await register({
        name: form.name.trim(),
        email: form.email.trim().toLowerCase(),
        department: form.department.trim() || null,
        password: form.password
      });
    } catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="center-page">
      <div className="left">
        <Logo plate />
        <h1 style={{ marginTop: 16 }}>Create your<br />RoomIQ account.</h1>
        <p style={{ marginTop: 20 }}>
          Sign up with your Uneecops work email and you can book straight away — there is
          no account request to wait on. Room bookings themselves still go to facilities
          for approval, and you are emailed either way.
        </p>
        {domains.length > 0 && (
          <p className="mono" style={{ marginTop: 20, color: 'var(--ink-3)' }}>
            Accepted domains: {domains.map((d) => `@${d}`).join('  ·  ')}
          </p>
        )}
      </div>

      <div className="right">
        <Eyebrow>Sign up</Eyebrow>
        <h1 style={{ marginTop: 12, marginBottom: 24 }}>Get started</h1>

        {policy && !policy.open ? (
          <>
            <Notice tone="bad">
              Self sign-up is currently turned off. Ask facilities to create your account.
            </Notice>
            <p style={{ marginTop: 20 }}><Link to="/login">Back to sign in</Link></p>
          </>
        ) : (
          <>
            <form onSubmit={submit}>
              <Field label="Full name">
                <input value={form.name} onChange={set('name')} required minLength={2}
                       autoComplete="name" placeholder="Sneha Kulkarni" />
              </Field>
              <Field label="Work email">
                <input type="email" value={form.email} onChange={set('email')} required
                       autoComplete="username" placeholder={`name@${domains[0] || 'uneecops.in'}`} />
              </Field>
              {!domainOk && (
                <Notice tone="bad">
                  Only {domains.map((d) => `@${d}`).join(' and ')} addresses can sign up here.
                </Notice>
              )}
              <Field label="Department (optional)">
                <input value={form.department} onChange={set('department')} placeholder="Presales" />
              </Field>
              <Field label="Password (min 8 characters)">
                <input type="password" value={form.password} onChange={set('password')} required
                       minLength={8} autoComplete="new-password" />
              </Field>
              <Field label="Confirm password">
                <input type="password" value={form.confirm} onChange={set('confirm')} required
                       autoComplete="new-password" />
              </Field>
              {mismatch && <Notice tone="bad">Both passwords must match.</Notice>}
              {error && <Notice tone="bad">{error}</Notice>}
              <button className="btn" style={{ marginTop: 16, width: '100%' }}
                      disabled={busy || mismatch || !domainOk}>
                {busy ? 'Creating your account…' : 'Create account'}
              </button>
            </form>

            <hr className="rule" />
            <p style={{ color: 'var(--ink-3)' }}>
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
