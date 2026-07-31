#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Fortress Hub - Local Mirror =="
echo "  Backend: http://localhost:4002"
echo "  Frontend: http://localhost:5173"
echo ""

echo "==> Installing deps (if needed)"
(cd frontend && npm install 2>/dev/null || true)
(cd backend && npm install 2>/dev/null || true)
(cd worker && npm install 2>/dev/null || true)

echo "==> Running migrations"
(cd backend && node migrations/run.js)

echo "==> Starting backend + worker + frontend"
npm run dev
