// Fist Duel — game server
//
// Two things live here on one process/port:
//  1) A WebSocket presence counter (unchanged from before) — counts open
//     tabs and broadcasts the number.
//  2) A real HTTP API for registration/login, backed by a real database
//     file on disk (lowdb — a small JSON-file database; no native
//     compilation needed, so it deploys cleanly on free hosts).
//
// Passwords are never stored in plain text — they're hashed with bcrypt
// before being written to the database.
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

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || 'db.json';

// ---------- Database ----------
const adapter = new JSONFileSync(DB_PATH);
const db = new LowSync(adapter, { users: [], matches: [] });
db.read();
db.data ||= { users: [], matches: [] };
db.data.matches ||= [];
db.write();

function findUser(username) {
  return db.data.users.find(
    (u) => u.username.toLowerCase() === String(username).toLowerCase()
  );
}

// In-memory session store: token -> username.
// (Simple and fine for a small game server; sessions reset if the
// process restarts, which just means players log in again.)
const sessions = new Map();
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
function usernameFromRequest(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return token ? sessions.get(token) : null;
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
    return res.status(400).json({ error: 'Имя игрока — от 3 до 20 символов.' });
  }
  if (pass.length < 4) {
    return res.status(400).json({ error: 'Пароль — минимум 4 символа.' });
  }
  if (findUser(name)) {
    return res.status(409).json({ error: 'Это имя уже занято.' });
  }

  const passwordHash = bcrypt.hashSync(pass, 10);
  db.data.users.push({
    username: name,
    passwordHash,
    createdAt: new Date().toISOString(),
  });
  db.write();

  res.status(201).json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const name = typeof username === 'string' ? username.trim() : '';
  const pass = typeof password === 'string' ? password : '';

  const user = findUser(name);
  if (!user || !bcrypt.compareSync(pass, user.passwordHash)) {
    return res.status(401).json({ error: 'Неверное имя игрока или пароль.' });
  }

  const token = makeToken();
  sessions.set(token, user.username);
  res.json({ ok: true, token, username: user.username });
});

app.get('/api/me', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: 'Не авторизован.' });
  res.json({ username });
});

app.post('/api/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/matches/:matchId', (req, res) => {
  const record = db.data.matches.find((m) => m.matchId === req.params.matchId);
  if (!record) return res.status(404).json({ error: 'Матч не найден.' });
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

// ---------- Card stats mirror (for validating incoming turns) ----------
// Keep this in sync with the client's POOL in fist-duel.html. Only the
// fields needed to validate a submitted board/spell are duplicated here —
// the server still doesn't run combat, it just checks that what a client
// claims to have played is actually legal (a real card, real stats,
// affordable with that round's mana).
const CARD_POOL = [
  { name: 'Забияка', cost: 1, atk: 1, hp: 2 },
  { name: 'Щитоносец', cost: 2, atk: 1, hp: 5 },
  { name: 'Костолом', cost: 2, atk: 3, hp: 2 },
  { name: 'Наёмник', cost: 3, atk: 3, hp: 3 },
  { name: 'Ветеран Ямы', cost: 3, atk: 2, hp: 6 },
  { name: 'Берсерк', cost: 4, atk: 6, hp: 2 },
  { name: 'Каменная Стена', cost: 4, atk: 2, hp: 9 },
  { name: 'Чемпион Ринга', cost: 5, atk: 5, hp: 6 },
  { name: 'Тяжеловес', cost: 6, atk: 7, hp: 8 },
];
const SPELL_POOL = [
  { name: 'Удар в челюсть', cost: 2, dmg: 3 },
  { name: 'Прямой в корпус', cost: 4, dmg: 5 },
  { name: 'Перевязка', cost: 2, heal: 4 },
];

function findCardByName(name) {
  return CARD_POOL.find((c) => c.name === name);
}
function findSpellByName(name) {
  return SPELL_POOL.find((c) => c.name === name);
}
function maxManaForRound(round) {
  return Math.min(2 + Math.max(0, round - 1), 10);
}
function isValidBoardShape(b) {
  return Array.isArray(b) && b.length === 3 && b.every((lane) => Array.isArray(lane) && lane.length === 2);
}

// Checks a submitted turn against the match's last known state for that
// player. Returns null if it's legal, or a human-readable reason if not.
// Newly-appeared units (weren't in the same lane/slot last time) must be
// real cards played within that round's mana budget; units that already
// existed just get their current HP sanity-checked (can go down from
// combat, or up from a heal, but never above their own max HP).
function validateTurn(record, username, payload) {
  const board = payload && payload.board;
  const spells = (payload && payload.spells) || [];
  if (!isValidBoardShape(board)) return 'Некорректная форма доски.';

  const prevBoard = record.boards[username] || emptyBoard();
  let spent = 0;

  for (let l = 0; l < 3; l++) {
    for (let d = 0; d < 2; d++) {
      const unit = board[l][d];
      if (!unit) continue;
      if (typeof unit.name !== 'string' || typeof unit.atk !== 'number' || typeof unit.hp !== 'number') {
        return 'Некорректные данные юнита.';
      }
      const card = findCardByName(unit.name);
      if (!card) return `Неизвестная карта: ${unit.name}`;
      if (unit.atk !== card.atk) return `Некорректная атака у ${unit.name}.`;
      if (unit.hp < 1 || unit.hp > card.hp) return `Некорректное HP у ${unit.name}.`;

      const prevUnit = prevBoard[l] && prevBoard[l][d];
      const isSameUnit = prevUnit && prevUnit.name === unit.name;
      if (!isSameUnit) spent += card.cost; // a freshly placed card this round
    }
  }

  for (const sp of spells) {
    if (!sp || typeof sp.name !== 'string') return 'Некорректное заклинание.';
    const card = findSpellByName(sp.name);
    if (!card) return `Неизвестное заклинание: ${sp.name}`;
    spent += card.cost;
  }

  const allowed = maxManaForRound(record.round) + Math.max(0, Math.min(7, Math.floor(Number(payload && payload.sacrifices) || 0)));
  if (spent > allowed) return `Потрачено ${spent} маны при лимите ${allowed} в этом раунде.`;
  return null;
}

// ---------- PVP matchmaking + persisted match state ----------
// Each match's game state (round, HP, last known board for each player) is
// written to the same database file as user accounts, under db.data.matches.
// The server still doesn't referee the game itself — clients run the same
// deterministic engine and report their results back — but the state is
// now durable: if the process restarts, or a player refreshes the page,
// the match can be looked up and resumed instead of being lost.
const waitingQueue = []; // { ws, username }
const activeMatches = new Map(); // matchId -> { usernames:[a,b], sockets:{ [username]: ws } }

function findMatchRecord(matchId) {
  return db.data.matches.find((m) => m.matchId === matchId);
}

function upsertMatchRecord(record) {
  const idx = db.data.matches.findIndex((m) => m.matchId === record.matchId);
  if (idx === -1) db.data.matches.push(record);
  else db.data.matches[idx] = record;
  db.write();
}

function emptyBoard() {
  // Mirrors the client's freshBoard(): 3 lanes, each [front, back] = [null, null].
  return [[null, null], [null, null], [null, null]];
}

function createMatchRecord(matchId, nameA, nameB) {
  const now = new Date().toISOString();
  const record = {
    matchId,
    players: [nameA, nameB],
    round: 1,
    hp: { [nameA]: 30, [nameB]: 30 },
    boards: { [nameA]: emptyBoard(), [nameB]: emptyBoard() },
    status: 'active', // active | finished | abandoned
    winner: null,
    startedAt: now,
    updatedAt: now,
  };
  upsertMatchRecord(record);
  return record;
}

function removeFromQueue(ws) {
  const idx = waitingQueue.findIndex((w) => w.ws === ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

// Detach a disconnected socket from any match it was part of, without
// ending the match — the stored state stays put so the player can
// reconnect via 'resume_match'. The opponent just gets a soft notice.
function handleSocketDisconnect(ws) {
  removeFromQueue(ws);
  for (const [matchId, mm] of activeMatches) {
    for (const username of Object.keys(mm.sockets)) {
      if (mm.sockets[username] === ws) {
        delete mm.sockets[username];
        const otherName = mm.usernames.find((n) => n !== username);
        const oppWs = mm.sockets[otherName];
        safeSend(oppWs, { type: 'opponent_disconnected' });
      }
    }
  }
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

    if (msg.type === 'find_match') {
      removeFromQueue(ws); // avoid double-queueing the same socket
      if (waitingQueue.length > 0) {
        const opponent = waitingQueue.shift();
        const matchId = crypto.randomBytes(8).toString('hex');
        const myName = String(msg.username || 'Игрок').slice(0, 20);
        activeMatches.set(matchId, {
          usernames: [myName, opponent.username],
          sockets: { [myName]: ws, [opponent.username]: opponent.ws },
        });
        createMatchRecord(matchId, myName, opponent.username);
        safeSend(ws, { type: 'match_found', matchId, opponent: opponent.username });
        safeSend(opponent.ws, { type: 'match_found', matchId, opponent: myName });
      } else {
        waitingQueue.push({ ws, username: String(msg.username || 'Игрок').slice(0, 20) });
        safeSend(ws, { type: 'searching' });
      }
      return;
    }

    if (msg.type === 'cancel_search') {
      removeFromQueue(ws);
      return;
    }

    if (msg.type === 'turn_data' && msg.matchId && msg.username) {
      const mm = activeMatches.get(msg.matchId);
      if (!mm) return;
      const record = findMatchRecord(msg.matchId);
      if (record) {
        const reason = validateTurn(record, msg.username, msg.payload);
        if (reason) {
          safeSend(ws, { type: 'turn_rejected', reason });
          return; // don't relay or persist an illegal turn
        }
      }
      const otherName = mm.usernames.find((n) => n !== msg.username);
      safeSend(mm.sockets[otherName], { type: 'opponent_turn', payload: msg.payload });

      if (record) {
        record.boards[msg.username] = (msg.payload && msg.payload.board) || emptyBoard();
        record.updatedAt = new Date().toISOString();
        upsertMatchRecord(record);
      }
      return;
    }

    if (msg.type === 'state_sync' && msg.matchId && msg.username) {
      const mm = activeMatches.get(msg.matchId);
      const record = findMatchRecord(msg.matchId);
      if (!record) return;
      const otherName = mm
        ? mm.usernames.find((n) => n !== msg.username)
        : record.players.find((n) => n !== msg.username);
      const clampHp = (v) => Math.max(0, Math.min(30, v));
      record.round = msg.round || record.round;
      if (typeof msg.myHp === 'number') record.hp[msg.username] = clampHp(msg.myHp);
      if (typeof msg.opponentHp === 'number' && otherName) record.hp[otherName] = clampHp(msg.opponentHp);
      record.updatedAt = new Date().toISOString();
      upsertMatchRecord(record);
      return;
    }

    if (msg.type === 'match_over' && msg.matchId && msg.username) {
      const record = findMatchRecord(msg.matchId);
      if (record && record.status === 'active') {
        const otherName = record.players.find((n) => n !== msg.username);
        record.status = 'finished';
        record.winner = msg.result === 'win' ? msg.username : otherName;
        record.updatedAt = new Date().toISOString();
        upsertMatchRecord(record);
      }
      activeMatches.delete(msg.matchId);
      return;
    }

    if (msg.type === 'leave_match' && msg.matchId && msg.username) {
      const mm = activeMatches.get(msg.matchId);
      const record = findMatchRecord(msg.matchId);
      const otherName = mm
        ? mm.usernames.find((n) => n !== msg.username)
        : record && record.players.find((n) => n !== msg.username);
      if (mm) safeSend(mm.sockets[otherName], { type: 'opponent_left' });
      if (record && record.status === 'active') {
        record.status = 'abandoned';
        record.winner = otherName || null;
        record.updatedAt = new Date().toISOString();
        upsertMatchRecord(record);
      }
      activeMatches.delete(msg.matchId);
      return;
    }

    if (msg.type === 'resume_match' && msg.matchId && msg.username) {
      const record = findMatchRecord(msg.matchId);
      if (!record || record.status !== 'active' || !record.players.includes(msg.username)) {
        safeSend(ws, { type: 'resume_failed' });
        return;
      }
      let mm = activeMatches.get(msg.matchId);
      if (!mm) {
        mm = { usernames: record.players.slice(), sockets: {} };
        activeMatches.set(msg.matchId, mm);
      }
      mm.sockets[msg.username] = ws;
      const otherName = record.players.find((n) => n !== msg.username);
      safeSend(ws, {
        type: 'match_state',
        matchId: msg.matchId,
        round: record.round,
        myHp: record.hp[msg.username],
        opponentHp: record.hp[otherName],
        myBoard: record.boards[msg.username] || emptyBoard(),
        opponentBoard: record.boards[otherName] || emptyBoard(),
        opponentName: otherName,
      });
      // Let the opponent know this player is back, in case they were
      // waiting on an 'opponent_disconnected' notice.
      safeSend(mm.sockets[otherName], { type: 'opponent_reconnected' });
      return;
    }
  });

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
});
