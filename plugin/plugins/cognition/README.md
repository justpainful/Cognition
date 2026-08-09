# Cognition

Live control of one Discord server used as a lab for bots and programming
experiments. Not general-purpose — everything here points at guild
`1535979812860993617`.

## What it gives Claude

**Classifer**, an MCP server with 46 tools: read the server, build structure, post
Registry-backed panels, run test sessions, schedule work, snapshot and restore, and
a two-step gate in front of anything irreversible.

**Seven skills** that carry the operating model:

| Skill | What it settles |
|---|---|
| `cognition-authority` | Who decides. Read this first. |
| `server-read` | Reading live state, and what a read cannot tell you |
| `build-system` | Composing a system out of primitives instead of code |
| `registry-authoring` | The full action and predicate grammar |
| `run-session` | Build → test → promote or archive, without moving anything |
| `schedule-work` | Which of the two scheduling tiers a task belongs in |
| `danger` | The irreversible-operation protocol |

## The shape of it

```
Claude ──▶ Classifer (MCP, REST, no gateway) ──┬──▶ Discord
                                               │
                                        Registry (SQLite)
                                               │
           Cognition bot (gateway, 24/7) ──────┴──▶ Discord
             Dispatcher · Executor · Scheduler
```

Two processes on purpose. The bot needs a permanent gateway connection to receive
button presses; an MCP server lives and dies with a Claude session. Splitting them
means the server can be inspected and rebuilt whether or not the bot is running —
and the bot keeps answering clicks whether or not Claude Code is open.

## Behaviour is data

There is no per-feature code in the bot. A button's meaning is a Registry row, read
fresh on every press, so a new system is a row rather than a deploy and a changed
system takes effect on the next click with no restart.

The engine is a fixed ~20 files. It does not grow when the server does.

## Requirements

- Node 22.5+ (uses the built-in `node:sqlite`, so nothing native to compile)
- `.env` at the project root with `DISCORD_TOKEN` and `COGNITION_GUILD_ID`
- The bot running: `npm run bot`

## Without the plugin installed

Every tool is reachable from the command line through the same server:

```bash
node scripts/call.js guild_snapshot
node scripts/call.js registry_put '{"key":"...","kind":"reply","params":{}}'
node scripts/classifer-check.js          # list tools, smoke the server
node scripts/simulate-click.js <component_key> <user_id> '["arg"]'
node scripts/smoke.js                    # token, guild, registry
```
