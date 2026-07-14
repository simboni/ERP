#!/usr/bin/env bash
# One-shot Jenga ERP deployment for any fresh Ubuntu/Debian VPS
# (DigitalOcean, Hetzner, Contabo, Linode, a local server — anything).
#
#   curl -fsSL https://raw.githubusercontent.com/simboni/ERP/claude/kenya-erp-research-design-97wuc7/deploy/vps.sh | bash
#
# Or clone the repo and run: bash deploy/vps.sh
# Optional: DOMAIN=erp.example.co.ke bash deploy/vps.sh   (adds HTTPS via Caddy)
set -euo pipefail

BRANCH="claude/kenya-erp-research-design-97wuc7"
REPO="https://github.com/simboni/ERP"
DIR="${JENGA_DIR:-$HOME/jenga-erp}"

echo "==> Jenga ERP VPS installer"

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

# 2. Code
if [ -d "$DIR/.git" ]; then
  echo "==> Updating $DIR"
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull origin "$BRANCH"
else
  echo "==> Cloning to $DIR"
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

# 3. Secrets (created once, reused on updates)
if [ ! -f .env ]; then
  echo "==> Generating secrets (.env)"
  {
    echo "JWT_SECRET=$(openssl rand -hex 32)"
    echo "DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)"
  } > .env
  chmod 600 .env
fi

# 4. Optional HTTPS via Caddy when DOMAIN is set
COMPOSE_FILES=(-f docker-compose.yml)
if [ "${DOMAIN:-}" != "" ]; then
  echo "==> Enabling HTTPS for $DOMAIN (Caddy)"
  export DOMAIN
  COMPOSE_FILES+=(-f deploy/docker-compose.https.yml)
fi

# 5. Up
echo "==> Building and starting (first build takes a few minutes)..."
docker compose "${COMPOSE_FILES[@]}" up -d --build

echo ""
echo "======================================================================"
if [ "${DOMAIN:-}" != "" ]; then
  echo "  Jenga ERP is starting at: https://$DOMAIN"
  echo "  (point the domain's A record at this server's IP first)"
else
  IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  echo "  Jenga ERP is starting at: http://${IP:-<server-ip>}:3000"
fi
echo "  Health:   /health should show {\"status\":\"ok\",\"db\":\"ok\"}"
echo "  Logs:     docker compose logs -f app"
echo "  Update:   re-run this script"
echo "======================================================================"
