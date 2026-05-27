#!/bin/bash
# ==============================================================================
# deploy.sh — Mise à jour de l'app après un git push.
# Usage (depuis la machine locale) :
#   ssh ubuntu@<EC2-IP> 'bash /home/ubuntu/app/aws/deploy.sh'
# Ou directement sur l'instance :
#   bash aws/deploy.sh
# ==============================================================================
set -e

APP_DIR="/home/ubuntu/app"
WORKER_DIR="$APP_DIR/worker"

echo "[1/3] git pull..."
git -C "$APP_DIR" pull

echo "[2/3] npm ci (si package-lock a changé)..."
cd "$WORKER_DIR"
npm ci --omit=dev

echo "[3/3] Redémarrage PM2..."
pm2 restart fb-poster

echo ""
pm2 status
echo ""
echo "Déployé avec succès ✓"
