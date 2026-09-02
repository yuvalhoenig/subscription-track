/** Gate for admin-only routes. Always chained after requireAuth. */

import { forbidden } from '../lib/errors.js';

export const requireAdmin = (req, _res, next) => {
  if (!req.user?.is_admin) return next(forbidden('Admin access required'));
  return next();
};
