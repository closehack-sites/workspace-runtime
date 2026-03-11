#!/bin/bash
set -e

# Required env vars
: "${REPO_NAME:?REPO_NAME is required (e.g. closehack-sites/my-project)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

echo "[workspace] Cloning https://github.com/${REPO_NAME}..."
git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_NAME}.git" /workspace

cd /workspace

echo "[workspace] Installing dependencies..."
npm install

echo "[workspace] Starting dev server on port 3000..."
exec npx next dev --hostname 0.0.0.0 --port 3000
