#!/bin/sh
# Installation (ou réparation) complète du serveur OutDO!. Sans danger si on la relance : rien n'est effacé
# (les comptes, porte-monnaie et parties restent dans la base de données).
set -x
export DEBIAN_FRONTEND=noninteractive
command -v docker >/dev/null 2>&1 || { apt-get update -q && apt-get install -yq docker.io docker-compose-v2 git curl; }
command -v git >/dev/null 2>&1 || apt-get install -yq git
systemctl enable --now docker
if [ ! -d /opt/outdo/.git ]; then
  rm -rf /opt/outdo
  git clone -q --depth 1 https://github.com/Masterkmn67/outdo-serveur.git /opt/outdo
fi
if [ ! -f /opt/outdo-secrets.env ]; then
  IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4 || curl -s https://api.ipify.org)
  {
    echo "OUTDO_DOMAIN=$(echo "$IP" | tr . -).sslip.io"
    echo "OUTDO_DB_PASSWORD=$(openssl rand -hex 16)"
    echo "OUTDO_HTTP_KEY=$(openssl rand -hex 16)"
    echo "OUTDO_CONSOLE_USER=admin"
    echo "OUTDO_CONSOLE_PASSWORD=$(openssl rand -hex 12)"
    echo "OUTDO_SERVER_KEY=outdo-public"
    echo "OUTDO_MULTI_MIN_SEC=120"
  } > /opt/outdo-secrets.env
  chmod 600 /opt/outdo-secrets.env
fi
sh /opt/outdo/update.sh --force
