# syntax=docker/dockerfile:1
#
# Browser worker image. Build from the repository root:
#   docker build -f apps/browser-worker/Dockerfile -t smp-browser-worker .
#
# Stages as in infra/docker/node-app.Dockerfile: prune (turbo) -> deps (pnpm, frozen lockfile) ->
# build (turbo) -> runtime. The runtime is the official Playwright image, which ships Chromium and
# its system libraries; its tag must match the exact Playwright version pinned in
# apps/browser-worker/package.json.

ARG NODE_IMAGE=node:24.21.0-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Keeps only what the browser worker needs, and separates the manifests from the sources.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.8 prune @smp/browser-worker --docker

FROM base AS deps
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./
COPY --from=prune /repo/out/pnpm-workspace.yaml ./
# The runtime image brings Chromium; nothing is downloaded during the install.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY --from=prune /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=@smp/browser-worker...
RUN pnpm deploy --legacy --filter @smp/browser-worker --prod --config.auto-install-peers=false /out

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /out ./
USER pwuser
CMD ["node", "--require", "@smp/observability/register", "dist/main.js"]
