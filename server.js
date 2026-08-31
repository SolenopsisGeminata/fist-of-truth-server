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
const db = new LowSync(adapter, { users: [] });
db.read();
db.data ||= { users: [] };
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

// ---------- PVP matchmaking + turn relay ----------
// Nothing fancy: a waiting list of one-at-a-time players, and a map of
// active matches (matchId -> [wsA, wsB]) used purely to relay each
// player's turn payload to their opponent. No game logic lives on the
// server — both clients run the same deterministic game engine and just
// exchange what they placed on their own board each round.
const waitingQueue = []; // { ws, username }
const activeMatches = new Map(); // matchId -> [ws, ws]

function otherSocketInMatch(matchId, ws) {
  const pair = activeMatches.get(matchId);
  if (!pair) return null;
  return pair[0] === ws ? pair[1] : pair[0];
}

function removeFromQueue(ws) {
  const idx = waitingQueue.findIndex((w) => w.ws === ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function leaveAnyActiveMatch(ws) {
  for (const [matchId, pair] of activeMatches) {
    if (pair.includes(ws)) {
      const opp = pair[0] === ws ? pair[1] : pair[0];
      safeSend(opp, { type: 'opponent_left' });
      activeMatches.delete(matchId);
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
        activeMatches.set(matchId, [ws, opponent.ws]);
        const myName = String(msg.username || 'Игрок').slice(0, 20);
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

    if (msg.type === 'turn_data' && msg.matchId) {
      const opp = otherSocketInMatch(msg.matchId, ws);
      if (opp) safeSend(opp, { type: 'opponent_turn', payload: msg.payload });
      return;
    }

    if (msg.type === 'leave_match' && msg.matchId) {
      const opp = otherSocketInMatch(msg.matchId, ws);
      if (opp) safeSend(opp, { type: 'opponent_left' });
      activeMatches.delete(msg.matchId);
      return;
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
    removeFromQueue(ws);
    leaveAnyActiveMatch(ws);
  });
  ws.on('error', () => {
    clearInterval(heartbeat);
    clients.delete(ws);
    broadcastCount();
    removeFromQueue(ws);
    leaveAnyActiveMatch(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Fist Duel server listening on port ${PORT}`);
});
