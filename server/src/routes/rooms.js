import { Router } from 'express';
import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export const roomsRouter = Router();

/** Rooms the caller may actually book. Restricted rooms need an explicit grant. */
export async function visibleRooms(user) {
  const { rows } = await q(
    `SELECT r.*,
            (r.restricted = false OR $2 = 'admin' OR ra.user_id IS NOT NULL) AS can_book
       FROM rooms r
       LEFT JOIN room_access ra ON ra.room_id = r.id AND ra.user_id = $1
      WHERE r.is_active
      ORDER BY r.floor NULLS LAST, r.name`,
    [user.id, user.role]
  );
  return rows;
}

roomsRouter.get('/', requireAuth, async (req, res, next) => {
  try { res.json({ rooms: await visibleRooms(req.user) }); } catch (e) { next(e); }
});
