# Serveur de jeu OutDO!

Programme du serveur (Nakama) du jeu **OutDO! My life is BETTER !**. Ce dépôt ne contient **que** le serveur :
ni le jeu, ni les dessins, ni aucun mot de passe (ceux-ci sont créés sur le serveur lui-même à l'installation).

- `modules/outdo.js` : porte-monnaie protégé, récompenses, boutique, mode Admin, tables privées et matchmaking.
- `docker-compose.yml` : Nakama + base de données + HTTPS automatique (Caddy).
- `cloud-init.yaml` : installation complète à la création du serveur (à coller dans « Cloud config »).
- `update.sh` : mise à jour automatique toutes les 5 minutes depuis ce dépôt.
- `admins.txt` : comptes propriétaires.
- `test/run.mjs` : tests de bout en bout (lancés par GitHub Actions à chaque envoi).
- `etat.txt` : état public du serveur (version, conteneurs, journal des mises à jour).
