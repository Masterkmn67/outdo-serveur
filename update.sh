#!/bin/sh
# Mise à jour automatique du serveur (toutes les 5 minutes) : récupère la dernière version publiée sur GitHub
# (dépôt public outdo-serveur, branche main). Nakama n'est redémarré que si son programme ou ses réglages ont changé
# (une nouvelle version web du jeu est servie tout de suite, sans couper les parties en cours).
cd /opt/outdo || exit 1
before=$(git rev-parse HEAD)
git fetch -q --depth 1 origin main && git reset -q --hard origin/main
after=$(git rev-parse HEAD)
export OUTDO_ADMINS="$(grep -v '^#' admins.txt | tr -d ' \r' | paste -sd, -)"
C="docker compose --env-file /opt/outdo-secrets.env --profile https"
if [ "$1" = "--force" ]; then
  $C up -d --force-recreate
  exit 0
fi
[ "$before" = "$after" ] && exit 0
changed=$(git diff --name-only "$before" "$after" 2>/dev/null || echo "tout")
if echo "$changed" | grep -qE '^(modules/|docker-compose.yml|admins.txt|tout)'; then
  $C up -d --force-recreate nakama
fi
if echo "$changed" | grep -qE '^(Caddyfile|docker-compose.yml|tout)'; then
  $C up -d --force-recreate caddy
fi
