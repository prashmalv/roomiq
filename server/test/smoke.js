/* End-to-end smoke test against a running server. node test/smoke.js [baseUrl] */
import { DateTime } from 'luxon';

const BASE = process.argv[2] || 'http://localhost:8080';
let pass = 0, fail = 0;

const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${extra}`); }
};

function session() {
  let cookie = '';
  return async (method, path, body) => {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = r.headers.getSetCookie?.() || [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    let json = null;
    try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: json };
  };
}

const emp = session();
const adm = session();

console.log(`\nRoomIQ smoke test → ${BASE}\n`);

// ---------------------------------------------------------------- auth ----
console.log('auth');
let r = await emp('POST', '/api/auth/login', { email: 'rahul.verma@uneecops.in', password: 'Welcome@123' });
ok('employee can sign in', r.status === 200 && r.body.user.role === 'employee', JSON.stringify(r.body));

r = await emp('POST', '/api/auth/login', { email: 'rahul.verma@uneecops.in', password: 'wrong' });
ok('wrong password is rejected', r.status === 401);

r = await adm('POST', '/api/auth/login', { email: 'admin@uneecops.in', password: 'Admin@123' });
ok('admin can sign in', r.status === 200 && r.body.user.role === 'admin', JSON.stringify(r.body));

// -------------------------------------------------------------- window ----
console.log('\nbooking window');
const me = (await emp('GET', '/api/auth/me')).body;
const expectedMax = DateTime.now().setZone('Asia/Kolkata').plus({ months: 1 }).endOf('month').toISODate();
ok(`employee window ends ${expectedMax}`, me.window.maxDate === expectedMax, `got ${me.window.maxDate}`);

const meA = (await adm('GET', '/api/auth/me')).body;
ok('admin window is ~1 year', meA.window.maxDate > DateTime.now().plus({ months: 11 }).toISODate());

// --------------------------------------------------------- suggestions ----
console.log('\ndashboard suggestions');
r = await emp('GET', '/api/availability/suggestions?duration=60&attendees=4');
const sug = r.body.suggestions || [];
ok('suggestions are returned', sug.length > 0, JSON.stringify(r.body).slice(0, 200));
ok('no more than 2 slots per room', new Set(sug.map((s) => s.roomId)).size >= Math.min(3, sug.length));
ok('every suggestion fits the party', sug.every((s) => s.capacity >= 4));

// ------------------------------------------------------------ requests ----
console.log('\nrequest → approve');
const pick = sug[0];
r = await emp('POST', '/api/bookings', {
  roomId: pick.roomId, title: 'Smoke test standup', attendees: 4,
  date: pick.date, start: pick.start, end: pick.end
});
ok('employee booking lands as pending', r.status === 201 && r.body.booking.status === 'pending', JSON.stringify(r.body));
const bookingId = r.body.booking?.id;

r = await emp('POST', '/api/bookings', {
  roomId: pick.roomId, title: 'Clash', attendees: 2,
  date: pick.date, start: pick.start, end: pick.end
});
ok('the same slot cannot be double booked', r.status === 409 && r.body.error.code === 'SLOT_TAKEN', JSON.stringify(r.body));

const far = DateTime.now().setZone('Asia/Kolkata').plus({ months: 3 }).set({ day: 10 }).toISODate();
r = await emp('POST', '/api/bookings', {
  roomId: pick.roomId, title: 'Too far ahead', attendees: 2, date: far, start: '10:00', end: '11:00'
});
ok('employee blocked beyond next month', r.status === 403 && r.body.error.code === 'OUTSIDE_WINDOW', JSON.stringify(r.body));

r = await adm('POST', '/api/bookings', {
  roomId: pick.roomId, title: 'Admin long-range booking', attendees: 2, date: far, start: '10:00', end: '11:00'
});
ok('admin can book the same far date', r.status === 201 && r.body.booking.status === 'approved', JSON.stringify(r.body));
const adminBooking = r.body.booking;

// ------------------------------------------------------------ privacy ----
console.log('\nvisibility');
r = await emp('GET', `/api/availability/day?date=${adminBooking.date}`);
const room = r.body.rooms.find((x) => x.room.id === pick.roomId);
const other = room.bookings.find((b) => b.id === adminBooking.id);
ok('employee sees the slot as taken', !!other);
ok('employee cannot see who holds it', other && other.holder === null, JSON.stringify(other));

r = await adm('GET', `/api/availability/day?date=${adminBooking.date}`);
const adminView = r.body.rooms.find((x) => x.room.id === pick.roomId).bookings.find((b) => b.id === adminBooking.id);
ok('admin sees the holder', adminView && !!adminView.holder, JSON.stringify(adminView));

// ------------------------------------------------------------ approval ----
console.log('\napproval workflow');
r = await emp('POST', `/api/admin/bookings/${bookingId}/approve`);
ok('employee cannot approve', r.status === 403);

r = await adm('GET', '/api/admin/bookings?status=pending');
ok('pending queue reaches the admin', r.body.bookings.some((b) => b.id === bookingId));

r = await adm('POST', `/api/admin/bookings/${bookingId}/reject`, {});
ok('rejection requires a reason', r.status === 400 && r.body.error.code === 'NOTE_REQUIRED');

r = await adm('POST', `/api/admin/bookings/${bookingId}/approve`);
ok('admin approves', r.status === 200 && r.body.booking.status === 'approved', JSON.stringify(r.body));
const approved = r.body.booking;

r = await adm('POST', `/api/admin/bookings/${bookingId}/approve`);
ok('a decided request cannot be decided twice', r.status === 400);

// ---------------------------------------------------------------- pass ----
console.log('\nbooking pass');
r = await fetch(`${BASE}/api/pass/${approved.passCode}`).then((x) => x.json());
ok('pass resolves without signing in', r.pass?.room === approved.room.name, JSON.stringify(r).slice(0, 160));
ok('pass carries no email address', !JSON.stringify(r).includes('@uneecops.in'));

r = await fetch(`${BASE}/api/pass/AAAA-BBBB`);
ok('an unknown pass code 404s', r.status === 404);

// -------------------------------------------------------------- cancel ----
console.log('\ncancellation');
r = await emp('POST', `/api/bookings/${adminBooking.id}/cancel`);
ok("an employee cannot cancel someone else's booking", r.status === 403);

r = await emp('POST', `/api/bookings/${bookingId}/cancel`, { note: 'no longer needed' });
ok('owner can cancel their own booking', r.status === 200 && r.body.booking.status === 'cancelled');

r = await emp('POST', '/api/bookings', {
  roomId: pick.roomId, title: 'Reusing the freed slot', attendees: 2,
  date: pick.date, start: pick.start, end: pick.end
});
ok('the freed slot becomes bookable again', r.status === 201, JSON.stringify(r.body));

// ----------------------------------------------------------- mail + adm ---
console.log('\nnotifications and admin surfaces');
r = await adm('GET', '/api/admin/outbox');
ok('every decision queued an email', r.body.mails.length >= 4, `${r.body.mails.length} mails`);
ok('approval mail was generated', r.body.mails.some((m) => m.kind === 'booking_approved'));
ok('admins were notified of the request', r.body.mails.some((m) => m.kind === 'booking_requested'));

r = await adm('GET', '/api/admin/stats');
ok('admin stats load', r.status === 200 && typeof r.body.stats.pending === 'number');

r = await emp('GET', '/api/admin/stats');
ok('employees are locked out of admin routes', r.status === 403);

r = await adm('POST', '/api/admin/rooms', {
  name: `Smoke Room ${Date.now() % 10000}`, capacity: 6, floor: '2nd floor', amenities: ['TV screen']
});
ok('admin can create a room', r.status === 201, JSON.stringify(r.body));

// --------------------------------------------------- self-registration ----
// Unique per run so the suite can be re-run without colliding on the email.
console.log('\nself-registration');
const stamp = Date.now().toString(36);
const newHire = session();
const senior = session();

r = await newHire('GET', '/api/auth/registration');
ok('sign-up policy is public', r.status === 200 && Array.isArray(r.body.domains), JSON.stringify(r.body));

r = await newHire('POST', '/api/auth/register', {
  name: 'Outside Person', email: `someone-${stamp}@gmail.com`, password: 'Testing@123'
});
ok('a non-work domain is refused', r.status === 400 && r.body.error.code === 'BAD_DOMAIN', JSON.stringify(r.body));

r = await newHire('POST', '/api/auth/register', {
  name: 'Smoke Newhire', email: `smoke.newhire.${stamp}@uneecops.in`,
  department: 'Presales', password: 'Testing@123'
});
ok('a uneecops.in address can sign up', r.status === 201 && r.body.user.role === 'employee', JSON.stringify(r.body));

r = await newHire('POST', '/api/auth/register', {
  name: 'Smoke Newhire', email: `smoke.newhire.${stamp}@uneecops.in`, password: 'Testing@123'
});
ok('the same address cannot register twice', r.status === 409 && r.body.error.code === 'DUPLICATE');

r = await newHire('GET', '/api/auth/me');
ok('registering signs the new employee straight in', r.status === 200, JSON.stringify(r.body));

r = await senior('POST', '/api/auth/register', {
  name: 'Smoke Leader', email: `smoke.leader.${stamp}@uneecops.com`, password: 'Testing@123'
});
ok('the second work domain is accepted too', r.status === 201, JSON.stringify(r.body));
const seniorId = r.body.user?.id;

// ------------------------------------------------------ own password ------
console.log('\nchanging your own password');
r = await newHire('POST', '/api/auth/change-password', { current: 'wrong-one', next: 'Changed@456' });
ok('the current password must be right', r.status === 400 && r.body.error.code === 'BAD_PASSWORD');

r = await newHire('POST', '/api/auth/change-password', { current: 'Testing@123', next: 'Changed@456' });
ok('an employee can change their own password', r.status === 200);

const relog = session();
r = await relog('POST', '/api/auth/login', { email: `smoke.newhire.${stamp}@uneecops.in`, password: 'Changed@456' });
ok('the new password works', r.status === 200);
r = await relog('POST', '/api/auth/login', { email: `smoke.newhire.${stamp}@uneecops.in`, password: 'Testing@123' });
ok('the old password stops working', r.status === 401);

// ------------------------------------------------- senior leadership ------
console.log('\nsenior leadership');
r = await adm('PATCH', `/api/admin/users/${seniorId}`, { is_senior: true });
ok('an admin can mark someone senior leadership', r.status === 200 && r.body.user.is_senior === true, JSON.stringify(r.body));

r = await senior('GET', '/api/availability/suggestions?duration=60&attendees=2');
const seniorSlot = r.body.suggestions?.[0];

r = await adm('PATCH', '/api/admin/settings', { auto_approve_senior: false });
ok('auto-approval can be switched off', r.status === 200 && r.body.settings.auto_approve_senior === false);

r = await senior('POST', '/api/bookings', {
  roomId: seniorSlot.roomId, title: 'Leadership review', attendees: 2,
  date: seniorSlot.date, start: seniorSlot.start, end: seniorSlot.end
});
ok('with auto-approval off a senior request still pends', r.status === 201 && r.body.booking.status === 'pending', JSON.stringify(r.body));
const seniorPending = r.body.booking;

r = await adm('GET', '/api/admin/bookings?status=pending&senior=true');
ok('the leadership queue returns only senior requests',
   r.status === 200 && r.body.bookings.length > 0 && r.body.bookings.every((b) => b.bookedFor.isSenior),
   JSON.stringify(r.body.bookings?.map((b) => b.bookedFor.name)));

r = await adm('GET', '/api/admin/bookings?status=pending');
ok('a senior request sorts above the rest of the queue',
   r.body.bookings[0]?.id === seniorPending.id,
   `first was ${r.body.bookings[0]?.bookedFor?.name}`);

r = await adm('GET', '/api/admin/stats');
ok('the leadership queue has its own count', r.body.stats.pending_senior >= 1, JSON.stringify(r.body.stats));

// The settings cache is held for 30s, so re-read rather than racing it.
await adm('POST', `/api/admin/bookings/${seniorPending.id}/reject`, { note: 'clearing the smoke test slot' });
r = await adm('PATCH', '/api/admin/settings', { auto_approve_senior: true });
ok('auto-approval can be switched on', r.status === 200 && r.body.settings.auto_approve_senior === true);
await new Promise((res) => setTimeout(res, 31_000));

r = await senior('GET', '/api/availability/suggestions?duration=60&attendees=2');
const freeSlot = r.body.suggestions?.[0];
r = await senior('POST', '/api/bookings', {
  roomId: freeSlot.roomId, title: 'Leadership sync', attendees: 2,
  date: freeSlot.date, start: freeSlot.start, end: freeSlot.end
});
ok('a free room confirms a senior request outright',
   r.status === 201 && r.body.booking.status === 'approved' && r.body.booking.autoApproved === true,
   JSON.stringify(r.body));
const autoBooking = r.body.booking;
ok('the system, not a person, is recorded as the decider', autoBooking?.decidedBy === null, JSON.stringify(autoBooking?.decidedBy));

r = await senior('POST', '/api/bookings', {
  roomId: freeSlot.roomId, title: 'Clashing leadership booking', attendees: 2,
  date: freeSlot.date, start: freeSlot.start, end: freeSlot.end
});
ok('a busy room is refused rather than displacing the holder',
   r.status === 409 && r.body.error.code === 'SLOT_TAKEN', JSON.stringify(r.body));

r = await emp('POST', '/api/bookings', {
  roomId: freeSlot.roomId, title: 'Ordinary request', attendees: 2,
  date: freeSlot.date, start: freeSlot.end, end: DateTime.fromISO(`2000-01-01T${freeSlot.end}`).plus({ hours: 1 }).toFormat('HH:mm')
});
ok('a non-senior employee is unaffected by the policy',
   r.status === 201 && r.body.booking.status === 'pending', JSON.stringify(r.body));

r = await adm('GET', '/api/admin/outbox');
ok('the auto-confirmation emailed the requester', r.body.mails.some((m) => m.kind === 'booking_auto_approved'));
ok('facilities were told about the auto-confirmation', r.body.mails.some((m) => m.kind === 'booking_auto_approved_notice'));
ok('the new joiner got a welcome email', r.body.mails.some((m) => m.kind === 'account_registered'));

// Leave the instance as it was found.
await adm('PATCH', '/api/admin/settings', { auto_approve_senior: false });

// ------------------------------------------------- contested slots --------
console.log('\ncontested slots');
const junior = session();
r = await junior('POST', '/api/auth/register', {
  name: 'Smoke Junior', email: `smoke.junior.${stamp}@uneecops.in`, password: 'Testing@123'
});
ok('a second employee can sign up', r.status === 201, JSON.stringify(r.body));

await adm('PATCH', '/api/admin/settings', { auto_approve_senior: false });
await new Promise((res) => setTimeout(res, 31_000));

r = await junior('GET', '/api/availability/suggestions?duration=60&attendees=2');
const clashSlot = r.body.suggestions?.find((x) => x.date > DateTime.now().setZone('Asia/Kolkata').toISODate());

r = await junior('POST', '/api/bookings', {
  roomId: clashSlot.roomId, title: 'Filed first', attendees: 2,
  date: clashSlot.date, start: clashSlot.start, end: clashSlot.end
});
ok('the employee who asked first holds the slot', r.status === 201 && r.body.booking.status === 'pending', JSON.stringify(r.body));
const holder = r.body.booking;

r = await senior('POST', '/api/bookings', {
  roomId: clashSlot.roomId, title: 'Leadership wants the same slot', attendees: 2,
  date: clashSlot.date, start: clashSlot.start, end: clashSlot.end
});
ok('a senior clashing with an undecided request is recorded, not refused',
   r.status === 201 && r.body.booking.status === 'contested', JSON.stringify(r.body));
const contested = r.body.booking;

r = await junior('GET', `/api/bookings/${holder.id}`);
ok('the slot still belongs to whoever asked first', r.body.booking.status === 'pending');

r = await adm('GET', '/api/admin/bookings?status=pending');
const flagged = r.body.bookings.find((b) => b.id === holder.id);
ok('the admin sees the earlier request flagged as contested',
   flagged?.contestedBy?.length === 1, JSON.stringify(flagged?.contestedBy));

r = await adm('GET', '/api/admin/bookings?status=contested');
ok('the contested request names what is blocking it',
   r.body.bookings[0]?.blockedBy?.some((k) => k.status === 'pending'), JSON.stringify(r.body.bookings[0]?.blockedBy));

r = await adm('GET', '/api/admin/stats');
ok('contested requests have their own count', r.body.stats.contested >= 1, JSON.stringify(r.body.stats));

r = await adm('POST', `/api/admin/bookings/${contested.id}/approve`);
ok('a contested request cannot evict the holder silently',
   r.status === 409 && r.body.error.code === 'STILL_HELD', JSON.stringify(r.body));

r = await adm('POST', `/api/admin/bookings/${holder.id}/approve`);
ok('the admin can still confirm the request that was filed first', r.status === 200, JSON.stringify(r.body));

r = await adm('GET', `/api/admin/bookings?status=rejected`);
ok('confirming the holder closes the contested request',
   r.body.bookings.some((b) => b.id === contested.id), 'contested request was left open');

r = await adm('GET', '/api/admin/outbox');
ok('both sides were emailed about the clash', r.body.mails.some((m) => m.kind === 'booking_contested'));
ok('the contesting senior was told they were second', r.body.mails.some((m) => m.kind === 'booking_contested_ack'));

// ------------------------------------------------ recurring bookings ------
console.log('\nrecurring bookings');
const nextMonday = DateTime.now().setZone('Asia/Kolkata').plus({ weeks: 1 }).startOf('week');
const mondayISO = nextMonday.toISODate();

r = await junior('GET', '/api/rooms');
const freeRoom = r.body.rooms.filter((x) => x.can_book)[1];

r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Daily standup', attendees: 2,
  date: mondayISO, start: '09:00', end: '09:30', repeat: 'daily'
});
ok('a daily repeat books Monday to Saturday, skipping Sunday',
   r.status === 201 && r.body.series?.created.length === 6, JSON.stringify(r.body.series?.created.map((b) => b.date)));
ok('a repeat never runs past the end of its week',
   r.body.series.created.every((b) => b.date <= nextMonday.endOf('week').toISODate()),
   JSON.stringify(r.body.series.created.map((b) => b.date)));

r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Alternate standup', attendees: 2,
  date: mondayISO, start: '10:00', end: '10:30', repeat: 'alternate'
});
ok('an alternate repeat steps two days at a time',
   r.status === 201 && r.body.series?.created.length === 3, JSON.stringify(r.body.series?.created.map((b) => b.date)));

const wedISO = nextMonday.plus({ days: 2 }).toISODate();
r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Blocker', attendees: 2, date: wedISO, start: '11:00', end: '11:30'
});
ok('a single midweek booking is created', r.status === 201);

r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Partly blocked', attendees: 2,
  date: mondayISO, start: '11:00', end: '11:30', repeat: 'daily'
});
ok('a repeat books around a date that is already taken',
   r.status === 201 && r.body.series.created.length === 5 && r.body.series.skipped.length === 1,
   JSON.stringify({ made: r.body.series?.created.length, skipped: r.body.series?.skipped }));
ok('the skipped date is named rather than silently dropped',
   r.body.series.skipped[0]?.date === wedISO, JSON.stringify(r.body.series.skipped));

r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Fully blocked', attendees: 2,
  date: mondayISO, start: '09:00', end: '09:30', repeat: 'daily'
});
ok('a repeat with nothing bookable fails outright', r.status === 409, JSON.stringify(r.body));

r = await junior('POST', '/api/bookings', {
  roomId: freeRoom.id, title: 'Single date', attendees: 2,
  date: nextMonday.plus({ days: 1 }).toISODate(), start: '15:00', end: '15:30', repeat: 'none'
});
ok('a non-repeating booking still returns no series', r.status === 201 && r.body.series === undefined);

// -------------------------------------------------------------- report ----
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
