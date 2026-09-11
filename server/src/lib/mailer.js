import nodemailer from 'nodemailer';
import { createHash, createHmac } from 'node:crypto';
import { config } from '../config.js';
import { q } from './db.js';

/* ---------------------------------------------------------------------------
   Transport is deliberately behind a one-function interface.  Today: SMTP
   (Microsoft 365 / any relay) or `log` for local work.  Swapping in Azure
   Communication Services or SendGrid means adding one branch here and three
   app settings — no route or template changes.
--------------------------------------------------------------------------- */
let transport = null;
function getTransport() {
  if (config.mail.driver !== 'smtp') return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined
    });
  }
  return transport;
}

/* ---------------------------------------------------------------------------
   Azure Communication Services Email, over its REST API rather than its SMTP
   front door: SMTP there needs an Entra app registration and tenant-level SMTP
   AUTH, while this needs only the resource's access key. Signed with the ACS
   HMAC scheme, which is a content hash plus date and host — no SDK required.
--------------------------------------------------------------------------- */
async function acsSend({ to, toName, subject, html, text }) {
  const { acsEndpoint, acsKey, from } = config.mail;
  if (!acsEndpoint || !acsKey) throw new Error('ACS_ENDPOINT and ACS_ACCESS_KEY must both be set.');

  // "RoomIQ <donotreply@x.azurecomm.net>" → the bare address ACS wants.
  const senderAddress = (from.match(/<([^>]+)>/)?.[1] || from).trim();
  const path = '/emails:send?api-version=2023-03-31';
  const url = new URL(acsEndpoint + path);
  const body = JSON.stringify({
    senderAddress,
    content: { subject, plainText: text, html },
    recipients: { to: [{ address: to, displayName: toName || to }] }
  });

  const contentHash = createHash('sha256').update(body, 'utf8').digest('base64');
  const date = new Date().toUTCString();
  const stringToSign = `POST
${url.pathname}${url.search}
${date};${url.host};${contentHash}`;
  const signature = createHmac('sha256', Buffer.from(acsKey, 'base64'))
    .update(stringToSign, 'utf8').digest('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ms-date': date,
      'x-ms-content-sha256': contentHash,
      Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
    },
    body
  });

  // 202 Accepted is the success case; ACS then delivers asynchronously.
  if (!res.ok) throw new Error(`ACS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.headers.get('operation-location') || res.headers.get('x-ms-request-id') || 'accepted';
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function shell(heading, eyebrow, rows, bodyLines, cta) {
  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 16px 8px 0;font:500 11px/1.4 Arial,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:#0B5FA5;white-space:nowrap;vertical-align:top">${esc(
          k
        )}</td><td style="padding:8px 0;font:400 15px/1.5 Arial,sans-serif;color:#10161D">${esc(v)}</td></tr>`
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#F3F7FA;padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fff">
<tr><td style="background:#0A3D6E;padding:24px 28px">
  <div style="font:500 11px/1.4 Arial,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#1E8FD5">${esc(eyebrow)}</div>
  <div style="font:500 26px/1.15 Georgia,serif;color:#fff;margin-top:8px">${esc(heading)}</div>
</td></tr>
<tr><td style="padding:28px">
  <table role="presentation" cellpadding="0" cellspacing="0">${rowHtml}</table>
  ${bodyLines
    .map(
      (l) =>
        `<p style="font:400 15px/1.6 Arial,sans-serif;color:#4A5561;margin:20px 0 0">${esc(l)}</p>`
    )
    .join('')}
  ${
    cta
      ? `<p style="margin:24px 0 0"><a href="${esc(cta.url)}" style="display:inline-block;background:#0B5FA5;color:#fff;font:500 14px/1 Arial,sans-serif;padding:12px 18px;text-decoration:none;border-radius:2px">${esc(
          cta.label
        )}</a></p>`
      : ''
  }
</td></tr>
<tr><td style="border-top:1px solid #D8DEE4;padding:16px 28px;font:400 11px/1.5 Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#7A8590">RoomIQ &nbsp;·&nbsp; ${esc(
    config.mail.from.replace(/.*<|>.*/g, '') || 'RoomIQ'
  )}</td></tr>
</table></body></html>`;
}

const fmtDate = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });

const slotRows = (b) => [
  ['Room', b.room_name],
  ['Date', fmtDate(b.booking_date)],
  ['Time', `${b.start_time.slice(0, 5)} – ${b.end_time.slice(0, 5)}`],
  ['Meeting', b.title],
  ['Booked for', `${b.for_name} (${b.for_email})`]
];

export const templates = {
  booking_requested: (b) => ({
    subject: `Approval needed — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Awaiting approval',
    heading: 'A room request needs your decision',
    rows: slotRows(b).concat([['Requested by', b.by_name]]),
    lines: [b.purpose ? `Purpose: ${b.purpose}` : 'No purpose was recorded.'],
    cta: { label: 'Review request', url: `${config.publicUrl}/admin/approvals` }
  }),
  booking_approved: (b) => ({
    subject: `Approved — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Booking confirmed',
    heading: 'Your room is confirmed',
    rows: slotRows(b),
    lines: [
      'Open your booking pass if someone else is already sitting in the room — it shows the room, the time and your name as proof of the confirmed slot.'
    ],
    cta: { label: 'Open booking pass', url: `${config.publicUrl}/pass/${b.pass_code}` }
  }),
  booking_rejected: (b) => ({
    subject: `Not approved — ${b.room_name}, ${fmtDate(b.booking_date)}`,
    eyebrow: 'Request declined',
    heading: 'Your room request was not approved',
    rows: slotRows(b),
    lines: [b.decision_note ? `Reason: ${b.decision_note}` : 'No reason was recorded.',
            'The slot is free again — you can pick another room or time from the dashboard.'],
    cta: { label: 'Find another slot', url: `${config.publicUrl}/` }
  }),
  booking_cancelled: (b) => ({
    subject: `Cancelled — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Booking cancelled',
    heading: 'This booking has been cancelled',
    rows: slotRows(b),
    lines: [b.decision_note ? `Note: ${b.decision_note}` : 'The slot is available again.'],
    cta: { label: 'Open RoomIQ', url: `${config.publicUrl}/` }
  }),
  booking_allocated: (b) => ({
    subject: `Room allocated — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Allocated by admin',
    heading: 'A room has been allocated to you',
    rows: slotRows(b).concat([['Allocated by', b.by_name]]),
    lines: ['No approval is needed — the slot is already confirmed in your name.'],
    cta: { label: 'Open booking pass', url: `${config.publicUrl}/pass/${b.pass_code}` }
  }),
  booking_auto_approved: (b) => ({
    subject: `Confirmed — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Confirmed automatically',
    heading: 'Your room is confirmed — no approval needed',
    rows: slotRows(b),
    lines: [
      'The room was free, so RoomIQ confirmed this booking straight away under the senior leadership policy. Facilities have been notified for their records.',
      'Open your booking pass if someone else is already sitting in the room.'
    ],
    cta: { label: 'Open booking pass', url: `${config.publicUrl}/pass/${b.pass_code}` }
  }),
  booking_auto_approved_notice: (b) => ({
    subject: `Auto-confirmed — ${b.for_name}, ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'No action needed',
    heading: 'A senior leadership booking was confirmed by the system',
    rows: slotRows(b).concat([['Decision', 'Approved by system']]),
    lines: [
      'The room was free at the requested time and the senior leadership auto-approval policy is on, so this was confirmed without waiting for a decision.',
      'It appears in the approvals register as approved by system. Cancel it there if it needs to be undone.'
    ],
    cta: { label: 'Open approvals', url: `${config.publicUrl}/admin/approvals` }
  }),
  booking_contested: (b) => ({
    subject: `Clash — ${b.for_name} wants ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Two requests, one slot',
    heading: 'A senior leadership request is waiting on an undecided slot',
    rows: slotRows(b).concat([['Requested by', b.by_name]]),
    lines: [
      'Someone asked for this slot first and that request is still undecided, so nothing has been taken from them — both requests are now in front of you.',
      'Confirming the earlier request closes this one automatically. To confirm this one instead, decline the earlier request first; the slot is only released once that is decided.'
    ],
    cta: { label: 'Open approvals', url: `${config.publicUrl}/admin/approvals` }
  }),
  booking_contested_ack: (b) => ({
    subject: `Waiting on a decision — ${b.room_name}, ${fmtDate(b.booking_date)} ${b.start_time.slice(0, 5)}`,
    eyebrow: 'Not confirmed yet',
    heading: 'Someone asked for this slot before you',
    rows: slotRows(b),
    lines: [
      'Their request has not been decided yet, so the room is not free to give you — your request has been put in front of facilities alongside theirs rather than being turned away.',
      'You will be emailed as soon as it is decided either way. If you need certainty now, book a different slot.'
    ],
    cta: { label: 'Find another slot', url: `${config.publicUrl}/` }
  }),
  account_registered: (b) => ({
    subject: 'Your RoomIQ account is ready',
    eyebrow: 'Welcome',
    heading: 'You can now book meeting rooms',
    rows: [['Email', b.for_email], ['Role', 'Employee']],
    lines: [
      'You signed up with your Uneecops work email, so your account is active straight away — no approval needed to sign in.',
      'Room requests you raise do go to facilities for approval, and you will be emailed either way.'
    ],
    cta: { label: 'Open RoomIQ', url: `${config.publicUrl}/` }
  }),
  account_created: (b) => ({
    subject: 'Your RoomIQ account is ready',
    eyebrow: 'Welcome',
    heading: 'You can now book meeting rooms',
    rows: [['Email', b.for_email], ['Temporary password', b.temp_password], ['Role', b.role]],
    lines: ['Please sign in and change your password from your profile.'],
    cta: { label: 'Sign in', url: `${config.publicUrl}/login` }
  })
};

/** Persist first, send second. Returns the outbox row id. */
export async function queueMail(kind, to, payload, bookingId = null) {
  const t = templates[kind](payload);
  const html = shell(t.heading, t.eyebrow, t.rows, t.lines, t.cta);
  const text =
    `${t.heading}\n\n` +
    t.rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\n${t.lines.join('\n')}` +
    (t.cta ? `\n\n${t.cta.label}: ${t.cta.url}` : '');

  const { rows } = await q(
    `INSERT INTO email_outbox (booking_id, kind, to_email, to_name, subject, body_html, body_text)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [bookingId, kind, to.email, to.name || null, t.subject, html, text]
  );
  return rows[0].id;
}

/** Drain the outbox. Called after each mutation and by a 60s interval. */
export async function flushOutbox(limit = 25) {
  const { rows } = await q(
    `SELECT id, to_email, to_name, subject, body_html, body_text
       FROM email_outbox
      WHERE status = 'queued' AND attempts < 5
      ORDER BY created_at LIMIT $1`,
    [limit]
  );
  if (!rows.length) return { sent: 0, skipped: 0, failed: 0 };

  const acs = config.mail.driver === 'acs';
  const tp = acs ? null : getTransport();
  let sent = 0, skipped = 0, failed = 0;

  for (const m of rows) {
    if (!acs && !tp) {
      await q(`UPDATE email_outbox SET status='skipped', attempts=attempts+1, sent_at=now(),
               last_error='no transport configured (MAIL_DRIVER=log)' WHERE id=$1`, [m.id]);
      skipped++;
      console.log(`[mail:log] → ${m.to_email} :: ${m.subject}`);
      continue;
    }
    try {
      if (acs) {
        await acsSend({
          to: m.to_email, toName: m.to_name,
          subject: m.subject, html: m.body_html, text: m.body_text
        });
      } else {
        await tp.sendMail({
          from: config.mail.from,
          to: m.to_name ? `${m.to_name} <${m.to_email}>` : m.to_email,
          subject: m.subject,
          html: m.body_html,
          text: m.body_text
        });
      }
      await q(`UPDATE email_outbox SET status='sent', attempts=attempts+1, sent_at=now() WHERE id=$1`, [m.id]);
      sent++;
    } catch (e) {
      await q(`UPDATE email_outbox SET status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'queued' END,
               attempts=attempts+1, last_error=$2 WHERE id=$1`, [m.id, e.message]);
      failed++;
      console.error(`[mail] send failed → ${m.to_email}: ${e.message}`);
    }
  }
  return { sent, skipped, failed };
}

/** Fire-and-forget flush so a request never waits on SMTP. */
export const flushSoon = () => setTimeout(() => flushOutbox().catch(() => {}), 50);

export async function adminRecipients() {
  const { rows } = await q(
    `SELECT name, email FROM users WHERE role='admin' AND is_active ORDER BY name`
  );
  if (rows.length) return rows;
  return config.mail.adminFallback ? [{ name: 'Administrator', email: config.mail.adminFallback }] : [];
}
