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
const db = new LowSync(adapter, { users: [], decks: {}, matches: [] });
db.read();
db.data ||= { users: [], decks: {}, matches: [] };
db.data.decks ||= {};
db.data.matches ||= [];
db.write();

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

// Deck is tied to the account, not local storage, because the server
// needs it to build a real draw pile when a PVP match starts.
app.get('/api/deck', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: 'Не авторизован.' });
  res.json({ counts: getDeckCounts(username) });
});

app.post('/api/deck', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: 'Не авторизован.' });
  const counts = (req.body && req.body.counts) || {};
  const clean = {};
  let total = 0;
  for (const id of Object.keys(counts)) {
    if (!engine.cardById(id)) continue;
    const n = Math.max(0, Math.min(4, Math.floor(Number(counts[id]) || 0)));
    if (n > 0) clean[id] = n;
    total += n;
  }
  if (total > 30) return res.status(400).json({ error: 'В колоде не может быть больше 30 карт.' });
  db.data.decks[username] = clean;
  db.write();
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

// ---------- PVP: live authoritative matches + matchmaking ----------
// `liveMatches` holds the real, in-memory, authoritative engine.Match
// objects (see game-engine.js) plus the two players' live sockets.
// `db.data.matches` holds a durable, JSON-safe snapshot of the same data
// for resume-after-restart — written on every state-changing action.
const waitingQueue = []; // { ws, username }
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
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

// Detach a disconnected socket from any live match without ending it —
// the match (and its full hidden state) stays in memory + db so the
// player can reconnect via 'resume_match'.
function handleSocketDisconnect(ws) {
  removeFromQueue(ws);
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

    // ---- Matchmaking ----
    if (msg.type === 'find_match') {
      removeFromQueue(ws);
      const myName = String(msg.username || 'Игрок').slice(0, 20);
      if (waitingQueue.length > 0) {
        const opponent = waitingQueue.shift();
        const matchId = crypto.randomBytes(8).toString('hex');
        const match = engine.createMatch(
          matchId,
          myName, getDeckCounts(myName),
          opponent.username, getDeckCounts(opponent.username)
        );
        const mm = { match, sockets: { [myName]: ws, [opponent.username]: opponent.ws } };
        liveMatches.set(matchId, mm);
        persistMatch(mm);
        safeSend(ws, { type: 'match_found', matchId, opponent: opponent.username });
        safeSend(opponent.ws, { type: 'match_found', matchId, opponent: myName });
        sendSnapshots(mm);
      } else {
        waitingQueue.push({ ws, username: myName });
        safeSend(ws, { type: 'searching' });
      }
      return;
    }

    if (msg.type === 'cancel_search') {
      removeFromQueue(ws);
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
      const result = engine.tryEndTurn(mm.match, msg.username);
      if (!result.ready) {
        persistMatch(mm);
        sendSnapshots(mm); // just marks this player as "ready", opponent still placing
        return;
      }
      // Both players were ready — resolution just ran synchronously inside
      // tryEndTurn(). Send the event log (for animation) + fresh per-player
      // snapshots (for the settled state) to both sides.
      for (const username of mm.match.players) {
        safeSend(mm.sockets[username], {
          type: 'resolution',
          events: result.events,
          state: engine.snapshotFor(mm.match, username),
        });
      }
      persistMatch(mm);
      if (result.gameOver) endMatch(mm, 'finished', result.winner);
      return;
    }

    if (msg.type === 'leave_match' && msg.matchId && msg.username) {
      const mm = liveMatches.get(msg.matchId);
      if (mm) {
        const otherName = engine.otherPlayer(mm.match, msg.username);
        safeSend(mm.sockets[otherName], { type: 'opponent_left' });
        endMatch(mm, 'abandoned', otherName);
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
