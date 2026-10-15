# syntax=docker/dockerfile:1
#
# Backend images for the api and the worker. Build from the repository root:
#   docker build -f infra/docker/node-app.Dockerfile --build-arg APP=api -t smp-api .
#   docker build -f infra/docker/node-app.Dockerfile --build-arg APP=worker -t smp-worker .
#
# Stages: prune (turbo) -> deps (pnpm, frozen lockfile) -> build (turbo) -> runtime (production deps only).

ARG NODE_IMAGE=node:24-slim
ARG APP=api
ARG HEALTH_URL=http://127.0.0.1:3001/api/health/live

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Keeps only what the target app needs, and separates the manifests from the sources.
FROM base AS prune
ARG APP
COPY . .
RUN pnpm dlx turbo@2.11.8 prune @smp/${APP} --docker

FROM base AS deps
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./
COPY --from=prune /repo/out/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG APP
COPY --from=prune /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=@smp/${APP}...
RUN pnpm deploy --legacy --filter @smp/${APP} --prod --config.auto-install-peers=false /out

FROM ${NODE_IMAGE} AS runtime
ARG HEALTH_URL
ENV NODE_ENV=production
ENV HEALTH_URL=${HEALTH_URL}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch(process.env.HEALTH_URL).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--require", "@smp/observability/register", "dist/main.js"]
