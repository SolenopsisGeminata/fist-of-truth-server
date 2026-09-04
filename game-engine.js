// Fist Duel — authoritative PVP game engine (server-side).
//
// This is the single source of truth for a PVP match: hands, decks, boards,
// mana, and the two-wave combat/spell resolution. The client for PVP mode
// sends only intents (place a card, cast a spell, sacrifice, end turn) and
// renders whatever snapshot this module produces — it does not compute
// outcomes itself.
//
// Card *stats* live here; card *art/flavor text* stays client-side and is
// looked up locally by `id`, so snapshots only need to carry ids + numbers.

export const LANES = 3;
export const DEPTH = 3;
export const START_HP = 30;
export const MAX_MANA = 10;
export const MAX_HAND = 7;

export const CARD_POOL = [
  { id: 'c1', name: 'Забияка', type: 'creature', cost: 1, atk: 1, hp: 2 },
  { id: 'c2', name: 'Щитоносец', type: 'creature', cost: 2, atk: 1, hp: 5 },
  { id: 'c3', name: 'Костолом', type: 'creature', cost: 2, atk: 3, hp: 2 },
  { id: 'c4', name: 'Наёмник', type: 'creature', cost: 3, atk: 3, hp: 3 },
  { id: 'c5', name: 'Ветеран Ямы', type: 'creature', cost: 3, atk: 2, hp: 6 },
  { id: 'c6', name: 'Берсерк', type: 'creature', cost: 4, atk: 6, hp: 2 },
  { id: 'c7', name: 'Каменная Стена', type: 'creature', cost: 4, atk: 2, hp: 9 },
  { id: 'c8', name: 'Чемпион Ринга', type: 'creature', cost: 5, atk: 5, hp: 6 },
  { id: 'c9', name: 'Тяжеловес', type: 'creature', cost: 6, atk: 7, hp: 8 },
  { id: 's1', name: 'Удар в челюсть', type: 'spell', cost: 2, dmg: 3 },
  { id: 's2', name: 'Прямой в корпус', type: 'spell', cost: 4, dmg: 5 },
  { id: 's3', name: 'Перевязка', type: 'spell', cost: 2, heal: 4 },
];

export function cardById(id) {
  return CARD_POOL.find((c) => c.id === id);
}

export function defaultDeckCounts() {
  // A full 30-card starting deck (max 4 copies of any single card),
  // given to every new account from the moment it's registered.
  return { c1: 4, c2: 3, c3: 3, c4: 2, c5: 2, c6: 2, c7: 2, c8: 2, c9: 2, s1: 3, s2: 2, s3: 3 };
}

let uidCounter = 1;
function nextUid(prefix) {
  uidCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidCounter}`;
}

export function buildDeckFromCounts(counts) {
  const deck = [];
  Object.keys(counts || {}).forEach((id) => {
    const base = cardById(id);
    if (!base) return;
    const n = Math.max(0, Math.min(4, Math.floor(counts[id]) || 0));
    for (let i = 0; i < n; i++) deck.push({ id, uid: nextUid('card') });
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck.slice(0, 30); // MAX_DECK_SIZE
}

export function freshBoard() {
  return Array.from({ length: LANES }, () => Array(DEPTH).fill(null));
}

export function frontUnit(board, laneIdx) {
  for (let d = 0; d < DEPTH; d++) {
    if (board[laneIdx][d]) return { unit: board[laneIdx][d], depth: d };
  }
  return null;
}

function actingOrder(board, laneIdx) {
  const order = [];
  for (let d = 0; d < DEPTH; d++) {
    if (board[laneIdx][d]) order.push({ unit: board[laneIdx][d], depth: d });
  }
  return order;
}

function draw(deck, hand, n) {
  for (let i = 0; i < n; i++) {
    if (hand.length >= MAX_HAND) break;
    const card = deck.shift();
    if (card) hand.push(card);
  }
}

// ---------- Match creation ----------
export function createMatch(matchId, nameA, deckCountsA, nameB, deckCountsB) {
  const match = {
    matchId,
    players: [nameA, nameB],
    hands: { [nameA]: [], [nameB]: [] },
    decks: {
      [nameA]: buildDeckFromCounts(deckCountsA || defaultDeckCounts()),
      [nameB]: buildDeckFromCounts(deckCountsB || defaultDeckCounts()),
    },
    boards: { [nameA]: freshBoard(), [nameB]: freshBoard() },
    hp: { [nameA]: START_HP, [nameB]: START_HP },
    mana: { [nameA]: 2, [nameB]: 2 },
    maxMana: 2,
    round: 1,
    pendingSpells: [],
    sacrifices: { [nameA]: 0, [nameB]: 0 },
    readyToEnd: { [nameA]: false, [nameB]: false },
    phase: 'placing', // placing | resolving | over
    status: 'active', // active | finished | abandoned
    winner: null,
  };
  draw(match.decks[nameA], match.hands[nameA], 3);
  draw(match.decks[nameB], match.hands[nameB], 3);
  captureCommitted(match);
  return match;
}

// A snapshot of "what's publicly visible right now" — taken at the start
// of each placing phase (match creation, and again after every round's
// combat resolves). While a round is in progress, a player's own board
// updates live as they play cards, but their opponent's board (and hand
// count, and queued spells) stay frozen at this snapshot — so nobody
// can watch the other side's moves happen in real time. Everything
// becomes visible again the moment both players end their turn and the
// round resolves.
function deepClone(x) {
  return JSON.parse(JSON.stringify(x));
}
function captureCommitted(match) {
  const counts = {};
  match.players.forEach((n) => { counts[n] = match.hands[n].length; });
  match.committed = { boards: deepClone(match.boards), handCounts: counts };
}

export function otherPlayer(match, username) {
  return match.players.find((n) => n !== username);
}

// ---------- Player actions (validated here — this IS the anti-cheat) ----------
export function placeCard(match, username, uid, lane, depth) {
  if (match.phase !== 'placing') return { error: 'Сейчас не фаза расстановки.' };
  if (lane < 0 || lane >= LANES || !Number.isInteger(depth) || depth < 0 || depth >= DEPTH) return { error: 'Некорректная позиция.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: 'Такой карты нет в руке.' };
  const card = cardById(hand[idx].id);
  if (!card || card.type !== 'creature') return { error: 'Эта карта не боец.' };
  if (match.boards[username][lane][depth]) return { error: 'Слот занят.' };
  if (match.mana[username] < card.cost) return { error: 'Не хватает маны.' };

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  match.boards[username][lane][depth] = {
    id: card.id,
    uid: nextUid('unit'),
    atk: card.atk,
    hp: card.hp,
    maxHp: card.hp,
  };
  return { ok: true };
}

export function castSpell(match, username, uid, lane, depth) {
  if (match.phase !== 'placing') return { error: 'Сейчас не фаза расстановки.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: 'Такой карты нет в руке.' };
  const card = cardById(hand[idx].id);
  if (!card || card.type !== 'spell') return { error: 'Эта карта не заклинание.' };
  if (match.mana[username] < card.cost) return { error: 'Не хватает маны.' };

  if (card.dmg) {
    if (lane < 0 || lane >= LANES) return { error: 'Некорректная полоса.' };
  } else if (card.heal) {
    const unit = depth != null && match.boards[username][lane] && match.boards[username][lane][depth];
    if (!unit) return { error: 'Там некого лечить.' };
  }

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  match.pendingSpells.push({
    side: username,
    cardId: card.id,
    kind: card.dmg ? 'damage' : 'heal',
    laneIdx: lane,
    depthIdx: depth,
    dmg: card.dmg,
    heal: card.heal,
  });
  return { ok: true };
}

export function sacrifice(match, username, uid) {
  if (match.phase !== 'placing') return { error: 'Сейчас не фаза расстановки.' };
  if (match.sacrifices[username] >= 1) return { error: 'В этом раунде уже принесена жертва.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: 'Такой карты нет в руке.' };
  hand.splice(idx, 1);
  match.mana[username] += 1;
  match.sacrifices[username] += 1;
  return { ok: true };
}

// ---------- End turn + resolution ----------
// Returns { events, roundOver } where events is an ordered list the client
// replays for animation. Only called once both players are ready.
function resolveSpells(match, events) {
  match.pendingSpells.forEach((spell) => {
    if (spell.kind === 'damage') {
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const info = frontUnit(board, spell.laneIdx);
      if (info) {
        info.unit.hp -= spell.dmg;
        const died = info.unit.hp <= 0;
        events.push({
          type: 'spell', kind: 'damage', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: info.depth,
          amount: spell.dmg, died,
        });
        if (died) board[spell.laneIdx][info.depth] = null;
      } else {
        match.hp[defenderName] -= spell.dmg;
        events.push({
          type: 'spell', kind: 'damage', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetHero: true, amount: spell.dmg,
        });
      }
    } else if (spell.kind === 'heal') {
      const board = match.boards[spell.side];
      const unit = board[spell.laneIdx] && board[spell.laneIdx][spell.depthIdx];
      if (unit) {
        unit.hp = Math.min(unit.maxHp, unit.hp + spell.heal);
        events.push({
          type: 'spell', kind: 'heal', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: spell.side, targetDepth: spell.depthIdx, amount: spell.heal,
        });
      }
    }
  });
  match.pendingSpells = [];
}

function resolveCombat(match, events) {
  const [nameA, nameB] = match.players;
  for (let l = 0; l < LANES; l++) {
    const orderA = actingOrder(match.boards[nameA], l);
    const orderB = actingOrder(match.boards[nameB], l);
    const waves = Math.max(orderA.length, orderB.length);
    for (let w = 0; w < waves; w++) {
      let aInfo = orderA[w] || null;
      let bInfo = orderB[w] || null;
      // Skip an actor that already died earlier this lane's combat.
      if (aInfo && match.boards[nameA][l][aInfo.depth] !== aInfo.unit) aInfo = null;
      if (bInfo && match.boards[nameB][l][bInfo.depth] !== bInfo.unit) bInfo = null;
      if (!aInfo && !bInfo) continue;

      const aUnit = aInfo && aInfo.unit;
      const bUnit = bInfo && bInfo.unit;
      const aTarget = aUnit ? frontUnit(match.boards[nameB], l) : null;
      const bTarget = bUnit ? frontUnit(match.boards[nameA], l) : null;

      if (aUnit) {
        if (aTarget) {
          aTarget.unit.hp -= aUnit.atk;
        } else {
          match.hp[nameB] -= aUnit.atk;
        }
      }
      if (bUnit) {
        if (bTarget) {
          bTarget.unit.hp -= bUnit.atk;
        } else {
          match.hp[nameA] -= bUnit.atk;
        }
      }

      const aDied = !!(aTarget && aTarget.unit.hp <= 0);
      const bDied = !!(bTarget && bTarget.unit.hp <= 0);

      events.push({
        type: 'wave', lane: l, waveIndex: w,
        attackerA: aUnit ? { side: nameA, uid: aUnit.uid, depth: aInfo.depth } : null,
        attackerB: bUnit ? { side: nameB, uid: bUnit.uid, depth: bInfo.depth } : null,
        targetAHero: !!(aUnit && !aTarget),
        targetBHero: !!(bUnit && !bTarget),
        targetADepth: aTarget ? aTarget.depth : null,
        targetBDepth: bTarget ? bTarget.depth : null,
        aDamage: aUnit ? aUnit.atk : 0,
        bDamage: bUnit ? bUnit.atk : 0,
        aDied, bDied,
      });

      if (aDied) match.boards[nameB][l][aTarget.depth] = null;
      if (bDied) match.boards[nameA][l][bTarget.depth] = null;
    }
  }
}

export function tryEndTurn(match, username) {
  if (match.phase !== 'placing') return { ready: false };
  match.readyToEnd[username] = true;
  const [nameA, nameB] = match.players;
  if (!match.readyToEnd[nameA] || !match.readyToEnd[nameB]) {
    return { ready: false };
  }

  match.phase = 'resolving';
  // Snapshot exactly what both sides placed this round, before anything
  // fires — the client renders this first (revealing the opponent's
  // moves, which were hidden during placement) so units visibly appear
  // on the field before spells or combat animate.
  const preBoards = { [nameA]: deepClone(match.boards[nameA]), [nameB]: deepClone(match.boards[nameB]) };

  const events = [];
  resolveSpells(match, events);
  resolveCombat(match, events);

  let roundOver = true;
  let winner = null;
  if (match.hp[nameA] <= 0 || match.hp[nameB] <= 0) {
    match.phase = 'over';
    match.status = 'finished';
    if (match.hp[nameA] <= 0 && match.hp[nameB] <= 0) winner = null; // draw
    else winner = match.hp[nameA] > 0 ? nameA : nameB;
    match.winner = winner;
  } else {
    match.round += 1;
    match.maxMana = Math.min(MAX_MANA, match.maxMana + 1);
    match.mana[nameA] = match.maxMana;
    match.mana[nameB] = match.maxMana;
    match.sacrifices[nameA] = 0;
    match.sacrifices[nameB] = 0;
    match.readyToEnd[nameA] = false;
    match.readyToEnd[nameB] = false;
    draw(match.decks[nameA], match.hands[nameA], 1);
    draw(match.decks[nameB], match.hands[nameB], 1);
    match.phase = 'placing';
    captureCommitted(match); // new round's hidden baseline = the just-resolved board
  }

  return { ready: true, events, gameOver: match.phase === 'over', winner, preBoards };
}

// ---------- Snapshots (per-player perspective; hides opponent's hand) ----------
export function snapshotFor(match, username) {
  const other = otherPlayer(match, username);
  // During placement, your own board updates live as you play — but the
  // opponent's side of the field only updates once both of you have
  // ended the turn and the round has actually resolved. Until then they
  // see the board exactly as it looked at the start of this round.
  const stillPlacing = match.phase === 'placing';
  const committed = match.committed || { boards: {}, handCounts: {} };
  const opponentBoard = stillPlacing ? (committed.boards[other] || freshBoard()) : match.boards[other];
  const opponentHandCount = stillPlacing
    ? (typeof committed.handCounts[other] === 'number' ? committed.handCounts[other] : match.hands[other].length)
    : match.hands[other].length;
  const pendingSpells = stillPlacing
    ? match.pendingSpells.filter((sp) => sp.side === username)
    : match.pendingSpells;
  return {
    matchId: match.matchId,
    round: match.round,
    phase: match.phase,
    status: match.status,
    winner: match.winner,
    mana: match.mana[username],
    maxMana: match.maxMana,
    myHp: match.hp[username],
    opponentHp: match.hp[other],
    myBoard: match.boards[username],
    opponentBoard,
    myHand: match.hands[username],
    opponentHandCount,
    pendingSpells,
    opponentName: other,
    myReady: match.readyToEnd[username],
    mySacrifices: match.sacrifices[username],
    opponentReady: match.readyToEnd[other],
  };
}

// Lightweight, DB-safe snapshot (no ws refs) used for persistence/resume.
export function serializeMatch(match) {
  return JSON.parse(JSON.stringify(match));
}
