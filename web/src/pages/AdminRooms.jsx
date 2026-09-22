import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Eyebrow, Field, Loading, Modal, Notice } from '../components/ui.jsx';

const blank = { branch_id: '', name: '', location: '', floor: '', capacity: 8, amenities: '', restricted: false, is_active: true };

export default function AdminRooms() {
  const [rooms, setRooms] = useState(null);
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [allocating, setAllocating] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState(null);
  const [branches, setBranches] = useState([]);

  const load = useCallback(async () => {
    const [r, u, b] = await Promise.all([
      api.get('/api/admin/rooms'), api.get('/api/admin/users'), api.get('/api/admin/branches')
    ]);
    setRooms(r.rooms); setPeople(u.users.filter((x) => x.is_active)); setBranches(b.branches);
    // A room must sit in a branch, so preselect the only sensible default.
    setForm((f) => (f.branch_id ? f : { ...f, branch_id: b.branches[0]?.id || '' }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked
      : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));

  const payload = (f) => ({
    branch_id: f.branch_id,
    name: f.name.trim(),
    location: f.location?.trim() || null,
    floor: f.floor?.trim() || null,
    capacity: Number(f.capacity),
    amenities: String(f.amenities || '').split(',').map((s) => s.trim()).filter(Boolean),
    restricted: !!f.restricted,
    is_active: !!f.is_active
  });

  /* The file is posted as the raw request body rather than multipart: one file,
     no fields, and no extra dependency on the server to parse it. */
  const upload = async (file) => {
    if (!file) return;
    setImporting(true); setError(''); setReport(null);
    try {
      const res = await fetch('/api/admin/rooms/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        body: file
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error?.message || 'That upload failed.');
      setReport(d);
      setFlash(`${d.created.length} of ${d.read} row${d.read === 1 ? '' : 's'} added.`);
      await load();
    } catch (err) { setError(err.message); } finally { setImporting(false); }
  };

  const create = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const { room } = await api.post('/api/admin/rooms', payload(form));
      setFlash(`${room.name} added and bookable immediately.`);
      setForm(blank); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const saveEdit = async (e) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await api.patch(`/api/admin/rooms/${editing.id}`, payload(editing));
      setFlash(`${editing.name} updated.`); setEditing(null); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const toggleActive = async (r) => {
    await api.patch(`/api/admin/rooms/${r.id}`, { is_active: !r.is_active });
    setFlash(`${r.name} ${r.is_active ? 'taken out of service' : 'brought back into service'}.`);
    await load();
  };

  const grant = async () => {
    if (!pick) return;
    await api.post(`/api/admin/rooms/${allocating.id}/access`, { userId: pick });
    setPick(''); await load();
    const fresh = (await api.get('/api/admin/rooms')).rooms.find((x) => x.id === allocating.id);
    setAllocating(fresh);
  };
  const revoke = async (userId) => {
    await api.del(`/api/admin/rooms/${allocating.id}/access/${userId}`);
    await load();
    const fresh = (await api.get('/api/admin/rooms')).rooms.find((x) => x.id === allocating.id);
    setAllocating(fresh);
  };

  const editSet = (k) => (e) =>
    setEditing((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked
      : e.target.type === 'number' ? Number(e.target.value) : e.target.value }));

  return (
    <div className="shell page">
      <Eyebrow>Inventory</Eyebrow>
      <h1 style={{ marginTop: 12 }}>Rooms</h1>
      <p style={{ marginTop: 12 }}>
        A <strong>restricted</strong> room is bookable only by the people you allocate it to —
        that is how a boardroom stays a boardroom. Everything else is open to all employees.
      </p>

      <div className="filters" style={{ marginTop: 'var(--s-6)' }}>
        <a className="btn btn-sec btn-sm" href="/api/admin/export/rooms.xlsx"
           style={{ textDecoration: 'none' }}>Download Excel</a>
        <a className="btn btn-sec btn-sm" href="/api/admin/rooms/template.xlsx"
           style={{ textDecoration: 'none' }}>Get upload template</a>
        <label className="btn btn-sm" style={{ cursor: importing ? 'wait' : 'pointer' }}>
          {importing ? 'Reading the sheet…' : 'Bulk upload rooms'}
          <input type="file" accept=".xlsx" hidden disabled={importing}
                 onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>

      {flash && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="good">{flash}</Notice></div>}
      {error && <div style={{ marginTop: 'var(--s-5)' }}><Notice tone="bad">{error}</Notice></div>}

      {report && (
        <section className="section">
          <div className="section-head">
            <h2>Upload result</h2>
            <button className="btn btn-sec btn-sm" onClick={() => setReport(null)}>Dismiss</button>
          </div>
          <p>
            {report.read} row{report.read === 1 ? '' : 's'} read ·{' '}
            <strong>{report.created.length} added</strong> ·{' '}
            {report.skipped.length} skipped. Nothing was overwritten.
          </p>
          {report.skipped.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Sheet row</th><th>Name</th><th>Why it was skipped</th></tr></thead>
                <tbody>
                  {report.skipped.map((s) => (
                    <tr key={s.row} className="row-clash">
                      <td className="num">{s.row}</td>
                      <td>{s.name || <span className="muted">(blank)</span>}</td>
                      <td>{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <div className="split section">
        <section>
          {!rooms ? <Loading /> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Room</th><th className="right">Seats</th><th>Amenities</th><th>Access</th><th className="right">Actions</th></tr>
                </thead>
                <tbody>
                  {rooms.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {r.name}
                        <div className="mono muted">{[r.floor, r.location].filter(Boolean).join(' · ') || '—'}</div>
                        {!r.is_active && <div className="mono" style={{ color: 'var(--bad)' }}>OUT OF SERVICE</div>}
                      </td>
                      <td className="right num">{r.capacity}</td>
                      <td className="mono muted">{r.amenities?.join(', ') || '—'}</td>
                      <td>
                        {r.restricted
                          ? <>Restricted<div className="mono muted">{r.allocated.length
                              ? r.allocated.map((a) => a.name).join(', ') : 'nobody allocated yet'}</div></>
                          : <span className="muted">All employees</span>}
                      </td>
                      <td className="right">
                        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn-sec btn-sm" onClick={() => setEditing({ ...r, amenities: (r.amenities || []).join(', ') })}>Edit</button>
                          <button className="btn btn-sec btn-sm" onClick={() => setAllocating(r)}>Allocate</button>
                          <button className="btn btn-sec btn-sm" onClick={() => toggleActive(r)}>
                            {r.is_active ? 'Retire' : 'Restore'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card">
          <Eyebrow>Add a room</Eyebrow>
          <h3 style={{ margin: '10px 0 18px' }}>New meeting room</h3>
          <form onSubmit={create}>
            <Field label="Office and branch">
              <select value={form.branch_id} onChange={set('branch_id')} required>
                {branches.length === 0 && <option value="">No branch you administer</option>}
                {[...new Set(branches.map((b) => b.location_name))].map((office) => (
                  <optgroup key={office} label={office}>
                    {branches.filter((b) => b.location_name === office).map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <Field label="Name"><input value={form.name} onChange={set('name')} required minLength={2} placeholder="Sutlej" /></Field>
            <Field label="Location"><input value={form.location} onChange={set('location')} /></Field>
            <div className="grid-2">
              <Field label="Floor"><input value={form.floor} onChange={set('floor')} placeholder="3rd floor" /></Field>
              <Field label="Seats"><input type="number" min="1" value={form.capacity} onChange={set('capacity')} required /></Field>
            </div>
            <Field label="Amenities (comma separated)">
              <input value={form.amenities} onChange={set('amenities')} placeholder="Projector, Video conf" />
            </Field>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14, marginBottom: 16 }}>
              <input type="checkbox" checked={form.restricted} onChange={set('restricted')} style={{ width: 16, height: 16 }} />
              Restricted — only allocated people can book it
            </label>
            {error && <Notice tone="bad">{error}</Notice>}
            <button className="btn" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? 'Saving…' : 'Add room'}
            </button>
          </form>
        </aside>
      </div>

      {editing && (
        <Modal title={`Edit ${editing.name}`} eyebrow="Room details" onClose={() => setEditing(null)}
               footer={<>
                 <button className="btn btn-sec" onClick={() => setEditing(null)}>Cancel</button>
                 <button className="btn" form="edit-room" disabled={busy}>Save changes</button>
               </>}>
          <form id="edit-room" onSubmit={saveEdit}>
            <Field label="Name"><input value={editing.name} onChange={editSet('name')} required /></Field>
            <div className="grid-2">
              <Field label="Floor"><input value={editing.floor || ''} onChange={editSet('floor')} /></Field>
              <Field label="Seats"><input type="number" min="1" value={editing.capacity} onChange={editSet('capacity')} /></Field>
            </div>
            <Field label="Location"><input value={editing.location || ''} onChange={editSet('location')} /></Field>
            <Field label="Amenities"><input value={editing.amenities} onChange={editSet('amenities')} /></Field>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={!!editing.restricted} onChange={editSet('restricted')} style={{ width: 16, height: 16 }} />
              Restricted room
            </label>
            {error && <Notice tone="bad">{error}</Notice>}
          </form>
        </Modal>
      )}

      {allocating && (
        <Modal title={`Allocate ${allocating.name}`} eyebrow="Standing access" onClose={() => setAllocating(null)}
               footer={<button className="btn btn-sec" onClick={() => setAllocating(null)}>Done</button>}>
          {!allocating.restricted && (
            <Notice>
              {allocating.name} is open to all employees, so an allocation changes nothing yet.
              Mark it restricted first if you want it reserved for specific people.
            </Notice>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 16 }}>
            <Field label="Give access to">
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a person…</option>
                {people.filter((p) => !allocating.allocated.some((a) => a.id === p.id))
                  .map((p) => <option key={p.id} value={p.id}>{p.name} — {p.department || 'Uneecops'}</option>)}
              </select>
            </Field>
            <button className="btn" style={{ marginBottom: 16 }} onClick={grant} disabled={!pick}>Allocate</button>
          </div>

          <hr className="rule" style={{ margin: '8px 0 16px' }} />
          <Eyebrow mute>Currently allocated</Eyebrow>
          {allocating.allocated.length === 0 ? <p className="muted" style={{ marginTop: 8 }}>Nobody yet.</p> : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
              {allocating.allocated.map((a) => (
                <li key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12,
                                        borderTop: '1px solid var(--rule)', padding: '10px 0' }}>
                  <span style={{ color: 'var(--ink)' }}>{a.name}</span>
                  <span className="mono muted">{a.email}</span>
                  <button className="btn btn-sec btn-sm" style={{ marginLeft: 'auto' }}
                          onClick={() => revoke(a.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </div>
  );
}
