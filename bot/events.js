// Gateway events routed into Registry actions.
//
// Same shape as the Dispatcher: an event arrives, the Registry is read fresh,
// matching triggers run through the same executor and land in the same audit
// trail. No per-event code beyond translating each gateway payload into one
// common shape.
//
// This is what finally uses the privileged intents. MessageContent, GuildMembers
// and GuildMessageReactions were all being requested and none of them were read,
// which is both a wasted capability and a bad thing to be asking Discord for.

import { Events } from 'discord.js';
import { listTriggers, matches, markFired } from '../shared/triggers.js';
import { execute } from '../shared/executor.js';
import { log as auditLog } from '../shared/audit.js';
import { GUILD_ID } from '../shared/env.js';

/** Run every enabled trigger for this event whose filter matches. */
async function fire(event, payload, client) {
  const triggers = listTriggers({ event, enabledOnly: true });
  if (!triggers.length) return;

  for (const trigger of triggers) {
    const verdict = matches(trigger.filter, payload);
    if (!verdict.pass) continue;

    const ctx = {
      source: 'trigger',
      actor: payload.userId ?? 'system',
      guildId: GUILD_ID,
      guildOwnerId: client.guilds.cache.get(GUILD_ID)?.ownerId ?? null,
      user: payload.user,
      channel: payload.channel,
      message: payload.message,
      memberRoles: payload.memberRoles ?? [],
      args: [],
      fields: {},
      extra: payload.extra ?? {},
    };

    try {
      const result = await execute(trigger.actionKey, ctx);
      markFired(trigger.key);
      auditLog({
        source: 'trigger',
        actor: payload.userId ?? 'system',
        op: trigger.key,
        target: trigger.actionKey,
        params: { event },
        result: 'ok',
        detail: result.log.join(' · ').slice(0, 500),
      });
    } catch (error) {
      markFired(trigger.key);
      auditLog({
        source: 'trigger',
        actor: payload.userId ?? 'system',
        op: trigger.key,
        target: trigger.actionKey,
        params: { event },
        result: 'error',
        detail: error.message,
      });
    }
  }
}

export function attach(client) {
  // Cognition's own messages never trigger anything, whatever a filter says.
  // An action that posts a message would otherwise re-trigger itself, and the
  // loop runs at gateway speed until the rate limiter catches it.
  const isSelf = (id) => id === client.user?.id;

  client.on(Events.MessageCreate, async (message) => {
    if (message.guildId !== GUILD_ID) return;
    if (isSelf(message.author?.id)) return;

    await fire(
      'message_create',
      {
        userId: message.author?.id,
        isBot: !!message.author?.bot,
        content: message.content ?? '',
        channelId: message.channelId,
        memberRoles: message.member?.roles?.cache ? [...message.member.roles.cache.keys()] : [],
        user: {
          id: message.author?.id,
          username: message.author?.username,
          displayName: message.member?.displayName ?? message.author?.username,
        },
        channel: { id: message.channelId, name: message.channel?.name ?? '' },
        message: { id: message.id, content: message.content ?? '' },
        extra: { 'message.id': message.id, 'message.content': message.content ?? '' },
      },
      client,
    ).catch((e) => console.error(`[events] message_create: ${e.message}`));
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    if (member.guild?.id !== GUILD_ID) return;
    await fire(
      'member_join',
      {
        userId: member.id,
        isBot: !!member.user?.bot,
        user: { id: member.id, username: member.user?.username, displayName: member.displayName },
        memberRoles: [...(member.roles?.cache?.keys() ?? [])],
      },
      client,
    ).catch((e) => console.error(`[events] member_join: ${e.message}`));
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    if (member.guild?.id !== GUILD_ID) return;
    await fire(
      'member_leave',
      {
        userId: member.id,
        isBot: !!member.user?.bot,
        user: { id: member.id, username: member.user?.username, displayName: member.displayName },
      },
      client,
    ).catch((e) => console.error(`[events] member_leave: ${e.message}`));
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (reaction.message?.guildId !== GUILD_ID) return;
    if (isSelf(user.id)) return;

    // Reactions on messages from before the bot started arrive partial.
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    await fire(
      'reaction_add',
      {
        userId: user.id,
        isBot: !!user.bot,
        emoji: reaction.emoji?.name,
        channelId: reaction.message.channelId,
        user: { id: user.id, username: user.username, displayName: user.username },
        channel: { id: reaction.message.channelId, name: reaction.message.channel?.name ?? '' },
        message: { id: reaction.message.id, content: reaction.message.content ?? '' },
        extra: { 'message.id': reaction.message.id, emoji: reaction.emoji?.name ?? '' },
      },
      client,
    ).catch((e) => console.error(`[events] reaction_add: ${e.message}`));
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (channel.guildId !== GUILD_ID) return;
    await fire(
      'channel_delete',
      {
        channelId: channel.id,
        channel: { id: channel.id, name: channel.name ?? '' },
        extra: { 'channel.name': channel.name ?? '' },
      },
      client,
    ).catch((e) => console.error(`[events] channel_delete: ${e.message}`));
  });

  client.on(Events.ThreadCreate, async (thread) => {
    if (thread.guildId !== GUILD_ID) return;
    await fire(
      'thread_create',
      {
        channelId: thread.parentId,
        channel: { id: thread.id, name: thread.name ?? '' },
        extra: { 'thread.id': thread.id, 'thread.name': thread.name ?? '' },
      },
      client,
    ).catch((e) => console.error(`[events] thread_create: ${e.message}`));
  });
}
