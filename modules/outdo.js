// OutDO! — programme du serveur Nakama (JavaScript exécuté par Nakama).
//
// Ce que fait le serveur (et que les joueurs ne peuvent pas trafiquer) :
//  - porte-monnaie : pièces et gemmes comptées par le serveur (portefeuille Nakama), jamais par le téléphone ;
//  - récompenses : plafonnées et espacées (parties solo), versées par le serveur en fin de partie à plusieurs ;
//  - boutique : prix lus sur le serveur, achat refusé si le solde ne suffit pas, objets achetés notés côté serveur ;
//  - mode Admin : réservé aux comptes listés dans OUTDO_ADMINS (cadeaux, liste des joueurs, bannissement) ;
//  - parties privées avec code, et parties avec des inconnus (matchmaking) : le serveur tient la table
//    (qui est là, qui est l'hôte, reprise de l'hôte s'il part) et relaie les messages.
//
// Règle de Nakama : chaque fonction branchée (RPC, partie) doit être une fonction déclarée au niveau du fichier.

var SYSTEM_ID = '00000000-0000-0000-0000-000000000000';
var MAX_PLAYERS = 6;

// opcodes des messages de partie
var OP_ROSTER = 1; // serveur → tous : joueurs présents, hôte, réglages, partie lancée ?
var OP_SNAPSHOT = 2; // hôte → serveur → autres : état complet de la partie
var OP_INTENT = 3; // joueur → serveur → hôte : coup joué, réponse à une question
var OP_EMOJI = 4; // joueur → serveur → tous
var OP_SETTINGS = 5; // hôte (avant le départ) : bots, remplacement des absents
var OP_START = 6; // hôte : lance la partie
var OP_RESULT = 7; // hôte : classement final → le serveur verse les récompenses
var OP_REWARD = 8; // serveur → chacun : récompense versée
var OP_ERROR = 9; // serveur → un joueur : action refusée

// barème des récompenses (même que contre les bots dans le jeu)
var REWARD_BASE = 20, REWARD_WIN = 60, REWARD_DAILY = 100;
var SOLO_MAX_COINS = REWARD_BASE + REWARD_WIN + REWARD_DAILY; // le maximum possible pour une partie
var SOLO_MIN_GAP_SEC = 90; // une partie ne dure jamais moins que ça
var MULTI_MIN_SEC = 120;

// ---------------------------------------------------------------------------------------------
// outils
// ---------------------------------------------------------------------------------------------

function parse(payload) {
  if (!payload) return {};
  try {
    var o = JSON.parse(payload);
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    throw new Error('Données illisibles');
  }
}

function int(v, def) {
  var n = Math.floor(Number(v));
  return isFinite(n) ? n : def;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function readOne(nk, collection, key, userId) {
  var r = nk.storageRead([{ collection: collection, key: key, userId: userId }]);
  return r && r.length ? r[0] : null;
}

function writeOne(nk, collection, key, userId, value, version, publicRead) {
  var w = { collection: collection, key: key, userId: userId, value: value, permissionRead: publicRead ? 2 : 1, permissionWrite: 0 };
  if (version) w.version = version;
  nk.storageWrite([w]);
}

function walletOf(nk, userId) {
  var a = nk.accountGetId(userId);
  var w = (a && a.wallet) || {};
  return { coins: int(w.coins, 0), gems: int(w.gems, 0) };
}

function isAdmin(ctx) {
  var list = String((ctx.env && ctx.env['OUTDO_ADMINS']) || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
  if (!ctx.userId) return false;
  return list.indexOf(ctx.username) >= 0 || list.indexOf(ctx.userId) >= 0;
}

function requireAdmin(ctx) {
  if (!isAdmin(ctx)) throw new Error('Action réservée au propriétaire');
}

function requireUser(ctx) {
  if (!ctx.userId) throw new Error('Connexion requise');
}

// barème d'absence (le même que dans le jeu) : complet jusqu'à 5 min, presque rien après 15 min
function awayFactor(ms) {
  var m = ms / 60000;
  if (m <= 5) return 1;
  if (m >= 15) return 0.05;
  return 1 - 0.95 * ((m - 5) / 10);
}

// ---------------------------------------------------------------------------------------------
// porte-monnaie et récompenses
// ---------------------------------------------------------------------------------------------

function rpcWalletGet(ctx, logger, nk, payload) {
  requireUser(ctx);
  return JSON.stringify(walletOf(nk, ctx.userId));
}

// Fin d'une partie contre les bots : le joueur annonce son résultat, le serveur plafonne et espace les gains.
function rpcSoloReward(ctx, logger, nk, payload) {
  requireUser(ctx);
  var p = parse(payload);
  var won = p.won === true, daily = p.daily === true;
  var meta = readOne(nk, 'meta', 'solo', ctx.userId);
  var v = (meta && meta.value) || {};
  var t = nowSec();
  if (v.last && t - v.last < SOLO_MIN_GAP_SEC) throw new Error('Récompense déjà reçue : partie trop courte');
  var today = new Date().toISOString().slice(0, 10);
  if (daily && v.daily === today) daily = false; // le défi du jour ne paie qu'une fois par jour
  var coins = REWARD_BASE + (won ? REWARD_WIN : 0) + (daily ? REWARD_DAILY : 0);
  if (coins > SOLO_MAX_COINS) coins = SOLO_MAX_COINS;
  writeOne(nk, 'meta', 'solo', ctx.userId, { last: t, daily: daily ? today : v.daily || '' }, meta ? meta.version : '*');
  nk.walletUpdate(ctx.userId, { coins: coins }, { reason: 'solo', won: won, daily: daily }, true);
  return JSON.stringify({ coins: coins, wallet: walletOf(nk, ctx.userId) });
}

// ---------------------------------------------------------------------------------------------
// boutique
// ---------------------------------------------------------------------------------------------

function prices(nk) {
  var r = readOne(nk, 'config', 'prices', SYSTEM_ID);
  return (r && r.value && r.value.items) || {};
}

function rpcShopPrices(ctx, logger, nk, payload) {
  return JSON.stringify({ items: prices(nk) });
}

function rpcInventory(ctx, logger, nk, payload) {
  requireUser(ctx);
  var r = readOne(nk, 'inventory', 'owned', ctx.userId);
  return JSON.stringify({ owned: (r && r.value && r.value.owned) || {} });
}

// achat : { id: "tenue:blingbling", with: "gems" | "coins" }
function rpcShopBuy(ctx, logger, nk, payload) {
  requireUser(ctx);
  var p = parse(payload);
  var id = String(p.id || ''), withGems = p['with'] !== 'coins';
  var item = prices(nk)[id];
  if (!item) throw new Error('Objet inconnu ou plus en vente');
  var price = withGems ? item.g : item.c;
  if (price === undefined || price === null) throw new Error(withGems ? 'Pas en vente contre des gemmes' : 'Pas en vente contre des pièces');
  price = int(price, -1);
  if (price < 0) throw new Error('Prix invalide');
  var inv = readOne(nk, 'inventory', 'owned', ctx.userId);
  var owned = (inv && inv.value && inv.value.owned) || {};
  if (owned[id]) throw new Error('Déjà possédé');
  var w = walletOf(nk, ctx.userId);
  if ((withGems ? w.gems : w.coins) < price) throw new Error('Solde insuffisant');
  owned[id] = nowSec();
  // l'objet d'abord (version vérifiée : deux achats simultanés ne passent pas), puis le paiement
  writeOne(nk, 'inventory', 'owned', ctx.userId, { owned: owned }, inv ? inv.version : '*');
  var change = {};
  change[withGems ? 'gems' : 'coins'] = -price;
  nk.walletUpdate(ctx.userId, change, { reason: 'achat', item: id }, true);
  return JSON.stringify({ ok: true, owned: owned, wallet: walletOf(nk, ctx.userId) });
}

// ---------------------------------------------------------------------------------------------
// mode Admin (propriétaire)
// ---------------------------------------------------------------------------------------------

function rpcAdminWhoami(ctx, logger, nk, payload) {
  return JSON.stringify({ admin: isAdmin(ctx) });
}

// prix de la boutique : { items: { "tenue:blingbling": { g: 900, c: 9000 }, ... } }
function rpcAdminSetPrices(ctx, logger, nk, payload) {
  requireAdmin(ctx);
  var p = parse(payload);
  var items = {};
  var src = p.items || {};
  for (var k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    var it = src[k] || {};
    var o = {};
    if (it.g !== undefined && it.g !== null) o.g = Math.max(0, int(it.g, 0));
    if (it.c !== undefined && it.c !== null) o.c = Math.max(0, int(it.c, 0));
    items[k] = o;
  }
  writeOne(nk, 'config', 'prices', SYSTEM_ID, { items: items, at: nowSec(), by: ctx.username }, null, true);
  return JSON.stringify({ ok: true, count: Object.keys(items).length });
}

function rpcAdminPlayers(ctx, logger, nk, payload) {
  requireAdmin(ctx);
  var rows = nk.sqlQuery(
    'SELECT id, username, display_name, wallet, disable_time, update_time FROM users WHERE id <> $1 ORDER BY update_time DESC LIMIT 300',
    [SYSTEM_ID]
  );
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var w = {};
    try {
      w = typeof r.wallet === 'string' ? JSON.parse(r.wallet) : r.wallet || {};
    } catch (e) {}
    out.push({
      id: r.id,
      username: r.username,
      name: r.display_name || r.username,
      coins: int(w.coins, 0),
      gems: int(w.gems, 0),
      banned: !!r.disable_time && String(r.disable_time).indexOf('1970') !== 0,
    });
  }
  return JSON.stringify({ players: out });
}

// cadeau (ou retrait, montant négatif) : { userId, coins, gems, note }
function rpcAdminGift(ctx, logger, nk, payload) {
  requireAdmin(ctx);
  var p = parse(payload);
  var uid = String(p.userId || '');
  var coins = int(p.coins, 0), gems = int(p.gems, 0);
  if (!uid) throw new Error('Joueur manquant');
  if (!coins && !gems) throw new Error('Indique un montant');
  if (Math.abs(coins) > 999999 || Math.abs(gems) > 999999) throw new Error('Montant trop grand');
  var w = walletOf(nk, uid);
  // jamais en dessous de zéro
  if (w.coins + coins < 0) coins = -w.coins || 0; // « || 0 » : jamais de « -0 », refusé par Nakama
  if (w.gems + gems < 0) gems = -w.gems || 0;
  if (!coins && !gems) return JSON.stringify({ ok: true, wallet: w });
  nk.walletUpdate(uid, { coins: coins, gems: gems }, { reason: 'cadeau', by: ctx.username, note: String(p.note || '').slice(0, 120) }, true);
  logger.info('cadeau de %s à %s : %d pièces, %d gemmes', ctx.username, uid, coins, gems);
  return JSON.stringify({ ok: true, wallet: walletOf(nk, uid) });
}

function rpcAdminBan(ctx, logger, nk, payload) {
  requireAdmin(ctx);
  var p = parse(payload);
  var uid = String(p.userId || '');
  if (!uid) throw new Error('Joueur manquant');
  if (p.unban === true) nk.usersUnbanId([uid]);
  else nk.usersBanId([uid]);
  return JSON.stringify({ ok: true });
}

// ---------------------------------------------------------------------------------------------
// parties privées (code) et avec des inconnus (matchmaking)
// ---------------------------------------------------------------------------------------------

var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  var s = '';
  for (var i = 0; i < 5; i++) s += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return s;
}

function rpcPrivateCreate(ctx, logger, nk, payload) {
  requireUser(ctx);
  var p = parse(payload);
  for (var tries = 0; tries < 8; tries++) {
    var code = newCode();
    if (readOne(nk, 'codes', code, SYSTEM_ID)) continue;
    var matchId = nk.matchCreate('outdo_table', { code: code, owner: ctx.userId, bots: int(p.bots, 0), replaceAbsent: p.replaceAbsent !== false });
    writeOne(nk, 'codes', code, SYSTEM_ID, { matchId: matchId, at: nowSec() }, null, false);
    return JSON.stringify({ code: code, matchId: matchId });
  }
  throw new Error('Réessaie dans un instant');
}

function rpcPrivateJoin(ctx, logger, nk, payload) {
  requireUser(ctx);
  var p = parse(payload);
  var code = String(p.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  var r = readOne(nk, 'codes', code, SYSTEM_ID);
  if (!r) throw new Error('Code inconnu');
  var m = nk.matchGet(r.value.matchId);
  if (!m) throw new Error('Cette partie est terminée');
  return JSON.stringify({ matchId: r.value.matchId });
}

// des inconnus réunis par le matchmaking : une table sans code, complétée par des bots
function onMatchmakerMatched(ctx, logger, nk, matches) {
  var n = matches.length;
  return nk.matchCreate('outdo_table', { code: '', owner: '', bots: Math.max(0, 4 - n), replaceAbsent: true, auto: true, expected: n });
}

// --- la table (partie tenue par le serveur, jeu calculé par l'hôte) ---

function roster(state) {
  var players = [];
  for (var i = 0; i < state.order.length; i++) {
    var uid = state.order[i];
    var pl = state.players[uid];
    players.push({ userId: uid, username: pl.username, present: !!state.presences[uid], awayMs: pl.awayMs + (pl.leftAt ? Date.now() - pl.leftAt : 0) });
  }
  return { code: state.code, host: state.host, started: state.started, settings: state.settings, players: players, over: state.over };
}

function sendRoster(dispatcher, state) {
  dispatcher.broadcastMessage(OP_ROSTER, JSON.stringify(roster(state)), null, null, true);
}

function presenceList(state, except) {
  var out = [];
  for (var uid in state.presences) {
    if (Object.prototype.hasOwnProperty.call(state.presences, uid) && uid !== except) out.push(state.presences[uid]);
  }
  return out;
}

function pickHost(state) {
  if (state.host && state.presences[state.host]) return;
  state.host = '';
  for (var i = 0; i < state.order.length; i++) {
    if (state.presences[state.order[i]]) {
      state.host = state.order[i];
      return;
    }
  }
}

function matchInit(ctx, logger, nk, params) {
  var state = {
    code: params.code || '',
    owner: params.owner || '',
    auto: !!params.auto,
    settings: { bots: int(params.bots, 0), replaceAbsent: params.replaceAbsent !== false },
    presences: {},
    players: {},
    order: [],
    host: '',
    started: false,
    startedAt: 0,
    over: false,
    rewarded: false,
    lastSnap: null,
    emptyTicks: 0,
  };
  return { state: state, tickRate: 5, label: JSON.stringify({ code: state.code, auto: state.auto, open: true }) };
}

function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  var known = !!state.players[presence.userId];
  if (!known && state.started) return { state: state, accept: false, rejectMessage: 'La partie a déjà commencé' };
  if (!known && state.order.length >= MAX_PLAYERS) return { state: state, accept: false, rejectMessage: 'Table complète' };
  return { state: state, accept: true };
}

function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    state.presences[p.userId] = p;
    var pl = state.players[p.userId];
    if (!pl) {
      state.players[p.userId] = { username: p.username, awayMs: 0, leftAt: 0 };
      state.order.push(p.userId);
    } else if (pl.leftAt) {
      pl.awayMs += Date.now() - pl.leftAt; // retour après une absence : compté pour les récompenses
      pl.leftAt = 0;
    }
  }
  // le créateur d'une table privée en est l'hôte tant qu'il est là
  if (state.owner && state.presences[state.owner] && !state.started) state.host = state.owner;
  pickHost(state);
  state.emptyTicks = 0;
  sendRoster(dispatcher, state);
  // un joueur qui revient reçoit tout de suite l'état de la partie
  if (state.lastSnap) {
    for (var j = 0; j < presences.length; j++) dispatcher.broadcastMessage(OP_SNAPSHOT, state.lastSnap, [presences[j]], null, true);
  }
  return { state: state };
}

function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    delete state.presences[p.userId];
    var pl = state.players[p.userId];
    if (pl) {
      if (!state.started) {
        // avant le départ : il quitte simplement la table
        delete state.players[p.userId];
        state.order = state.order.filter(function (u) { return u !== p.userId; });
      } else {
        pl.leftAt = Date.now();
      }
    }
  }
  pickHost(state); // l'hôte est parti : le premier joueur encore là reprend la partie depuis le dernier état
  sendRoster(dispatcher, state);
  return { state: state };
}

function rewardAll(ctx, nk, logger, dispatcher, state, result) {
  if (state.rewarded) return;
  state.rewarded = true;
  var winners = result.winners || [];
  var sole = winners.length === 1 ? winners[0] : '';
  var minSec = int(ctx.env && ctx.env['OUTDO_MULTI_MIN_SEC'], MULTI_MIN_SEC);
  var minOk = state.startedAt && Date.now() - state.startedAt >= minSec * 1000;
  for (var i = 0; i < state.order.length; i++) {
    var uid = state.order[i];
    var pl = state.players[uid];
    var away = pl.awayMs + (pl.leftAt ? Date.now() - pl.leftAt : 0);
    var coins = minOk ? Math.round((REWARD_BASE + (uid === sole ? REWARD_WIN : 0)) * awayFactor(away)) : 0;
    if (coins > 0) nk.walletUpdate(uid, { coins: coins }, { reason: 'partie', code: state.code, won: uid === sole }, true);
    var pres = state.presences[uid];
    if (pres) dispatcher.broadcastMessage(OP_REWARD, JSON.stringify({ coins: coins, awayMs: away, factor: awayFactor(away) }), [pres], null, true);
  }
  logger.info('table %s terminée, récompenses versées', state.code || '(inconnus)');
}

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var from = m.sender.userId;
    var data = nk.binaryToString(m.data);
    var isHost = from === state.host;
    switch (m.opCode) {
      case OP_SNAPSHOT:
        if (!isHost) break;
        state.lastSnap = data;
        dispatcher.broadcastMessage(OP_SNAPSHOT, data, presenceList(state, from), null, true);
        break;
      case OP_INTENT:
        if (isHost || !state.presences[state.host]) break;
        // l'hôte apprend qui a envoyé le coup (le serveur l'atteste, impossible de jouer à la place d'un autre)
        dispatcher.broadcastMessage(OP_INTENT, JSON.stringify({ from: from, d: data }), [state.presences[state.host]], null, true);
        break;
      case OP_EMOJI:
        dispatcher.broadcastMessage(OP_EMOJI, JSON.stringify({ from: from, e: String(data).slice(0, 16) }), null, null, true);
        break;
      case OP_SETTINGS:
        if (!isHost || state.started) break;
        try {
          var s = JSON.parse(data);
          state.settings = { bots: Math.max(0, Math.min(5, int(s.bots, 0))), replaceAbsent: s.replaceAbsent !== false };
          sendRoster(dispatcher, state);
        } catch (e) {}
        break;
      case OP_START:
        if (!isHost || state.started) break;
        if (state.order.length + state.settings.bots < 2) {
          dispatcher.broadcastMessage(OP_ERROR, JSON.stringify({ msg: 'Il faut au moins 2 joueurs (ou des bots)' }), [m.sender], null, true);
          break;
        }
        state.started = true;
        state.startedAt = Date.now();
        dispatcher.matchLabelUpdate(JSON.stringify({ code: state.code, auto: state.auto, open: false }));
        sendRoster(dispatcher, state);
        break;
      case OP_RESULT:
        if (!isHost || !state.started || state.over) break;
        try {
          var r = JSON.parse(data);
          state.over = true;
          rewardAll(ctx, nk, logger, dispatcher, state, r);
          sendRoster(dispatcher, state);
        } catch (e) {}
        break;
    }
  }
  // table vide : fermée au bout de 10 minutes (code libéré)
  if (presenceList(state, '').length === 0) {
    state.emptyTicks++;
    if (state.emptyTicks > 5 * 60 * 10) {
      if (state.code) nk.storageDelete([{ collection: 'codes', key: state.code, userId: SYSTEM_ID }]);
      return null;
    }
  }
  return { state: state };
}

function matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  if (state.code) {
    try {
      nk.storageDelete([{ collection: 'codes', key: state.code, userId: SYSTEM_ID }]);
    } catch (e) {}
  }
  return { state: state };
}

function matchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state: state, data: JSON.stringify(roster(state)) };
}

// ---------------------------------------------------------------------------------------------

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc('wallet_get', rpcWalletGet);
  initializer.registerRpc('solo_reward', rpcSoloReward);
  initializer.registerRpc('shop_prices', rpcShopPrices);
  initializer.registerRpc('shop_buy', rpcShopBuy);
  initializer.registerRpc('inventory_get', rpcInventory);
  initializer.registerRpc('admin_whoami', rpcAdminWhoami);
  initializer.registerRpc('admin_set_prices', rpcAdminSetPrices);
  initializer.registerRpc('admin_players', rpcAdminPlayers);
  initializer.registerRpc('admin_gift', rpcAdminGift);
  initializer.registerRpc('admin_ban', rpcAdminBan);
  initializer.registerRpc('private_create', rpcPrivateCreate);
  initializer.registerRpc('private_join', rpcPrivateJoin);
  initializer.registerMatch('outdo_table', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });
  initializer.registerMatchmakerMatched(onMatchmakerMatched);
  logger.info('OutDO! : module du serveur chargé');
}
