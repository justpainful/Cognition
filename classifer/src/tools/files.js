// Putting a file into a channel.
//
// A tool that reads an arbitrary path and posts it to a chat server is a
// straightforward way to leak whatever is on the disk, so it is deliberately
// narrow: only inside the project, never a dotfile, and never anything that
// contains the bot token. Those checks are not about distrusting the caller.
// They are there because the caller might be acting on a request that arrived
// from a channel, and a channel is not a trusted source of file paths.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, basename, extname, isAbsolute } from 'node:path';
import { tool, z } from '../kit.js';
import { postMultipart } from '../../../shared/rest.js';
import { ROOT, TOKEN } from '../../../shared/env.js';

// Discord's own ceiling for an unboosted guild.
const MAX_BYTES = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function vet(path) {
  const abs = resolve(ROOT, path);
  const rel = relative(ROOT, abs);

  // isAbsolute catches the other-drive case on Windows, where relative() gives up
  // and returns an absolute path rather than a chain of '..'.
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`"${path}" is outside the project. Only files under the Cognition directory can be sent.`);
  }
  if (!existsSync(abs)) throw new Error(`No file at ${rel}`);

  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`${rel} is not a file.`);
  if (stat.size > MAX_BYTES) {
    throw new Error(`${rel} is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over Discord's 10 MB limit.`);
  }

  const name = basename(abs);
  if (name.startsWith('.')) {
    throw new Error(`Refusing to send "${name}" — dotfiles hold configuration and credentials, not deliverables.`);
  }

  const buf = readFileSync(abs);
  // Last line of defence: a generated file could have picked the token up from
  // anywhere, and a channel is readable by everyone in it.
  if (TOKEN && buf.includes(TOKEN)) {
    throw new Error(`Refusing to send ${rel} — it contains the bot token.`);
  }

  return { abs, rel, name, buf, size: stat.size };
}

tool({
  name: 'file_send',
  title: 'Upload a file to a channel',
  description:
    'Attach a file from the project to a Discord message. Restricted to files inside the Cognition directory, never dotfiles, never anything containing the token, and capped at 10 MB. Discord shows text and image attachments inline; everything else appears as a download.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    path: z.string().describe('path relative to the project root, e.g. out/report.html'),
    content: z.string().max(2000).optional().describe('message text posted alongside it'),
    filename: z.string().optional().describe('override the name shown in Discord'),
  },
  async run({ channel_id, path, content, filename }) {
    const file = vet(path);
    const shown = filename ?? file.name;
    const type = MIME[extname(shown).toLowerCase()] ?? 'application/octet-stream';

    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content,
        attachments: [{ id: 0, filename: shown }],
        allowed_mentions: { parse: [] },
      }),
    );
    form.append('files[0]', new Blob([file.buf], { type }), shown);

    const msg = await postMultipart(`/channels/${channel_id}/messages`, form, {
      reason: 'Classifer: file_send',
    });

    return {
      target: msg.id,
      text: [
        `Sent ${file.rel} to ${channel_id} as "${shown}".`,
        `  ${(file.size / 1024).toFixed(0)} KB · ${type}`,
        `  message ${msg.id}`,
        '',
        type.startsWith('text/html')
          ? 'Discord will not render HTML. It appears as a download, because Discord has no way to run a page inside itself.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
