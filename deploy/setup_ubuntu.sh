#!/usr/bin/env bash
# EFTForge Ubuntu production setup script
# Run as root or with sudo from the repo root: sudo bash deploy/setup_ubuntu.sh

set -euo pipefail

DEPLOY_DIR="/var/www/eftforge"
SERVICE_NAME="eftforge"

# ── 1. System packages ───────────────────────────────────────────────────────
apt-get update -q
apt-get install -y python3 python3-venv python3-pip nginx

# ── 2. Copy project files ────────────────────────────────────────────────────
mkdir -p "$DEPLOY_DIR"
cp -r backend  "$DEPLOY_DIR/"
cp -r frontend "$DEPLOY_DIR/"

# ── 3. Python venv + dependencies ────────────────────────────────────────────
python3 -m venv "$DEPLOY_DIR/backend/venv"
"$DEPLOY_DIR/backend/venv/bin/pip" install --upgrade pip
"$DEPLOY_DIR/backend/venv/bin/pip" install -r "$DEPLOY_DIR/backend/requirements.txt"

# ── 4. Environment file ──────────────────────────────────────────────────────
ENV_FILE="$DEPLOY_DIR/backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    cp "$DEPLOY_DIR/backend/.env.example" "$ENV_FILE"
    echo ""
    echo "⚠  Created $ENV_FILE from .env.example"
    echo "   You MUST edit it and set:"
    echo "     IP_HASH_SECRET=<openssl rand -hex 32>"
    echo "     ADMIN_API_KEY=<openssl rand -hex 32>"
    echo "     CORS_ORIGINS=https://your-domain.com"
    echo ""
    read -rp "Press Enter after editing .env to continue, or Ctrl+C to abort..." _
fi

# ── 5. Initial database sync ─────────────────────────────────────────────────
cd "$DEPLOY_DIR/backend"
"$DEPLOY_DIR/backend/venv/bin/python" sync_tarkov_dev.py

# ── 6. Permissions ───────────────────────────────────────────────────────────
chown -R www-data:www-data "$DEPLOY_DIR"
chmod -R 750 "$DEPLOY_DIR/backend"
chmod -R 755 "$DEPLOY_DIR/frontend"

# ── 7. Systemd service ───────────────────────────────────────────────────────
cp "$(dirname "$0")/eftforge.service" "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# ── 8. Nginx ─────────────────────────────────────────────────────────────────
NGINX_CONF="/etc/nginx/sites-available/$SERVICE_NAME"
cp "$(dirname "$0")/nginx.conf" "$NGINX_CONF"
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/$SERVICE_NAME"
rm -f /etc/nginx/sites-enabled/default

echo ""
echo "⚠  Edit $NGINX_CONF and replace 'your-domain.com' with your actual domain."
echo "   Then run: nginx -t && systemctl reload nginx"
echo ""

nginx -t && systemctl reload nginx || true

echo "✓ Setup complete. Check status with: systemctl status $SERVICE_NAME"
