// Tests du serveur OutDO! contre un vrai Nakama (lancé par GitHub Actions avec docker compose).
// Chaque vérification affiche ✔ ou arrête tout avec ✘ et la raison.
import { Client } from '@heroiclabs/nakama-js';

const HOST = process.env.NAKAMA_HOST || '127.0.0.1';
const client = new Client('defaultkey', HOST, '7350', false);
const dec = new TextDecoder();
let n = 0;

function ok(cond, what) {
  n++;
  if (!cond) {
    console.error(`✘ ${what}`);
    process.exit(1);
  }
  console.log(`✔ ${what}`);
}

async function errText(e) {
  if (e && typeof e.json === 'function') {
    try {
      const j = await e.json();
      return j.message || JSON.stringify(j);
    } catch (_) {}
  }
  return String(e && e.message ? e.message : e);
}

async function rpc(session, id, input = {}) {
  const r = await client.rpc(session, id, input);
  return r.payload || {};
}

async function rpcFails(session, id, input, what) {
  try {
    await client.rpc(session, id, input);
  } catch (e) {
    ok(true, `${what} (refusé : ${await errText(e)})`);
    return;
  }
  ok(false, `${what} (aurait dû être refusé)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(id, username) {
  return client.authenticateCustom(id, true, username);
}

/** Une connexion temps réel qui garde tous les messages reçus. */
async function live(session) {
  const socket = client.createSocket(false, false);
  await socket.connect(session, true);
  const inbox = [];
  socket.onmatchdata = (md) => inbox.push({ op: md.op_code, data: dec.decode(md.data), from: md.presence && md.presence.user_id });
  return { socket, inbox };
}

async function waitFor(inbox, pred, what, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await sleep(50);
  }
  ok(false, `${what} (rien reçu en ${ms} ms)`);
}

const OP = { ROSTER: 1, SNAPSHOT: 2, INTENT: 3, EMOJI: 4, SETTINGS: 5, START: 6, RESULT: 7, REWARD: 8, ERROR: 9, DOC_SET: 20, DOC: 21, DOC_ALL: 22 };
const rnd = Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------------------------
console.log('— Comptes et porte-monnaie');
const owner = await login(`owner-${rnd}-xxxxxxxx`, 'owner_test');
const alice = await login(`alice-${rnd}-xxxxxxxx`, `alice_${rnd}`);
const bob = await login(`bob-${rnd}-xxxxxxxxxx`, `bob_${rnd}`);
ok((await rpc(owner, 'admin_whoami')).admin === true, 'le compte propriétaire est reconnu comme Admin');
ok((await rpc(alice, 'admin_whoami')).admin === false, 'un joueur normal n’est pas Admin');
let w = await rpc(alice, 'wallet_get');
ok(w.coins === 0 && w.gems === 0, 'nouveau joueur : 0 pièce, 0 gemme');

console.log('— Cadeau de bienvenue');
const dora = await login(`dora-${rnd}-xxxxxxxxx`, `dora_${rnd}`);
let wr = await rpc(dora, 'welcome_claim');
ok(wr.given === true && wr.wallet.coins === 500 && wr.wallet.gems === 50, 'nouveau joueur : 500 pièces et 50 gemmes de bienvenue');
wr = await rpc(dora, 'welcome_claim');
ok(wr.given === false && wr.wallet.coins === 500, 'le cadeau de bienvenue ne se reçoit qu’une fois');
const meInfo = await rpc(dora, 'me');
ok(meInfo.userId === dora.user_id && meInfo.admin === false, 'le joueur connaît son identifiant serveur');
wr = await rpc(dora, 'solo_reward', { won: true, factor: 0.5 });
ok(wr.coins === 40, `partie à plusieurs avec absence : part réduite par le facteur (reçu ${wr.coins})`);
const eve = await login(`eve-${rnd}-xxxxxxxxxx`, `eve_${rnd}`);
wr = await rpc(eve, 'solo_reward', { won: false, factor: 7 });
ok(wr.coins === 20, 'un facteur trafiqué (plus grand que 1) ne fait pas gagner plus');

console.log('— Récompense d’une partie contre les bots');
let r = await rpc(alice, 'solo_reward', { won: true, daily: true, coins: 999999 });
ok(r.coins === 180, `gain plafonné au barème (180 pièces), même si le téléphone demande plus (reçu ${r.coins})`);
await rpcFails(alice, 'solo_reward', { won: true }, 'deux récompenses coup sur coup');
w = await rpc(alice, 'wallet_get');
ok(w.coins === 180, 'le solde vient du serveur (180 pièces)');

console.log('— Mode Admin');
await rpcFails(alice, 'admin_gift', { userId: alice.user_id, gems: 5000 }, 'un joueur ne peut pas se donner des gemmes');
await rpcFails(alice, 'admin_players', {}, 'un joueur ne voit pas la liste des joueurs');
await rpcFails(alice, 'admin_set_prices', { items: {} }, 'un joueur ne peut pas changer les prix');
const players = (await rpc(owner, 'admin_players')).players;
ok(players.some((p) => p.id === alice.user_id), 'le propriétaire voit les joueurs dans la liste');
r = await rpc(owner, 'admin_gift', { userId: alice.user_id, gems: 1000, coins: 20, note: 'test' });
ok(r.wallet.gems === 1000 && r.wallet.coins === 200, 'cadeau du propriétaire reçu (1000 gemmes, +20 pièces)');
r = await rpc(owner, 'admin_gift', { userId: bob.user_id, gems: -50 });
ok(r.wallet.gems === 0, 'un retrait ne fait jamais passer sous zéro');

console.log('— Boutique');
await rpc(owner, 'admin_set_prices', { items: { 'tenue:blingbling': { g: 900, c: 9000 }, 'aura:energie': { g: 5000 } } });
let items = (await rpc(alice, 'shop_prices')).items;
ok(items['tenue:blingbling'].g === 900 && items['aura:energie'].g === 5000, 'les prix (fichier du jeu + corrections du propriétaire) sont lisibles par tous');
ok(Object.keys(items).length > 10, `les prix du jeu sont chargés depuis prices.json (${Object.keys(items).length} objets)`);
await rpcFails(alice, 'shop_buy', { id: 'aura:energie', with: 'gems' }, 'achat refusé si le solde ne suffit pas');
await rpcFails(alice, 'shop_buy', { id: 'tenue:inconnue', with: 'gems' }, 'achat refusé pour un objet inconnu');
r = await rpc(alice, 'shop_buy', { id: 'tenue:blingbling', with: 'gems' });
ok(r.wallet.gems === 100 && r.owned['tenue:blingbling'], 'achat : 900 gemmes retirées, objet possédé');
await rpcFails(alice, 'shop_buy', { id: 'tenue:blingbling', with: 'gems' }, 'impossible d’acheter deux fois le même objet');
ok((await rpc(alice, 'inventory_get')).owned['tenue:blingbling'], 'l’inventaire est gardé par le serveur');

console.log('— Partie privée avec code');
const created = await rpc(alice, 'private_create', { bots: 1 });
ok(/^[A-Z0-9]{5}$/.test(created.code), `code de partie créé (${created.code})`);
await rpcFails(bob, 'private_join', { code: 'ZZZZZ' }, 'un code inconnu est refusé');
const joined = await rpc(bob, 'private_join', { code: created.code.toLowerCase() });
ok(joined.matchId === created.matchId, 'le code (même tapé en minuscules) mène à la bonne table');

const A = await live(alice), B = await live(bob);
await A.socket.joinMatch(created.matchId);
let ro = JSON.parse((await waitFor(A.inbox, (m) => m.op === OP.ROSTER, 'table : Alice voit la table')).data);
ok(ro.host === alice.user_id, 'la créatrice est l’hôte');
await B.socket.joinMatch(created.matchId);
ro = JSON.parse((await waitFor(A.inbox, (m) => m.op === OP.ROSTER && JSON.parse(m.data).players.length === 2, 'Bob arrive')).data);
ok(ro.players.map((p) => p.userId).join() === [alice.user_id, bob.user_id].join(), 'les deux joueurs sont à la table, dans l’ordre d’arrivée');

await B.socket.sendMatchState(created.matchId, OP.START, '{}');
await sleep(400);
ok(!A.inbox.some((m) => m.op === OP.ROSTER && JSON.parse(m.data).started), 'seul l’hôte peut lancer la partie');
await A.socket.sendMatchState(created.matchId, OP.SETTINGS, JSON.stringify({ bots: 2, replaceAbsent: true }));
ro = JSON.parse((await waitFor(B.inbox, (m) => m.op === OP.ROSTER && JSON.parse(m.data).settings.bots === 2, 'réglages reçus')).data);
ok(ro.settings.replaceAbsent === true, 'les réglages de l’hôte (bots, remplacement) arrivent chez tous');
await A.socket.sendMatchState(created.matchId, OP.START, '{}');
await waitFor(B.inbox, (m) => m.op === OP.ROSTER && JSON.parse(m.data).started, 'partie lancée');
ok(true, 'l’hôte lance la partie');

const C = await live(await login(`carl-${rnd}-xxxxxxxxx`, `carl_${rnd}`));
let refused = false;
try {
  await C.socket.joinMatch(created.matchId);
} catch (e) {
  refused = true;
}
ok(refused, 'un nouveau venu ne peut pas entrer une fois la partie lancée');

await A.socket.sendMatchState(created.matchId, OP.SNAPSHOT, JSON.stringify({ turn: 1 }));
let m = await waitFor(B.inbox, (x) => x.op === OP.SNAPSHOT, 'état de la partie relayé');
ok(JSON.parse(m.data).turn === 1, 'l’état envoyé par l’hôte arrive chez les autres');
await B.socket.sendMatchState(created.matchId, OP.SNAPSHOT, JSON.stringify({ turn: 99 }));
await sleep(400);
ok(!A.inbox.some((x) => x.op === OP.SNAPSHOT), 'un joueur qui n’est pas l’hôte ne peut pas imposer un faux état');
await B.socket.sendMatchState(created.matchId, OP.INTENT, JSON.stringify({ a: 'draw' }));
m = await waitFor(A.inbox, (x) => x.op === OP.INTENT, 'coup relayé à l’hôte');
ok(JSON.parse(m.data).from === bob.user_id, 'l’hôte reçoit le coup de Bob, signé par le serveur');
await B.socket.sendMatchState(created.matchId, OP.EMOJI, new TextEncoder().encode('😂')); // texte non latin : envoyé en octets UTF-8
m = await waitFor(A.inbox, (x) => x.op === OP.EMOJI, 'émoji');
ok(JSON.parse(m.data).e === '😂', 'les émojis arrivent chez tout le monde');

console.log('— Départ de l’hôte, reprise, retour');
A.socket.disconnect(false);
ro = JSON.parse((await waitFor(B.inbox, (x) => x.op === OP.ROSTER && JSON.parse(x.data).host === bob.user_id, 'nouvel hôte')).data);
ok(ro.players.find((p) => p.userId === alice.user_id).present === false, 'l’hôte parti : Bob reprend la partie, Alice est marquée absente');
await B.socket.sendMatchState(created.matchId, OP.SNAPSHOT, JSON.stringify({ turn: 2 }));
await sleep(300);
const A2 = await live(alice);
await A2.socket.joinMatch(created.matchId);
m = await waitFor(A2.inbox, (x) => x.op === OP.SNAPSHOT, 'Alice revient');
ok(JSON.parse(m.data).turn === 2, 'Alice revient et reçoit tout de suite l’état actuel de la partie');
ro = JSON.parse((await waitFor(A2.inbox, (x) => x.op === OP.ROSTER, 'table au retour')).data);
ok(ro.host === bob.user_id, 'Bob reste l’hôte après le retour d’Alice');

console.log('— Fin de partie et récompenses');
const before = (await rpc(bob, 'wallet_get')).coins;
await A2.socket.sendMatchState(created.matchId, OP.RESULT, JSON.stringify({ winners: [alice.user_id] }));
await sleep(400);
ok(!A2.inbox.some((x) => x.op === OP.REWARD), 'seul l’hôte peut déclarer la fin de partie');
await B.socket.sendMatchState(created.matchId, OP.RESULT, JSON.stringify({ winners: [bob.user_id] }));
m = await waitFor(B.inbox, (x) => x.op === OP.REWARD, 'récompense de Bob');
ok(JSON.parse(m.data).coins === 80, `le gagnant reçoit 80 pièces du serveur (reçu ${JSON.parse(m.data).coins})`);
ok((await rpc(bob, 'wallet_get')).coins === before + 80, 'le solde de Bob est mis à jour par le serveur');
m = await waitFor(A2.inbox, (x) => x.op === OP.REWARD, 'récompense d’Alice');
ok(JSON.parse(m.data).coins === 20, 'Alice (absente quelques secondes) reçoit sa part complète');
await B.socket.sendMatchState(created.matchId, OP.RESULT, JSON.stringify({ winners: [bob.user_id] }));
await sleep(500);
ok((await rpc(bob, 'wallet_get')).coins === before + 80, 'une fin de partie ne paie qu’une seule fois');

console.log('— Table du jeu actuel (documents relayés par le serveur)');
const fz = await login(`fred-${rnd}-xxxxxxxxx`, `fred_${rnd}`), gz = await login(`gina-${rnd}-xxxxxxxxx`, `gina_${rnd}`);
const want = 'Q' + rnd.toUpperCase().replace(/[^A-Z2-9]/g, 'K').slice(0, 4).padEnd(4, 'K');
const t1 = await rpc(fz, 'private_create', { code: want });
ok(t1.code === want, `le jeu peut choisir son code de table (${want})`);
await rpcFails(gz, 'private_create', { code: want }, 'un code déjà utilisé ne peut pas être repris');
const F = await live(fz), G = await live(gz);
await F.socket.joinMatch(t1.matchId);
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
await F.socket.sendMatchState(t1.matchId, OP.DOC_SET, enc({ path: `mp/${want}`, data: { status: 'lobby', host: fz.user_id } }));
await F.socket.sendMatchState(t1.matchId, OP.DOC_SET, enc({ path: `mp/${want}/p/${fz.user_id}`, data: { uid: fz.user_id, seen: 1 } }));
await sleep(400);
const j2 = await rpc(gz, 'private_join', { code: want });
await G.socket.joinMatch(j2.matchId);
let all = JSON.parse((await waitFor(G.inbox, (x) => x.op === OP.DOC_ALL, 'documents à l’arrivée')).data);
ok(all[`mp/${want}`].status === 'lobby' && all[`mp/${want}/p/${fz.user_id}`].seen === 1, 'le nouvel arrivant reçoit tous les documents de la table');
await G.socket.sendMatchState(t1.matchId, OP.DOC_SET, enc({ path: `mp/${want}/p/${gz.user_id}`, data: { uid: gz.user_id, seen: 2 } }));
m = await waitFor(F.inbox, (x) => x.op === OP.DOC, 'fiche de Gina');
ok(JSON.parse(m.data).path === `mp/${want}/p/${gz.user_id}`, 'la fiche d’un joueur arrive chez les autres');
await G.socket.sendMatchState(t1.matchId, OP.DOC_SET, enc({ path: `mp/${want}/p/${fz.user_id}`, data: { uid: fz.user_id, left: true } }));
await sleep(400);
ok(!F.inbox.some((x) => x.op === OP.DOC), 'un joueur ne peut pas écrire la fiche d’un autre');
await G.socket.sendMatchState(t1.matchId, OP.DOC_SET, enc({ path: `mp/${want}`, data: { status: 'playing', big: 'x'.repeat(150000) } }));
m = await waitFor(F.inbox, (x) => x.op === OP.DOC, 'gros document');
ok(JSON.parse(m.data).data.big.length === 150000, 'un gros état de partie (150 ko) passe sans problème');

console.log('— Amis et invitations');
const h1 = await login(`hugo-${rnd}-xxxxxxxxx`, `hugo_${rnd}`), h2 = await login(`ines-${rnd}-xxxxxxxxx`, `ines_${rnd}`), h3 = await login(`jade-${rnd}-xxxxxxxxx`, `jade_${rnd}`);
await client.addFriends(h1, undefined, [`ines_${rnd}`]);
let fr = await client.listFriends(h2);
ok(fr.friends.some((f) => f.user.id === h1.user_id && f.state === 2), 'demande d’ami reçue');
await client.addFriends(h2, [h1.user_id]);
fr = await client.listFriends(h1);
ok(fr.friends.some((f) => f.user.id === h2.user_id && f.state === 0), 'demande acceptée : amis des deux côtés');
let inv = await rpc(h1, 'friend_invite', { code: 'ABCDE', userIds: [h2.user_id, h3.user_id] });
ok(inv.sent === 1, 'invitation envoyée seulement aux vrais amis (pas à une inconnue)');
const nl = await client.listNotifications(h2, 10);
const invN = (nl.notifications || []).find((n) => n.code === 100);
ok(invN && invN.content.code === 'ABCDE', 'l’ami reçoit l’invitation avec le code de la table');
await rpcFails(h1, 'friend_invite', { code: 'XX', userIds: [h2.user_id] }, 'invitation refusée sans code valide');


console.log('— Mode Admin du jeu (mêmes règles que l’artefact claude.ai)');
const oid = await rpc(owner, 'ad_identity');
ok(oid.isOwner === true && oid.canEdit === true && oid.id === owner.user_id, 'le propriétaire est reconnu (identité vérifiée par le serveur)');
const aid = await rpc(alice, 'ad_identity');
ok(aid.isOwner === false && aid.canEdit === false, 'un joueur normal n’a aucun rôle');
await rpc(owner, 'ad_set', { path: 'placement/current', data: { schema: 1, place: { a: 1 } } });
ok((await rpc(alice, 'ad_get', { path: 'placement/current' })).data.place.a === 1, 'tout le monde lit le placement (le jeu en a besoin)');
await rpcFails(alice, 'ad_set', { path: 'placement/current', data: { x: 1 } }, 'un joueur normal ne peut pas modifier le placement');
await rpcFails(alice, 'ad_set', { path: 'roles/main', data: { members: {} } }, 'un joueur ne peut pas se donner un rôle');
await rpc(alice, 'ad_set', { path: 'sandbox/state', data: { s: 1 } });
ok((await rpc(owner, 'ad_get', { path: 'sandbox/state' })).data.s === 1, 'bac à sable : joueurs de test partagés');
await rpc(alice, 'ad_set', { path: `audit/${alice.user_id}`, data: { entries: [1] } });
await rpcFails(alice, 'ad_set', { path: `audit/${bob.user_id}`, data: { entries: [] } }, 'personne n’écrit le journal d’un autre');
await rpcFails(alice, 'ad_list', { path: 'audit' }, 'le journal complet est réservé aux administrateurs');
ok((await rpc(owner, 'ad_list', { path: 'audit' })).docs.some((d) => d.id === alice.user_id), 'le propriétaire lit tous les journaux');
await rpc(owner, 'ad_set', { path: 'roles/main', data: { schema: 1, members: { [alice.user_id]: { role: 'admin' } } } });
const aid2 = await rpc(alice, 'ad_identity');
ok(aid2.canEdit === true && aid2.isOwner === false, 'rôle Administrateur donné par le propriétaire : peut modifier, sans être propriétaire');
await rpc(alice, 'ad_set', { path: 'placementVersions/v1', data: { id: 'v1' } });
ok((await rpc(owner, 'ad_list', { path: 'placementVersions' })).docs.length === 1, 'versions enregistrées et listées');
await rpcFails(alice, 'ad_set', { path: 'roles/main', data: { members: {} } }, 'un administrateur ne gère pas les rôles (propriétaire seulement)');
await rpc(owner, 'ad_set', { path: 'roles/main', data: { schema: 1, members: {} } });
ok((await rpc(alice, 'ad_identity')).canEdit === false, 'rôle retiré');
const wl = await rpc(owner, 'ad_list', { path: 'wallets', limit: 500 });
ok(wl.docs.some((d) => d.id === alice.user_id && typeof d.data.coins === 'number'), 'liste des vrais joueurs avec leurs porte-monnaie du serveur');
const before = (await rpc(alice, 'wallet_get')).gems;
await rpc(owner, 'ad_set', { path: `gifts/${alice.user_id}`, data: { list: [{ id: 'g1', coins: 0, gems: 7 }] } });
await rpc(owner, 'ad_set', { path: `gifts/${alice.user_id}`, data: { list: [{ id: 'g1', coins: 0, gems: 7 }] } });
ok((await rpc(alice, 'wallet_get')).gems === before + 7, 'cadeau du tableau de bord vraiment versé, une seule fois (double clic sans effet)');
await rpcFails(alice, 'ad_set', { path: `gifts/${alice.user_id}`, data: { list: [{ id: 'triche', gems: 999 }] } }, 'un joueur ne peut pas s’offrir des gemmes');
await rpcFails(alice, 'ad_set', { path: '../x/y', data: {} }, 'chemin invalide refusé');
ok(Object.values((await rpc(alice, 'ad_names', { ids: [owner.user_id] })).names).length === 1, 'noms des joueurs');
await rpcFails(alice, 'ad_search', { q: 'a' }, 'recherche de joueurs réservée au propriétaire');
ok((await rpc(owner, 'ad_search', { q: 'alice' })).users.some((u) => u.id === alice.user_id), 'le propriétaire trouve un joueur par son nom');

console.log('— Bannissement');
await rpc(owner, 'admin_ban', { userId: bob.user_id });
let banned = false;
try {
  await login(`bob-${rnd}-xxxxxxxxxx`, `bob_${rnd}`);
} catch (e) {
  banned = true;
}
ok(banned, 'un joueur banni ne peut plus se connecter');
await rpc(owner, 'admin_ban', { userId: bob.user_id, unban: true });
ok(!!(await login(`bob-${rnd}-xxxxxxxxxx`, `bob_${rnd}`)).token, 'après levée du bannissement, il peut revenir');

console.log(`\nTout est bon : ${n} vérifications réussies.`);
process.exit(0);
