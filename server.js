// Fist Duel — game server
//
// Three things live here on one process/port:
//  1) A WebSocket presence counter — counts open tabs and broadcasts the number.
//  2) A real HTTP API for registration/login, backed by a real database
//     file on disk (lowdb). Passwords are hashed with bcrypt.
//  3) A fully authoritative PVP match engine (see game-engine.js). The
//     server holds the only copy of each match's hands, decks, boards,
//     mana, and combat resolution — PVP clients send intents (place a
//     card, cast a spell, sacrifice, end turn) and render whatever
//     snapshot the server sends back. They do not compute outcomes.
//
// Run locally:   npm install && npm start
// Deploy:        see README.md in this folder

import http from 'http';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { WebSocketServer, WebSocket } from 'ws';
import { LowSync } from 'lowdb';
import { JSONFileSync } from 'lowdb/node';
import * as engine from './game-engine.js';

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || 'db.json';

// ---------- Database ----------
const adapter = new JSONFileSync(DB_PATH);
const db = new LowSync(adapter, { users: [], decks: {}, matches: [], tournament: {}, resources: {}, pveProgress: {}, ownedCards: {}, shop: {} });
db.read();
db.data ||= { users: [], decks: {}, matches: [], tournament: {}, resources: {}, pveProgress: {}, ownedCards: {}, shop: {} };
db.data.decks ||= {};
db.data.matches ||= [];
db.data.tournament ||= {};
db.data.resources ||= {};
db.data.pveProgress ||= {};
db.data.ownedCards ||= {};
db.data.shop ||= {};
db.write();

// ---------- Tournament ladder ----------
// Ordered lowest-to-highest. Король (king) has no stars/progress bar —
// it's ranked purely by an accumulating point total instead.
const LEAGUE_ORDER = ['squire', 'warrior', 'gladiator', 'elite', 'warlord', 'champion', 'king'];
const LEAGUE_STARS = { squire: 3, warrior: 3, gladiator: 4, elite: 4, warlord: 5, champion: 5, king: 0 };

function getTournamentRecord(username) {
  let rec = db.data.tournament[username];
  if (!rec) {
    rec = { league: 'squire', stars: 0, progress: 0, streak: 0, kingPoints: 0 };
    db.data.tournament[username] = rec;
    db.write();
  }
  return rec;
}

// Account-bound currencies. Nothing awards them yet — that's a later
// step — this just gives every account a real, persisted balance
// (starting at 0) so the client has something honest to display.
function getResources(username) {
  let rec = db.data.resources[username];
  if (!rec) {
    rec = { dust: 0, gold: 0, crystals: 0 };
    db.data.resources[username] = rec;
    db.write();
  }
  return rec;
}

// How many copies of each card this account owns — a map of cardId to
// count. Every new account starts with exactly the starter deck's own
// counts (see engine.defaultOwnedCounts); everything else starts at 0
// copies until bought in the shop. There's no upper limit on copies —
// buying a card you already have just increments its count.
function getOwnedCounts(username) {
  let rec = db.data.ownedCards[username];
  if (!rec) {
    rec = engine.defaultOwnedCounts();
    db.data.ownedCards[username] = rec;
    db.write();
  } else if (Array.isArray(rec)) {
    // One-time migration for accounts created before per-card counts
    // existed, back when ownedCards was just a boolean array of ids
    // ("do I have this card at all"). Starter cards get their known
    // starter-deck count back; anything else in the old array (bought
    // under the old one-copy-only shop rule) becomes exactly 1 copy —
    // the old format never recorded quantity, so 1 is the accurate
    // floor of what "owned" meant back then.
    const defaults = engine.defaultOwnedCounts();
    const migrated = {};
    for (const id of rec) {
      migrated[id] = defaults[id] || 1;
    }
    rec = migrated;
    db.data.ownedCards[username] = rec;
    db.write();
  }
  return rec;
}

// ---------- Shop ----------
// The daily card lists reset at 00:00 Moscow time — computed via the
// IANA timezone (not the server's own local time or a fixed UTC offset),
// so it stays correct even if the server itself runs in another region.
function moscowDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

const SHOP_TABS = ['gold', 'dust', 'crystals'];
const SHOP_LIST_SIZE = 6;
const SHOP_REFRESH_COST = 12; // crystals — same cost regardless of which tab is being refreshed

function regenerateShopTab(username, tab) {
  const pool = engine.shoppableCards();
  const cardIds = engine.pickRandomShopCards(pool, SHOP_LIST_SIZE);
  if (!db.data.shop[username]) db.data.shop[username] = {};
  db.data.shop[username][tab] = { day: moscowDateString(), cardIds };
}

// Ensures all three tabs have a list generated for "today" (Moscow date)
// — lazily regenerating any that are missing or stale from a previous
// day, exactly once per day per account, with no separate cron/scheduler
// needed. Same account, same day => same list every time this is called.
function getShopState(username) {
  if (!db.data.shop[username]) db.data.shop[username] = {};
  const rec = db.data.shop[username];
  const today = moscowDateString();
  let changed = false;
  for (const tab of SHOP_TABS) {
    if (!rec[tab] || rec[tab].day !== today) {
      regenerateShopTab(username, tab);
      changed = true;
    }
  }
  if (changed) db.write();
  return rec;
}


// ---------- PVE progress ladder ----------
// A simple "play N matches, get gold" track shown on the PVE screen.
// `n` is the 1-based iteration number. Purely a formula — no state here,
// state lives in db.data.pveProgress. Schedule, exactly as specced:
//  iteration 1: 1 match  -> 100 gold
//  iteration 2: 3 matches -> 200 gold
//  iteration 3: 5 matches -> 300 gold
//  iterations 4-8  (5 of them): 5 matches each -> 400 gold each
//  iterations 9-15 (7 of them): 7 matches each -> 500 gold each
//  iteration 16 onward (forever): 10 matches each -> 800 gold each
function pveIterationInfo(n) {
  if (n === 1) return { required: 1, reward: 100 };
  if (n === 2) return { required: 3, reward: 200 };
  if (n === 3) return { required: 5, reward: 300 };
  if (n >= 4 && n <= 8) return { required: 5, reward: 400 };
  if (n >= 9 && n <= 15) return { required: 7, reward: 500 };
  return { required: 10, reward: 800 };
}

function getPveProgress(username) {
  let rec = db.data.pveProgress[username];
  if (!rec) {
    rec = { iteration: 1, matchesPlayed: 0 };
    db.data.pveProgress[username] = rec;
    db.write();
  }
  return rec;
}

// Counts one WON PVE match (losses don't advance the bar) toward the
// human player's progress, and grants + advances to the next iteration
// once it fills. There's no bot-stand-in concept in PVE (that's a
// tournament/PVP-only mechanic for covering a missing opponent), so
// `match.players` always has exactly one real account plus `match.aiName`.
function applyPveProgress(match) {
  const username = match.players.find((p) => p !== match.aiName);
  if (!username) return;
  if (match.winner !== username) return; // loss — no progress toward the bar
  const progress = getPveProgress(username);
  progress.matchesPlayed = (progress.matchesPlayed || 0) + 1;
  const info = pveIterationInfo(progress.iteration);
  if (progress.matchesPlayed >= info.required) {
    const resources = getResources(username);
    resources.gold = (resources.gold || 0) + info.reward;
    progress.iteration += 1;
    progress.matchesPlayed = 0;
  }
  db.write();
}

// How long to wait for a real opponent before falling back to a bot —
// the window widens in higher leagues, where fewer real players are
// likely to be queued at the same moment.
function randomBotWaitMs(league) {
  let minSec, maxSec;
  if (league === 'squire' || league === 'warrior') { minSec = 10; maxSec = 30; }
  else if (league === 'gladiator' || league === 'elite') { minSec = 10; maxSec = 60; }
  else { minSec = 30; maxSec = 90; } // warlord, champion, king
  const sec = minSec + Math.random() * (maxSec - minSec);
  return Math.round(sec * 1000);
}

// Applies win/loss rating changes once a tournament match ends. Draws
// change nothing. `match.botStandIn`, if set, is a real player's username
// borrowed only for its name + deck — that account did not actually play,
// so its own ladder record is never touched.
function applyTournamentResult(match) {
  if (!match.winner) return;
  for (const name of match.players) {
    if (match.botStandIn && match.botStandIn === name) continue;
    const record = getTournamentRecord(name);
    if (match.winner === name) {
      record.streak = (record.streak || 0) + 1;
      const bonus = Math.min(20, 10 + 2 * (record.streak - 1));
      if (record.league === 'king') {
        record.kingPoints = (record.kingPoints || 0) + bonus;
      } else {
        record.progress = (record.progress || 0) + bonus;
        const maxStars = LEAGUE_STARS[record.league];
        while (record.progress >= 30) {
          record.progress -= 30;
          record.stars += 1;
          if (record.stars >= maxStars) {
            const idx = LEAGUE_ORDER.indexOf(record.league);
            record.league = LEAGUE_ORDER[idx + 1];
            record.stars = 0;
            record.progress = 0;
            break; // fresh bar in the new league — no cross-league carry
          }
        }
      }
    } else {
      record.streak = 0;
      if (record.league === 'king') {
        record.kingPoints = Math.max(0, (record.kingPoints || 0) - 10);
      } else {
        record.progress = Math.max(0, (record.progress || 0) - 10);
      }
    }
  }
  db.write();
}

function findUser(username) {
  return db.data.users.find(
    (u) => u.username.toLowerCase() === String(username).toLowerCase()
  );
}

// In-memory session store: token -> username.
const sessions = new Map();
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
function usernameFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? sessions.get(token) : null;
}

function getDeckCounts(username) {
  return db.data.decks[username] || engine.defaultDeckCounts();
}

// ---------- HTTP API ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.type('text/plain').send('Fist Duel server is running.\n');
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  const name = typeof username === 'string' ? username.trim() : '';
  const pass = typeof password === 'string' ? password : '';

  if (name.length < 3 || name.length > 20) {
    return res.status(400).json({ error: '\u0418\u043c\u044f \u0438\u0433\u0440\u043e\u043a\u0430 \u2014 \u043e\u0442 3 \u0434\u043e 20 \u0441\u0438\u043c\u0432\u043e\u043b\u043e\u0432.' });
  }
  if (pass.length < 4) {
    return res.status(400).json({ error: '\u041f\u0430\u0440\u043e\u043b\u044c \u2014 \u043c\u0438\u043d\u0438\u043c\u0443\u043c 4 \u0441\u0438\u043c\u0432\u043e\u043b\u0430.' });
  }
  if (findUser(name)) {
    return res.status(409).json({ error: '\u042d\u0442\u043e \u0438\u043c\u044f \u0443\u0436\u0435 \u0437\u0430\u043d\u044f\u0442\u043e.' });
  }

  const passwordHash = bcrypt.hashSync(pass, 10);
  db.data.users.push({
    username: name,
    passwordHash,
    createdAt: new Date().toISOString(),
  });
  // Every new account starts with a full 30-card deck already saved,
  // not just falling back to a default at read time.
  db.data.decks[name] = engine.defaultDeckCounts();
  db.data.tournament[name] = { league: 'squire', stars: 0, progress: 0, streak: 0, kingPoints: 0 };
  db.data.resources[name] = { dust: 0, gold: 0, crystals: 0 };
  db.data.pveProgress[name] = { iteration: 1, matchesPlayed: 0 };
  db.data.ownedCards[name] = engine.defaultOwnedCounts();
  db.write();

  res.status(201).json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const name = typeof username === 'string' ? username.trim() : '';
  const pass = typeof password === 'string' ? password : '';

  const user = findUser(name);
  if (!user || !bcrypt.compareSync(pass, user.passwordHash)) {
    return res.status(401).json({ error: '\u041d\u0435\u0432\u0435\u0440\u043d\u043e\u0435 \u0438\u043c\u044f \u0438\u0433\u0440\u043e\u043a\u0430 \u0438\u043b\u0438 \u043f\u0430\u0440\u043e\u043b\u044c.' });
  }

  const token = makeToken();
  sessions.set(token, user.username);
  res.json({ ok: true, token, username: user.username });
});

app.get('/api/me', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  res.json({ username });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Deck is tied to the account, not local storage, because the server
// needs it to build a real draw pile when a PVP match starts.
app.get('/api/deck', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  res.json({ counts: getDeckCounts(username) });
});

app.post('/api/deck', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const counts = (req.body && req.body.counts) || {};
  const owned = getOwnedCounts(username);
  const clean = {};
  let total = 0;
  for (const id of Object.keys(counts)) {
    const card = engine.cardById(id);
    if (!card) continue;
    if (!(owned[id] > 0)) continue; // not owned (0 copies) — can't go in a deck
    const n = Math.max(0, Math.min(engine.deckSlotCapForCard(card, owned[id]), Math.floor(Number(counts[id]) || 0)));
    if (n > 0) clean[id] = n;
    total += n;
  }
  if (total > 30) return res.status(400).json({ error: '\u0412 \u043a\u043e\u043b\u043e\u0434\u0435 \u043d\u0435 \u043c\u043e\u0436\u0435\u0442 \u0431\u044b\u0442\u044c \u0431\u043e\u043b\u044c\u0448\u0435 30 \u043a\u0430\u0440\u0442.' });
  db.data.decks[username] = clean;
  db.write();
  res.json({ ok: true });
});

// How many copies of each card this account owns (cardId -> count).
// Read-only here — the only way this changes is buying more copies via
// POST /api/shop/buy.
app.get('/api/owned-cards', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  res.json({ counts: getOwnedCounts(username) });
});

// Today's shop lists (all 3 currency tabs at once) — auto-regenerates any
// tab that's stale from a previous Moscow calendar day.
app.get('/api/shop', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const rec = getShopState(username);
  res.json({
    gold: { cardIds: rec.gold.cardIds },
    dust: { cardIds: rec.dust.cardIds },
    crystals: { cardIds: rec.crystals.cardIds },
  });
});

// Pays SHOP_REFRESH_COST crystals to re-roll one tab's list early, ahead
// of its natural daily reset. Costs crystals regardless of which tab
// (gold/dust/crystals) is being refreshed — crystals are the "premium"
// currency used for this kind of action across the shop.
app.post('/api/shop/refresh', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const tab = req.body && req.body.tab;
  if (!SHOP_TABS.includes(tab)) {
    return res.status(400).json({ error: '\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u0430.' });
  }
  getShopState(username); // make sure today's lists exist first, so a refresh right at day-rollover behaves predictably
  const resources = getResources(username);
  if ((resources.crystals || 0) < SHOP_REFRESH_COST) {
    return res.status(400).json({ error: '\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u043a\u0440\u0438\u0441\u0442\u0430\u043b\u043b\u043e\u0432.' });
  }
  resources.crystals -= SHOP_REFRESH_COST;
  regenerateShopTab(username, tab);
  db.write();
  res.json({ cardIds: db.data.shop[username][tab].cardIds, crystals: resources.crystals });
});

// Buys one specific slot from a tab's currently-listed cards, paying in
// that tab's own currency (gold tab charges gold, etc. — SHOP_TABS names
// double as the matching resources keys). `index` (not cardId) identifies
// the slot, since the same card can legitimately appear more than once in
// a 6-slot list drawn with replacement — buying slot 2 shouldn't silently
// also consume slot 5 just because they're the same card. The purchased
// card is added to the account's owned cards; the list itself is left
// as-is (any other slot showing the same card simply becomes "already
// owned" from the client's perspective, since ownership is per-card, not
// per-slot).
// Buys one specific slot from a tab's currently-listed cards, paying in
// that tab's own currency (gold tab charges gold, etc. — SHOP_TABS names
// double as the matching resources keys). `index` (not cardId) identifies
// the slot, since the same card can legitimately appear more than once in
// a 6-slot list drawn with replacement — buying slot 2 shouldn't silently
// also consume slot 5 just because they're the same card. Each purchase
// adds exactly one MORE copy to the account's owned count — there's no
// cap, and buying a card you already own is fully expected (that's how
// you stack up copies), not blocked.
app.post('/api/shop/buy', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const tab = req.body && req.body.tab;
  const index = req.body && req.body.index;
  if (!SHOP_TABS.includes(tab)) {
    return res.status(400).json({ error: '\u041d\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043d\u0430\u044f \u0432\u043a\u043b\u0430\u0434\u043a\u0430 \u043c\u0430\u0433\u0430\u0437\u0438\u043d\u0430.' });
  }
  const rec = getShopState(username);
  const list = rec[tab].cardIds;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return res.status(400).json({ error: '\u041d\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u043a\u0430\u0440\u0442\u0430.' });
  }
  const cardId = list[index];
  const card = engine.cardById(cardId);
  if (!card) return res.status(400).json({ error: '\u041d\u0435\u0432\u0435\u0440\u043d\u0430\u044f \u043a\u0430\u0440\u0442\u0430.' });
  const price = engine.shopPriceForCard(card, tab);
  if (price == null) return res.status(400).json({ error: '\u042d\u0442\u0430 \u043a\u0430\u0440\u0442\u0430 \u043d\u0435 \u043f\u0440\u043e\u0434\u0430\u0451\u0442\u0441\u044f.' });
  const resources = getResources(username);
  if ((resources[tab] || 0) < price) {
    return res.status(400).json({ error: '\u041d\u0435\u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e \u0441\u0440\u0435\u0434\u0441\u0442\u0432.' });
  }
  resources[tab] -= price;
  const owned = getOwnedCounts(username);
  owned[cardId] = (owned[cardId] || 0) + 1;
  db.write();
  res.json({ ok: true, cardId, ownedCount: owned[cardId], resources });
});

// Account-bound currencies (пыль/золото/кристаллы). Read-only for now —
// nothing awards them yet, that's a later step. Every account starts at
// 0 and this just exposes the persisted balance.
app.get('/api/resources', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  res.json(getResources(username));
});

// Current standing on the PVE match-count reward ladder. Read-only —
// progress only advances server-side, when a PVE match actually finishes
// (see applyPveProgress). Includes the current iteration's target/reward
// alongside the raw counters so the client doesn't need its own copy of
// the reward schedule.
app.get('/api/pve-progress', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const progress = getPveProgress(username);
  const info = pveIterationInfo(progress.iteration);
  res.json({
    iteration: progress.iteration,
    matchesPlayed: progress.matchesPlayed,
    matchesRequired: info.required,
    reward: info.reward,
  });
});

// Current ladder standing for the logged-in account. Read-only — all
// progress changes happen server-side when a tournament match ends.
app.get('/api/tournament', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const record = getTournamentRecord(username);
  const maxStars = LEAGUE_STARS[record.league];
  let kingRank = null;
  if (record.league === 'king') {
    const myPoints = record.kingPoints || 0;
    const higherCount = db.data.users
      .map((u) => u.username)
      .filter((u) => u !== username)
      .map((u) => getTournamentRecord(u))
      .filter((r) => r.league === 'king' && (r.kingPoints || 0) > myPoints).length;
    kingRank = higherCount + 1;
  }
  res.json({ league: record.league, stars: record.stars, maxStars, progress: record.progress, kingRank });
});

app.get('/api/matches/:matchId', (req, res) => {
  const record = db.data.matches.find((m) => m.matchId === req.params.matchId);
  if (!record) return res.status(404).json({ error: '\u041c\u0430\u0442\u0447 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d.' });
  res.json(record);
});

// ---------- HTTP + WebSocket share one server/port ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcastCount() {
  const payload = JSON.stringify({ type: 'count', count: clients.size });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- PVP: live authoritative matches + matchmaking ----------
// `liveMatches` holds the real, in-memory, authoritative engine.Match
// objects (see game-engine.js) plus the two players' live sockets.
// `db.data.matches` holds a durable, JSON-safe snapshot of the same data
// for resume-after-restart — written on every state-changing action.
const waitingQueue = []; // { ws, username }
const tournamentQueue = []; // { ws, username, timeout }
const liveMatches = new Map(); // matchId -> { match, sockets: { [username]: ws } }

function persistMatch(mm) {
  const snap = engine.serializeMatch(mm.match);
  snap.updatedAt = new Date().toISOString();
  const idx = db.data.matches.findIndex((m) => m.matchId === snap.matchId);
  if (idx === -1) db.data.matches.push(snap);
  else db.data.matches[idx] = snap;
  db.write();
}

function sendSnapshots(mm) {
  for (const username of mm.match.players) {
    safeSend(mm.sockets[username], {
      type: 'state_update',
      state: engine.snapshotFor(mm.match, username),
    });
  }
}

function removeFromQueue(ws) {
  const idx = waitingQueue.findIndex((w) => w.ws === ws);
  if (idx !== -1) {
    clearTimeout(waitingQueue[idx].timeout);
    waitingQueue.splice(idx, 1);
  }
}

function removeFromTournamentQueue(ws) {
  const idx = tournamentQueue.findIndex((w) => w.ws === ws);
  if (idx !== -1) {
    clearTimeout(tournamentQueue[idx].timeout);
    tournamentQueue.splice(idx, 1);
  }
}

// A tournament match against a real opponent is presented to the client
// exactly like ordinary PVP — 'mode: pvp' — since from the human player's
// side there is nothing different about it.
function startTournamentMatch(nameA, wsA, nameB, wsB) {
  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, nameA, getDeckCounts(nameA), nameB, getDeckCounts(nameB));
  match.isTournament = true;
  const mm = { match, sockets: { [nameA]: wsA, [nameB]: wsB } };
  liveMatches.set(matchId, mm);
  persistMatch(mm);
  safeSend(wsA, { type: 'match_found', matchId, opponent: nameB, mode: 'pvp' });
  safeSend(wsB, { type: 'match_found', matchId, opponent: nameA, mode: 'pvp' });
  sendSnapshots(mm);
}

// Plain-PVP equivalent of the tournament bot fallback below — no league
// concept here, so the borrowed account is picked from the whole player
// base rather than a league-adjacent slice.
function startPvpBotMatch(myName, ws) {
  const candidates = db.data.users.map((u) => u.username).filter((u) => u !== myName);
  let botName, botDeck;
  if (candidates.length > 0) {
    botName = candidates[Math.floor(Math.random() * candidates.length)];
    botDeck = getDeckCounts(botName);
  } else {
    botName = myName === '\u0418\u0418' ? '\u0418\u0418-\u0421\u043e\u043f\u0435\u0440\u043d\u0438\u043a' : '\u0418\u0418';
    botDeck = engine.defaultDeckCounts();
  }
  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, myName, getDeckCounts(myName), botName, botDeck);
  match.isPve = true; // reuses the existing "server auto-plays this side" turn logic
  match.aiName = botName;
  match.botStandIn = botName; // borrowed identity — not a real participant
  const mm = { match, sockets: { [myName]: ws } };
  liveMatches.set(matchId, mm);
  persistMatch(mm);
  safeSend(ws, { type: 'match_found', matchId, opponent: botName, mode: 'pvp' });
  sendSnapshots(mm);
}

function randomPvpBotWaitMs() {
  return Math.round((30 + Math.random() * 60) * 1000); // 30–90s, uniformly
}

// No real opponent showed up in time — borrow a real account's name and
// deck from the same league (or one league up/down) so the match still
// feels like it's against another person, and quietly drive that side
// with the same bot AI used for plain PVE.
function startTournamentBotMatch(myName, ws) {
  const myRecord = getTournamentRecord(myName);
  const myIdx = LEAGUE_ORDER.indexOf(myRecord.league);
  const eligibleLeagues = new Set([myRecord.league]);
  if (myIdx > 0) eligibleLeagues.add(LEAGUE_ORDER[myIdx - 1]);
  if (myIdx < LEAGUE_ORDER.length - 1) eligibleLeagues.add(LEAGUE_ORDER[myIdx + 1]);

  const candidates = db.data.users
    .map((u) => u.username)
    .filter((u) => u !== myName && eligibleLeagues.has(getTournamentRecord(u).league));

  let botName, botDeck;
  if (candidates.length > 0) {
    botName = candidates[Math.floor(Math.random() * candidates.length)];
    botDeck = getDeckCounts(botName);
  } else {
    // No eligible real account to borrow (very few registered players) —
    // fall back to a plain, clearly-generic opponent rather than failing.
    botName = myName === '\u0418\u0418' ? '\u0418\u0418-\u0421\u043e\u043f\u0435\u0440\u043d\u0438\u043a' : '\u0418\u0418';
    botDeck = engine.defaultDeckCounts();
  }

  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, myName, getDeckCounts(myName), botName, botDeck);
  match.isTournament = true;
  match.isPve = true; // reuses the existing "server auto-plays this side" turn logic
  match.aiName = botName;
  match.botStandIn = botName; // borrowed identity — never update its own ladder record
  const mm = { match, sockets: { [myName]: ws } };
  liveMatches.set(matchId, mm);
  persistMatch(mm);
  safeSend(ws, { type: 'match_found', matchId, opponent: botName, mode: 'pvp' });
  sendSnapshots(mm);
}

// Detach a disconnected socket from any live match without ending it —
// the match (and its full hidden state) stays in memory + db so the
// player can reconnect via 'resume_match'.
function handleSocketDisconnect(ws) {
  removeFromQueue(ws);
  removeFromTournamentQueue(ws);
  for (const mm of liveMatches.values()) {
    for (const username of Object.keys(mm.sockets)) {
      if (mm.sockets[username] === ws) {
        delete mm.sockets[username];
        const otherName = engine.otherPlayer(mm.match, username);
        safeSend(mm.sockets[otherName], { type: 'opponent_disconnected' });
      }
    }
  }
}

function endMatch(mm, status, winner) {
  mm.match.status = status;
  mm.match.winner = winner || null;
  persistMatch(mm);
  liveMatches.delete(mm.match.matchId);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcastCount();

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    // Everything below this point is wrapped: one malformed/unexpected
    // message must never be able to throw an uncaught exception and take
    // the whole process (and every other player's live match) down with
    // it. If this ever fires, the error is logged so the real cause is
    // visible in the deploy logs instead of showing up as a bare "crash".
    try {
      handleMessage(ws, msg);
    } catch (err) {
      console.error('[ws message handler error]', msg && msg.type, err);
    }
  });

  function handleMessage(ws, msg){
    // ---- Matchmaking ----
    if (msg.type === 'find_match') {
      removeFromQueue(ws);
      const myName = String(msg.username || '\u0418\u0433\u0440\u043e\u043a').slice(0, 20);
      if (waitingQueue.length > 0) {
        const opponent = waitingQueue.shift();
        clearTimeout(opponent.timeout);
        const matchId = crypto.randomBytes(8).toString('hex');
        const match = engine.createMatch(
          matchId,
          myName, getDeckCounts(myName),
          opponent.username, getDeckCounts(opponent.username)
        );
        const mm = { match, sockets: { [myName]: ws, [opponent.username]: opponent.ws } };
        liveMatches.set(matchId, mm);
        persistMatch(mm);
        safeSend(ws, { type: 'match_found', matchId, opponent: opponent.username, mode: 'pvp' });
        safeSend(opponent.ws, { type: 'match_found', matchId, opponent: myName, mode: 'pvp' });
        sendSnapshots(mm);
      } else {
        const entry = { ws, username: myName };
        entry.timeout = setTimeout(() => {
          const idx = waitingQueue.indexOf(entry);
          if (idx === -1) return; // matched with a real opponent in the meantime
          waitingQueue.splice(idx, 1);
          startPvpBotMatch(myName, ws);
        }, randomPvpBotWaitMs());
        waitingQueue.push(entry);
        safeSend(ws, { type: 'searching' });
      }
      return;
    }

    // PVE needs no queue or second socket — the bot opponent is just
    // another "player" in the same match record, driven by aiPlaceCards()
    // whenever the human ends their turn (see the end_turn handler below).
    if (msg.type === 'start_pve') {
      const myName = String(msg.username || '\u0418\u0433\u0440\u043e\u043a').slice(0, 20);
      const aiName = myName === '\u0418\u0418' ? '\u0418\u0418-\u0421\u043e\u043f\u0435\u0440\u043d\u0438\u043a' : '\u0418\u0418'; // avoid name clash in the unlikely case someone is literally named "ИИ"
      const matchId = crypto.randomBytes(8).toString('hex');
      const match = engine.createMatch(matchId, myName, getDeckCounts(myName), aiName, engine.defaultDeckCounts());
      match.isPve = true;
      match.aiName = aiName;
      const mm = { match, sockets: { [myName]: ws } }; // no socket for the bot side
      liveMatches.set(matchId, mm);
      persistMatch(mm);
      safeSend(ws, { type: 'match_found', matchId, opponent: aiName, mode: 'pve' });
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'cancel_search') {
      removeFromQueue(ws);
      return;
    }

    // ---- Tournament matchmaking ----
    if (msg.type === 'start_tournament_search') {
      removeFromTournamentQueue(ws);
      const myName = String(msg.username || '\u0418\u0433\u0440\u043e\u043a').slice(0, 20);
      if (tournamentQueue.length > 0) {
        const opponent = tournamentQueue.shift();
        clearTimeout(opponent.timeout);
        startTournamentMatch(myName, ws, opponent.username, opponent.ws);
      } else {
        const record = getTournamentRecord(myName);
        const waitMs = randomBotWaitMs(record.league);
        const entry = { ws, username: myName };
        entry.timeout = setTimeout(() => {
          const idx = tournamentQueue.indexOf(entry);
          if (idx === -1) return; // matched with a real opponent in the meantime
          tournamentQueue.splice(idx, 1);
          startTournamentBotMatch(myName, ws);
        }, waitMs);
        tournamentQueue.push(entry);
        safeSend(ws, { type: 'searching' });
      }
      return;
    }

    if (msg.type === 'cancel_tournament_search') {
      removeFromTournamentQueue(ws);
      return;
    }

    // ---- In-match actions (all validated server-side in game-engine.js) ----
    if (msg.type === 'place_card' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      const result = engine.placeCard(mm.match, msg.username, msg.uid, msg.lane, msg.depth);
      if (result.error) { safeSend(ws, { type: 'action_rejected', reason: result.error }); return; }
      persistMatch(mm);
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'move_unit' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      const result = engine.moveUnit(mm.match, msg.username, msg.uid, msg.lane, msg.depth);
      if (result.error) { safeSend(ws, { type: 'action_rejected', reason: result.error }); return; }
      persistMatch(mm);
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'return_to_hand' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      const result = engine.returnToHand(mm.match, msg.username, msg.uid);
      if (result.error) { safeSend(ws, { type: 'action_rejected', reason: result.error }); return; }
      persistMatch(mm);
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'cast_spell' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      const result = engine.castSpell(mm.match, msg.username, msg.uid, msg.lane, msg.depth);
      if (result.error) { safeSend(ws, { type: 'action_rejected', reason: result.error }); return; }
      persistMatch(mm);
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'sacrifice' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      const result = engine.sacrifice(mm.match, msg.username, msg.uid);
      if (result.error) { safeSend(ws, { type: 'action_rejected', reason: result.error }); return; }
      persistMatch(mm);
      sendSnapshots(mm);
      return;
    }

    if (msg.type === 'end_turn' && msg.matchId) {
      const mm = liveMatches.get(msg.matchId);
      if (!mm) return;
      if (mm.match.isPve) {
        // The bot plays its whole turn right now, then immediately marks
        // itself ready — from here the flow is identical to PVP.
        engine.aiPlaceCards(mm.match, mm.match.aiName);
        engine.tryEndTurn(mm.match, mm.match.aiName);
      }
      const result = engine.tryEndTurn(mm.match, msg.username);
      if (!result.ready) {
        persistMatch(mm);
        sendSnapshots(mm); // just marks this player as "ready", opponent still placing
        return;
      }
      // Both players were ready — resolution just ran synchronously inside
      // tryEndTurn(). Send each side: the pre-resolution board (so the
      // client can reveal what was actually placed first), the event log
      // (for spell/combat animation), and the settled final snapshot.
      for (const username of mm.match.players) {
        const other = engine.otherPlayer(mm.match, username);
        safeSend(mm.sockets[username], {
          type: 'resolution',
          preBoard: { myBoard: result.preBoards[username], opponentBoard: result.preBoards[other] },
          events: result.events,
          state: engine.snapshotFor(mm.match, username),
        });
      }
      persistMatch(mm);
      if (result.gameOver) {
        endMatch(mm, 'finished', result.winner);
        if (mm.match.isTournament) applyTournamentResult(mm.match);
        if (mm.match.isPve) applyPveProgress(mm.match);
      }
      return;
    }

    if (msg.type === 'leave_match' && msg.matchId && msg.username) {
      const mm = liveMatches.get(msg.matchId);
      if (mm) {
        const otherName = engine.otherPlayer(mm.match, msg.username);
        safeSend(mm.sockets[otherName], { type: 'opponent_left' });
        endMatch(mm, 'abandoned', otherName);
        if (mm.match.isTournament) applyTournamentResult(mm.match);
      }
      return;
    }

    if (msg.type === 'resume_match' && msg.matchId && msg.username) {
      let mm = liveMatches.get(msg.matchId);
      if (!mm) {
        // Not live (server restarted, or this player's browser reconnected
        // to a match only the db remembers) — try to rebuild it from disk.
        const record = db.data.matches.find((m) => m.matchId === msg.matchId);
        if (!record || record.status !== 'active' || !record.players.includes(msg.username)) {
          safeSend(ws, { type: 'resume_failed' });
          return;
        }
        mm = { match: record, sockets: {} };
        liveMatches.set(msg.matchId, mm);
      }
      if (!mm.match.players.includes(msg.username)) {
        safeSend(ws, { type: 'resume_failed' });
        return;
      }
      mm.sockets[msg.username] = ws;
      safeSend(ws, { type: 'state_update', state: engine.snapshotFor(mm.match, msg.username), resumed: true });
      const otherName = engine.otherPlayer(mm.match, msg.username);
      safeSend(mm.sockets[otherName], { type: 'opponent_reconnected' });
      return;
    }
  }

  ws.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
    handleSocketDisconnect(ws);
  });
  ws.on('error', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
    handleSocketDisconnect(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Fist Duel server listening on port ${PORT}`);
  // Build/encoding self-check: if this ever prints as "??" or "\u..." or
  // mojibake like "??" / garbled bytes instead of "ИИ", the running code
  // is NOT the version with the unicode-escape encoding fix — a stale
  // deploy is the problem, not the app itself.
  console.log(`[boot check] AI name should read as "\u0418\u0418" -> got: "${'\u0418\u0418'}"`);
});
