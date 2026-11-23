#!/usr/bin/env bash
# Claude Chat setup: detects the host (Synology DSM, Ubuntu/Debian, other Linux, WSL, VMs), checks Docker,
# permissions, ports and resources, shows a summary, asks only what is needed, then writes .env with random
# secrets and a self-signed code signing certificate for the device agent.
#
#   ./setup.sh                      interactive
#   ./setup.sh https://chat.example.com          (old style: first argument = APP_URL)
#   ./setup.sh --yes --dir /opt/claude-chat --url http://10.0.0.5:15980 --port 15980 [--install-docker] [--start]
#   ./setup.sh --detect-only        only show what was detected (no changes, no questions)
#
# Flags: --dir PATH  --url URL  --port N  --yes|-y|--non-interactive  --install-docker  --no-install-docker
#        --start (run docker compose up -d --build at the end)  --detect-only|--dry-run  --help
set -eu

SRC_DIR=$(cd "$(dirname "$0")" && pwd)
ARG_DIR=""; ARG_URL=""; ARG_PORT=""; YES=0; INSTALL_DOCKER=ask; START=ask; DETECT_ONLY=0

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) ARG_DIR=${2:?--dir needs a path}; shift ;;
    --dir=*) ARG_DIR=${1#*=} ;;
    --url) ARG_URL=${2:?--url needs a value}; shift ;;
    --url=*) ARG_URL=${1#*=} ;;
    --port) ARG_PORT=${2:?--port needs a number}; shift ;;
    --port=*) ARG_PORT=${1#*=} ;;
    -y|--yes|--non-interactive) YES=1 ;;
    --install-docker) INSTALL_DOCKER=yes ;;
    --no-install-docker) INSTALL_DOCKER=no ;;
    --start) START=yes ;;
    --detect-only|--dry-run) DETECT_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) [ -z "$ARG_URL" ] && ARG_URL=$1 ;;
  esac
  shift
done

# No terminal (pipe, CI, ssh -T): behave like --yes
[ -t 0 ] || YES=1

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" default
  _v=$1; _q=$2; _d=$3
  if [ "$YES" = 1 ]; then eval "$_v=\$_d"; return; fi
  printf '%s [%s]: ' "$_q" "$_d"; read -r _a || _a=""
  eval "$_v=\${_a:-\$_d}"
}
confirm() { # confirm "question" default(y/n)
  [ "$YES" = 1 ] && { [ "$2" = y ]; return; }
  printf '%s [%s]: ' "$1" "$([ "$2" = y ] && echo Y/n || echo y/N)"; read -r _a || _a=""
  case "${_a:-$2}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- detection (no side effects)
detect() {
  ARCH=$(uname -m)
  case "$ARCH" in x86_64|amd64) ARCH_NAME=amd64 ;; aarch64|arm64) ARCH_NAME=arm64 ;; *) ARCH_NAME=$ARCH ;; esac
  OS_ID=""; OS_PRETTY=""; OS_LIKE=""
  if [ -r /etc/os-release ]; then
    OS_ID=$(. /etc/os-release; echo "${ID:-}"); OS_PRETTY=$(. /etc/os-release; echo "${PRETTY_NAME:-}"); OS_LIKE=$(. /etc/os-release; echo "${ID_LIKE:-}")
  fi
  PLATFORM=linux
  if [ -f /etc/synoinfo.conf ] || [ -f /etc.defaults/VERSION ]; then
    PLATFORM=synology
    OS_PRETTY="Synology DSM $(grep -E '^productversion=' /etc.defaults/VERSION 2>/dev/null | cut -d'"' -f2)"
  elif grep -qiE 'microsoft|wsl' /proc/version 2>/dev/null; then PLATFORM=wsl
  else
    case " $OS_ID $OS_LIKE " in *" ubuntu "*|*" debian "*) PLATFORM=debian ;; esac
  fi
  VIRT=none
  if have systemd-detect-virt; then VIRT=$(systemd-detect-virt 2>/dev/null || true); [ -n "$VIRT" ] || VIRT=none
  elif [ -r /sys/class/dmi/id/product_name ]; then
    case "$(cat /sys/class/dmi/id/product_name 2>/dev/null)" in *VMware*) VIRT=vmware ;; *VirtualBox*) VIRT=oracle ;; *KVM*|*QEMU*) VIRT=kvm ;; esac
  fi
  [ "$VIRT" = docker ] && VIRT=container
  [ "$VIRT" = none ] && [ -f /.dockerenv ] && VIRT=container

  UID_N=$(id -u); GID_N=$(id -g); USER_N=$(id -un)
  IS_ROOT=0; [ "$UID_N" = 0 ] && IS_ROOT=1
  HAS_SUDO=0; if [ $IS_ROOT = 1 ]; then HAS_SUDO=1; elif have sudo; then sudo -n true 2>/dev/null && HAS_SUDO=1 || HAS_SUDO=maybe; fi
  SUDO=""; [ $IS_ROOT = 0 ] && have sudo && SUDO=sudo
  IN_DOCKER_GROUP=0; id -nG | tr ' ' '\n' | grep -qx docker && IN_DOCKER_GROUP=1

  DOCKER_BIN=""
  for c in docker /usr/local/bin/docker /volume1/@appstore/ContainerManager/usr/bin/docker; do
    if have "$c" || [ -x "$c" ]; then DOCKER_BIN=$c; break; fi
  done
  DOCKER_CMD=""; DOCKER_ACCESS=none; COMPOSE=no; DOCKER_VERSION=""
  if [ -n "$DOCKER_BIN" ]; then
    if "$DOCKER_BIN" info >/dev/null 2>&1; then DOCKER_CMD=$DOCKER_BIN; DOCKER_ACCESS=direct
    elif [ -n "$SUDO" ] && $SUDO -n "$DOCKER_BIN" info >/dev/null 2>&1; then DOCKER_CMD="sudo $DOCKER_BIN"; DOCKER_ACCESS=sudo
    elif [ -S /var/run/docker.sock ]; then DOCKER_ACCESS=denied
    else DOCKER_ACCESS=daemon-down; fi
    DOCKER_VERSION=$("$DOCKER_BIN" --version 2>/dev/null | head -1 || true)
    [ -n "$DOCKER_CMD" ] && $DOCKER_CMD compose version >/dev/null 2>&1 && COMPOSE=v2
    if [ "$COMPOSE" = no ] && [ -n "$DOCKER_CMD" ] && have docker-compose; then COMPOSE=v1-only; fi
    # Compose present but daemon not reachable: still report the plugin
    if [ "$COMPOSE" = no ] && [ -z "$DOCKER_CMD" ] && "$DOCKER_BIN" compose version >/dev/null 2>&1; then COMPOSE=v2; fi
  fi
  SOCK=no; [ -S /var/run/docker.sock ] && SOCK=yes
  SOCK_PERM=$(ls -l /var/run/docker.sock 2>/dev/null | awk '{print $1" "$3":"$4}' || true)

  case $PLATFORM in synology) DEF_DIR=/volume1/docker/claude-chat; HOST_LABEL=NAS ;; *) DEF_DIR=/opt/claude-chat; HOST_LABEL=server ;; esac
  [ "$VIRT" != none ] && [ "$PLATFORM" != synology ] && HOST_LABEL=VM

  IP=""; have hostname && IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$IP" ] && have ip && IP=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
  MEM_MB=$(awk '/MemTotal/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)
  DISK_PATH=$SRC_DIR; [ -d "$(dirname "$DEF_DIR")" ] && DISK_PATH=$(dirname "$DEF_DIR")
  DISK_GB=$(df -Pk "$DISK_PATH" 2>/dev/null | awk 'NR==2 {printf "%d", $4/1048576}' || echo 0)
}

port_free() {
  if have ss; then ! ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  elif have netstat; then ! netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; fi
}
next_free_port() { p=$1; n=0; while ! port_free "$p" && [ $n -lt 50 ]; do p=$((p+1)); n=$((n+1)); done; echo "$p"; }

detect
PORT_WANT=${ARG_PORT:-15980}
if [ -f "$SRC_DIR/.env" ] && [ -z "$ARG_PORT" ]; then PORT_WANT=$(grep -E '^APP_PORT=' "$SRC_DIR/.env" | cut -d= -f2 | head -1); PORT_WANT=${PORT_WANT:-15980}; fi
PORT_STATE=free; port_free "$PORT_WANT" || PORT_STATE=in-use
PORT_FREE=$(next_free_port "$PORT_WANT")

summary() {
  say "== Detected environment =="
  say "  Platform:       $PLATFORM ($OS_PRETTY)"
  say "  Architecture:   $ARCH ($ARCH_NAME)"
  say "  Virtualization: $VIRT$( [ "$VIRT" != none ] && echo ' (no special setup needed; use the VM IP below, with a bridged network if other devices must reach it)')"
  say "  Network IP:     ${IP:-unknown}"
  say "  User:           $USER_N (uid $UID_N, gid $GID_N), root=$([ $IS_ROOT = 1 ] && echo yes || echo no), sudo=$(case $HAS_SUDO in 1) echo yes ;; maybe) echo "needs password" ;; *) echo no ;; esac), docker group=$([ $IN_DOCKER_GROUP = 1 ] && echo yes || echo no)"
  say "  Docker:         ${DOCKER_VERSION:-not installed}"
  say "  Docker access:  $DOCKER_ACCESS$( [ -n "$DOCKER_CMD" ] && echo " (using: $DOCKER_CMD)")  socket: $SOCK ${SOCK_PERM:+($SOCK_PERM)}"
  say "  Compose v2:     $COMPOSE"
  say "  Port $PORT_WANT:    $PORT_STATE$( [ "$PORT_STATE" = in-use ] && echo " (next free: $PORT_FREE)")"
  say "  Resources:      ${MEM_MB} MB RAM, ${DISK_GB} GB free on $DISK_PATH"
  say "  Install dir:    suggested $DEF_DIR (this checkout: $SRC_DIR)"
  say "  Volumes:        named Docker volumes (owned inside Docker, no host UID/GID setup needed); bind mounts need read access for others on: database/migrations, nginx, shared-skills, import"
}
problems() {
  [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 3500 ] && warn "Only ${MEM_MB} MB RAM; about 4 GB is advised (the build is heavy). Add swap or RAM."
  [ "$DISK_GB" -gt 0 ] && [ "$DISK_GB" -lt 10 ] && warn "Only ${DISK_GB} GB free; the images and volumes need roughly 10 GB."
  [ "$PLATFORM" = wsl ] && warn "WSL: use Docker Desktop with WSL integration enabled (or Docker Engine with systemd) and keep the project inside the Linux filesystem (not /mnt/c)."
  [ "$PLATFORM" = synology ] && [ $IS_ROOT = 0 ] && warn "Synology: docker needs root. Run this with sudo or log in over SSH as an admin user with sudo."
  case "$ARCH_NAME" in amd64|arm64) ;; *) warn "Architecture $ARCH is untested; the Go device agent and Chromium build may fail." ;; esac
  case "$DOCKER_ACCESS" in
    denied) warn "Docker is installed but this user cannot reach /var/run/docker.sock. Fix: sudo usermod -aG docker $USER_N, then log out and in again (or run with sudo)." ;;
    daemon-down) warn "Docker is installed but the daemon is not running. Try: sudo systemctl start docker" ;;
  esac
  [ "$COMPOSE" = v1-only ] && warn "Only the old docker-compose v1 was found; Docker Compose v2 (docker compose) is required."
  return 0
}

say "Claude Chat setup"; say
summary; say
problems
if [ $DETECT_ONLY = 1 ]; then say; say "Detect-only: nothing was changed."; exit 0; fi
say

# ---------------------------------------------------------------- Docker installation (Ubuntu/Debian only)
need_docker=0
[ -z "$DOCKER_BIN" ] && need_docker=1
[ -n "$DOCKER_BIN" ] && [ "$COMPOSE" = no ] && need_docker=1
[ "$COMPOSE" = v1-only ] && need_docker=1
if [ $need_docker = 1 ]; then
  if [ "$PLATFORM" = debian ] && [ "$INSTALL_DOCKER" != no ]; then
    say "Docker or Docker Compose v2 is missing."
    say "I can install Docker Engine plus the Compose plugin with Docker's official script (https://get.docker.com):"
    say "it adds Docker's apt repository, installs docker-ce and docker-compose-plugin, starts the service, and"
    say "adds '$USER_N' to the docker group (re-login needed for that; this run uses sudo meanwhile)."
    if [ "$INSTALL_DOCKER" = yes ] || confirm "Install Docker now?" y; then
      [ $IS_ROOT = 1 ] || have sudo || die "sudo is needed to install Docker. Install sudo or run this script as root."
      have curl || { $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl ca-certificates; }
      tmp=$(mktemp); curl -fsSL https://get.docker.com -o "$tmp"; $SUDO sh "$tmp"; rm -f "$tmp"
      [ $IS_ROOT = 1 ] || $SUDO usermod -aG docker "$USER_N" || true
      $SUDO systemctl enable --now docker 2>/dev/null || true
      detect
      [ -n "$DOCKER_CMD" ] || { DOCKER_BIN=docker; DOCKER_CMD="${SUDO:+$SUDO }docker"; }
    fi
  else
    case $PLATFORM in
      synology) say "Install 'Container Manager' from the Synology Package Center, then run this script again." ;;
      wsl) say "Install Docker Desktop for Windows and enable WSL integration for this distro, then run this script again." ;;
      debian) say "Install Docker Engine and the Compose plugin (https://docs.docker.com/engine/install/), then run this script again." ;;
      *) say "Install Docker Engine and the Compose v2 plugin for your distribution (https://docs.docker.com/engine/install/), then run this script again." ;;
    esac
    [ "$DOCKER_BIN" = "" ] && warn "Docker not found; continuing with the configuration only."
  fi
fi
[ -n "$DOCKER_CMD" ] || DOCKER_CMD=${DOCKER_BIN:-docker}

# ---------------------------------------------------------------- install location
if [ -n "$ARG_DIR" ]; then WANT_DIR=$ARG_DIR
elif [ "$YES" = 1 ]; then WANT_DIR=$SRC_DIR          # non-interactive: stay where the checkout is (old behaviour)
else ask WANT_DIR "Install directory" "$DEF_DIR"; fi
case "$WANT_DIR" in /*) ;; *) WANT_DIR="$(pwd)/$WANT_DIR" ;; esac
WANT_DIR=${WANT_DIR%/}
if [ "$WANT_DIR" != "$SRC_DIR" ]; then
  if [ -e "$WANT_DIR" ] && [ -n "$(ls -A "$WANT_DIR" 2>/dev/null)" ]; then die "$WANT_DIR exists and is not empty."; fi
  parent=$(dirname "$WANT_DIR"); S=""
  if ! { mkdir -p "$parent" 2>/dev/null && [ -w "$parent" ]; }; then
    [ -n "$SUDO" ] || [ $IS_ROOT = 1 ] || die "Cannot write to $parent and sudo is not available."
    S=$SUDO
  fi
  $S mkdir -p "$WANT_DIR"
  $S cp -a "$SRC_DIR/." "$WANT_DIR/"
  [ -n "$S" ] && $S chown -R "$UID_N:$GID_N" "$WANT_DIR"
  say "Copied the project to $WANT_DIR (the original checkout in $SRC_DIR is left alone; you can delete it)."
  SRC_DIR=$WANT_DIR
fi
cd "$SRC_DIR"

# ---------------------------------------------------------------- port and URL
PORT=${ARG_PORT:-$PORT_WANT}
if ! port_free "$PORT" && ! [ -f .env ]; then
  warn "Port $PORT is already in use."
  ask PORT "Port for Claude Chat" "$(next_free_port "$PORT")"
fi
if [ -n "$ARG_URL" ]; then URL=$ARG_URL
elif [ -f .env ]; then URL=""
else
  if [ "$PLATFORM" = wsl ] || [ -z "$IP" ]; then DEF_URL="http://localhost:$PORT"; else DEF_URL="http://$IP:$PORT"; fi
  ask URL "URL users will open (APP_URL; use your https address if behind a reverse proxy)" "$DEF_URL"
fi

# ---------------------------------------------------------------- .env
rnd() { openssl rand -hex "$1"; }
esc() { printf '%s' "$1" | sed 's/[&#\\]/\\&/g'; }
have openssl || die "openssl is required (sudo apt install openssl)."
[ -f .env.example ] || die ".env.example not found in $SRC_DIR"
if [ ! -f .env ]; then
  # A leftover Postgres volume from an earlier attempt keeps its old password and schema state
  if [ -n "$DOCKER_CMD" ] && $DOCKER_CMD volume ls -q 2>/dev/null | grep -qx 'claude-chat_postgres_data'; then
    warn "A Docker volume 'claude-chat_postgres_data' already exists from an earlier install; the new password would not match."
    warn "If this is a fresh start, remove it first: $DOCKER_CMD compose down -v   (this deletes that database)"
  fi
  sed -e "s#^APP_URL=.*#APP_URL=$(esc "$URL")#" \
      -e "s#^APP_PORT=.*#APP_PORT=$PORT#" \
      -e "s#^PROJECT_DIR=.*#PROJECT_DIR=$(esc "$SRC_DIR")#" \
      -e "s#^HOST_LABEL=.*#HOST_LABEL=$HOST_LABEL#" \
      -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(rnd 24)#" \
      -e "s#^REDIS_PASSWORD=.*#REDIS_PASSWORD=$(rnd 24)#" \
      -e "s#^JWT_SECRET=.*#JWT_SECRET=$(rnd 64)#" \
      -e "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$(rnd 32)#" \
      -e "s#^INTERNAL_API_KEY=.*#INTERNAL_API_KEY=$(rnd 32)#" \
      .env.example > .env
  chmod 600 .env
  say "Created .env (APP_URL=$URL, APP_PORT=$PORT, PROJECT_DIR=$SRC_DIR)"
else
  say ".env exists, left alone"
  cur=$(grep -E '^PROJECT_DIR=' .env | cut -d= -f2-)
  [ -n "$cur" ] && [ "$cur" != "$SRC_DIR" ] && warn "PROJECT_DIR in .env is $cur but this directory is $SRC_DIR. Update it, or the admin chat, selfupdate and backups look in the wrong place."
fi

# ---------------------------------------------------------------- files and permissions
mkdir -p signing import shared-skills
if [ ! -s signing/codesign.key ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout signing/codesign.key -out signing/codesign.crt \
    -subj "/CN=Claude Chat Agent" -addext "extendedKeyUsage=codeSigning" >/dev/null 2>&1
  chmod 600 signing/codesign.key
  say "Created self-signed code signing certificate in signing/"
fi
# Postgres (uid 70 inside its image), nginx and the backend read these bind mounts as other users. A restrictive
# umask at clone time (077) or a root-owned 700 checkout made Postgres skip database/migrations with
# 'permission denied', leaving an empty database ('relation ... does not exist'). Make them world-readable.
for d in database/migrations nginx shared-skills import; do
  [ -e "$d" ] && chmod -R a+rX "$d" 2>/dev/null || true
done
if [ -n "$(find database/migrations -name '*.sql' ! -perm -o=r 2>/dev/null)" ]; then
  warn "Some files in database/migrations are not world-readable; Postgres will fail to create the tables. Run: chmod -R a+rX database/migrations"
fi
ls database/migrations/*.sql >/dev/null 2>&1 || warn "database/migrations has no .sql files; the database would stay empty. Re-clone the repository."

# ---------------------------------------------------------------- start
CC="$DOCKER_CMD compose"
say
if [ "$START" = ask ]; then confirm "Build and start Claude Chat now (docker compose up -d --build)?" n && START=yes || START=no; fi
if [ "$START" = yes ]; then
  [ "$COMPOSE" != no ] || [ -n "$DOCKER_BIN" ] || die "Docker is not available; cannot start."
  $CC up -d --build
  say "Started. Admin password: $CC logs backend | grep WACHTWOORD"
else
  say "Next:"
  say "  cd $SRC_DIR && $CC up -d --build"
  say "  $CC logs backend | grep WACHTWOORD    # admin password, unless ADMIN_PASSWORD is set"
fi
[ $IN_DOCKER_GROUP = 0 ] && [ $IS_ROOT = 0 ] && [ "$DOCKER_ACCESS" != direct ] && say "Note: until you log out and in again, use sudo for docker commands."
say "Open: $(grep -E '^APP_URL=' .env | cut -d= -f2-)"
