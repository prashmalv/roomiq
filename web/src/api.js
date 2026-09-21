async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Request failed (${res.status})`);
    err.code = data?.error?.code;
    err.status = res.status;
    err.canWaitlist = !!data?.error?.canWaitlist;
    throw err;
  }
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b) => call('POST', p, b),
  patch: (p, b) => call('PATCH', p, b),
  del: (p) => call('DELETE', p)
};

/* ------------------------------------------------------------- formatting -- */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

export const parseISO = (d) => new Date(`${d}T00:00:00`);
export const fmtDate = (d) => {
  const x = parseISO(d);
  return `${DAYS[x.getDay()]} ${x.getDate()} ${MONTHS[x.getMonth()]}`;
};
export const fmtLongDate = (d) => {
  const x = parseISO(d);
  return `${DAYS[x.getDay()]}, ${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
};
export const fmtMonth = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return `${['January','February','March','April','May','June','July','August','September','October','November','December'][mm - 1]} ${y}`;
};
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addMonths = (m, n) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
export const monthOf = (iso) => iso.slice(0, 7);
export const minutesBetween = (a, b) => {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
};
export const addMinutes = (t, n) => {
  const [h, m] = t.split(':').map(Number);
  // Number(n): a <select> hands back a string, and `900 + '120'` is '900120',
  // which silently became 02:00 instead of 17:00.
  const v = h * 60 + m + Number(n);
  return `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
};
export const durationLabel = (mins) =>
  mins % 60 === 0 ? `${mins / 60} hr${mins === 60 ? '' : 's'}` : `${Math.floor(mins / 60)} hr ${mins % 60} min`;

/**
 * What to tell someone after a booking call. A repeat can partly succeed — some
 * dates taken, the rest booked — and saying "Booking created" to that would be
 * a lie, so the skipped dates are named.
 */
export const bookingFlash = (booking, series) => {
  const slot = `${booking.room.name}, ${booking.start}–${booking.end}`;
  if (series) {
    const made = series.created.length;
    const head = `${made} of ${series.requested} date${series.requested === 1 ? '' : 's'} booked — ${slot}.`;
    return series.skipped.length
      ? `${head} Skipped ${series.skipped.map((s) => s.date).join(', ')} — already taken.`
      : head;
  }
  if (booking.status === 'waitlisted')
    return `You are number ${booking.waitlistPosition} on the waiting list for ${slot} on ${booking.date}. Nothing is reserved — if the room is released it goes to whoever joined first.`;
  if (booking.status === 'contested')
    return `${slot} on ${booking.date} is already claimed by an undecided request. Yours has gone to facilities alongside it — you will be emailed once they decide.`;
  if (booking.status === 'approved')
    return `Confirmed — ${slot} on ${booking.date}.`;
  return `Request sent to facilities — ${slot} on ${booking.date}. You will get an email once it is decided.`;
};
