<div align="center">

# 🦋 MOTH

**A self-hosted, AI-powered Discord bot and server management platform.**

An AI server architect, moderation, anti-raid security, tickets, automations, custom commands, community features, analytics and a web dashboard, installed with one command.

</div>

```bash
curl -fsSL https://raw.githubusercontent.com/lk5t/MOTH-discord-bot/main/install.sh | sudo bash
```

---

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Managing MOTH](#managing-moth)
- [Discord commands](#discord-commands)
- [AI providers](#ai-providers)
- [Security model](#security-model)
- [Development](#development)

## Features

| Area | What you get |
| --- | --- |
| **MOTH Architect** | Describe a server in plain language and MOTH designs categories, channels, roles, permission hierarchies, verification, onboarding, moderation, security, ticket panels, role menus, automations, embeds and a visual theme. It has three modes for existing servers: **Quick Edit**, **Smart Improve** (an audit with a health score) and **Full Redesign**. You can refine a proposal in conversation, see a full preview and approve each change. Destructive changes need explicit approval. MOTH takes a backup before every apply, keeps a full history and supports one-click rollback. Built-in and saved blueprints are included. It works without an AI key through a built-in heuristic designer. |
| **Quick Setup** | One click (dashboard or `/setup`) sets up a complete server: **logs & protection** (staff log channels, full logging, automod, anti-raid), **welcome & member roles**, **verification gate**, **support tickets** (panel, staff role, transcripts), **suggestions & starboard**, **join-to-create voice** and **live stats channels**. MOTH reuses the channels and roles you already have, creates only what's missing, shows a preview first and takes a backup. A health check on the Overview page lists what your server is missing. |
| **Server Tools** | **Server logs:** deleted and edited messages, bulk deletes, joins (account age and invite used), leaves and kicks, roles, nicknames, bans, channel/role/permission changes, invites and voice, each showing who did it. **Invite tracking:** `/invites leaderboard`, `/invites who`. **Join-to-create voice rooms:** owners get lock, hide, rename, limit and claim buttons, and empty rooms are deleted. **Suggestions:** button voting, discussion threads, staff approve/deny with a reason, and the author is notified. **Starboard.** **Channel rules:** media-only, auto-thread, auto-publish, auto-react, auto-delete and one-post-per-interval. **Sticky messages.** **Stats channels** (members, humans, bots, boosts, online…). |
| **Moderation** | `/ban` `/kick` `/timeout` `/warn` `/note` `/purge` `/slowmode` `/lock`, case management, user history, escalating punishments, ban appeals from DMs, moderator roles and a mod log. Automod covers spam, duplicates, mass mentions, invites, links (allow-list), word and regex filters, caps and zalgo. An optional AI moderation assist only flags messages by default. Every automated action records *why* it happened. |
| **Security** | Join-spike detection, suspicious-account scoring with explainable signals, and raid mode (lockdown, kick or ban new joiners). Emergency lockdown saves exact permissions and restores them, even after a restart. Anti-nuke stops mass deletions and bans. Four sensitivity presets (low → paranoid), automatic recovery and a detailed security log. |
| **Tickets** | Multiple panels (buttons or dropdowns), categories with their own staff roles, pre-ticket forms, private channels, claiming, assignment, priorities, close/reopen, HTML transcripts (posted to a channel and DMed to the user), archive or auto-delete, auto-close for inactive tickets, statistics and an optional AI first response. |
| **Automation** | A visual workflow builder (trigger → conditions → actions → delays). It includes **15 one-click recipes**: delayed member role, quarantine of new accounts, bump reminder, FAQ auto-reply, in-voice role, help-thread replies, staff alerts, night-time slowmode, scheduled channel open/close, recurring event announcements, partner-invite roles and more. Triggers: joins, leaves, messages (including from other bots), deleted messages, threads, reactions, roles, voice, schedules (cron), level-ups, tickets, boosts and suggestions. Actions cover messages, DMs, roles, kick/ban/timeout, lock/unlock, slowmode, pin, publish, voice move/disconnect, random replies and HTTPS webhooks (Zapier, Make, n8n). Conditions cover roles, account age, time in server, time of day, weekday and invite used. Delays of up to 24 hours survive restarts. Also welcome/goodbye messages and DMs, auto-roles, reaction/button/dropdown role menus, milestones, dry-run testing and a run log. You can describe an automation in plain language and MOTH builds it. |
| **Custom commands** | Slash commands and message triggers with an embed builder, placeholders (`{user}`, `{args.x}`, `{random:a\|b}` …), options, conditional responses, follow-up actions, role and channel permissions, cooldowns, import/export, a test preview and AI generation. |
| **AI** | Works out of the box with a free local model (no API key). Also supports OpenAI, Anthropic, any OpenAI-compatible endpoint (OpenRouter, Groq, vLLM, LM Studio…) or a local Ollama. Features: `/ask`, mention chat and AI channels, `/summarize`, `/modassist`, AI support replies, command and automation generation, and server analysis. Personality is configurable, with per-user limits. **The AI never takes administrative actions on its own; every change is a proposal that an authorised human approves.** |
| **Community** | XP and levels (message and voice, multipliers, role rewards), leaderboards, profiles, achievements and badges, daily rewards with streaks, economy with a shop, giveaways with requirements, polls, and member milestones. |
| **Analytics** | Member growth, message activity, an activity heatmap, top channels, voice time, moderation, tickets, security, automation and AI usage, live and historical. |
| **Dashboard** | A dark interface with crimson accents and 14 sections: Overview, Quick Setup, Architect, Server Tools, Moderation, Security, Tickets, Automation, Commands, Members, Analytics, AI Settings, Server Settings and System. Discord OAuth login, multi-server switching, role-based access, live updates (SSE), confirmation dialogs and a responsive layout. Changes sync both ways between Discord and the dashboard. |

## Architecture

```
 ┌───────────────┐   OAuth / HTTPS   ┌──────────────────────┐   internal API (private network)   ┌───────────────────┐
 │    Browser    │ ────────────────▶ │  dashboard (Next.js) │ ─────────────────────────────────▶ │  bot (discord.js) │ ◀──▶ Discord
 └───────────────┘ ◀── SSE (live) ── └──────────┬───────────┘                                    └─────────┬─────────┘
                                                │            LISTEN/NOTIFY event bus                       │
                                                └──────────────────▶  PostgreSQL  ◀────────────────────────┘
```

| Path | Purpose |
| --- | --- |
| `packages/core` | Shared TypeScript library: Drizzle schema and migrations, typed per-guild config (zod), Postgres event bus, AES-256-GCM credential store, provider-independent AI client, the Architect engine (blueprints, planner/diff, templates, analyser), the automation and command schemas, and templating. |
| `apps/bot` | The discord.js gateway service: commands, moderation, automod, security, tickets, automation engine, community features, the Architect executor with rollback, a durable job scheduler, analytics, and the authenticated internal HTTP API. |
| `apps/dashboard` | The Next.js 16 app: Discord OAuth, sessions, RBAC, API routes and the UI. |
| `install.sh`, `scripts/moth`, `docker-compose.yml`, `Dockerfile` | One-command installer, management CLI and deployment. |

**Synchronisation.** Both services write to Postgres and publish events on a `LISTEN/NOTIFY` channel. The bot invalidates caches and re-registers slash commands when something changes. The dashboard streams events to browsers over Server-Sent Events, so a change made with `/config` shows up in an open dashboard immediately, and a change saved in the dashboard reaches Discord immediately.

**Reliability.** Every container has a health check and `restart: unless-stopped`. Migrations run in a one-shot `migrate` container under an advisory lock. Scheduled jobs (temp-ban expiry, ticket deletion) and lockdown/raid state live in Postgres, so they survive restarts. The event bus reconnects with backoff. Services write heartbeats every 15 s, which the System page shows. Logs are structured JSON (pino).

## Installation

### Requirements

- A 64-bit Linux server (x86_64 or arm64) with **1 GB RAM** (2 GB recommended) and **4 GB** free disk.
- Supported: Ubuntu, Debian, Raspberry Pi OS, Fedora, CentOS/RHEL/Rocky/Alma, Arch, openSUSE and Alpine.
- A Discord application ([Developer Portal](https://discord.com/developers/applications)):
  1. **Bot** tab: reset and copy the token, and enable **Server Members Intent** and **Message Content Intent**.
  2. **OAuth2** tab: copy the **Client ID** and **Client Secret**.

### One command

```bash
curl -fsSL https://raw.githubusercontent.com/lk5t/MOTH-discord-bot/main/install.sh | sudo bash
```

The installer:

1. detects the distribution and architecture
2. checks system requirements
3. installs the dependencies
4. installs Docker and Docker Compose if they're missing
5. downloads the latest stable release (or `main`)
6. prompts for and validates your Discord credentials, generates secrets, configures PostgreSQL and sets up free local AI (no key needed)
7. sets up persistent volumes and a backup directory
8. sets up the bot service
9. sets up the dashboard
10. configures networking: firewall rules, plus automatic HTTPS through Caddy if you give it a domain
11. installs a `moth.service` systemd unit and the `moth` CLI
12. pulls the images (or builds them locally), downloads the local AI model and starts everything
13. checks that the database, dashboard and Discord connection are healthy

When it finishes, **add the redirect URL it prints** (`<dashboard-url>/api/auth/callback`) under **OAuth2 → Redirects** in the Developer Portal, then invite the bot with the link it prints.

#### Unattended / automated installs

```bash
curl -fsSL https://raw.githubusercontent.com/lk5t/MOTH-discord-bot/main/install.sh | sudo \
  DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_CLIENT_SECRET=... MOTH_OWNER_IDS=<your user id> \
  bash -s -- --unattended --domain moth.example.com
```

Options: `--dir`, `--version <tag>`, `--domain`, `--port`, `--unattended`, `--build` (build images locally), `--no-start`, `--no-ai`, `--local-ai <model>`.

#### Creating a new server with the Architect

Discord doesn't let bots create guilds. Create an empty server in Discord, invite MOTH, then open **Architect → New server** (or run `/architect create`), describe what you want, review the preview and apply it.

## Managing MOTH

```text
moth status            service health
moth logs bot -f       follow logs (bot, dashboard, postgres, migrate, caddy)
moth update            upgrade now (backs up the database first)
moth autoupdate        automatic updates: on by default, checked every 3 hours (on|off)
moth backup            pg_dump to /opt/moth/backups
moth restore <file>    restore a dump
moth config            edit .env and restart
moth doctor            check the token, privileged intents, config and containers
moth url               dashboard URL, OAuth redirect and invite link
moth uninstall
```

**Automatic updates.** A systemd timer checks GitHub every 3 hours. When a new version is published, MOTH backs up the database, builds the new version while the current one keeps running, and switches over in seconds. Your configuration and data are always kept. The log is at `/var/log/moth-update.log`.

MOTH also takes daily configuration backups of each server's Discord structure and MOTH settings, plus a backup before every Architect change. You can view, download and restore them from **Server Settings → Backups**.

## Discord commands

| | |
| --- | --- |
| Architect | `/architect create · template · edit · improve · redesign · history · rollback` |
| Moderation | `/warn /timeout /untimeout /kick /ban /unban /note /purge /slowmode /lock /case /history /lockdown` |
| Tickets | `/ticket close · reopen · claim · add · remove · rename · priority · assign · panel · stats` |
| AI | `/ask /summarize /modassist`, or mention @MOTH |
| Setup & tools | `/setup`, `/suggest`, `/suggestion`, `/invites leaderboard · who` |
| Community | `/rank /leaderboard /profile /daily /balance /pay /shop /giveaway /poll` |
| Admin | `/config module · logs · welcome · automod · security · modroles · verification`, `/backup`, `/moth` |

## AI providers

**No API key is needed.** On servers with at least 4 CPU cores and 6 GB RAM, the installer automatically runs a free local AI model next to MOTH (Qwen 2.5 via Ollama) and picks a size that stays fast on your CPU: 3B by default, or 7B on machines with 8+ CPU cores and 8 GB RAM. Want a different trade-off? `sudo moth ai local qwen2.5:1.5b` is faster and `sudo moth ai local qwen2.5:7b` is smarter. The Architect never waits more than 20 seconds for the AI; if the model is slower than that, it uses the instant built-in designer. On smaller servers it leaves AI off so MOTH stays light, and MOTH uses its built-in designer and audit, which need no AI at all. `sudo moth ai off` turns AI off at any time and frees its memory, CPU and disk.

With local AI, the Architect asks the model for a short design brief: it reads your request and works out the server type, topics, features, custom sections and what to add, rename or remove. MOTH's designer then builds the full layout from that brief. This is fast on a CPU and reliable even with small models. The model also handles `/ask`, chat, summaries and command or automation generation.

Optional, if you ever want stronger AI:

```bash
sudo moth ai             # show what's running
sudo moth ai key         # use an OpenAI / Anthropic / OpenRouter key instead
sudo moth ai local       # switch back to the free local model (optionally: moth ai local qwen2.5:7b)
sudo moth ai off
```

Each server can also add its own provider under **AI Settings** in the dashboard. Keys are encrypted at rest with AES-256-GCM and never sent back to the browser.

## Security model

- **Dashboard access** comes from Discord: the server owner or anyone with Administrator/Manage Server is an *admin*. Other users get *moderator* or *viewer* access through role or user grants. Every API route checks the level server-side; hiding something in the navigation is never treated as a security boundary. Users listed in `MOTH_OWNER_IDS` can see the System page.
- Sessions use random 256-bit tokens. Only their SHA-256 hash is stored, in `httpOnly` `SameSite=Lax` cookies. State-changing requests also require a same-origin `Origin` header.
- Config writes use optimistic concurrency, so two editors can't silently overwrite each other. Every change goes to the change history with its source (dashboard, Discord, Architect or system).
- The bot's internal API is only reachable on the private Docker network and needs a shared secret.
- The AI is advisory. Architect plans, generated commands and generated automations only take effect after an authorised user approves them.

## Development

```bash
npm install
npm run build:core                 # shared library
npm test                           # unit tests (architect planner, templates, config, crypto…)
docker compose up -d postgres      # or any Postgres 14+
cp .env.example .env               # fill in values; DATABASE_URL=postgres://moth:<pw>@localhost:5432/moth
npm run db:migrate
npm run dev:bot                    # tsx watch
npm run dev:dashboard              # next dev on :3000
```

Schema changes: edit `packages/core/src/db/schema.ts`, then run `npm run db:generate`.

Releases: pushing a `v*` tag builds multi-arch images to `ghcr.io/lk5t/moth-bot` and `moth-dashboard` and publishes a GitHub release. The installer installs the latest release, and falls back to building `main` locally if there isn't one.
