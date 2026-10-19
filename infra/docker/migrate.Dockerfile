# syntax=docker/dockerfile:1
#
# The migrations of the database as a one-shot container of the production template (guide step
# 8.9): prisma migrate deploy as app_migrator, before API and worker start. Build from the
# repository root:
#   docker build -f infra/docker/migrate.Dockerfile -t smp-migrate .
#
# Stages: prune (turbo) -> deps (pnpm, frozen lockfile) -> runtime (the prisma CLI with the schema
# and the migrations of packages/db, no package manager).

ARG NODE_IMAGE=node:24.21.0-trixie-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# @smp/migrate holds only the CLI and what prisma.config.ts imports, not the devDependencies of
# packages/db with its test tools.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.8 prune @smp/migrate --docker

FROM base AS deps
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./
COPY --from=prune /repo/out/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm deploy --legacy --filter @smp/migrate --prod --config.auto-install-peers=false /out

FROM ${NODE_IMAGE} AS runtime
# No package manager: the CLI runs with node alone (guide step 8.4).
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* /usr/local/bin/corepack /usr/local/bin/npm \
    /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
# The CLI asks for no updates and sends no telemetry.
ENV CHECKPOINT_DISABLE=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
# Owned by root: the container cannot change its own migrations.
COPY --from=deps /out ./
COPY packages/db/prisma.config.ts ./
COPY packages/db/prisma ./prisma
USER node
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
