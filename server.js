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
const db = new LowSync(adapter, { users: [], decks: {}, matches: [], tournament: {}, resources: {}, pveProgress: {}, ownedCards: {}, shop: {}, activeDeck: {}, pvpProgress: {}, treasureRace: {}, pveStats: {}, pvpStats: {}, treasureRaceBoard: {} });
db.read();
db.data ||= { users: [], decks: {}, matches: [], tournament: {}, resources: {}, pveProgress: {}, ownedCards: {}, shop: {}, activeDeck: {}, pvpProgress: {}, treasureRace: {}, pveStats: {}, pvpStats: {}, treasureRaceBoard: {} };
db.data.decks ||= {};
db.data.matches ||= [];
db.data.tournament ||= {};
db.data.resources ||= {};
db.data.pveProgress ||= {};
db.data.pvpProgress ||= {};
db.data.ownedCards ||= {};
db.data.shop ||= {};
db.data.activeDeck ||= {};
db.data.treasureRace ||= {};
db.data.pveStats ||= {};
db.data.pvpStats ||= {};
db.data.treasureRaceBoard ||= {};
db.write();

// ---------- Tournament ladder ----------
// Ordered lowest-to-highest. Король (king) has no stars/progress bar —
// it's ranked purely by an accumulating point total instead.
const LEAGUE_ORDER = ['squire', 'warrior', 'gladiator', 'elite', 'warlord', 'champion', 'king'];
const LEAGUE_STARS = { squire: 3, warrior: 3, gladiator: 4, elite: 4, warlord: 5, champion: 5, king: 0 };
// A single monotonically-increasing "total rating points" number, used to
// rank the leaderboard and shown to the player as their overall score.
// Climbing a league (30 points per star × however many stars that league
// has) always outweighs any amount of progress within a lower league, and
// reaching King jumps to a fixed baseline well above the maximum possible
// sub-King total (720) before kingPoints add on top of that — so any King
// always outranks any non-King, and among Kings it's kingPoints that
// break the tie. A brand-new Оруженосец (squire, 0 stars, 0 progress)
// scores exactly 0 — the "must be > 0 to appear" leaderboard rule reads
// directly off this number.
const TOURNAMENT_KING_BASELINE = 100000;
function tournamentTotalPoints(record) {
  if (record.league === 'king') {
    return TOURNAMENT_KING_BASELINE + (record.kingPoints || 0);
  }
  let points = 0;
  for (const league of LEAGUE_ORDER) {
    if (league === record.league) {
      points += (record.stars || 0) * 30 + (record.progress || 0);
      break;
    }
    points += LEAGUE_STARS[league] * 30;
  }
  return points;
}

function getTournamentRecord(username) {
  let rec = db.data.tournament[username];
  if (!rec) {
    rec = { league: 'squire', stars: 0, progress: 0, streak: 0, kingPoints: 0 };
    db.data.tournament[username] = rec;
    db.write();
  }
  return rec;
}

// ---------- Treasure Race (Гонка за сокровищами) ----------
// A limited-time event mode: open for 1 hour starting at 03:00, 07:00,
// 11:00, 15:00, 19:00 and 23:00 UTC ("server time" — this server's own
// clock, which runs UTC). Within one open window, a player plays a
// string of matches along a 13-node ladder, 3 lives total, banking gold
// per win — see TREASURE_RACE_REWARDS. Nothing here runs on a
// cron/scheduler: every check below is computed fresh from the current
// clock time whenever it's actually needed (same lazy-evaluation
// convention as the shop's own daily UTC reset).
const TREASURE_RACE_OPEN_HOURS = [3, 7, 11, 15, 19, 23];
const TREASURE_RACE_WINDOW_MS = 60 * 60 * 1000;
// Reward for the Nth win (1-indexed): rewards[0] is the 1st win's gold.
// Each of the big milestone nodes (4/7/10/13) folds in its own bonus on
// top of that tier's regular per-win amount — e.g. node 4 is the regular
// 35 (same as nodes 2-3) plus a 100 bonus = 135 total. See the client's
// TREASURE_RACE_REGULAR/TREASURE_RACE_BONUS for how these two parts are
// shown as separate labels; here only the combined total matters.
const TREASURE_RACE_REWARDS = [50, 35, 35, 135, 75, 75, 275, 125, 125, 425, 150, 150, 650];
const TREASURE_RACE_MAX_WINS = TREASURE_RACE_REWARDS.length; // 13
const TREASURE_RACE_BONUS_MULTIPLIER = 1.5; // applied to the running total once the 13th win lands
const TREASURE_RACE_HUNTER_NAME = '\u041e\u0445\u043e\u0442\u043d\u0438\u043a \u0437\u0430 \u0441\u043e\u043a\u0440\u043e\u0432\u0438\u0449\u0430\u043c\u0438';

// The window `now` currently falls inside, or null if it's between
// windows. `key` uniquely identifies this specific occurrence (its own
// start instant) — a fresh per-window player record is keyed on this.
function currentTreasureRaceWindow(now) {
  now = now || new Date();
  const h = now.getUTCHours();
  if (!TREASURE_RACE_OPEN_HOURS.includes(h)) return null;
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, 0, 0, 0);
  return { key: new Date(startMs).toISOString(), startMs, endMs: startMs + TREASURE_RACE_WINDOW_MS };
}

// The next time (epoch ms) a window will open, strictly after `now` —
// used so the client can show a countdown/label when the mode is closed.
function nextTreasureRaceWindowStart(now) {
  now = now || new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0);
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    for (const h of TREASURE_RACE_OPEN_HOURS) {
      const t = dayStart + dayOffset * dayMs + h * 60 * 60 * 1000;
      if (t > now.getTime()) return t;
    }
  }
  return dayStart + 2 * dayMs; // unreachable in practice — safety net only
}

// This account's record for whichever window is relevant right now.
// - If a window is currently open and the stored record is from an
//   older window (or doesn't exist), a fresh 13-node run starts: 0 wins,
//   3 lives, 0 gold, status 'active' — UNLESS the old record still has
//   an unclaimed reward sitting on it, in which case that one is kept
//   as-is (see below) instead of being silently discarded.
// - If a window is open and the stored record already belongs to it,
//   that record is returned as-is (mid-run).
// - If no window is open right now, whatever record is already stored
//   (from the last window this account played) is returned untouched —
//   including a still-'active' one, which gets lazily closed out below
//   the moment its own hour has elapsed, banking whatever gold was
//   earned so far (see the spec: "если жизни у игрока остались и
//   закончился временной интервал события, то он получает то, что
//   заработал").
// - An unclaimed reward from a finished run is never overwritten by a
//   fresh run, even once a later window opens — otherwise a player who
//   simply didn't see the reward notification in time would silently
//   lose that gold. They must claim it (POST .../claim) before a new
//   run can start.
// - Returns null only for an account that has never played this mode
//   and isn't inside an open window right now — nothing to show yet.
// Whenever an account's Treasure Race record is about to be left behind
// (its window has ended, or a newer window is starting), its final win
// count is folded into the shared "last completed window" leaderboard —
// this is the only leaderboard we keep, so contributing here is what
// keeps GET /api/leaderboard/treasure-race showing the right window.
// Idempotent (safe to call more than once for the same record) and
// self-resetting: the moment a record from a NEWER window than whatever
// the board currently holds shows up, the board starts over for it —
// this is exactly the "clears and rebuilds after each window" rule.
function contributeToTreasureRaceBoard(username, rec) {
  if (!rec || !(rec.wins > 0)) return;
  const board = db.data.treasureRaceBoard;
  if (board.windowKey !== rec.windowKey) {
    board.windowKey = rec.windowKey;
    board.entries = {};
  }
  const prev = board.entries[username];
  if (prev == null || rec.wins > prev) board.entries[username] = rec.wins;
}

function getTreasureRaceRecord(username) {
  const now = new Date();
  let rec = db.data.treasureRace[username];
  if (rec && rec.status === 'active' && now.getTime() >= Date.parse(rec.windowKey) + TREASURE_RACE_WINDOW_MS) {
    rec.status = 'ended'; // window elapsed while still alive — bank what's earned
    contributeToTreasureRaceBoard(username, rec);
    db.write();
  }
  const win = currentTreasureRaceWindow(now);
  if (win && (!rec || rec.windowKey !== win.key)) {
    // An unclaimed reward from an earlier window must survive until the
    // player actually claims it — even once a later window has opened
    // and a new run could otherwise start. Only start a fresh run once
    // there's nothing pending.
    const hasUnclaimedReward = rec && rec.status !== 'active' && !rec.claimed;
    if (!hasUnclaimedReward) {
      if (rec) contributeToTreasureRaceBoard(username, rec); // capture the outgoing record's final wins before it's replaced
      rec = { windowKey: win.key, wins: 0, lives: 3, gold: 0, status: 'active', claimed: false };
      db.data.treasureRace[username] = rec;
      db.write();
    }
  }
  return rec || null;
}

// Which of the 4 matchmaking brackets a win count belongs to (0-3, 4-6,
// 7-9, 10-12) — or -1 once 13 wins is reached, meaning this account is
// done for the window (win or otherwise) and can't queue for more.
function treasureRaceBucket(wins) {
  if (wins >= TREASURE_RACE_MAX_WINS) return -1;
  if (wins <= 3) return 0;
  if (wins <= 6) return 1;
  if (wins <= 9) return 2;
  return 3;
}

// A genuinely randomly-assembled 30-card deck (respecting each card's
// normal copy cap) — used only for the last-resort "Охотник за
// сокровищами" bot, when no real account exists at all to borrow a deck
// from. Not the same as engine.defaultDeckCounts(): every card in the
// pool is a candidate, not just the common starter set.
function buildRandomTreasureHunterDeck() {
  const pool = engine.CARD_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const counts = {};
  let total = 0;
  for (const card of pool) {
    if (total >= 30) break;
    const cap = engine.maxCopiesForCard(card);
    const n = Math.min(cap, 30 - total, 1 + Math.floor(Math.random() * cap));
    if (n > 0) { counts[card.id] = n; total += n; }
  }
  return counts;
}

// Applies a finished Treasure Race match's outcome to both real players'
// records (never to match.botStandIn — a borrowed identity that never
// actually played). A win advances the ladder and banks that node's
// gold, and the 13th win additionally multiplies the whole run's gold by
// TREASURE_RACE_BONUS_MULTIPLIER. A loss costs one life. Either can end
// the run (status leaves 'active') — the earned gold stays *pending*
// (not yet in the account's real balance) until the client's own
// acknowledgement claims it via POST /api/treasure-race/claim.
function applyTreasureRaceResult(match) {
  if (!match.winner) return; // a draw changes nothing here
  for (const name of match.players) {
    if (match.botStandIn && match.botStandIn === name) continue;
    const rec = getTreasureRaceRecord(name);
    if (!rec || rec.status !== 'active') continue; // shouldn't happen, but never touch a finished run
    if (match.winner === name) {
      rec.wins += 1;
      rec.gold += TREASURE_RACE_REWARDS[rec.wins - 1] || 0;
      if (rec.wins >= TREASURE_RACE_MAX_WINS) {
        rec.gold = Math.round(rec.gold * TREASURE_RACE_BONUS_MULTIPLIER);
        rec.status = 'won';
      }
    } else {
      rec.lives -= 1;
      if (rec.lives <= 0) rec.status = 'eliminated';
    }
  }
  db.write();
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
  // Кольчуга (s1) and Родная тетушка (c16) are core starter-deck cards —
  // every account must own at least 3 copies of each, always. This
  // backfills any account whose ownedCards record predates their
  // addition to the starter set (or otherwise ended up short), no matter
  // which branch above ran or whether one ran at all — old accounts
  // created before these two were part of defaultOwnedCounts() would
  // otherwise stay permanently missing or short on them.
  const GUARANTEED_MIN_OWNED = { s1: 3, c16: 3 };
  let backfilled = false;
  for (const [id, min] of Object.entries(GUARANTEED_MIN_OWNED)) {
    if (!rec[id] || rec[id] < min) {
      rec[id] = min;
      backfilled = true;
    }
  }
  if (backfilled) {
    db.data.ownedCards[username] = rec;
    db.write();
  }
  return rec;
}

// ---------- Shop ----------
// The daily card lists reset at 00:00 UTC — every account's shop tabs
// regenerate the first time they're read after the UTC calendar day has
// rolled over (see getShopState below), so this needs no separate cron
// job: whichever request happens to be the first one after midnight UTC
// triggers the regeneration for that account, transparently.
function utcDateString(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d || new Date());
}

const SHOP_TABS = ['gold', 'dust', 'crystals'];
const SHOP_LIST_SIZE = 6;
const SHOP_REFRESH_COST = 12; // crystals — same cost regardless of which tab is being refreshed

function regenerateShopTab(username, tab) {
  const pool = engine.shoppableCards();
  const cardIds = engine.pickRandomShopCards(pool, SHOP_LIST_SIZE);
  if (!db.data.shop[username]) db.data.shop[username] = {};
  db.data.shop[username][tab] = { day: utcDateString(), cardIds };
}

// Ensures all three tabs have a list generated for "today" (UTC date) —
// lazily regenerating any that are missing or stale from a previous day,
// exactly once per day per account, with no separate cron/scheduler
// needed. Same account, same day => same list every time this is called.
function getShopState(username) {
  if (!db.data.shop[username]) db.data.shop[username] = {};
  const rec = db.data.shop[username];
  const today = utcDateString();
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
// Counts one completed PVE match toward the human player's progress
// (only WINS advance the bar — losses don't), and pays a per-match
// reward regardless of outcome:
//   win  -> 20 gold + 20 dust
//   lose -> 10 gold (no dust)
// On top of that, a win that fills the bar also grants the ladder tier's
// gold reward (same schedule as before — gold only, no dust, unlike
// PVP's tier reward). Returns a { [username]: {...} } summary matching
// applyPvpRewards' shape, so the caller can embed it in that specific
// player's resolution message the same way.
function applyPveProgress(match) {
  const username = match.players.find((p) => p !== match.aiName);
  if (!username) return null;
  const won = match.winner === username;
  const stats = db.data.pveStats[username] || (db.data.pveStats[username] = { played: 0, won: 0 });
  stats.played += 1;
  if (won) stats.won += 1;
  const resources = getResources(username);
  const matchGold = won ? 20 : 10;
  const matchDust = won ? 20 : 0;
  resources.gold = (resources.gold || 0) + matchGold;
  resources.dust = (resources.dust || 0) + matchDust;
  let tierGold = 0;
  const tierDust = 0; // PVE's ladder tier reward is gold-only, unlike PVP's
  let tierCompleted = false;
  if (won) {
    const progress = getPveProgress(username);
    progress.matchesPlayed = (progress.matchesPlayed || 0) + 1;
    const info = pveIterationInfo(progress.iteration);
    if (progress.matchesPlayed >= info.required) {
      tierGold = info.reward;
      resources.gold += tierGold;
      progress.iteration += 1;
      progress.matchesPlayed = 0;
      tierCompleted = true;
    }
  }
  db.write();
  return { [username]: { matchGold, matchDust, tierGold, tierDust, tierCompleted } };
}

// ---------- PVP progress ladder ----------
// Same shape as the PVE screen, tracked completely separately
// (db.data.pvpProgress) — but PVP has its own reward rules on top:
//  - every PLAYED match pays out immediately, win or lose:
//      win  -> 30 gold + 30 dust
//      lose -> 20 gold (no dust)
//  - the progress bar itself only advances on wins (same rule as PVE),
//    using the exact same required-matches/gold schedule as PVE
//    (pveIterationInfo) — except the tier reward pays that amount in
//    BOTH gold and dust, not gold alone.
function getPvpProgress(username) {
  let rec = db.data.pvpProgress[username];
  if (!rec) {
    rec = { iteration: 1, matchesPlayed: 0 };
    db.data.pvpProgress[username] = rec;
    db.write();
  }
  return rec;
}

// Pays out per-match PVP rewards and, on a win, advances the PVP ladder
// (granting a tier reward if that fills the bar). Returns a per-username
// summary of exactly what was paid out, so the caller can hand it back
// to that specific player's client for the post-match reward display.
// Skips `match.botStandIn` (a real account's identity borrowed to cover
// a missing opponent) — that account never actually played, so it's
// never rewarded.
function applyPvpRewards(match) {
  const rewards = {};
  for (const username of match.players) {
    if (username === match.botStandIn) continue;
    const won = match.winner === username;
    const stats = db.data.pvpStats[username] || (db.data.pvpStats[username] = { played: 0, won: 0 });
    stats.played += 1;
    if (won) stats.won += 1;
    const resources = getResources(username);
    const matchGold = won ? 30 : 20;
    const matchDust = won ? 30 : 0;
    resources.gold = (resources.gold || 0) + matchGold;
    resources.dust = (resources.dust || 0) + matchDust;
    let tierGold = 0;
    let tierDust = 0;
    let tierCompleted = false;
    if (won) {
      const progress = getPvpProgress(username);
      progress.matchesPlayed = (progress.matchesPlayed || 0) + 1;
      const info = pveIterationInfo(progress.iteration);
      if (progress.matchesPlayed >= info.required) {
        tierGold = info.reward;
        tierDust = info.reward;
        resources.gold += tierGold;
        resources.dust += tierDust;
        progress.iteration += 1;
        progress.matchesPlayed = 0;
        tierCompleted = true;
      }
    }
    rewards[username] = { matchGold, matchDust, tierGold, tierDust, tierCompleted };
  }
  db.write();
  return rewards;
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

function getDecks(username) {
  let rec = db.data.decks[username];
  if (!rec) {
    rec = [{ id: 'basic', name: '\u0411\u0430\u0437\u043e\u0432\u0430\u044f \u043a\u043e\u043b\u043e\u0434\u0430', counts: engine.defaultDeckCounts() }];
    db.data.decks[username] = rec;
    db.write();
    return rec;
  }
  if (!Array.isArray(rec)) {
    // One-time migration for accounts created before multiple decks
    // existed, back when db.data.decks[username] was just a single
    // counts object. Wraps that deck as "Базовая колода" — and, since
    // those accounts could carry inconsistent/partial ownership from
    // earlier iterations of the shop, grants a clean baseline of exactly
    // 3 copies of every non-starter card, so "Доступные карты" has
    // something consistent to show right away.
    const migrated = { id: 'basic', name: '\u0411\u0430\u0437\u043e\u0432\u0430\u044f \u043a\u043e\u043b\u043e\u0434\u0430', counts: rec };
    rec = [migrated];
    db.data.decks[username] = rec;
    const owned = getOwnedCounts(username);
    const starterIds = new Set(Object.keys(engine.defaultDeckCounts()));
    engine.CARD_POOL.forEach((c) => {
      if (!starterIds.has(c.id)) owned[c.id] = 3;
    });
    db.write();
  }
  return rec;
}

function findDeck(decks, id) {
  return decks.find((d) => d.id === id);
}

// "Колода 2", "Колода 3", ... — picks the first name not already in use,
// so it stays unique even if decks are ever deleted/renamed later.
function nextDeckName(decks) {
  const names = new Set(decks.map((d) => d.name));
  let n = decks.length + 1;
  while (names.has(`\u041a\u043e\u043b\u043e\u0434\u0430 ${n}`)) n++;
  return `\u041a\u043e\u043b\u043e\u0434\u0430 ${n}`;
}

function makeDeckId() {
  return 'deck_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Which deck a match is actually played with. Defaults to "Базовая
// колода" until the player has explicitly picked a different one (see
// POST /api/decks/set-active) — covers both brand-new accounts and ones
// that existed before this concept did.
function getActiveDeckId(username) {
  return db.data.activeDeck[username] || 'basic';
}

function getDeckCounts(username) {
  const decks = getDecks(username);
  const active = findDeck(decks, getActiveDeckId(username)) || findDeck(decks, 'basic');
  return (active && active.counts) || engine.defaultDeckCounts();
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
  // Every new account starts with a full 30-card starter deck already
  // saved as "Базовая колода" — the first entry in what's now an array
  // of decks (multiple decks per account).
  db.data.decks[name] = [{ id: 'basic', name: '\u0411\u0430\u0437\u043e\u0432\u0430\u044f \u043a\u043e\u043b\u043e\u0434\u0430', counts: engine.defaultDeckCounts() }];
  db.data.activeDeck[name] = 'basic';
  db.data.tournament[name] = { league: 'squire', stars: 0, progress: 0, streak: 0, kingPoints: 0 };
  db.data.resources[name] = { dust: 0, gold: 0, crystals: 0 };
  db.data.pveProgress[name] = { iteration: 1, matchesPlayed: 0 };
  db.data.pvpProgress[name] = { iteration: 1, matchesPlayed: 0 };
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
// All of this account's decks (id, name, and card counts each).
app.get('/api/decks', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  res.json({ decks: getDecks(username), activeDeckId: getActiveDeckId(username) });
});

// Marks one of the account's decks as the one matches are actually
// played with (PVE/PVP/tournament alike) — takes effect immediately.
app.post('/api/decks/set-active', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const { id } = req.body || {};
  const decks = getDecks(username);
  if (!findDeck(decks, id)) return res.status(404).json({ error: '\u041a\u043e\u043b\u043e\u0434\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
  db.data.activeDeck[username] = id;
  db.write();
  res.json({ ok: true, activeDeckId: id });
});

// Creates a new, empty deck (auto-named "Колода N") the player can then
// build out. There's no limit on how many decks an account can have.
app.post('/api/decks/create', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const decks = getDecks(username);
  const deck = { id: makeDeckId(), name: nextDeckName(decks), counts: {} };
  decks.push(deck);
  db.write();
  res.json({ deck });
});

// Saves one specific deck's card counts (identified by id — every
// account can have several decks now). Same ownership/rarity/legendary
// cap and 30-card validation as before, just scoped to the one deck.
app.post('/api/decks/save', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const { id, counts } = req.body || {};
  const decks = getDecks(username);
  const deck = findDeck(decks, id);
  if (!deck) return res.status(404).json({ error: '\u041a\u043e\u043b\u043e\u0434\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
  const owned = getOwnedCounts(username);
  const clean = {};
  let total = 0;
  for (const cardId of Object.keys(counts || {})) {
    const card = engine.cardById(cardId);
    if (!card) continue;
    if (!(owned[cardId] > 0)) continue; // not owned (0 copies) — can't go in a deck
    const n = Math.max(0, Math.min(engine.deckSlotCapForCard(card, owned[cardId]), Math.floor(Number(counts[cardId]) || 0)));
    if (n > 0) clean[cardId] = n;
    total += n;
  }
  if (total > 30) return res.status(400).json({ error: '\u0412 \u043a\u043e\u043b\u043e\u0434\u0435 \u043d\u0435 \u043c\u043e\u0436\u0435\u0442 \u0431\u044b\u0442\u044c \u0431\u043e\u043b\u044c\u0448\u0435 30 \u043a\u0430\u0440\u0442.' });
  deck.counts = clean;
  db.write();
  res.json({ ok: true });
});

// Renames one of the account's decks. Any deck can be renamed, including
// "Базовая колода" — it's just a label, nothing else depends on it.
app.post('/api/decks/rename', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const { id, name } = req.body || {};
  const decks = getDecks(username);
  const deck = findDeck(decks, id);
  if (!deck) return res.status(404).json({ error: '\u041a\u043e\u043b\u043e\u0434\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
  const trimmed = String(name || '').trim().slice(0, 40);
  if (!trimmed) return res.status(400).json({ error: '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u0430\u0437\u0432\u0430\u043d\u0438\u0435.' });
  deck.name = trimmed;
  db.write();
  res.json({ ok: true, deck });
});

// Deletes one of the account's decks. An account must always keep at
// least one deck, so the very last one can't be removed — the player
// would have nothing left to play a match with. Deleting the currently
// active deck falls back to whichever deck is now first in the list.
app.post('/api/decks/delete', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const { id } = req.body || {};
  const decks = getDecks(username);
  const deck = findDeck(decks, id);
  if (!deck) return res.status(404).json({ error: '\u041a\u043e\u043b\u043e\u0434\u0430 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
  if (decks.length <= 1) return res.status(400).json({ error: '\u041d\u0435\u043b\u044c\u0437\u044f \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u0435\u0434\u0438\u043d\u0441\u0442\u0432\u0435\u043d\u043d\u0443\u044e \u043a\u043e\u043b\u043e\u0434\u0443.' });
  const idx = decks.findIndex((d) => d.id === id);
  decks.splice(idx, 1);
  let activeDeckId = getActiveDeckId(username);
  if (activeDeckId === id) {
    activeDeckId = decks[0].id;
    db.data.activeDeck[username] = activeDeckId;
  }
  db.write();
  res.json({ ok: true, decks, activeDeckId });
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
// tab that's stale from a previous UTC calendar day.
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

// TEMPORARY — dev/test helper only, remove after use. Only ever acts on
// the account literally named "admin" (checked against its own session
// token, not settable for any other account), setting its resources to
// a large fixed amount so it can be used for testing without running
// into resource limits. Not a general "give myself resources" endpoint.
app.post('/api/admin/grant-test-resources', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  if (username !== 'admin') return res.status(403).json({ error: '\u0417\u0430\u043f\u0440\u0435\u0449\u0435\u043d\u043e.' });
  const resources = getResources(username);
  resources.gold = 999999;
  resources.dust = 999999;
  resources.crystals = 999999;
  db.write();
  res.json({ ok: true, resources });
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

// Same shape as /api/pve-progress, but for the PVP ladder — the tier
// reward pays out in gold AND dust (equal amounts), unlike PVE's
// gold-only tier reward, so both are included here.
app.get('/api/pvp-progress', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const progress = getPvpProgress(username);
  const info = pveIterationInfo(progress.iteration);
  res.json({
    iteration: progress.iteration,
    matchesPlayed: progress.matchesPlayed,
    matchesRequired: info.required,
    rewardGold: info.reward,
    rewardDust: info.reward,
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

// ---------- Leaderboards ----------
// Shared cap so no single leaderboard response can grow unbounded as the
// player base grows — highest-ranked entries first, so truncating here
// just drops the bottom of the table, never the top.
const LEADERBOARD_LIMIT = 100;

// PVE/PVP: ranked by total wins ever in that mode. Eligibility is having
// played at least one match in it (ever) — not having won one; a 0-win
// account that's actually played still appears, just at the bottom.
// PVE/PVP: ranked by total wins ever in that mode. Eligibility is having
// WON at least one match in it (ever) — merely having played isn't
// enough, so a 0-win account never appears at all.
app.get('/api/leaderboard/pve', (req, res) => {
  if (!usernameFromRequest(req)) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const entries = Object.entries(db.data.pveStats)
    .filter(([, s]) => s.won > 0)
    .map(([username, s]) => ({ username, wins: s.won }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, LEADERBOARD_LIMIT);
  res.json({ entries });
});

app.get('/api/leaderboard/pvp', (req, res) => {
  if (!usernameFromRequest(req)) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const entries = Object.entries(db.data.pvpStats)
    .filter(([, s]) => s.won > 0)
    .map(([username, s]) => ({ username, wins: s.won }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, LEADERBOARD_LIMIT);
  res.json({ entries });
});

// Tournament: ranked by tournamentTotalPoints() (see its own comment for
// how league+stars+progress+kingPoints combine into one number).
// Eligibility is scoring above 0 — a fresh Оруженосец (0 stars, 0
// progress) scores exactly 0 and is excluded, matching the spec exactly.
app.get('/api/leaderboard/tournament', (req, res) => {
  if (!usernameFromRequest(req)) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const entries = Object.entries(db.data.tournament)
    .map(([username, record]) => ({
      username,
      league: record.league,
      stars: record.stars || 0,
      points: tournamentTotalPoints(record),
    }))
    .filter((e) => e.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, LEADERBOARD_LIMIT);
  res.json({ entries });
});

// Treasure Race: the single shared board (see contributeToTreasureRaceBoard)
// always reflects whichever window most recently finished — it's rebuilt
// from scratch the moment a later window's data first arrives. Calling
// getTreasureRaceRecord for the requesting account first ensures their
// own just-finished run (if any) is already folded in before we read the
// board, rather than possibly missing by one request.
app.get('/api/leaderboard/treasure-race', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  getTreasureRaceRecord(username); // side effect: folds this account's own finished run into the board if due
  const board = db.data.treasureRaceBoard;
  const entries = Object.entries(board.entries || {})
    .map(([u, wins]) => ({ username: u, wins }))
    .filter((e) => e.wins > 0)
    .sort((a, b) => b.wins - a.wins)
    .slice(0, LEADERBOARD_LIMIT);
  res.json({ entries, windowKey: board.windowKey || null });
});

// Current Treasure Race status for the logged-in account: whether the
// mode is open right now, this run's progress along the 13-node ladder,
// remaining lives, gold banked so far, and whether there's a finished
// run sitting unclaimed (rewardPending) — the client shows the "Ваша
// награда..." notification exactly when rewardPending is true, and only
// that notification's own acknowledgement (POST .../claim) actually
// credits the gold to the account's real balance.
app.get('/api/treasure-race', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const now = new Date();
  const win = currentTreasureRaceWindow(now);
  const rec = getTreasureRaceRecord(username);
  res.json({
    windowOpen: !!win,
    windowEndsAt: win ? new Date(win.endMs).toISOString() : null,
    nextWindowStart: new Date(nextTreasureRaceWindowStart(now)).toISOString(),
    wins: rec ? rec.wins : 0,
    lives: rec ? rec.lives : 3,
    gold: rec ? rec.gold : 0,
    status: rec ? rec.status : 'active',
    rewardPending: !!(rec && rec.status !== 'active' && !rec.claimed),
  });
});

// Banks a finished run's pending gold into the account's real balance.
// A no-op (not an error) if there's nothing to claim right now — makes
// this safe for the client to call speculatively without first checking
// rewardPending itself.
app.post('/api/treasure-race/claim', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: '\u041d\u0435 \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u043e\u0432\u0430\u043d.' });
  const rec = db.data.treasureRace[username];
  if (!rec || rec.status === 'active' || rec.claimed) {
    return res.json({ ok: true, credited: 0 });
  }
  const resources = getResources(username);
  resources.gold = (resources.gold || 0) + rec.gold;
  const credited = rec.gold;
  rec.claimed = true;
  db.write();
  res.json({ ok: true, credited, resources });
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
const treasureRaceQueues = [[], [], [], []]; // one FIFO queue per bucket (0-3, 4-6, 7-9, 10-12 wins)
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

function removeFromTreasureRaceQueues(ws) {
  for (const q of treasureRaceQueues) {
    const idx = q.findIndex((w) => w.ws === ws);
    if (idx !== -1) {
      clearTimeout(q[idx].timeout);
      q.splice(idx, 1);
    }
  }
}

// A tournament match against a real opponent is presented to the client
// exactly like ordinary PVP — 'mode: pvp' — since from the human player's
// side there is nothing different about it.
function startTournamentMatch(nameA, wsA, nameB, wsB) {
  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, nameA, getDeckCounts(nameA), nameB, getDeckCounts(nameB));
  match.isTournament = true;
  match.rewardMode = 'tournament';
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
  match.rewardMode = 'pvp'; // the human still experiences and is rewarded as PVP — only the AI-fill mechanics are borrowed from PVE
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

// Same idea as startTournamentMatch — a real-opponent Treasure Race
// match is just ordinary PVP from the client's point of view.
function startTreasureRaceMatch(nameA, wsA, nameB, wsB) {
  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, nameA, getDeckCounts(nameA), nameB, getDeckCounts(nameB));
  match.isTreasureRace = true;
  match.rewardMode = 'treasureRace';
  const mm = { match, sockets: { [nameA]: wsA, [nameB]: wsB } };
  liveMatches.set(matchId, mm);
  persistMatch(mm);
  safeSend(wsA, { type: 'match_found', matchId, opponent: nameB, mode: 'pvp' });
  safeSend(wsB, { type: 'match_found', matchId, opponent: nameA, mode: 'pvp' });
  sendSnapshots(mm);
}

// No real opponent queued up in time — borrow a real account's deck
// (preferring one currently in the same win-bucket, same "same league
// first" spirit as the tournament fallback) and quietly drive that side
// with the same bot AI used for plain PVE. If literally no other
// account exists to borrow from, fall back to a fully random deck under
// the generic "Охотник за сокровищами" name instead of failing.
function startTreasureRaceBotMatch(myName, ws, bucket) {
  const sameBucket = db.data.users
    .map((u) => u.username)
    .filter((u) => {
      if (u === myName) return false;
      const rec = db.data.treasureRace[u];
      return rec && rec.status === 'active' && treasureRaceBucket(rec.wins) === bucket;
    });
  const anyOther = db.data.users.map((u) => u.username).filter((u) => u !== myName);

  let botName, botDeck;
  if (sameBucket.length > 0) {
    botName = sameBucket[Math.floor(Math.random() * sameBucket.length)];
    botDeck = getDeckCounts(botName);
  } else if (anyOther.length > 0) {
    botName = anyOther[Math.floor(Math.random() * anyOther.length)];
    botDeck = getDeckCounts(botName);
  } else {
    botName = TREASURE_RACE_HUNTER_NAME;
    botDeck = buildRandomTreasureHunterDeck();
  }

  const matchId = crypto.randomBytes(8).toString('hex');
  const match = engine.createMatch(matchId, myName, getDeckCounts(myName), botName, botDeck);
  match.isTreasureRace = true;
  match.isPve = true; // reuses the existing "server auto-plays this side" turn logic
  match.rewardMode = 'treasureRace';
  match.aiName = botName;
  match.botStandIn = botName; // borrowed (or synthetic) identity — never a real participant
  const mm = { match, sockets: { [myName]: ws } };
  liveMatches.set(matchId, mm);
  persistMatch(mm);
  safeSend(ws, { type: 'match_found', matchId, opponent: botName, mode: 'pvp' });
  sendSnapshots(mm);
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
  match.rewardMode = 'tournament';
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
  removeFromTreasureRaceQueues(ws);
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
        match.rewardMode = 'pvp';
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
      match.rewardMode = 'pve';
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

    // ---- Treasure Race matchmaking ----
    if (msg.type === 'start_treasure_race_search') {
      removeFromTreasureRaceQueues(ws);
      const myName = String(msg.username || '\u0418\u0433\u0440\u043e\u043a').slice(0, 20);
      if (!currentTreasureRaceWindow()) { safeSend(ws, { type: 'treasure_race_closed' }); return; }
      const rec = getTreasureRaceRecord(myName);
      const bucket = rec ? treasureRaceBucket(rec.wins) : -1;
      if (!rec || rec.status !== 'active' || bucket === -1) { safeSend(ws, { type: 'treasure_race_closed' }); return; }
      const queue = treasureRaceQueues[bucket];
      if (queue.length > 0) {
        const opponent = queue.shift();
        clearTimeout(opponent.timeout);
        startTreasureRaceMatch(myName, ws, opponent.username, opponent.ws);
      } else {
        const waitMs = randomPvpBotWaitMs();
        const entry = { ws, username: myName };
        entry.timeout = setTimeout(() => {
          const idx = queue.indexOf(entry);
          if (idx === -1) return; // matched with a real opponent in the meantime
          queue.splice(idx, 1);
          startTreasureRaceBotMatch(myName, ws, bucket);
        }, waitMs);
        queue.push(entry);
        safeSend(ws, { type: 'searching' });
      }
      return;
    }

    if (msg.type === 'cancel_treasure_race_search') {
      removeFromTreasureRaceQueues(ws);
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
      // Rewards (if any) are computed BEFORE sending the resolution
      // messages below, so each side's own reward can be embedded
      // directly in the message the client uses to show the post-match
      // overlay — no separate round-trip needed for that.
      let pvpRewards = null;
      let pveRewards = null;
      if (result.gameOver) {
        endMatch(mm, 'finished', result.winner);
        if (mm.match.isTournament) applyTournamentResult(mm.match);
        if (mm.match.isTreasureRace) applyTreasureRaceResult(mm.match);
        if (mm.match.rewardMode === 'pve') pveRewards = applyPveProgress(mm.match);
        if (mm.match.rewardMode === 'pvp') pvpRewards = applyPvpRewards(mm.match);
      }
      // Both players were ready — resolution just ran synchronously inside
      // tryEndTurn(). Send each side: the pre-resolution board (so the
      // client can reveal what was actually placed first), the event log
      // (for spell/combat animation), and the settled final snapshot.
      for (const username of mm.match.players) {
        const other = engine.otherPlayer(mm.match, username);
        const payload = {
          type: 'resolution',
          preBoard: { myBoard: result.preBoards[username], opponentBoard: result.preBoards[other] },
          events: result.events,
          state: engine.snapshotFor(mm.match, username),
        };
        if (pvpRewards && pvpRewards[username]) payload.reward = pvpRewards[username];
        if (pveRewards && pveRewards[username]) payload.reward = pveRewards[username];
        safeSend(mm.sockets[username], payload);
      }
      persistMatch(mm);
      return;
    }

    if (msg.type === 'leave_match' && msg.matchId && msg.username) {
      const mm = liveMatches.get(msg.matchId);
      if (mm) {
        const otherName = engine.otherPlayer(mm.match, msg.username);
        safeSend(mm.sockets[otherName], { type: 'opponent_left' });
        endMatch(mm, 'abandoned', otherName);
        if (mm.match.isTournament) applyTournamentResult(mm.match);
        if (mm.match.isTreasureRace) applyTreasureRaceResult(mm.match);
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
