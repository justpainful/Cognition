// custom_id encoding.
//
// Discord caps custom_id at 100 characters. Packing every parameter into the id
// itself (action:open_ticket|category:123|panel:456) runs out of room as soon as
// a component carries two snowflakes, and it silently breaks at send time.
//
// So the id carries a Registry key and nothing else that isn't per-click:
//
//     c1|<key>|<arg0>|<arg1>
//
// The key resolves to a component row that holds all the fixed configuration.
// Args are only for values that are not knowable until the click happens — the
// member a moderator picked, the row of a list. Two args is the practical limit
// and the encoder enforces the length rather than letting Discord reject it.

export const VERSION = 'c1';
export const MAX_LENGTH = 100;
const SEP = '|';

const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no l/o/0/1 — these get read aloud
export const KEY_LENGTH = 10;

/** A short, unambiguous, url-safe key for a component row. */
export function newKey() {
  const bytes = new Uint8Array(KEY_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return out;
}

export function encode(key, args = []) {
  if (!key || key.includes(SEP)) throw new Error(`Bad component key: ${key}`);
  const parts = [VERSION, key, ...args.map((a) => String(a ?? ''))];
  const id = parts.join(SEP);
  if (id.length > MAX_LENGTH) {
    throw new Error(
      `custom_id is ${id.length} chars, over Discord's ${MAX_LENGTH}. ` +
        `Move the long values into the component's Registry row instead of passing them as args.`,
    );
  }
  return id;
}

/**
 * Returns null for anything this dispatcher did not create — components from
 * another bot, or ids from an older encoding. The caller should ignore those
 * rather than error on them.
 */
export function decode(customId) {
  if (typeof customId !== 'string') return null;
  const parts = customId.split(SEP);
  if (parts[0] !== VERSION || parts.length < 2 || !parts[1]) return null;
  return { version: parts[0], key: parts[1], args: parts.slice(2) };
}
