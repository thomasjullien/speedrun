#!/usr/bin/env bash
#
# First-time install of Race Timer on the VPS (Ubuntu 24.04).
# Run as root on the server, after the files have been copied to /opt/race-timer.
#
#   scp -r server.js package.json public deploy root@VPS:/opt/race-timer/
#   ssh root@VPS 'bash /opt/race-timer/deploy/install.sh'
#
set -euo pipefail

APP_DIR=/opt/race-timer
SERVICE=race-timer

echo "==> Checking Node"
node --version || { echo "Node is not installed on this host."; exit 1; }

echo "==> Preparing $APP_DIR"
mkdir -p "$APP_DIR/data"
chown -R www-data:www-data "$APP_DIR"

echo "==> Installing the systemd unit"
cp "$APP_DIR/deploy/race-timer.service" /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable --now $SERVICE

echo "==> Service status"
systemctl --no-pager --lines=5 status $SERVICE || true

echo
echo "The app now listens on 127.0.0.1:8090."
echo "Add the two blocks from deploy/nginx-speedrun.conf to the www.imoca.tech"
echo "server block, then:  nginx -t && systemctl reload nginx"
echo "It will be live at https://www.imoca.tech/speedrun/"
