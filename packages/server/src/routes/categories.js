/** Category CRUD. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errors.js';
import { validate, hexColor, shortText } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import * as categories from '../services/categories.js';
import { suggestRecategorisation } from '../services/ai/categorize.js';

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

const bodySchema = z
  .object({
    name: z.string().trim().min(1, 'Give the category a name').max(60),
    color: hexColor.optional(),
    icon: shortText(40).optional(),
  })
  .strict();

categoriesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ categories: await categories.listCategories(req.user.id) });
  }),
);

categoriesRouter.post(
  '/',
  validate(bodySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ category: await categories.createCategory(req.user.id, req.body) });
  }),
);

categoriesRouter.patch(
  '/:id',
  validate(
    bodySchema.partial().extend({ sortOrder: z.coerce.number().int().min(0).max(999).optional() }).strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json({ category: await categories.updateCategory(req.user.id, req.params.id, req.body) });
  }),
);

categoriesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await categories.deleteCategory(req.user.id, req.params.id));
  }),
);

/** Suggestions only — nothing is recategorised without the user accepting. */
categoriesRouter.get(
  '/suggestions',
  asyncHandler(async (req, res) => {
    res.json({ suggestions: await suggestRecategorisation(req.user.id) });
  }),
);
