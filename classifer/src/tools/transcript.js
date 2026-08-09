// Getting a conversation out of Discord in a form something else can render.
//
// messages_read exists for looking at a channel and is formatted for reading.
// This is the other need: the whole thing, structured, with the author identity
// and attachment metadata intact, so a transcript can be built from it without
// anyone re-typing what was said.

import { tool, z } from '../kit.js';
import { get, fetchChannel, guildRoute } from '../../../shared/rest.js';
import { GUILD_ID } from '../../../shared/env.js';

/** Discord returns 100 at a time, newest first. Walk back until it runs out. */
async function fetchAll(channelId, max) {
  const out = [];
  let before;
  while (out.length < max) {
    const batch = await get(`/channels/${channelId}/messages`, {
      query: { limit: Math.min(100, max - out.length), before },
    });
    if (!batch.length) break;
    out.push(...batch);
    before = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out.reverse(); // oldest first: a transcript reads forwards
}

tool({
  name: 'transcript_export',
  title: 'Export a conversation as structured data',
  description:
    'Every message in a channel, oldest first, with author identity, embeds, attachments and component metadata preserved. Use this when a conversation has to be rendered or archived somewhere else — messages_read is for looking, this is for building.',
  schema: {
    channel_id: z.string(),
    max: z.number().int().min(1).max(2000).default(500).optional(),
    include_participants: z.boolean().default(true).optional(),
  },
  async run({ channel_id, max = 500, include_participants = true }) {
    const channel = await fetchChannel(channel_id);
    const messages = await fetchAll(channel_id, max);

    const doc = {
      channel: { id: channel.id, name: channel.name, topic: channel.topic ?? null, parent_id: channel.parent_id ?? null },
      guild_id: GUILD_ID,
      exported_at: new Date().toISOString(),
      message_count: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        at: m.timestamp,
        edited_at: m.edited_timestamp ?? null,
        author: {
          id: m.author?.id,
          username: m.author?.username,
          global_name: m.author?.global_name ?? null,
          bot: !!m.author?.bot,
          avatar: m.author?.avatar ?? null,
        },
        content: m.content ?? '',
        embeds: (m.embeds ?? []).map((e) => ({
          title: e.title ?? null,
          description: e.description ?? null,
          color: e.color ?? null,
          footer: e.footer?.text ?? null,
          fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
        })),
        attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size, content_type: a.content_type ?? null })),
        components: (m.components ?? []).flatMap((row) =>
          (row.components ?? []).map((c) => ({ label: c.label ?? null, custom_id: c.custom_id ?? null, style: c.style ?? null })),
        ),
        reactions: (m.reactions ?? []).map((r) => ({ emoji: r.emoji?.name, count: r.count })),
        mentions: (m.mentions ?? []).map((u) => ({ id: u.id, username: u.username })),
      })),
    };

    if (include_participants) {
      // Identity from the message payloads is whatever it was at post time.
      // The member record is who they are now, including roles and nickname.
      const ids = [...new Set(doc.messages.map((m) => m.author.id).filter(Boolean))];
      doc.participants = [];
      for (const id of ids) {
        const member = await get(guildRoute(`/members/${id}`)).catch(() => null);
        doc.participants.push({
          id,
          username: member?.user?.username ?? doc.messages.find((m) => m.author.id === id)?.author.username,
          global_name: member?.user?.global_name ?? null,
          nick: member?.nick ?? null,
          bot: !!member?.user?.bot,
          avatar: member?.user?.avatar ?? null,
          banner: member?.user?.banner ?? null,
          accent_color: member?.user?.accent_color ?? null,
          joined_at: member?.joined_at ?? null,
          roles: member?.roles ?? [],
          in_guild: !!member,
          message_count: doc.messages.filter((m) => m.author.id === id).length,
        });
      }
    }

    return {
      target: channel_id,
      skipPublish: true,
      text: JSON.stringify(doc),
    };
  },
});
