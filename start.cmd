@echo off
rem Starts Social Media Poster on this computer for one person (Windows).
rem Needs Node.js 24, Docker Desktop and, for the AI, Claude Code signed in with a Claude subscription.
setlocal
set COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd /d "%~dp0"

where node >nul 2>nul || (echo [start] Node.js is missing. Install Node.js 24 from https://nodejs.org and run this script again.& pause & exit /b 1)
node -e "process.exit(Number(process.versions.node.split(String.fromCharCode(46))[0]) >= 24 ? 0 : 1)" || (echo [start] Node.js is too old. Install Node.js 24 from https://nodejs.org.& pause & exit /b 1)
where docker >nul 2>nul || (echo [start] Docker is missing. Install Docker Desktop and start it.& pause & exit /b 1)
docker info >nul 2>nul || (echo [start] Docker is not running. Start Docker Desktop and run this script again.& pause & exit /b 1)
where claude >nul 2>nul || echo [start] Claude Code was not found. Posts and diagrams need it: install it and run "claude" once to sign in.

echo [start] installing the dependencies (the first run takes a few minutes)
call corepack pnpm install --frozen-lockfile || (pause & exit /b 1)
call corepack pnpm local
pause
