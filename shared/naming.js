// Lifecycle is expressed in the name, not in the position.
//
// Promoting a system removes [TEST] from its name and changes nothing else;
// archiving adds [ARCHIVED] and locks it where it stands. Nothing is ever moved
// between categories, so a channel's id, its history, and every link anyone has
// posted to it all survive the transition.

export const TEST_TAG = '[TEST]';
export const ARCHIVED_TAG = '[ARCHIVED]';

// Discord lowercases and dash-joins text channel names, so the tag has to be
// matched in both the display form (categories) and the slug form (channels).
const TAG_PATTERNS = {
  [TEST_TAG]: /(?:\s*\[TEST\]\s*|-?test-?$|^test-)/gi,
  [ARCHIVED_TAG]: /(?:\s*\[ARCHIVED\]\s*|-?archived-?$|^archived-)/gi,
};

export function hasTag(name, tag) {
  if (!name) return false;
  const plain = name.toLowerCase();
  const bare = tag.replace(/[[\]]/g, '').toLowerCase();
  return plain.includes(bare);
}

export function stripTag(name, tag) {
  if (!name) return name;
  const out = String(name).replace(TAG_PATTERNS[tag] ?? new RegExp(tag, 'gi'), ' ');
  return tidy(out);
}

export function addTag(name, tag, { slug = false } = {}) {
  if (hasTag(name, tag)) return name;
  const bare = tag.replace(/[[\]]/g, '').toLowerCase();
  return slug ? tidySlug(`${name}-${bare}`) : tidy(`${name} ${tag}`);
}

/** Category names keep spaces and case. */
function tidy(s) {
  return String(s).replace(/\s{2,}/g, ' ').trim();
}

/** Text channel names must be lowercase, dash-separated, no leading/trailing dash. */
export function tidySlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

/** True when a name is tagged for either non-permanent state. */
export function lifecycleOf(name) {
  if (hasTag(name, ARCHIVED_TAG)) return 'archived';
  if (hasTag(name, TEST_TAG)) return 'testing';
  return 'permanent';
}
