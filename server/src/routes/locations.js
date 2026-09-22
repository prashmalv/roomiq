import { Router } from 'express';
import { z } from 'zod';
import { q, audit } from '../lib/db.js';
import { requireAuth, requireAdmin, requireSuperadmin, adminLocationIds } from '../lib/auth.js';
import { AppError } from '../lib/rules.js';

export const locationsRouter = Router();

/* Everyone signed in needs the office list: it is how the booking screens let
   someone pick a room in a city other than their own. */
locationsRouter.get('/', requireAuth, async (_req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT l.id, l.name, l.city, l.region, l.country, l.is_active,
              COALESCE(json_agg(json_build_object('id', br.id, 'name', br.name, 'address', br.address)
                                ORDER BY br.name) FILTER (WHERE br.id IS NOT NULL AND br.is_active), '[]') AS branches,
              (SELECT count(*) FROM rooms r
                 JOIN branches b2 ON b2.id = r.branch_id
                WHERE b2.location_id = l.id AND r.is_active)::int AS rooms
         FROM locations l
         LEFT JOIN branches br ON br.location_id = l.id
        WHERE l.is_active
        GROUP BY l.id
        ORDER BY l.sort_order, l.name`
    );
    res.json({ locations: rows });
  } catch (e) { next(e); }
});

/* ------------------------------------------------- administering offices -- */
const adminRouter = Router();
locationsRouter.use('/admin', requireAuth, requireAdmin, adminRouter);

/** Offices with their administrators. Scoped: an admin sees their own offices. */
adminRouter.get('/', async (req, res, next) => {
  try {
    const scope = await adminLocationIds(req.user);
    const { rows } = await q(
      `SELECT l.*,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id', br.id, 'name', br.name,
                                                            'address', br.address, 'is_active', br.is_active))
                       FILTER (WHERE br.id IS NOT NULL), '[]') AS branches,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email))
                       FILTER (WHERE u.id IS NOT NULL), '[]') AS admins,
              (SELECT count(*) FROM rooms r JOIN branches b2 ON b2.id = r.branch_id
                WHERE b2.location_id = l.id)::int AS rooms
         FROM locations l
         LEFT JOIN branches br ON br.location_id = l.id
         LEFT JOIN location_admins la ON la.location_id = l.id
         LEFT JOIN users u ON u.id = la.user_id AND u.is_active
        WHERE ($1::uuid[] IS NULL OR l.id = ANY($1))
        GROUP BY l.id ORDER BY l.sort_order, l.name`,
      [scope]
    );
    res.json({ locations: rows, scoped: scope !== null });
  } catch (e) { next(e); }
});

adminRouter.post('/', requireSuperadmin, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(60),
      city: z.string().trim().min(2).max(60),
      region: z.string().trim().max(60).optional().nullable(),
      country: z.string().trim().max(60).default('India'),
      sort_order: z.number().int().min(0).max(999).default(500)
    }).parse(req.body);
    const { rows } = await q(
      `INSERT INTO locations (name, city, region, country, sort_order)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.name, b.city, b.region || null, b.country, b.sort_order]
    );
    await audit(req.user.id, 'location.create', 'location', rows[0].id, { name: b.name });
    res.status(201).json({ location: rows[0] });
  } catch (e) {
    if (e.code === '23505') return next(new AppError(409, 'DUPLICATE', 'An office with that name already exists.'));
    next(e);
  }
});

adminRouter.patch('/:id', requireSuperadmin, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      city: z.string().trim().min(2).max(60).optional(),
      region: z.string().trim().max(60).nullable().optional(),
      country: z.string().trim().max(60).optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
      is_active: z.boolean().optional()
    }).parse(req.body);
    const keys = Object.keys(b);
    if (!keys.length) throw new AppError(400, 'EMPTY', 'Nothing to update.');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(`UPDATE locations SET ${sets} WHERE id = $1 RETURNING *`,
                             [req.params.id, ...keys.map((k) => b[k])]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Office not found.');
    await audit(req.user.id, 'location.update', 'location', req.params.id, b);
    res.json({ location: rows[0] });
  } catch (e) { next(e); }
});

/* ------------------------------------------------------------- branches --- */
adminRouter.post('/:id/branches', requireSuperadmin, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(80),
      address: z.string().trim().max(240).optional().nullable()
    }).parse(req.body);
    const { rows } = await q(
      `INSERT INTO branches (location_id, name, address) VALUES ($1,$2,$3) RETURNING *`,
      [req.params.id, b.name, b.address || null]
    );
    await audit(req.user.id, 'branch.create', 'branch', rows[0].id, { name: b.name, location: req.params.id });
    res.status(201).json({ branch: rows[0] });
  } catch (e) {
    if (e.code === '23505') return next(new AppError(409, 'DUPLICATE', 'That office already has a branch with this name.'));
    if (e.code === '23503') return next(new AppError(404, 'NOT_FOUND', 'Office not found.'));
    next(e);
  }
});

adminRouter.patch('/branches/:branchId', requireSuperadmin, async (req, res, next) => {
  try {
    const b = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      address: z.string().trim().max(240).nullable().optional(),
      is_active: z.boolean().optional()
    }).parse(req.body);
    const keys = Object.keys(b);
    if (!keys.length) throw new AppError(400, 'EMPTY', 'Nothing to update.');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await q(`UPDATE branches SET ${sets} WHERE id = $1 RETURNING *`,
                             [req.params.branchId, ...keys.map((k) => b[k])]);
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Branch not found.');
    await audit(req.user.id, 'branch.update', 'branch', req.params.branchId, b);
    res.json({ branch: rows[0] });
  } catch (e) { next(e); }
});

/* --------------------------------------------- appointing administrators -- */
adminRouter.post('/:id/admins', requireSuperadmin, async (req, res, next) => {
  try {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const { rows: [u] } = await q(`SELECT id, name, email, role FROM users WHERE id = $1`, [userId]);
    if (!u) throw new AppError(404, 'NOT_FOUND', 'That person does not exist.');

    // Appointing somebody to an office is what makes them an administrator;
    // asking the superadmin to do it in two steps would just invite the
    // half-done state where a row exists but the role does not.
    if (u.role === 'employee')
      await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId]);

    await q(
      `INSERT INTO location_admins (location_id, user_id, granted_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [req.params.id, userId, req.user.id]
    );
    await audit(req.user.id, 'location.admin.grant', 'location', req.params.id, { userId, email: u.email });
    res.json({ ok: true, promoted: u.role === 'employee' });
  } catch (e) {
    if (e.code === '23503') return next(new AppError(404, 'NOT_FOUND', 'Office not found.'));
    next(e);
  }
});

adminRouter.delete('/:id/admins/:userId', requireSuperadmin, async (req, res, next) => {
  try {
    if (req.params.userId === req.user.id)
      throw new AppError(400, 'SELF', 'You cannot remove yourself from an office.');
    await q(`DELETE FROM location_admins WHERE location_id=$1 AND user_id=$2`,
            [req.params.id, req.params.userId]);

    // Somebody who no longer administers anywhere is no longer an administrator,
    // otherwise the directory fills with admins who can see nothing.
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM location_admins WHERE user_id = $1`, [req.params.userId]
    );
    let demoted = false;
    if (rows[0].n === 0) {
      const { rowCount } = await q(
        `UPDATE users SET role='employee' WHERE id=$1 AND role='admin'`, [req.params.userId]
      );
      demoted = rowCount > 0;
    }
    await audit(req.user.id, 'location.admin.revoke', 'location', req.params.id,
                { userId: req.params.userId, demoted });
    res.json({ ok: true, demoted });
  } catch (e) { next(e); }
});
