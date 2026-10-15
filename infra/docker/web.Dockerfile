# syntax=docker/dockerfile:1
#
# Web image (Next.js, standalone output). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t smp-web .
#
# The image contains no rewrite to the API, so it is the same for every environment. A reverse
# proxy in front of it routes /api to the API (locally: the "proxy" service in compose.yaml).
# API_INTERNAL_URL is set at runtime for server-side calls only.

ARG NODE_IMAGE=node:24-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.8 prune @smp/web --docker

FROM base AS deps
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./
COPY --from=prune /repo/out/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=prune /repo/out/full/ ./
RUN pnpm exec turbo run build --filter=@smp/web...

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/web/server.js"]
