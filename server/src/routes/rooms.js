import { Router } from 'express';
import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export const roomsRouter = Router();

/** Rooms the caller may actually book. Restricted rooms need an explicit grant. */
/**
 * Rooms the caller may book, optionally narrowed to one office.
 *
 * The office filter is what lets somebody travelling to Bangalore book there
 * without wading through every room in the company.
 */
export async function visibleRooms(user, { locationId = null, branchId = null } = {}) {
  const { rows } = await q(
    `SELECT r.*,
            br.id AS branch_id, br.name AS branch_name,
            loc.id AS location_id, loc.name AS location_name, loc.city AS location_city,
            (r.restricted = false OR $2 IN ('admin','superadmin') OR ra.user_id IS NOT NULL) AS can_book
       FROM rooms r
       LEFT JOIN branches br ON br.id = r.branch_id
       LEFT JOIN locations loc ON loc.id = br.location_id
       LEFT JOIN room_access ra ON ra.room_id = r.id AND ra.user_id = $1
      WHERE r.is_active
        AND ($3::uuid IS NULL OR loc.id = $3)
        AND ($4::uuid IS NULL OR br.id = $4)
      ORDER BY loc.sort_order NULLS LAST, loc.name NULLS LAST, br.name NULLS LAST,
               r.floor NULLS LAST, r.name`,
    [user.id, user.role, locationId, branchId]
  );
  return rows;
}

roomsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    res.json({
      rooms: await visibleRooms(req.user, {
        locationId: req.query.location ? String(req.query.location) : null,
        branchId: req.query.branch ? String(req.query.branch) : null
      })
    });
  } catch (e) { next(e); }
});
