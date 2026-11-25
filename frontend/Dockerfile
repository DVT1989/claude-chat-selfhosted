FROM node:24-alpine AS builder

# sharp needs native build tools for PNG generation
RUN apk add --no-cache python3 make g++ vips-dev

WORKDIR /app
COPY package*.json ./
RUN npm install
# Generate PWA icons (PNG) from SVG sources
COPY scripts ./scripts
COPY public ./public
RUN node scripts/gen-icons.mjs
COPY . .
RUN npm run build

# ── Production image ──────────────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Next.js standalone output includes everything needed
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
