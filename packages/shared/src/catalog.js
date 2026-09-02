/**
 * Reference catalogue of well-known subscription services.
 *
 * This powers four features that must keep working with no Claude API key:
 *   - auto-categorisation fallback (`category` / `subcategory`)
 *   - duplicate & overlap detection (`overlapGroup`)
 *   - price comparison against market rates (`market`)
 *   - bundle / family-plan opportunities (`familyPlan`)
 *
 * Prices are indicative US list prices captured for demo purposes and are
 * deliberately stored as a low/typical/high band rather than a single figure,
 * because every one of these vendors reprices constantly. Treat the band as
 * "is the user wildly off market", not as a live price feed. Operators who
 * want live numbers should replace `market` from their own pricing source.
 */

const CATALOG = [
  // ── Video streaming ──────────────────────────────────────────────
  { id: 'netflix', name: 'Netflix', aliases: ['netflix.com'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 7.99, typical: 17.99, high: 24.99 }, familyPlan: { name: 'Premium (4 screens)', monthly: 24.99, seats: 4 }, cancelUrl: 'https://www.netflix.com/CancelPlan' },
  { id: 'disney-plus', name: 'Disney+', aliases: ['disney plus', 'disneyplus'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 9.99, typical: 15.99, high: 24.99 }, bundle: 'disney-bundle', cancelUrl: 'https://www.disneyplus.com/account/cancel-subscription' },
  { id: 'hulu', name: 'Hulu', aliases: [], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 9.99, typical: 18.99, high: 26.99 }, bundle: 'disney-bundle' },
  { id: 'espn-plus', name: 'ESPN+', aliases: ['espn plus'], category: 'Streaming', subcategory: 'Sports', overlapGroup: 'sports-streaming', market: { low: 11.99, typical: 11.99, high: 29.99 }, bundle: 'disney-bundle' },
  { id: 'max', name: 'Max', aliases: ['hbo max', 'hbo'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 9.99, typical: 16.99, high: 20.99 } },
  { id: 'prime-video', name: 'Amazon Prime Video', aliases: ['prime video', 'amazon prime'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 8.99, typical: 14.99, high: 14.99 }, cancelUrl: 'https://www.amazon.com/gp/help/customer/display.html?nodeId=GTJQ7QZY7QL2HK4Y' },
  { id: 'apple-tv-plus', name: 'Apple TV+', aliases: ['apple tv', 'appletv+'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 9.99, typical: 12.99, high: 12.99 }, bundle: 'apple-one', cancelUrl: 'https://support.apple.com/en-us/118428' },
  { id: 'paramount-plus', name: 'Paramount+', aliases: ['paramount plus'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 7.99, typical: 12.99, high: 12.99 } },
  { id: 'peacock', name: 'Peacock', aliases: [], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 7.99, typical: 13.99, high: 13.99 } },
  { id: 'youtube-premium', name: 'YouTube Premium', aliases: ['youtube red'], category: 'Streaming', subcategory: 'Video', overlapGroup: 'music-streaming', market: { low: 13.99, typical: 13.99, high: 22.99 }, familyPlan: { name: 'Family (5 members)', monthly: 22.99, seats: 5 }, cancelUrl: 'https://www.youtube.com/paid_memberships' },
  { id: 'crunchyroll', name: 'Crunchyroll', aliases: [], category: 'Streaming', subcategory: 'Video', overlapGroup: 'video-streaming', market: { low: 7.99, typical: 11.99, high: 15.99 } },
  { id: 'youtube-tv', name: 'YouTube TV', aliases: [], category: 'Streaming', subcategory: 'Video', overlapGroup: 'live-tv', market: { low: 72.99, typical: 82.99, high: 82.99 } },

  // ── Music & audio ────────────────────────────────────────────────
  { id: 'spotify', name: 'Spotify', aliases: ['spotify premium'], category: 'Streaming', subcategory: 'Music', overlapGroup: 'music-streaming', market: { low: 11.99, typical: 11.99, high: 19.99 }, familyPlan: { name: 'Premium Family (6 accounts)', monthly: 19.99, seats: 6 }, cancelUrl: 'https://support.spotify.com/us/article/cancel-premium/' },
  { id: 'apple-music', name: 'Apple Music', aliases: [], category: 'Streaming', subcategory: 'Music', overlapGroup: 'music-streaming', market: { low: 10.99, typical: 10.99, high: 16.99 }, familyPlan: { name: 'Family (6 accounts)', monthly: 16.99, seats: 6 }, bundle: 'apple-one', cancelUrl: 'https://support.apple.com/en-us/118428' },
  { id: 'tidal', name: 'Tidal', aliases: [], category: 'Streaming', subcategory: 'Music', overlapGroup: 'music-streaming', market: { low: 10.99, typical: 10.99, high: 16.99 } },
  { id: 'audible', name: 'Audible', aliases: [], category: 'Streaming', subcategory: 'Audiobooks', overlapGroup: 'audiobooks', market: { low: 7.95, typical: 14.95, high: 22.95 }, cancelUrl: 'https://help.audible.com/s/article/cancel-membership?language=en_US' },
  { id: 'pandora', name: 'Pandora', aliases: [], category: 'Streaming', subcategory: 'Music', overlapGroup: 'music-streaming', market: { low: 4.99, typical: 10.99, high: 14.99 } },

  // ── Productivity & storage ───────────────────────────────────────
  { id: 'notion', name: 'Notion', aliases: [], category: 'Productivity', subcategory: 'Notes', overlapGroup: 'notes', market: { low: 10, typical: 12, high: 20 } },
  { id: 'evernote', name: 'Evernote', aliases: [], category: 'Productivity', subcategory: 'Notes', overlapGroup: 'notes', market: { low: 10.83, typical: 14.99, high: 17.99 } },
  { id: 'obsidian', name: 'Obsidian Sync', aliases: ['obsidian'], category: 'Productivity', subcategory: 'Notes', overlapGroup: 'notes', market: { low: 4, typical: 5, high: 10 } },
  { id: 'todoist', name: 'Todoist', aliases: [], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'task-manager', market: { low: 4, typical: 5, high: 8 } },
  { id: 'things', name: 'Things 3', aliases: ['things'], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'task-manager', market: { low: 0, typical: 0, high: 0 } },
  { id: 'dropbox', name: 'Dropbox', aliases: [], category: 'Utilities', subcategory: 'Cloud', overlapGroup: 'cloud-storage', market: { low: 9.99, typical: 11.99, high: 19.99 }, familyPlan: { name: 'Family (6 users, 2 TB)', monthly: 19.99, seats: 6 }, cancelUrl: 'https://www.dropbox.com/account/billing' },
  { id: 'google-one', name: 'Google One', aliases: ['google drive', 'google storage'], category: 'Utilities', subcategory: 'Cloud', overlapGroup: 'cloud-storage', market: { low: 1.99, typical: 9.99, high: 19.99 }, familyPlan: { name: '2 TB Family (5 members)', monthly: 9.99, seats: 5 }, cancelUrl: 'https://one.google.com/settings' },
  { id: 'icloud', name: 'iCloud+', aliases: ['icloud', 'icloud storage'], category: 'Utilities', subcategory: 'Cloud', overlapGroup: 'cloud-storage', market: { low: 0.99, typical: 2.99, high: 10.99 }, familyPlan: { name: '2 TB with Family Sharing', monthly: 10.99, seats: 6 }, bundle: 'apple-one', cancelUrl: 'https://support.apple.com/en-us/118428' },
  { id: 'onedrive', name: 'Microsoft OneDrive', aliases: ['onedrive'], category: 'Utilities', subcategory: 'Cloud', overlapGroup: 'cloud-storage', market: { low: 1.99, typical: 6.99, high: 9.99 }, bundle: 'microsoft-365', cancelUrl: 'https://account.microsoft.com/services' },
  { id: 'microsoft-365', name: 'Microsoft 365', aliases: ['office 365', 'office'], category: 'Productivity', subcategory: 'Email', overlapGroup: 'office-suite', market: { low: 6.99, typical: 9.99, high: 12.5 }, familyPlan: { name: 'Family (6 people)', monthly: 12.99, seats: 6 }, cancelUrl: 'https://account.microsoft.com/services/microsoft365' },
  { id: 'google-workspace', name: 'Google Workspace', aliases: ['gsuite', 'g suite'], category: 'Productivity', subcategory: 'Email', overlapGroup: 'office-suite', market: { low: 6, typical: 12, high: 18 } },
  { id: 'slack', name: 'Slack', aliases: [], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'team-chat', market: { low: 7.25, typical: 8.75, high: 15 } },
  { id: 'zoom', name: 'Zoom', aliases: ['zoom pro'], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'video-calls', market: { low: 13.33, typical: 15.99, high: 21.99 } },
  { id: 'linear', name: 'Linear', aliases: [], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'issue-tracker', market: { low: 8, typical: 14, high: 14 } },
  { id: 'asana', name: 'Asana', aliases: [], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'issue-tracker', market: { low: 10.99, typical: 13.49, high: 24.99 } },
  { id: 'trello', name: 'Trello', aliases: [], category: 'Productivity', subcategory: 'Project Management', overlapGroup: 'issue-tracker', market: { low: 5, typical: 10, high: 17.5 } },
  { id: '1password', name: '1Password', aliases: ['one password'], category: 'Software', subcategory: 'Security', overlapGroup: 'password-manager', market: { low: 2.99, typical: 3.99, high: 7.99 }, familyPlan: { name: 'Families (5 members)', monthly: 4.99, seats: 5 }, cancelUrl: 'https://my.1password.com/billing' },
  { id: 'lastpass', name: 'LastPass', aliases: [], category: 'Software', subcategory: 'Security', overlapGroup: 'password-manager', market: { low: 3, typical: 4.75, high: 7 } },
  { id: 'dashlane', name: 'Dashlane', aliases: [], category: 'Software', subcategory: 'Security', overlapGroup: 'password-manager', market: { low: 4.99, typical: 6.49, high: 8.99 } },

  // ── Software, design & developer tools ───────────────────────────
  { id: 'adobe-cc', name: 'Adobe Creative Cloud', aliases: ['adobe', 'creative cloud', 'adobe creative suite'], category: 'Software', subcategory: 'Design', overlapGroup: 'design-suite', market: { low: 22.99, typical: 59.99, high: 89.99 }, cancelUrl: 'https://account.adobe.com/plans' },
  { id: 'figma', name: 'Figma', aliases: [], category: 'Software', subcategory: 'Design', overlapGroup: 'design-suite', market: { low: 12, typical: 15, high: 45 } },
  { id: 'sketch', name: 'Sketch', aliases: [], category: 'Software', subcategory: 'Design', overlapGroup: 'design-suite', market: { low: 10, typical: 12, high: 20 } },
  { id: 'canva', name: 'Canva', aliases: ['canva pro'], category: 'Software', subcategory: 'Design', overlapGroup: 'design-suite', market: { low: 12.99, typical: 14.99, high: 29.99 }, familyPlan: { name: 'Teams (up to 5)', monthly: 29.99, seats: 5 }, cancelUrl: 'https://www.canva.com/settings/billing-and-teams' },
  { id: 'github', name: 'GitHub', aliases: ['github pro', 'github copilot'], category: 'Software', subcategory: 'Developer Tools', overlapGroup: 'code-hosting', market: { low: 4, typical: 10, high: 21 }, cancelUrl: 'https://github.com/settings/billing' },
  { id: 'jetbrains', name: 'JetBrains All Products', aliases: ['jetbrains', 'intellij', 'pycharm', 'webstorm'], category: 'Software', subcategory: 'Developer Tools', overlapGroup: 'ide', market: { low: 8.9, typical: 28.9, high: 28.9 } },
  { id: 'vercel', name: 'Vercel', aliases: [], category: 'Software', subcategory: 'Developer Tools', overlapGroup: 'hosting', market: { low: 20, typical: 20, high: 40 } },
  { id: 'aws', name: 'Amazon Web Services', aliases: ['aws'], category: 'Software', subcategory: 'Developer Tools', overlapGroup: 'hosting', market: { low: 5, typical: 50, high: 500 } },
  { id: 'digitalocean', name: 'DigitalOcean', aliases: [], category: 'Software', subcategory: 'Developer Tools', overlapGroup: 'hosting', market: { low: 6, typical: 24, high: 96 } },
  { id: 'claude-pro', name: 'Claude Pro', aliases: ['claude', 'anthropic'], category: 'Software', subcategory: 'AI Tools', overlapGroup: 'ai-assistant', market: { low: 20, typical: 20, high: 100 } },
  { id: 'chatgpt-plus', name: 'ChatGPT Plus', aliases: ['chatgpt', 'openai'], category: 'Software', subcategory: 'AI Tools', overlapGroup: 'ai-assistant', market: { low: 20, typical: 20, high: 200 } },
  { id: 'midjourney', name: 'Midjourney', aliases: [], category: 'Software', subcategory: 'AI Tools', overlapGroup: 'ai-image', market: { low: 10, typical: 30, high: 120 } },
  { id: 'nordvpn', name: 'NordVPN', aliases: ['nord vpn'], category: 'Software', subcategory: 'Security', overlapGroup: 'vpn', market: { low: 3.39, typical: 6.99, high: 12.99 } },
  { id: 'expressvpn', name: 'ExpressVPN', aliases: ['express vpn'], category: 'Software', subcategory: 'Security', overlapGroup: 'vpn', market: { low: 6.67, typical: 9.99, high: 12.95 } },

  // ── Health, news, gaming, education, finance ─────────────────────
  { id: 'peloton', name: 'Peloton', aliases: ['peloton app'], category: 'Health & Fitness', subcategory: 'Gym', overlapGroup: 'fitness-app', market: { low: 12.99, typical: 24, high: 44 }, cancelUrl: 'https://members.onepeloton.com/preferences/membership' },
  { id: 'strava', name: 'Strava', aliases: [], category: 'Health & Fitness', subcategory: 'Gym', overlapGroup: 'fitness-app', market: { low: 6.67, typical: 11.99, high: 11.99 } },
  { id: 'whoop', name: 'WHOOP', aliases: [], category: 'Health & Fitness', subcategory: 'Gym', overlapGroup: 'fitness-app', market: { low: 20, typical: 30, high: 30 } },
  { id: 'headspace', name: 'Headspace', aliases: [], category: 'Health & Fitness', subcategory: 'Meditation', overlapGroup: 'meditation', market: { low: 5.83, typical: 12.99, high: 12.99 } },
  { id: 'calm', name: 'Calm', aliases: [], category: 'Health & Fitness', subcategory: 'Meditation', overlapGroup: 'meditation', market: { low: 5.83, typical: 14.99, high: 14.99 } },
  { id: 'nyt', name: 'The New York Times', aliases: ['nytimes', 'new york times', 'ny times'], category: 'News & Reading', subcategory: 'Newspapers', overlapGroup: 'news', market: { low: 4, typical: 17, high: 25 }, cancelUrl: 'https://myaccount.nytimes.com/seg/subscription' },
  { id: 'wsj', name: 'The Wall Street Journal', aliases: ['wsj', 'wall street journal'], category: 'News & Reading', subcategory: 'Newspapers', overlapGroup: 'news', market: { low: 9.75, typical: 38.99, high: 38.99 } },
  { id: 'medium', name: 'Medium', aliases: [], category: 'News & Reading', subcategory: 'Magazines', overlapGroup: 'news', market: { low: 5, typical: 5, high: 5 } },
  { id: 'kindle-unlimited', name: 'Kindle Unlimited', aliases: ['kindle'], category: 'News & Reading', subcategory: 'Magazines', overlapGroup: 'ebooks', market: { low: 11.99, typical: 11.99, high: 11.99 } },
  { id: 'xbox-game-pass', name: 'Xbox Game Pass', aliases: ['game pass', 'xbox'], category: 'Gaming', subcategory: 'Console', overlapGroup: 'game-subscription', market: { low: 9.99, typical: 19.99, high: 19.99 }, cancelUrl: 'https://account.microsoft.com/services' },
  { id: 'playstation-plus', name: 'PlayStation Plus', aliases: ['ps plus', 'psn'], category: 'Gaming', subcategory: 'Console', overlapGroup: 'game-subscription', market: { low: 6.99, typical: 13.99, high: 17.99 }, cancelUrl: 'https://www.playstation.com/en-us/support/subscriptions/cancel-playstation-plus/' },
  { id: 'nintendo-online', name: 'Nintendo Switch Online', aliases: ['nintendo'], category: 'Gaming', subcategory: 'Console', overlapGroup: 'game-subscription', market: { low: 3.33, typical: 4.17, high: 6.67 }, familyPlan: { name: 'Family Membership (8 accounts)', monthly: 2.92, seats: 8 }, cancelUrl: 'https://accounts.nintendo.com/portal' },
  { id: 'duolingo', name: 'Duolingo', aliases: ['duolingo plus', 'duolingo super'], category: 'Education', subcategory: 'Language', overlapGroup: 'language-learning', market: { low: 6.99, typical: 12.99, high: 12.99 }, familyPlan: { name: 'Super Family (6 accounts)', monthly: 9.99, seats: 6 }, cancelUrl: 'https://www.duolingo.com/settings/subscription' },
  { id: 'coursera', name: 'Coursera Plus', aliases: ['coursera'], category: 'Education', subcategory: 'Courses', overlapGroup: 'online-courses', market: { low: 33.25, typical: 59, high: 59 } },
  { id: 'masterclass', name: 'MasterClass', aliases: [], category: 'Education', subcategory: 'Courses', overlapGroup: 'online-courses', market: { low: 10, typical: 20, high: 33 } },
  { id: 'quickbooks', name: 'QuickBooks', aliases: ['intuit quickbooks'], category: 'Finance', subcategory: 'Accounting', overlapGroup: 'accounting', market: { low: 17.5, typical: 35, high: 117.5 } },
  { id: 'ynab', name: 'YNAB', aliases: ['you need a budget'], category: 'Finance', subcategory: 'Banking', overlapGroup: 'budgeting', market: { low: 8.25, typical: 14.99, high: 14.99 } },
];

/** Multi-service bundles worth flagging when a user holds several members. */
export const BUNDLES = Object.freeze([
  {
    id: 'disney-bundle',
    name: 'Disney Bundle (Disney+, Hulu, ESPN+)',
    members: ['disney-plus', 'hulu', 'espn-plus'],
    monthly: 26.99,
    minMembers: 2,
    note: 'Bundling Disney+, Hulu and ESPN+ together is cheaper than any two of them separately.',
  },
  {
    id: 'apple-one',
    name: 'Apple One Premier',
    members: ['apple-tv-plus', 'apple-music', 'icloud'],
    monthly: 37.95,
    minMembers: 2,
    note: 'Apple One rolls Music, TV+, Arcade, News+ and 2 TB of iCloud into one bill.',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365 Family',
    members: ['microsoft-365', 'onedrive'],
    monthly: 12.99,
    minMembers: 2,
    note: 'Microsoft 365 Family already includes 1 TB of OneDrive per person for up to six people.',
  },
]);

/** Overlap groups that represent genuinely interchangeable services. */
export const OVERLAP_LABELS = Object.freeze({
  'video-streaming': 'video streaming services',
  'music-streaming': 'music streaming services',
  'sports-streaming': 'sports streaming services',
  'live-tv': 'live TV services',
  'cloud-storage': 'cloud storage plans',
  notes: 'note-taking apps',
  'task-manager': 'task managers',
  'office-suite': 'office suites',
  'password-manager': 'password managers',
  'design-suite': 'design tools',
  'issue-tracker': 'project trackers',
  'ai-assistant': 'AI assistants',
  'ai-image': 'AI image generators',
  vpn: 'VPN providers',
  'fitness-app': 'fitness apps',
  meditation: 'meditation apps',
  news: 'news subscriptions',
  ebooks: 'ebook services',
  audiobooks: 'audiobook services',
  'game-subscription': 'game subscriptions',
  'language-learning': 'language apps',
  'online-courses': 'online course platforms',
  hosting: 'hosting providers',
  'code-hosting': 'code hosting plans',
  ide: 'IDE licences',
  'team-chat': 'team chat tools',
  'video-calls': 'video call tools',
  accounting: 'accounting tools',
  budgeting: 'budgeting apps',
});

export const SERVICE_CATALOG = Object.freeze(CATALOG.map(Object.freeze));

/** Strip case, punctuation and filler words so "Netflix.com " matches "netflix". */
export function normaliseName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.(com|io|app|co|net|org|tv)\b/g, ' ')
    .replace(/\b(subscription|monthly|yearly|annual|plan|premium|pro|plus|membership)\b/g, ' ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
}

const INDEX = new Map();
for (const service of SERVICE_CATALOG) {
  INDEX.set(normaliseName(service.name), service);
  INDEX.set(service.id, service);
  for (const alias of service.aliases) INDEX.set(normaliseName(alias), service);
}

/** Levenshtein distance, bounded so long strings stay cheap. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * 0..1 similarity between two service names.
 *
 * Substring containment is a strong signal ("netflix" inside "netflix
 * premium") but only when the shared part is substantial. Without the
 * length guard, the two-letter word "to" scores 0.9 against "todoist",
 * which is how a gym membership ends up categorised as a task manager.
 */
export function nameSimilarity(a, b) {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (
    longer.includes(shorter) &&
    shorter.length >= 4 &&
    shorter.length / longer.length >= 0.5
  ) {
    return 0.9;
  }

  const distance = editDistance(left, right);
  return Math.max(0, 1 - distance / longer.length);
}

/**
 * Resolve a free-text service name to a catalogue entry.
 * Exact and alias hits win; otherwise the closest fuzzy match above
 * `threshold` is returned so typos like "Netflx" still resolve.
 */
export function findService(name, { threshold = 0.82 } = {}) {
  const key = normaliseName(name);
  if (!key) return null;
  const direct = INDEX.get(key);
  if (direct) return direct;

  let best = null;
  let bestScore = 0;
  for (const service of SERVICE_CATALOG) {
    const score = Math.max(
      nameSimilarity(key, service.name),
      ...service.aliases.map((alias) => nameSimilarity(key, alias)),
    );
    if (score > bestScore) {
      best = service;
      bestScore = score;
    }
  }
  return bestScore >= threshold ? best : null;
}

/** Market price band for a service name, or null when we don't know it. */
export function marketRateFor(name) {
  return findService(name)?.market ?? null;
}

/**
 * Where to actually go to stop being charged for a subscription.
 *
 * This is the important distinction the whole app is built around: SubTrack
 * can mark a subscription as cancelled in its own database (which stops
 * counting it towards your spend), but it has no account, API access, or
 * credentials with Netflix, Spotify, or anyone else — nothing here can
 * reach out and cancel a real subscription on your behalf. Building that
 * would mean either an official partnership with every provider (which
 * essentially doesn't exist for consumer subscription cancellation) or
 * automating a login-and-click bot against each provider's site, which is
 * fragile, breaks the moment their page changes, and violates most
 * providers' terms of service.
 *
 * What this function gives instead is the next best thing: a direct link
 * to the real cancellation or account-management page for services in the
 * catalogue (each verified against the provider's own current help pages,
 * not guessed), and a Google search for "how to cancel X subscription" for
 * everything else — which reliably surfaces the right page even for
 * services this catalogue has never heard of.
 *
 * @returns {{ url: string, isDirect: boolean, label: string }}
 */
export function cancelHelpFor(name) {
  const service = findService(name);
  if (service?.cancelUrl) {
    return {
      url: service.cancelUrl,
      isDirect: true,
      label: `Cancel on ${service.name}`,
    };
  }
  const query = encodeURIComponent(`how to cancel ${name} subscription`);
  return {
    url: `https://www.google.com/search?q=${query}`,
    isDirect: false,
    label: `Find out how to cancel ${name}`,
  };
}

export function bundleById(id) {
  return BUNDLES.find((bundle) => bundle.id === id) ?? null;
}

export function overlapLabel(group) {
  return OVERLAP_LABELS[group] ?? 'similar services';
}
