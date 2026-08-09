// One listener for every interaction in the server.
//
// There is no per-feature handler anywhere in this process. A click arrives, its
// custom_id is decoded into a Registry key, the row is read, and the action tree
// is executed. That is the entire routing layer, and it is why a new button is a
// database write rather than a deploy.
//
// The Registry is read fresh on every interaction and never cached. Caching
// would buy nothing measurable against a local SQLite file, and it would cost
// the property that makes this design worth having: an action edited now takes
// effect on the very next click.

import { Events, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { decode } from '../shared/customid.js';
import { getComponent, getAction, getSession } from '../shared/registry.js';
import { execute, ActionError } from '../shared/executor.js';
import { evaluate } from '../shared/predicates.js';
import { log as auditLog } from '../shared/audit.js';
import { GUILD_ID } from '../shared/env.js';

const MODAL_STYLE = { short: TextInputStyle.Short, paragraph: TextInputStyle.Paragraph };

function buildModal(componentKey, action, params) {
  const modal = new ModalBuilder()
    .setCustomId(`c1|${componentKey}|submit`)
    .setTitle(String(params.title ?? 'Input').slice(0, 45));

  const fields = (params.fields ?? []).slice(0, 5);
  if (!fields.length) throw new ActionError('This modal has no fields configured.');

  for (const f of fields) {
    const input = new TextInputBuilder()
      .setCustomId(String(f.key))
      .setLabel(String(f.label ?? f.key).slice(0, 45))
      .setStyle(MODAL_STYLE[f.style] ?? TextInputStyle.Short)
      .setRequired(f.required !== false);
    if (f.placeholder) input.setPlaceholder(String(f.placeholder).slice(0, 100));
    if (f.max) input.setMaxLength(Number(f.max));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

/** Context the executor and predicates reason from. */
function buildContext(interaction, { args = [], fields = {}, session = null, respond, openModal }) {
  return {
    source: 'dispatcher',
    actor: interaction.user.id,
    guildId: GUILD_ID,
    guildOwnerId: interaction.guild?.ownerId ?? null,
    user: {
      id: interaction.user.id,
      username: interaction.user.username,
      globalName: interaction.user.globalName,
      displayName: interaction.member?.displayName ?? interaction.user.username,
    },
    channel: { id: interaction.channelId, name: interaction.channel?.name ?? '' },
    memberRoles: interaction.member?.roles?.cache ? [...interaction.member.roles.cache.keys()] : [],
    args,
    fields,
    session,
    respond,
    openModal,
  };
}

export function attach(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isAnySelectMenu() && !interaction.isModalSubmit()) return;

    const decoded = decode(interaction.customId);
    // Not ours. Another bot's component, or an id from before this encoding.
    if (!decoded) return;

    const component = getComponent(decoded.key);
    if (!component) {
      await interaction
        .reply({
          content:
            'This control is no longer defined. It was removed from the Registry — the panel it sits on is stale and should be reposted.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      auditLog({
        source: 'dispatcher',
        actor: interaction.user.id,
        op: 'orphaned_component',
        target: decoded.key,
        result: 'error',
        detail: 'component key not found in the Registry',
      });
      return;
    }

    const action = getAction(component.actionKey);
    if (!action) {
      await interaction
        .reply({
          content: `This control points at action "${component.actionKey}", which no longer exists.`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      auditLog({
        source: 'dispatcher',
        actor: interaction.user.id,
        op: 'orphaned_action',
        target: component.actionKey,
        result: 'error',
        detail: `component ${decoded.key} points at a missing action`,
      });
      return;
    }

    const session = component.sessionId ? getSession(component.sessionId) : null;
    const isModalSubmit = interaction.isModalSubmit();

    // Selects carry their chosen values as args, on top of anything baked into
    // the custom_id.
    const args = interaction.isAnySelectMenu()
      ? [...decoded.args, ...interaction.values]
      : decoded.args;

    const fields = {};
    if (isModalSubmit) {
      for (const row of interaction.fields?.fields?.values() ?? []) {
        fields[row.customId] = row.value;
      }
    }

    // A modal must BE the first response to the interaction, so this path
    // cannot defer. Everything else defers, because a Registry action may make
    // several REST calls and Discord only allows three seconds.
    const wantsModal = action.kind === 'modal_open' && !isModalSubmit;

    try {
      if (wantsModal) {
        const verdict = await evaluate(action.requires, buildContext(interaction, { args }));
        if (!verdict.pass) {
          await interaction.reply({ content: verdict.reason, flags: MessageFlags.Ephemeral });
          auditLog({
            source: 'dispatcher',
            actor: interaction.user.id,
            op: component.actionKey,
            target: decoded.key,
            result: 'error',
            detail: `refused: ${verdict.reason}`,
          });
          return;
        }
        await interaction.showModal(buildModal(decoded.key, action, action.params ?? {}));
        auditLog({
          source: 'dispatcher',
          actor: interaction.user.id,
          op: component.actionKey,
          target: decoded.key,
          result: 'ok',
          detail: 'modal opened',
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let answered = false;
      const respond = async (payload) => {
        answered = true;
        await interaction.editReply({
          content: payload.content ?? undefined,
          embeds: payload.embeds ?? [],
        });
      };

      // On a modal submit, the stored action is the modal_open; what actually
      // runs is whatever it named as on_submit.
      const toRun = isModalSubmit ? (action.params ?? {}).on_submit : component.actionKey;
      if (isModalSubmit && !toRun) {
        throw new ActionError('This modal has no on_submit action configured in the Registry.');
      }

      const ctx = buildContext(interaction, { args, fields, session, respond });
      const result = await execute(toRun, ctx);

      if (!answered) {
        await interaction.editReply({
          content: result.log.length ? `Done.\n${result.log.map((l) => `• ${l}`).join('\n')}` : 'Done.',
        });
      }

      auditLog({
        source: 'dispatcher',
        actor: interaction.user.id,
        op: typeof toRun === 'string' ? toRun : action.kind,
        target: decoded.key,
        params: { component: decoded.key, args, ...(Object.keys(fields).length ? { fields } : {}) },
        result: 'ok',
        detail: result.log.join(' · ').slice(0, 500),
      });
    } catch (error) {
      const userFacing =
        error instanceof ActionError
          ? error.message
          : `Something went wrong running this control. It has been logged.\n\`${String(error.message).slice(0, 300)}\``;

      const send = interaction.deferred || interaction.replied
        ? (payload) => interaction.editReply(payload)
        : (payload) => interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      await send({ content: userFacing }).catch(() => {});

      auditLog({
        source: 'dispatcher',
        actor: interaction.user.id,
        op: component.actionKey,
        target: decoded.key,
        params: { component: decoded.key, args },
        result: 'error',
        detail: error.message,
      });
    }
  });
}
