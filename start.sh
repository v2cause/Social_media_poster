#!/usr/bin/env sh
# Starts Social Media Poster on this computer for one person (macOS and Linux).
# Needs Node.js 24, Docker and, for the AI, Claude Code signed in with a Claude subscription.
set -e
# corepack fetches the pnpm of package.json without asking.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$(dirname "$0")"

fail() {
  echo "[start] $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is missing. Install Node.js 24 from https://nodejs.org and run this script again."
major=$(node -p "process.versions.node.split('.')[0]")
[ "$major" -ge 24 ] || fail "Node.js $major is too old. Install Node.js 24 from https://nodejs.org."
command -v docker >/dev/null 2>&1 || fail "Docker is missing. Install Docker Desktop (or Docker Engine) and start it."
docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop and run this script again."
command -v claude >/dev/null 2>&1 || echo "[start] Claude Code was not found. Posts and diagrams need it: install it and run \"claude\" once to sign in."

echo "[start] installing the dependencies (the first run takes a few minutes)"
corepack pnpm install --frozen-lockfile
exec corepack pnpm local
