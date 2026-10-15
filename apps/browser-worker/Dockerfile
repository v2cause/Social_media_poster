# Browser worker image. Build from the repository root:
#   docker build -f apps/browser-worker/Dockerfile -t smp-browser-worker .
#
# Build stage: install, build and prune to production dependencies with pnpm.
# Runtime stage: the official Playwright image, which ships Chromium and its system libraries.
# Its tag must match the exact Playwright version pinned in apps/browser-worker/package.json.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @smp/browser-worker...
RUN pnpm --filter @smp/browser-worker... build
RUN pnpm deploy --legacy --filter @smp/browser-worker --prod /out

FROM mcr.microsoft.com/playwright:v1.64.1-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /out ./
USER pwuser
CMD ["node", "dist/main.js"]
