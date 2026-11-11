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

const OP = { ROSTER: 1, SNAPSHOT: 2, INTENT: 3, EMOJI: 4, SETTINGS: 5, START: 6, RESULT: 7, REWARD: 8, ERROR: 9 };
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
ok(Object.keys((await rpc(alice, 'shop_prices')).items).length === 2, 'les prix sont lisibles par tous');
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
