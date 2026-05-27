#!/bin/bash
# ==============================================================================
# user-data.sh — Script de bootstrap EC2 (s'exécute UNE FOIS au 1er démarrage)
# À coller dans "Advanced > User data" lors de la création de l'instance EC2.
# ==============================================================================
set -e
exec > /var/log/user-data.log 2>&1

echo "[1/6] Mise à jour système..."
apt-get update -y
apt-get upgrade -y

echo "[2/6] Dépendances système pour Chromium (Playwright)..."
apt-get install -y \
  curl git unzip \
  libnss3 libnspr4 \
  libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 \
  libexpat1 libxcb1 libxkbcommon0 \
  libx11-6 libxcomposite1 libxdamage1 \
  libxext6 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 \
  libasound2

echo "[3/6] Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v && npm -v

echo "[4/6] PM2 (gestionnaire de process)..."
npm install -g pm2

echo "[5/6] Swap 2 Go (crucial : t2.micro n'a que 1 Go de RAM, Chromium en veut plus)..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "[6/6] Dossiers de l'app..."
mkdir -p /home/ubuntu/app
mkdir -p /home/ubuntu/logs
mkdir -p /home/ubuntu/app/worker/data/images
chown -R ubuntu:ubuntu /home/ubuntu/app /home/ubuntu/logs

echo "========================================="
echo "Bootstrap terminé !"
echo "Connecte-toi en SSH puis lance : bash aws/setup.sh"
echo "========================================="
