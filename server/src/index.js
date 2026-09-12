import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { pool } from './lib/db.js';
import { migrate } from './lib/migrate.js';
import { ensureAdmin } from './lib/bootstrap.js';
import { flushOutbox, verifyDeliveries } from './lib/mailer.js';
import { AppError } from './lib/rules.js';

import { authRouter } from './routes/auth.js';
import { roomsRouter } from './routes/rooms.js';
import { availabilityRouter } from './routes/availability.js';
import { bookingsRouter } from './routes/bookings.js';
import { adminRouter } from './routes/admin.js';
import { passRouter } from './routes/pass.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', '..', 'web', 'dist');

const app = express();
app.set('trust proxy', 1);                 // Azure App Service sits behind a proxy
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, env: config.env }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);
app.use('/api/availability', availabilityRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/pass', passRouter);

app.use('/api', (_req, _res, next) => next(new AppError(404, 'NO_ROUTE', 'Unknown endpoint.')));

// Single-origin deployment: the API and the built SPA share one App Service.
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(join(webDist, 'index.html')));
}

// ---------------------------------------------------------------- errors ----
app.use((err, _req, res, _next) => {
  if (err?.name === 'ZodError') {
    return res.status(400).json({
      error: { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'field'}: ${i.message}`).join('; ') }
    });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL',
      message: status >= 500 ? 'Something went wrong on our side.' : err.message,
      ...(err.maxDate ? { maxDate: err.maxDate } : {})
    }
  });
});

// ------------------------------------------------------------------ boot ----
const boot = async () => {
  await migrate();
  await ensureAdmin();
  setInterval(() => {
    flushOutbox().catch(() => {});
    verifyDeliveries().catch(() => {});
  }, 60_000).unref();
  app.listen(config.port, () =>
    console.log(`UneeRooms listening on :${config.port}  (${config.env}, tz ${config.timezone}, mail ${config.mail.driver})`)
  );
};

boot().catch((e) => { console.error('boot failed:', e); process.exit(1); });

const shutdown = async () => { await pool.end().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
