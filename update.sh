#!/bin/sh
# Mise à jour automatique du serveur OutDO! (toutes les 2 minutes, par un minuteur du système) :
#  - récupère la dernière version publiée sur GitHub (dépôt public outdo-serveur, branche main) ;
#  - redémarre Nakama seulement si son programme ou ses réglages ont changé (la version web, elle, est servie
#    tout de suite, sans couper les parties en cours) ;
#  - écrit un petit état public (sans aucun secret) : https://<serveur>/etat.txt
ETAT=/opt/outdo-etat
mkdir -p "$ETAT"
LOG="$ETAT/journal.txt"
{
echo "=== $(date -u '+%Y-%m-%d %H:%M:%S') UTC ($1)"
cd /opt/outdo || { echo "dossier /opt/outdo absent"; exit 1; }
git config --global --add safe.directory /opt/outdo 2>/dev/null
before=$(git rev-parse HEAD 2>/dev/null || echo aucun)
if ! git fetch -q --depth 1 origin main || ! git reset -q --hard origin/main; then
  echo "récupération impossible : nouveau téléchargement complet"
  cd / && rm -rf /opt/outdo.new && git clone -q --depth 1 https://github.com/Masterkmn67/outdo-serveur.git /opt/outdo.new \
    && rm -rf /opt/outdo && mv /opt/outdo.new /opt/outdo && cd /opt/outdo && before=aucun
fi
after=$(git rev-parse HEAD)
echo "version : $before -> $after"
export OUTDO_ADMINS="$(grep -v '^#' admins.txt | tr -d ' \r' | paste -sd, -)"
C="docker compose --env-file /opt/outdo-secrets.env --profile https"
if [ "$1" = "--force" ] || [ "$before" = "aucun" ]; then
  $C up -d --force-recreate --remove-orphans
elif [ "$before" != "$after" ]; then
  changed=$(git diff --name-only "$before" "$after" 2>/dev/null || echo tout)
  echo "$changed" | head -20
  if echo "$changed" | grep -qE '^(modules/|docker-compose.yml|admins.txt|tout)'; then $C up -d --force-recreate nakama; fi
  if echo "$changed" | grep -qE '^(Caddyfile|docker-compose.yml|tout)'; then $C up -d --force-recreate caddy; fi
else
  $C up -d >/dev/null 2>&1 # remet en route ce qui se serait arrêté
fi
# minuteur du système (plus fiable que cron) : installé ou mis à jour à chaque passage
cat > /etc/systemd/system/outdo-update.service <<UNIT
[Unit]
Description=Mise à jour du serveur OutDO!
[Service]
Type=oneshot
ExecStart=/bin/sh /opt/outdo/update.sh
UNIT
cat > /etc/systemd/system/outdo-update.timer <<UNIT
[Unit]
Description=Mise à jour du serveur OutDO! toutes les 2 minutes
[Timer]
OnBootSec=60
OnUnitActiveSec=120
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now outdo-update.timer >/dev/null 2>&1
rm -f /etc/cron.d/outdo-update
} >> "$LOG" 2>&1
# état public : version, conteneurs, fin du journal (aucun mot de passe : le fichier des secrets n'est jamais lu ici)
{
  echo "Serveur OutDO! — état au $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
  echo "version du programme : $(cd /opt/outdo && git log -1 --format='%h %s' 2>/dev/null)"
  echo
  docker compose -f /opt/outdo/docker-compose.yml --profile https ps --format '{{.Service}} : {{.Status}}' 2>&1
  echo
  echo "--- journal des mises à jour (fin)"
  tail -n 40 "$LOG"
} > "$ETAT/etat.txt.tmp" 2>&1 && mv "$ETAT/etat.txt.tmp" "$ETAT/etat.txt"
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
