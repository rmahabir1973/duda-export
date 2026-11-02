#!/bin/sh
# Railway volumes are mounted owned by root. Start as root only long enough to hand the data folder to the app user,
# then run the app as that unprivileged user (Chromium refuses to run as root, and we don't want it to).
set -e
DIR="${DATA_DIR:-/tmp/duda-data}"
mkdir -p "$DIR"
chown -R app:app "$DIR" 2>/dev/null || true
exec runuser -u app -- node server.mjs
