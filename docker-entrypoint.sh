#!/bin/sh
# Fly mounts the volume as root. Hand it to the unprivileged user, then run the server as that user.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data 2>/dev/null || true
  exec runuser -u node -- "$@"
fi
exec "$@"
