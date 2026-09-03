/** Gate for admin-only routes. Always chained after requireAuth. */

import { forbidden } from '../lib/errors.js';

export const requireAdmin = (req, _res, next) => {
  if (!req.user?.is_admin) return next(forbidden('Admin access required'));
  // An impersonation token (see accounts admin.impersonateUser) carries the
  // acting admin's id as the `act` claim. It must never itself reach the
  // admin panel — otherwise impersonating a user would be a way to act with
  // the *impersonated* account's privileges instead of the actor's own.
  if (req.tokenClaims?.act) return next(forbidden('Admin access required'));
  return next();
};
