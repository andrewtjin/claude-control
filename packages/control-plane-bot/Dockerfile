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

# Base image pinned by digest, not just the floating `node:24-alpine` tag, so every rebuild
# resolves the exact image this was tested against and a re-pushed or tampered tag cannot silently
# change the base out from under a deploy. This is the multi-arch manifest-list digest, so Docker
# still selects the right platform underneath it. Refresh the tag AND the digest together when
# bumping Node; the current digest for a tag comes straight from the registry:
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
#   curl -s -o /dev/null -D - -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.oci.image.index.v1+json" https://registry-1.docker.io/v2/library/node/manifests/24-alpine | grep -i docker-content-digest
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
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
# su-exec: Alpine's tiny (~20KB) setuid-free gosu equivalent, used by the entrypoint to drop from
# root to the unprivileged `node` user after fixing up state-volume ownership (see entrypoint.sh).
RUN apk add --no-cache su-exec

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

# Run the bot as an unprivileged user via a self-healing entrypoint (start root -> chown the
# persisted state volume -> su-exec to `node`). Copied straight from the build context; the image
# is deliberately NOT set to `USER node` at build time so the entrypoint can repair an existing
# root-owned volume before it drops privileges. See scripts/entrypoint.sh and the cap_add note in
# deploy/docker-compose.yml for the three capabilities the root phase needs and nothing more.
COPY packages/control-plane-bot/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/bin.js"]
