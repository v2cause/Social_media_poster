# syntax=docker/dockerfile:1
#
# Web image (Next.js, standalone output). Build from the repository root:
#   docker build -f infra/docker/web.Dockerfile -t smp-web .
#
# API_INTERNAL_URL is read by the rewrites at build time. Set it to the API's address in the
# network the web container runs in. In production a reverse proxy routes /api instead.

ARG NODE_IMAGE=node:24-slim
ARG API_INTERNAL_URL=http://127.0.0.1:3001

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
ARG API_INTERNAL_URL
ENV API_INTERNAL_URL=${API_INTERNAL_URL}
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
