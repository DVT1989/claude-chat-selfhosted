# Claude Chat (self-hosted)

A self-hosted web app around **Claude Code**. Every user gets an isolated workspace with a normal Claude Code
installation, logs in with their own Claude account, and chats with it from the browser, phone (PWA),
Telegram or WhatsApp. The app is a shell: it starts the official `claude` CLI and shows the stream.
Nothing is shared or resold; each user uses their own subscription or API key.

Built and used daily on a Synology NAS. The interface is in Dutch and English.

## Features

- Chat with Claude Code in the browser: streaming, tool calls, attachments, resume after restarts, multiple
  Claude accounts per user with automatic switch when one hits its limit, usage per account
- Multi-user with roles, 2FA (TOTP), push notifications, installable as PWA
- Connectors per user (SSH, SFTP, FTP, SMB, git, GitHub, OneDrive, Microsoft 365, sudo), stored encrypted
- Own agents (name, colour, prompt, model) with delegation to background workspaces
- Persistent memory, shared lessons, searchable history of all conversations
- Scheduled tasks (cron) that run Claude on a schedule
- Telegram bot and WhatsApp link per user
- Device agent for Windows and macOS (remote commands, files, screenshots, remote control) and a Chrome
  extension that lets Claude read and operate browser tabs
- Admin chat with access to the project itself (rebuild via `selfupdate`), daily backups

## Requirements

- Linux host with Docker and Docker Compose (a NAS works; tested on Synology DSM 7)
- A Claude account (Pro/Max) or an Anthropic API key per user
- About 4 GB RAM; the first build takes a while (Go, Next.js, Playwright)

## Install

The admin chat and `selfupdate` expect the project at `/volume1/docker/claude-chat` (the Synology path).
On another host, create that path or a symlink to it.

```sh
sudo mkdir -p /volume1/docker && cd /volume1/docker
git clone https://github.com/DVT1989/claude-chat-selfhosted.git claude-chat
cd claude-chat
./setup.sh https://claude.example.com    # or leave out for http://localhost:15980
docker compose up -d --build
docker compose logs backend | grep WACHTWOORD    # admin password, unless ADMIN_PASSWORD was set
```

Open the app (port 15980 by default), log in as `admin`, then in Settings > Claude link your Claude account.
Put it behind a reverse proxy with HTTPS for use outside your network (needed for PWA and push).

`setup.sh` writes `.env` with random secrets and creates a self-signed code signing certificate in `signing/`
for the Windows/macOS device agent. Both stay out of git.

## Updating

```sh
git pull
docker compose up -d --build
```

From inside the admin chat use `selfupdate backend frontend` instead; it rebuilds from a helper container so the
running chat survives the restart.

## Layout

```
backend/            Express + TypeScript API, Claude Code runner, device agent (Go) in backend/agent
frontend/           Next.js app
browser-extension/  Chrome extension
database/           SQL schema (first start); later migrations run from backend/src/index.ts
nginx/              reverse proxy in front of frontend and backend
shared-skills/      Claude Code skills and hooks for every user (empty by default)
```

## Security notes

- The backend container gets the Docker socket and the project folder for the admin chat and backups.
  Only admins reach that; still, treat the host as trusted.
- Run it on a network you control and use HTTPS.

## License

MIT
