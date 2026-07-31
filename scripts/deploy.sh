#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-local}"

case "$MODE" in
  local)
    echo "Starting Fortress Hub locally..."
    echo "  Frontend: http://localhost:5173"
    echo "  Backend:  http://localhost:4002"
    echo ""
    echo "On the same Wi-Fi, find your LAN IP and use that instead of localhost."
    echo "  e.g. http://192.168.x.x:5173"
    echo ""
    cd "$(dirname "$0")/.."
    npm run dev
    ;;
  tunnel)
    echo "Starting Fortress Hub with a public tunnel..."
    echo ""
    if ! command -v cloudflared &>/dev/null; then
      echo "  cloudflared not found. Install it:"
      echo "    brew install cloudflared"
      echo "  Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
      echo ""
      echo "  Alternatively, use ngrok:"
      echo "    brew install ngrok"
      echo "    ngrok http 4002"
      exit 1
    fi
    echo "  Starting backend + tunnel..."
    cd "$(dirname "$0")/.."
    npm run start:backend &
    BACKEND_PID=$!
    sleep 2
    echo "  Tunnel URL will appear below (https://xxxx.trycloudflare.com):"
    cloudflared tunnel --url http://localhost:4002
    kill $BACKEND_PID 2>/dev/null
    ;;
  vps)
    echo "=== Deploy via Docker Compose ==="
    echo ""
    echo "On your VPS (Ubuntu/Debian):"
    echo ""
    echo "  1. Install Docker:"
    echo "       curl -fsSL https://get.docker.com | sh"
    echo ""
    echo "  2. Clone the repo:"
    echo "       git clone https://github.com/thefortressentertainment-pixel/TFE_Hub.git"
    echo "       cd TFE_Hub"
    echo ""
    echo "  3. Set env vars:"
    echo "       echo 'OPENAI_API_KEY=sk-...' >> backend/.env"
    echo ""
    echo "  4. Start:"
    echo "       docker compose up --build -d"
    echo ""
    echo "  5. Access at http://YOUR_VPS_IP:3000"
    echo ""
    echo "  For SSL (HTTPS), put a reverse proxy (Caddy/nginx) in front."
    echo "  Example with Caddy:"
    echo "    caddy reverse-proxy --from yourdomain.com --to :3000"
    ;;
  *)
    echo "Usage: $0 {local|tunnel|vps}"
    echo ""
    echo "  local   – Run locally on your machine (default)"
    echo "  tunnel  – Run with a public tunnel URL (needs cloudflared)"
    echo "  vps     – Print deployment guide for a VPS"
    exit 1
    ;;
esac
