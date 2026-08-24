# Minute

A Slack and Discord plugin that makes the handoff between non-tech people and engineering **thin**.

Someone who does not know git asks for a simple thing in chat. Minute puts a photo of the change in **the same thread**. They iterate there. When they are satisfied they ping tech. Tech reviews the **PR on technical grounds** — approve or disapprove. Git stays on the tech side.

If it is not architecturally feasible, Minute **stops**. Humans talk. Tech improves the PR by hand.

## What it is for

Simple work that still has to live in the repo: a color, copy, a notes tab, dropping a chart onto a page. Not architecture, auth, payments, or a redesign.

- **Stakeholder** owns intent. The photo is the spec.
- **Tech** owns the system. They never have to hold “what the teacher wants the tab to look like.”

## Loop

```
/minute make a notes tab for my class
        ↓
same thread: working → photo
        ↓
reply to tweak (“bigger type”, “left side”)
        ↓
Looks good  →  tech is pinged with the PR
        ↓
tech reviews the PR (not in Minute)
        ↓
approve  or  disapprove (Minute exits; talk + fix the PR)
```

## Setup

Node 20+. A GitHub repo. An Anthropic or OpenAI key.

```bash
cd minute
cp .env.example .env
# fill .env
cp minute.config.yaml minute.config.yaml  # edit playgrounds, admins, tech
npm install
npx playwright install chromium
npm start
```

### 1. Config — tech draws the playground once

Edit `minute.config.yaml`:

- **admins** — can `/minute-admin allow @person`
- **requesters** — selected employees who may run `/minute` (admins can grant more in chat)
- **tech** — who gets pinged on sign-off
- **playgrounds** — one Slack/Discord channel → one repo, allowed paths/routes, refuse list, preview

Channel IDs:

- Slack: channel details → copy ID (or right-click with Dev Mode)
- Discord: right-click channel → Copy Channel ID (Developer Mode on)

### 2. Slack (Socket Mode)

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From a manifest → paste `slack-manifest.json`
2. Socket Mode → enable → generate App-Level Token with `connections:write` → `SLACK_APP_TOKEN`
3. Install to workspace → `SLACK_BOT_TOKEN`
4. Basic Information → Signing Secret → `SLACK_SIGNING_SECRET`
5. Invite `@Minute` to the playground channel

### 3. Discord

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token → `DISCORD_TOKEN`
2. OAuth2 → Client ID → `DISCORD_CLIENT_ID`
3. Bot → Privileged Gateway Intents → **Message Content Intent**
4. OAuth2 → URL Generator → scopes `bot` `applications.commands` → bot perms: Send Messages, Create Public Threads, Attach Files, Read Message History
5. Invite the bot, then:

```bash
npm run discord:commands
```

### 4. GitHub

A PAT or GitHub App token with `repo` (clone, push, open PRs). `GITHUB_TOKEN` in `.env`.

The token’s user needs write access to the playground repo.

### 5. Photos

In the playground:

```yaml
preview:
  baseUrl: https://staging.example.com   # optional "before" photo
  command: npm run dev                   # boot the edited app for the "after" photo
  url: http://localhost:3000
  waitSeconds: 25
  defaultRoute: /
```

If `command` is empty, Minute still opens the PR and says in-thread that it could not take a live photo.

## Commands

| | |
|---|---|
| `/minute …` | Start a run in this channel’s playground |
| Reply in the thread | Tweak (same PR) |
| **Looks good** | Ping tech; photo is on the PR |
| **Cancel** | Stop |
| `/minute-admin allow @user` | Grant access |
| `/minute-admin revoke @user` | Revoke |
| `/minute-admin` / `who` | Show rails |

Tech never has to merge from chat. They review the PR as usual. `CHANGES_REQUESTED` or closing the PR posts an exit in the thread and Minute does not keep iterating.

## Layout

```
src/protocol.ts      the loop (refuse, change, proof, handoff, exit)
src/classify.ts      refuse early if it isn't simple
src/agent.ts         smallest edit inside allow.paths
src/preview.ts       Playwright photo
src/slack-app.ts     Slack slash + thread + buttons
src/discord-app.ts   Discord slash + thread + buttons
minute.config.yaml   playgrounds
```
