# Builds a slim runtime image for @claude-control/control-plane-bot out of the pnpm
# workspace. Build context must be the repo root (see deploy/docker-compose.yml).
#
# Two stages: `build` installs the FULL workspace (pnpm's frozen-lockfile check reconciles
# against every workspace importer, so every package.json needs to be present) and compiles
# only the bot and the packages it actually depends on; `runtime` installs a PRODUCTION-only
# node_modules scoped to that same package set and copies in the compiled output. Neither
# stage ever fetches or links switch-engine's, daemon's, session-runtime's, or cli's own
# dependencies into this image — see index.ts's zero-credential comment and
# src/dependencyClosure.test.ts, which enforces the same rule at test time.

FROM node:24-alpine AS base
# corepack ships with Node but is opt-in; the pnpm version actually used is resolved per-stage
# from the "packageManager" field of whatever package.json is nearest at invocation time, so
# every stage below reproduces the exact dependency graph CI and local dev resolve.
RUN corepack enable

# ---------------------------------------------------------------------------------------------
# build: full workspace install (required for the lockfile check), scoped compile
# ---------------------------------------------------------------------------------------------
FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# The trailing "..." selects the named package AND everything it depends on, built in
# topological order — shared-protocol and usage-advisor compile before the bot does, and
# nothing outside that dependency set is touched.
RUN pnpm --filter "@claude-control/control-plane-bot..." run build

# ---------------------------------------------------------------------------------------------
# runtime: production-only install scoped to the same package set, plus compiled output
# ---------------------------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/control-plane-bot/package.json packages/control-plane-bot/package.json
COPY packages/shared-protocol/package.json packages/shared-protocol/package.json
COPY packages/usage-advisor/package.json packages/usage-advisor/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/daemon/package.json packages/daemon/package.json
COPY packages/session-runtime/package.json packages/session-runtime/package.json
COPY packages/switch-engine/package.json packages/switch-engine/package.json
# Every workspace package.json must be present for pnpm to reconcile the lockfile, but
# --filter below still restricts what is actually fetched and linked to the bot and its
# declared dependencies — switch-engine's own dependencies are never installed into this image
# even though its (empty) manifest is present on disk for the lockfile check above.
RUN pnpm install --frozen-lockfile --prod --filter "@claude-control/control-plane-bot..."

COPY --from=build /repo/packages/control-plane-bot/dist packages/control-plane-bot/dist
COPY --from=build /repo/packages/shared-protocol/dist packages/shared-protocol/dist
COPY --from=build /repo/packages/usage-advisor/dist packages/usage-advisor/dist
# Progress-bar sprites: discordJsGateway.ts resolves this directory relative to its own
# compiled location (dist/discord/discordJsGateway.js -> ../../assets/progress-bar).
COPY packages/control-plane-bot/assets packages/control-plane-bot/assets

WORKDIR /repo/packages/control-plane-bot
# Matches CCTL_RELAY_PORT's default (bin.ts) — the same port serves daemon websockets and the
# unauthenticated GET /health probe.
EXPOSE 8765
CMD ["node", "dist/bin.js"]
