/** Category CRUD. Categories are per-user; the defaults are seeded at signup. */

import { colorForCategory } from '@subtrack/shared';
import { one, many, query } from '../db/pool.js';
import { notFound, conflict, badRequest } from '../lib/errors.js';
import { invalidateUserCaches } from './subscriptions.js';

export async function listCategories(userId) {
  return many(
    `SELECT c.id, c.name, c.color, c.icon, c.is_default, c.sort_order, c.created_at,
            count(s.id) FILTER (WHERE s.status <> 'cancelled')::int AS subscription_count,
            COALESCE(sum(
              CASE s.billing_cycle
                WHEN 'weekly'     THEN s.cost * 52 / 12
                WHEN 'biweekly'   THEN s.cost * 26 / 12
                WHEN 'monthly'    THEN s.cost
                WHEN 'quarterly'  THEN s.cost / 3
                WHEN 'semiannual' THEN s.cost / 6
                WHEN 'yearly'     THEN s.cost / 12
              END
            ) FILTER (WHERE s.status = 'active'), 0)::numeric(12,2) AS monthly_spend
       FROM categories c
       LEFT JOIN subscriptions s ON s.category_id = c.id
      WHERE c.user_id = $1
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`,
    [userId],
  );
}

export async function createCategory(userId, { name, color, icon }) {
  try {
    return await one(
      `INSERT INTO categories (user_id, name, color, icon, sort_order)
       VALUES ($1, $2, $3, $4,
               COALESCE((SELECT max(sort_order) + 1 FROM categories WHERE user_id = $1), 0))
       RETURNING id, name, color, icon, is_default, sort_order, created_at`,
      [userId, name, color ?? colorForCategory(name), icon ?? 'tag'],
    );
  } catch (error) {
    if (error.code === '23505') throw conflict(`You already have a category called "${name}"`);
    throw error;
  }
}

export async function updateCategory(userId, id, patch) {
  const fields = [];
  const params = [];
  for (const [key, column] of Object.entries({ name: 'name', color: 'color', icon: 'icon', sortOrder: 'sort_order' })) {
    if (patch[key] !== undefined) {
      params.push(patch[key]);
      fields.push(`${column} = $${params.length}`);
    }
  }
  if (!fields.length) throw badRequest('No changes supplied');
  params.push(id, userId);
  try {
    const row = await one(
      `UPDATE categories SET ${fields.join(', ')}
        WHERE id = $${params.length - 1} AND user_id = $${params.length}
        RETURNING id, name, color, icon, is_default, sort_order, created_at`,
      params,
    );
    if (!row) throw notFound('Category not found');
    await invalidateUserCaches(userId);
    return row;
  } catch (error) {
    if (error.code === '23505') throw conflict('You already have a category with that name');
    throw error;
  }
}

/**
 * Delete a category. Subscriptions keep their history and fall back to
 * "Uncategorised" (the FK is ON DELETE SET NULL), so removing a category
 * can never destroy spending data.
 */
export async function deleteCategory(userId, id) {
  const { rowCount } = await query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw notFound('Category not found');
  await invalidateUserCaches(userId);
  return { deleted: true };
}

/**
 * Find a category by name, creating it if it does not exist.
 * Used by the AI categoriser, which invents subcategory names the user
 * may not have created yet.
 */
export async function ensureCategory(userId, name) {
  if (!name) return null;
  const existing = await one(
    'SELECT id, name FROM categories WHERE user_id = $1 AND lower(name) = lower($2)',
    [userId, name],
  );
  if (existing) return existing;
  return createCategory(userId, { name, color: colorForCategory(name) });
}
