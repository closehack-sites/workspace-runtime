#!/bin/bash
set -e

# Required env vars
: "${REPO_NAME:?REPO_NAME is required (e.g. closehack-sites/my-project)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

echo "[workspace] Cloning https://github.com/${REPO_NAME}..."
git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_NAME}.git" /workspace

cd /workspace
git config gc.auto 0

echo "[workspace] Installing dependencies..."
npm install

echo "[workspace] Starting Next.js dev server on port 3001..."
NODE_OPTIONS="--max-old-space-size=512" npx next dev --hostname 0.0.0.0 --port 3001 &

echo "[workspace] Starting workspace API on port ${PORT:-3000}..."
exec node --max-old-space-size=256 /workspace-api.mjs
