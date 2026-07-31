#!/usr/bin/env bash
set -euo pipefail
npm run install:all
echo 'Running migrations...'
npm --workspace backend run migrate
docker-compose up --build -d
echo 'Started (docker-compose)'
