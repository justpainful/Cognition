// Posting into the server, including the panels that carry Registry-backed
// components.
//
// panel_publish is the join between the two halves of the system: it writes the
// component rows and posts the message whose buttons point at them. After this
// runs, pressing a button is entirely a Registry lookup — no code anywhere knows
// what that particular button does.

import { tool, z } from '../kit.js';
import { post, patch } from '../../../shared/rest.js';
import { putComponent, getAction, listComponents } from '../../../shared/registry.js';
import { encode } from '../../../shared/customid.js';

const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

const embedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4000).optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  footer: z.string().max(2048).optional(),
});

function buildEmbed(e) {
  if (!e) return undefined;
  return [
    {
      title: e.title,
      description: e.description,
      color: e.color ?? 0x5865f2,
      footer: e.footer ? { text: e.footer } : undefined,
    },
  ];
}

tool({
  name: 'message_send',
  title: 'Post a message',
  description: 'Post plain text and/or one embed to a channel. For a message with buttons, use panel_publish.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    content: z.string().max(2000).optional(),
    embed: embedSchema.optional(),
    silent: z.boolean().default(true).optional().describe('suppress the notification ping'),
  },
  async run({ channel_id, content, embed, silent = true }) {
    if (!content && !embed) throw new Error('Give content, an embed, or both.');
    const msg = await post(`/channels/${channel_id}/messages`, {
      content,
      embeds: buildEmbed(embed),
      flags: silent ? 1 << 12 : undefined,
      allowed_mentions: { parse: [] },
    });
    return { target: msg.id, text: `Posted to ${channel_id} — message id ${msg.id}` };
  },
});

tool({
  name: 'message_edit',
  title: 'Edit a message',
  description: 'Rewrite a message Cognition posted. Only messages authored by the bot can be edited.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    message_id: z.string(),
    content: z.string().max(2000).optional(),
    embed: embedSchema.optional(),
  },
  async run({ channel_id, message_id, content, embed }) {
    const body = {};
    if (content !== undefined) body.content = content;
    if (embed !== undefined) body.embeds = buildEmbed(embed);
    if (!Object.keys(body).length) return 'Nothing to change.';
    await patch(`/channels/${channel_id}/messages/${message_id}`, body);
    return { target: message_id, text: `Edited message ${message_id} in ${channel_id}.` };
  },
});

tool({
  name: 'panel_publish',
  title: 'Post a panel of Registry-backed buttons',
  description:
    'Post a message whose buttons are bound to Registry actions. Each button becomes a component row, and its custom_id carries only that row\'s key — so what the button does is editable afterwards with registry_put, with no restart and no repost. Up to 5 buttons per row, 5 rows.',
  mutating: true,
  schema: {
    channel_id: z.string(),
    content: z.string().max(2000).optional(),
    embed: embedSchema.optional(),
    buttons: z
      .array(
        z.object({
          label: z.string().max(80),
          action_key: z.string().describe('an existing action key in the Registry'),
          style: z.enum(['primary', 'secondary', 'success', 'danger']).default('primary'),
          emoji: z.string().optional().describe('a unicode emoji'),
          args: z.array(z.string()).max(2).optional().describe('fixed per-click args appended to the custom_id'),
          session_id: z.number().int().optional(),
        }),
      )
      .min(1)
      .max(25),
    silent: z.boolean().default(true).optional(),
  },
  async run({ channel_id, content, embed, buttons, silent = true }) {
    // Fail before posting anything if a button points nowhere — a half-published
    // panel is worse than none.
    for (const b of buttons) {
      if (!getAction(b.action_key)) {
        throw new Error(
          `Button "${b.label}" points at action "${b.action_key}", which is not in the Registry. ` +
            `Create it with registry_put first.`,
        );
      }
    }

    const created = [];
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
      const slice = buttons.slice(i, i + 5);
      rows.push({
        type: 1,
        components: slice.map((b) => {
          const comp = putComponent({
            kind: 'button',
            actionKey: b.action_key,
            spec: { label: b.label, style: b.style ?? 'primary', emoji: b.emoji ?? null, args: b.args ?? [] },
            sessionId: b.session_id ?? null,
          });
          created.push({ key: comp.key, label: b.label, action: b.action_key });
          return {
            type: 2,
            style: BUTTON_STYLE[b.style ?? 'primary'],
            label: b.label,
            emoji: b.emoji ? { name: b.emoji } : undefined,
            custom_id: encode(comp.key, b.args ?? []),
          };
        }),
      });
    }

    const msg = await post(`/channels/${channel_id}/messages`, {
      content,
      embeds: buildEmbed(embed),
      components: rows,
      flags: silent ? 1 << 12 : undefined,
      allowed_mentions: { parse: [] },
    });

    return {
      target: msg.id,
      text: [
        `Published panel to ${channel_id} — message id ${msg.id}`,
        '',
        'Components created:',
        ...created.map((c) => `  ${c.key}  "${c.label}" -> ${c.action}`),
        '',
        'To change what a button does, registry_put the action it points at. The panel does not need reposting.',
      ].join('\n'),
    };
  },
});

tool({
  name: 'panel_components',
  title: 'What is behind the buttons',
  description: 'List component rows and the actions they resolve to, so you can see what a published panel will actually do.',
  schema: {
    session_id: z.number().int().optional(),
  },
  async run({ session_id }) {
    const comps = session_id === undefined ? listComponents() : listComponents({ sessionId: session_id });
    if (!comps.length) return '(no components)';
    return comps
      .map((c) => {
        const action = getAction(c.actionKey);
        return `${c.key}  "${c.spec.label ?? '?'}"  -> ${c.actionKey} (${action?.kind ?? 'MISSING ACTION'})${
          action?.confirm ? '  [confirm]' : ''
        }`;
      })
      .join('\n');
  },
});
