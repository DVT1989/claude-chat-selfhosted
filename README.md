# Claude Chat (self-hosted)

A self-hosted web app around **Claude Code**. Every user gets an isolated workspace with a normal Claude Code
installation, logs in with their own Claude account, and chats with it from the browser, phone (PWA),
Telegram or WhatsApp. The app is a shell: it starts the official `claude` CLI and shows the stream.
Nothing is shared or resold; each user uses their own subscription or API key.

Runs on any Linux host with Docker (built and used daily on a Synology NAS; Ubuntu, Debian and WSL2 are supported too). The interface is in Dutch and English.

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

- 64-bit Linux host (amd64 or arm64) with Docker Engine and Docker Compose v2, or a Synology NAS with Container Manager
- A Claude account (Pro/Max) or an Anthropic API key per user
- About 4 GB RAM and 10 GB free disk; the first build takes a while (Go, Next.js, Playwright)

## Install

`setup.sh` detects the platform (Synology DSM, Ubuntu/Debian, other Linux, WSL, VM), checks Docker, Compose v2,
permissions and free ports, shows a summary, and asks only what it needs. Then it writes `.env` with random secrets
(including `PROJECT_DIR`, the path the backend mounts at the same location for the admin chat, `selfupdate` and
backups) and creates a self-signed code signing certificate in `signing/` for the Windows/macOS device agent.
Both stay out of git.

```sh
git clone https://github.com/DVT1989/claude-chat-selfhosted.git
cd claude-chat-selfhosted
./setup.sh --detect-only      # optional: only show what was detected, change nothing
./setup.sh                    # interactive; offers to start the build at the end
```

Non-interactive, for scripts:

```sh
./setup.sh --yes --dir /opt/claude-chat --url http://192.168.1.50:15980 --port 15980 --install-docker --start
```

Flags: `--dir PATH`, `--url URL`, `--port N`, `--yes`, `--install-docker` / `--no-install-docker`, `--start`,
`--detect-only`. Without `--dir`, `--yes` keeps the project where it is; interactively the suggested folder is
`/opt/claude-chat` (`/volume1/docker/claude-chat` on Synology), and the checkout is copied there. The old call
`./setup.sh https://claude.example.com` still works.

Afterwards, if you did not use `--start`:

```sh
cd /opt/claude-chat
docker compose up -d --build
docker compose logs backend | grep WACHTWOORD    # admin password, unless ADMIN_PASSWORD was set
```

Open the app (port 15980 by default), log in as `admin`, then in Settings > Claude link your Claude account.
Put it behind a reverse proxy with HTTPS for use outside your network (needed for PWA and push).
`HOST_LABEL` in `.env` is what the host is called in prompts (`NAS`, `VM`, `server`, `VPS`).

### Synology (DSM 7)

Install Container Manager from the Package Center, enable SSH, log in as an admin user and run setup with sudo
(`sudo ./setup.sh`): docker on DSM needs root. Suggested folder: `/volume1/docker/claude-chat`. DSM's own reverse
proxy (Application Portal) works; the nginx config already passes the headers for streaming.

### Ubuntu / Debian (also in a VMware, Proxmox or VirtualBox VM)

No special VM settings are needed. Use a bridged network (not NAT) if other devices must reach the app, and open the
app at `http://<VM-IP>:15980`; setup shows the IP and uses it as the default `APP_URL`. If Docker is missing,
setup offers to install it with Docker's official script (https://get.docker.com: adds the apt repository, installs
docker-ce and the Compose plugin, adds you to the `docker` group). Log out and in afterwards, or keep using sudo.
Or install it yourself: https://docs.docker.com/engine/install/ubuntu/

### Other Linux

Install Docker Engine and the Compose v2 plugin for your distribution, then run `./setup.sh`. On Fedora/RHEL with
SELinux enforcing, bind mounts need the label: `sudo chcon -Rt container_file_t /opt/claude-chat`. Rootless Docker is
not supported (the admin chat needs `/var/run/docker.sock`).

### Windows with WSL2

Use Docker Desktop with WSL integration enabled for your distro (or Docker Engine in WSL with systemd). Keep the project
inside the Linux filesystem (`~/claude-chat` or `/opt/claude-chat`), not under `/mnt/c`: bind mounts and permissions
are unreliable there. Open the app at `http://localhost:15980`.

## Troubleshooting

- `relation "..." does not exist` or `permission denied` for the database: Postgres only creates the tables on
  the very first start, from `database/migrations/*.sql`. If it could not read those files (checkout made with a strict
  umask, or owned by root with mode 700) it stays empty. `./setup.sh` now fixes the permissions; to repair by hand:
  `chmod -R a+rX database/migrations && docker compose down -v && docker compose up -d --build`
  (`down -v` deletes the database volume, only do this on a fresh install).
- Backend log shows `Migration failed`: look at `docker compose logs backend`; on an empty database migration
  `009_schema_sync.sql` builds the full schema, so make sure the repository is up to date (`git pull`).
- Postgres authentication failed after re-running setup: `.env` was recreated but the old `postgres_data` volume keeps
  the old password. Fresh install: `docker compose down -v`. Otherwise restore the old `.env`.
- `permission denied while trying to connect to the Docker daemon socket`: add yourself to the docker group
  (`sudo usermod -aG docker $USER`, log out and in) or use sudo.
- `docker compose` is not a command: install the Compose v2 plugin (`docker-compose-plugin`); the old `docker-compose`
  v1 does not work.
- Port already in use: pass `--port` or set `APP_PORT` in `.env`; setup suggests the next free port.
- Container names: the compose project is named `claude-chat` whatever the folder is called, so the admin chat,
  `selfupdate` and backups find `claude-chat-backend-1` and `claude-chat-postgres-1`.

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
