# ── Claude Agent (Windows/Mac) + Windows installer ───────────
FROM golang:1.23-bookworm AS agent
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent/*.go ./
COPY agent/fonts ./fonts
ARG AGENT_VERSION=1.7.0
RUN mkdir -p /out \
 && for t in windows/amd64 darwin/arm64 darwin/amd64; do \
      os=${t%/*}; arch=${t#*/}; ext=""; [ "$os" = windows ] && ext=".exe"; \
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.version=$AGENT_VERSION" -o /out/claude-agent-$os-$arch$ext . || exit 1; \
    done \
 && cp /out/claude-agent-windows-amd64.exe /out/claude-agent.exe \
 && echo "$AGENT_VERSION" > /out/version.txt

# Sign the Mac agent with the stable "Claude Chat Agent" identity (rcodesign, runs on Linux). The designated
# requirement becomes identifier nl.claudechat.agent + certificate, so macOS TCC permissions (screen recording,
# accessibility) survive agent updates. Without the secret: binaries stay ad-hoc/linker-signed.
FROM debian:bookworm-slim AS macsign
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG APPLE_CODESIGN_TAG=0.29.0
RUN curl -fsSL "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/${APPLE_CODESIGN_TAG}/apple-codesign-${APPLE_CODESIGN_TAG}-$(uname -m)-unknown-linux-musl.tar.gz" | tar xz -C /tmp \
 && cp /tmp/apple-codesign-*/rcodesign /usr/local/bin/rcodesign && rm -rf /tmp/apple-codesign-*
COPY --from=agent /out/claude-agent-darwin-arm64 /out/claude-agent-darwin-amd64 /in/
RUN --mount=type=secret,id=codesign_key --mount=type=secret,id=codesign_crt \
    mkdir -p /out && \
    for a in arm64 amd64; do \
      if [ -s /run/secrets/codesign_key ] && [ -s /run/secrets/codesign_crt ]; then \
        rcodesign sign --pem-file /run/secrets/codesign_key --pem-file /run/secrets/codesign_crt --binary-identifier nl.claudechat.agent /in/claude-agent-darwin-$a /out/claude-agent-darwin-$a || exit 1; \
        rcodesign print-signature-info /out/claude-agent-darwin-$a | grep -E "identifier:|designated"; \
      else cp /in/claude-agent-darwin-$a /out/; fi; \
    done
# "Claude Agent.app": name + icon in Privacy & Security; TCC client becomes the bundle id (stable across updates).
ARG AGENT_VERSION=1.7.0
COPY agent/mac/AppIcon.icns /in/AppIcon.icns
RUN --mount=type=secret,id=codesign_key --mount=type=secret,id=codesign_crt \
    for a in arm64 amd64; do \
      B="/app-$a/Claude Agent.app/Contents"; mkdir -p "$B/MacOS" "$B/Resources" && \
      cp /in/claude-agent-darwin-$a "$B/MacOS/claude-agent" && chmod 755 "$B/MacOS/claude-agent" && \
      cp /in/AppIcon.icns "$B/Resources/AppIcon.icns" && printf 'APPL????' > "$B/PkgInfo" && \
      printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
        '<plist version="1.0"><dict>' \
        '<key>CFBundleIdentifier</key><string>nl.claudechat.agent</string>' \
        '<key>CFBundleName</key><string>Claude Agent</string>' \
        '<key>CFBundleDisplayName</key><string>Claude Agent</string>' \
        '<key>CFBundleExecutable</key><string>claude-agent</string>' \
        '<key>CFBundleIconFile</key><string>AppIcon</string>' \
        '<key>CFBundlePackageType</key><string>APPL</string>' \
        '<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>' \
        "<key>CFBundleShortVersionString</key><string>$AGENT_VERSION</string>" \
        "<key>CFBundleVersion</key><string>$AGENT_VERSION</string>" \
        '<key>LSMinimumSystemVersion</key><string>11.0</string>' \
        '<key>LSUIElement</key><true/>' \
        '<key>NSScreenCaptureUsageDescription</key><string>Claude Agent toont je scherm aan de beheerder die meekijkt.</string>' \
        '<key>NSAppleEventsUsageDescription</key><string>Claude Agent bedient apps namens de beheerder.</string>' \
        '</dict></plist>' > "$B/Info.plist" && \
      if [ -s /run/secrets/codesign_key ] && [ -s /run/secrets/codesign_crt ]; then \
        rcodesign sign --pem-file /run/secrets/codesign_key --pem-file /run/secrets/codesign_crt "/app-$a/Claude Agent.app" || exit 1; \
        rcodesign print-signature-info "$B/MacOS/claude-agent" | grep -E "identifier:|designated"; \
      fi; \
      tar czf /out/claude-agent-app-darwin-$a.tar.gz -C /app-$a "Claude Agent.app" || exit 1; \
    done

FROM debian:bookworm-slim AS installer
RUN apt-get update && apt-get install -y --no-install-recommends nsis osslsigncode ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
ARG APP_URL=https://
ARG AGENT_VERSION=1.7.0
COPY agent/installer.nsi ./
COPY --from=agent /out/claude-agent.exe ./
# Sign agent, uninstaller and installer with the self-signed "Claude Chat Agent" certificate.
# The key comes in as a BuildKit secret (signing/ on the NAS, never in the image or git); without it: unsigned.
RUN --mount=type=secret,id=codesign_key --mount=type=secret,id=codesign_crt \
    set -e; \
    if [ -s /run/secrets/codesign_key ] && [ -s /run/secrets/codesign_crt ]; then \
      cp /run/secrets/codesign_crt codesign.crt; \
      printf '#!/bin/sh\nset -e\nfor ts in http://timestamp.digicert.com http://timestamp.sectigo.com ""; do\n  if osslsigncode sign -certs /run/secrets/codesign_crt -key /run/secrets/codesign_key -n "Claude Agent" -i "%s" -h sha256 ${ts:+-t $ts} -in "$1" -out "$1.signed" >/dev/null 2>&1; then mv "$1.signed" "$1"; exit 0; fi\ndone\nexit 1\n' "$APP_URL" > /usr/local/bin/sign && chmod 755 /usr/local/bin/sign; \
      sign claude-agent.exe; \
      makensis -V2 -DAPP_URL="$APP_URL" -DVERSION="$AGENT_VERSION" -DSIGN=1 installer.nsi; \
      sign ClaudeAgentSetup.exe; \
      osslsigncode verify -CAfile codesign.crt -in ClaudeAgentSetup.exe | grep -E "Signer|Signature verification|Timestamp" | head -4; \
    else \
      : > codesign.crt; \
      makensis -V2 -DAPP_URL="$APP_URL" -DVERSION="$AGENT_VERSION" installer.nsi; \
    fi

FROM node:24-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production image ──────────────────────────────────────────
FROM node:24-bookworm AS production

WORKDIR /app

ENV NODE_ENV=production

# System tools needed by connectors + Claude Code
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    python3-pip \
    openssh-client \
    sshpass \
    curl \
    wget \
    smbclient \
    lftp \
    bash \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh): repos and GitHub Actions for Windows builds
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && wget -qO /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# PowerShell 7 (pwsh): .ps1 scripts and cloud modules (Microsoft.Graph, ExchangeOnlineManagement, PnP.PowerShell)
# without depending on a Windows pc. Modules install per user with -Scope CurrentUser into the persistent home.
RUN wget -qO /tmp/ms.deb https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
 && dpkg -i /tmp/ms.deb && rm /tmp/ms.deb \
 && apt-get update && apt-get install -y --no-install-recommends powershell && rm -rf /var/lib/apt/lists/* \
 && pwsh -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
ENV POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code --unsafe-perm

# Non-root user for running Claude Code (dangerously-skip-permissions requires non-root)
# ssh/scp read ~/.ssh/config from the passwd home (/home/clauderunner), not from $HOME (the per-user
# home under /claude-homes), so connector aliases like "NAS" were ignored and resolved via DNS instead.
RUN printf '#!/bin/sh\nif [ -f "$HOME/.ssh/config" ]; then exec /usr/bin/ssh -F "$HOME/.ssh/config" "$@"; fi\nexec /usr/bin/ssh "$@"\n' > /usr/local/bin/ssh \
 && printf '#!/bin/sh\nif [ -f "$HOME/.ssh/config" ]; then exec /usr/bin/scp -F "$HOME/.ssh/config" "$@"; fi\nexec /usr/bin/scp "$@"\n' > /usr/local/bin/scp \
 && chmod 755 /usr/local/bin/ssh /usr/local/bin/scp
RUN useradd -m -u 1001 -s /bin/bash clauderunner

# Docker CLI + compose plugin for the admin chat and backups (talks to the host daemon via the mounted socket).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY selfupdate.sh /usr/local/bin/selfupdate
RUN chmod 755 /usr/local/bin/selfupdate
# Mount point of the project dir. /volume1 is root:root 750: only gid 0 (the admin chat) may enter,
# normal chats (1001:1001) cannot read the source, .env or backups.
RUN mkdir -p /volume1/docker/claude-chat && chown root:root /volume1 && chmod 750 /volume1

# Create base directory structure for per-user homes and workspaces
RUN mkdir -p /claude-homes && chown clauderunner:clauderunner /claude-homes && chmod 755 /claude-homes

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Chromium for the virtual device "Browser (NAS)" (headless, started on demand, persistent profile per user in /data/browser)
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/browser /data/transfers && chmod 700 /data/browser /data/transfers

COPY --from=builder /app/dist ./dist

# Agent downloads (served by /devices/download/*)
COPY --from=macsign /out/claude-agent-darwin-arm64 /out/claude-agent-darwin-amd64 /out/claude-agent-app-darwin-arm64.tar.gz /out/claude-agent-app-darwin-amd64.tar.gz /app/agent-dist/
COPY --from=agent /out/version.txt /app/agent-dist/
COPY --from=installer /build/ClaudeAgentSetup.exe /build/codesign.crt /app/agent-dist/

RUN mkdir -p /workspace && chown clauderunner:clauderunner /workspace && chmod 755 /workspace

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -qO- http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
