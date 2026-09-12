import dotenv from 'dotenv';
dotenv.config();

const bool = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  env:  process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 8080),

  // Azure App Service injects the public hostname; used in email links.
  publicUrl:
    process.env.PUBLIC_URL ||
    (process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : 'http://localhost:8080'),

  db: {
    connectionString: process.env.DATABASE_URL,
    // Azure Database for PostgreSQL requires TLS. Locally it does not.
    ssl: bool(process.env.PGSSL, /azure|postgres\.database/.test(process.env.DATABASE_URL || ''))
      ? { rejectUnauthorized: false }
      : false,
    max: Number(process.env.PGPOOL_MAX || 10)
  },

  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  cookieSecure: bool(process.env.COOKIE_SECURE, process.env.NODE_ENV === 'production'),

  timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',

  seedAdminEmail: (process.env.SEED_ADMIN_EMAIL || 'admin@uneecops.in').toLowerCase(),
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@123',
  seedDemoData: bool(process.env.SEED_DEMO_DATA, true),

  mail: {
    // driver: acs | smtp | log — one branch each in mailer.js
    driver: process.env.MAIL_DRIVER ||
            (process.env.ACS_ENDPOINT ? 'acs' : process.env.SMTP_HOST ? 'smtp' : 'log'),
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || 'UneeRooms <no-reply@uneecops.in>',
    adminFallback: (process.env.MAIL_ADMIN_FALLBACK || '').toLowerCase(),
    // Azure Communication Services: REST + access key, so there is no SMTP AUTH
    // to have enabled on a tenant and no mailbox password to rotate.
    acsEndpoint: (process.env.ACS_ENDPOINT || '').replace(/\/+$/, ''),
    acsKey: process.env.ACS_ACCESS_KEY
  }
};

if (!config.db.connectionString) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}
if (config.env === 'production' && config.jwtSecret.startsWith('dev-only')) {
  console.error('FATAL: JWT_SECRET must be set in production.');
  process.exit(1);
}
