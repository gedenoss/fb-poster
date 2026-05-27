#!/bin/bash
# ==============================================================================
# setup.sh — À lancer UNE SEULE FOIS après le premier SSH sur l'instance.
# Usage : bash aws/setup.sh
# ==============================================================================
set -e

REPO_URL="https://github.com/gedenoss/fb-poster.git"   # <-- remplace par ton URL GitHub
APP_DIR="/home/ubuntu/app"
WORKER_DIR="$APP_DIR/worker"

echo "[1/5] Clone du repo..."
if [ -d "$APP_DIR/.git" ]; then
  echo "  Repo déjà cloné, on fait juste un pull."
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "[2/5] npm ci..."
cd "$WORKER_DIR"
npm ci

echo "[3/5] Installation de Chromium (Playwright)..."
npx playwright install chromium

echo "[4/5] Création du fichier .env..."
if [ ! -f "$WORKER_DIR/.env" ]; then
  cp "$WORKER_DIR/.env.example" "$WORKER_DIR/.env"
  echo ""
  echo "  *** IMPORTANT : remplis $WORKER_DIR/.env avec tes vraies valeurs ***"
  echo "  nano $WORKER_DIR/.env"
  echo ""
else
  echo "  .env déjà présent, on ne l'écrase pas."
fi

echo "[5/5] Démarrage PM2..."
cd "$WORKER_DIR"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu | tail -1 | bash   # active le démarrage auto au boot

echo ""
echo "========================================="
echo "Setup terminé !"
echo ""
echo "Vérifie que l'app tourne : pm2 status"
echo "Logs en live           : pm2 logs fb-poster"
echo "Santé du worker        : curl http://localhost:8080/healthz"
echo ""
echo "Mets à jour PUBLIC_BASE_URL dans .env avec l'IP publique de cette instance,"
echo "puis : pm2 restart fb-poster"
echo "========================================="
