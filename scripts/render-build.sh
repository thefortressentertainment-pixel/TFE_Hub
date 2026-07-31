#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Installing frontend deps (incl. dev)"
(cd frontend && npm install --include=dev)

echo "==> Installing backend deps"
(cd backend && npm install)

echo "==> Installing worker deps"
(cd worker && npm install)

echo "==> Building frontend"
(cd frontend && npm run build)

echo "==> Build complete"
