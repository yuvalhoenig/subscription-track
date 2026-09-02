/**
 * Default category set, created for every new user during registration.
 * Users can rename, recolour or delete these; the AI categoriser learns
 * whatever set the user ends up with rather than assuming these names.
 */

export const DEFAULT_CATEGORIES = Object.freeze([
  { name: 'Streaming', color: '#e0245e', icon: 'play-circle', subcategories: ['Video', 'Music', 'Sports', 'Audiobooks'] },
  { name: 'Productivity', color: '#4f46e5', icon: 'check-square', subcategories: ['Notes', 'Storage', 'Email', 'Project Management'] },
  { name: 'Software', color: '#0ea5e9', icon: 'code', subcategories: ['Design', 'Developer Tools', 'Security', 'AI Tools'] },
  { name: 'Health & Fitness', color: '#10b981', icon: 'heart', subcategories: ['Gym', 'Meditation', 'Nutrition'] },
  { name: 'News & Reading', color: '#f59e0b', icon: 'book-open', subcategories: ['Newspapers', 'Magazines', 'Newsletters'] },
  { name: 'Gaming', color: '#8b5cf6', icon: 'gamepad', subcategories: ['Console', 'PC', 'Mobile'] },
  { name: 'Utilities', color: '#64748b', icon: 'zap', subcategories: ['Internet', 'Phone', 'Cloud'] },
  { name: 'Education', color: '#14b8a6', icon: 'graduation-cap', subcategories: ['Courses', 'Language', 'Tutoring'] },
  { name: 'Finance', color: '#22c55e', icon: 'trending-up', subcategories: ['Banking', 'Investing', 'Accounting'] },
  { name: 'Other', color: '#94a3b8', icon: 'more-horizontal', subcategories: [] },
]);

export const DEFAULT_CATEGORY_NAMES = Object.freeze(DEFAULT_CATEGORIES.map((c) => c.name));

/** Palette offered when a user creates a custom category. */
export const CATEGORY_PALETTE = Object.freeze([
  '#e0245e', '#4f46e5', '#0ea5e9', '#10b981', '#f59e0b',
  '#8b5cf6', '#64748b', '#14b8a6', '#22c55e', '#ef4444',
  '#ec4899', '#f97316', '#84cc16', '#06b6d4', '#a855f7',
]);

/** Deterministic colour for a category we have no record of. */
export function colorForCategory(name) {
  const known = DEFAULT_CATEGORIES.find(
    (c) => c.name.toLowerCase() === String(name ?? '').toLowerCase(),
  );
  if (known) return known.color;
  let hash = 0;
  for (const char of String(name ?? '')) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}
