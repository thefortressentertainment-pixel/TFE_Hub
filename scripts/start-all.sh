#!/usr/bin/env bash
set -euo pipefail
npm run install:all
docker-compose up --build -d
echo 'Started (docker-compose)'
