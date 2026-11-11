#!/bin/sh
# Mise à jour automatique du serveur (toutes les 5 minutes) : récupère la dernière version publiée sur GitHub
# (dépôt public outdo-serveur, branche main) et redémarre Nakama seulement si le programme du serveur a changé.
cd /opt/outdo || exit 1
before=$(git rev-parse HEAD)
git fetch -q --depth 1 origin main && git reset -q --hard origin/main
after=$(git rev-parse HEAD)
export OUTDO_ADMINS="$(grep -v '^#' admins.txt | tr -d ' \r' | paste -sd, -)"
if [ "$before" != "$after" ] || [ "$1" = "--force" ]; then
  docker compose --env-file /opt/outdo-secrets.env --profile https up -d --force-recreate nakama caddy postgres
fi
