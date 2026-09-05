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
  { id: 'c1', name: '\u041a\u0440\u0435\u0441\u0442\u044c\u044f\u043d\u0438\u043d', type: 'creature', cost: 2, atk: 1, hp: 3 },
  { id: 'c2', name: '\u0429\u0438\u0442\u043e\u043d\u043e\u0441\u0435\u0446', type: 'creature', cost: 2, atk: 1, hp: 5, armor: 1 },
  { id: 'c3', name: '\u0421\u0442\u0440\u0430\u0436\u043d\u0438\u043a', type: 'creature', cost: 2, atk: 2, hp: 1 },
  { id: 'c4', name: '\u041d\u0430\u0451\u043c\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 3 },
  { id: 'c6', name: '\u041c\u043e\u043b\u043e\u0442\u043e\u0431\u043e\u0435\u0446', type: 'creature', cost: 4, atk: 5, hp: 2 },
  { id: 'c7', name: '\u041a\u0430\u043c\u0435\u043d\u043d\u0430\u044f \u0421\u0442\u0435\u043d\u0430', type: 'creature', cost: 4, atk: 2, hp: 9 },
  { id: 'c8', name: '\u041f\u0430\u043b\u0430\u0434\u0438\u043d', type: 'creature', cost: 5, atk: 4, hp: 2, rallyBuff: true },
  { id: 'c10', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446', type: 'creature', cost: 1, atk: 1, hp: 1 },
  { id: 'c11', name: '\u0421\u0442\u0440\u0430\u0436 \u0434\u0432\u043e\u0440\u0446\u0430', type: 'creature', cost: 2, atk: 2, hp: 2, lifesteal: true },
  { id: 'c12', name: '\u041b\u0435\u0433\u0438\u043e\u043d\u0435\u0440', type: 'creature', cost: 3, atk: 2, hp: 3, lifesteal: true, synergy: true },
  { id: 's1', name: '\u041a\u043e\u043b\u044c\u0447\u0443\u0433\u0430', type: 'spell', cost: 2, buffHp: 3, buffAtk: 1 },
  { id: 'c13', name: '\u041f\u043e\u0432\u0430\u0440', type: 'creature', cost: 3, atk: 2, hp: 2, cookHeal: true },
  { id: 'c14', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446 \u0441 \u0434\u0443\u0431\u0438\u043d\u043e\u0439', type: 'creature', cost: 3, atk: 3, hp: 1 },
  { id: 'c15', name: '\u041a\u0440\u0435\u043f\u043a\u0438\u0439 \u0440\u0430\u0431\u043e\u0442\u044f\u0433\u0430', type: 'creature', cost: 4, atk: 3, hp: 4 },
  { id: 'c16', name: '\u0420\u043e\u0434\u043d\u0430\u044f \u0442\u0435\u0442\u0443\u0448\u043a\u0430', type: 'creature', cost: 3, atk: 1, hp: 2, auntBuff: true },
];

export function cardById(id) {
  return CARD_POOL.find((c) => c.id === id);
}

export function defaultDeckCounts() {
  // A starting deck given to every new account, respecting both the
  // max-3-copies-per-card rule and the 30-card deck cap. 21 (original 7
  // creatures ×3) + 2 (Кольчуга) + 3 (Ополченец с дубиной) + 3 (Крепкий
  // работяга) + 1 (Родная тетушка) = 30 exactly — she gets only 1 copy
  // here (not 3) specifically because 3 would have pushed the total past
  // the cap.
  return { c1: 3, c2: 3, c3: 3, c4: 3, c6: 3, c7: 3, c8: 3, s1: 2, c14: 3, c15: 3, c16: 1 };
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

// ---------- Synergy (Легионер) ----------
// Counts allied units directly above/below/left/right of a given cell on
// the SAME board (lane = row, depth = column of a LANES×DEPTH grid).
// Only cardinal neighbours count — diagonals don't.
function countAdjacentAllies(board, laneIdx, depthIdx) {
  let count = 0;
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dl, dd] of deltas) {
    const l = laneIdx + dl, d = depthIdx + dd;
    if (l >= 0 && l < LANES && d >= 0 && d < DEPTH && board[l][d]) count++;
  }
  return count;
}

// The attack a unit actually fights with right now — base atk plus its
// Synergy bonus (+1 per adjacent ally), recomputed fresh every time since
// the board changes every round. Non-synergy units just return their atk.
export function effectiveAtk(board, laneIdx, depthIdx) {
  const unit = board[laneIdx][depthIdx];
  if (!unit) return 0;
  const bonus = unit.synergy ? countAdjacentAllies(board, laneIdx, depthIdx) : 0;
  return unit.atk + bonus;
}

// A client-facing copy of a board where every synergy unit's displayed
// atk already reflects its current bonus — always returns fresh unit
// objects (never the live references) so it's safe to use as a snapshot.
export function displayBoard(board) {
  return board.map((lane, l) => lane.map((unit, d) => {
    if (!unit) return null;
    return { ...unit, atk: effectiveAtk(board, l, d) };
  }));
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
    pendingRallyBuffs: [],
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
function captureCommitted(match) {
  const counts = {};
  match.players.forEach((n) => { counts[n] = match.hands[n].length; });
  const boards = {};
  match.players.forEach((n) => { boards[n] = displayBoard(match.boards[n]); });
  match.committed = { boards, handCounts: counts };
}

export function otherPlayer(match, username) {
  return match.players.find((n) => n !== username);
}

// ---------- Player actions (validated here — this IS the anti-cheat) ----------
export function placeCard(match, username, uid, lane, depth) {
  if (match.phase !== 'placing') return { error: '\u0421\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0444\u0430\u0437\u0430 \u0440\u0430\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438.' };
  if (lane < 0 || lane >= LANES || !Number.isInteger(depth) || depth < 0 || depth >= DEPTH) return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: '\u0422\u0430\u043a\u043e\u0439 \u043a\u0430\u0440\u0442\u044b \u043d\u0435\u0442 \u0432 \u0440\u0443\u043a\u0435.' };
  const card = cardById(hand[idx].id);
  if (!card || card.type !== 'creature') return { error: '\u042d\u0442\u0430 \u043a\u0430\u0440\u0442\u0430 \u043d\u0435 \u0431\u043e\u0435\u0446.' };
  if (match.boards[username][lane][depth]) return { error: '\u0421\u043b\u043e\u0442 \u0437\u0430\u043d\u044f\u0442.' };
  if (match.mana[username] < card.cost) return { error: '\u041d\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043c\u0430\u043d\u044b.' };

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  const unit = {
    id: card.id,
    uid: nextUid('unit'),
    atk: card.atk,
    hp: card.hp,
    maxHp: card.hp,
    armor: card.armor || 0,
    lifesteal: !!card.lifesteal,
    synergy: !!card.synergy,
    cookHeal: !!card.cookHeal,
  };
  match.boards[username][lane][depth] = unit;

  // Battlecry: a one-time, permanent +2/+2 to every other allied unit
  // already on the board at the moment this one is placed — units placed
  // *after* it get nothing retroactively, and it never buffs itself.
  if (card.rallyBuff) {
    // Queued, not applied immediately: the client needs to reveal the
    // *pre*-buff board first (so it can animate the increase), which
    // means the actual stat change has to wait until resolution starts
    // — see tryEndTurn(), where match.pendingRallyBuffs is drained.
    const board = match.boards[username];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const other = board[l][d];
        if (other && other !== unit) {
          match.pendingRallyBuffs.push({ side: username, laneIdx: l, depthIdx: d, buffAtk: 2, buffHp: 2 });
        }
      }
    }
  }

  // Родная тетушка: picks exactly one other ally already on the board
  // (at random — she can't play favourites with more than one at a time)
  // and gives it a permanent +1/+1. Does nothing if she's placed alone.
  if (card.auntBuff) {
    // Same deferred-queue mechanism as Паладин's rallyBuff (see above) —
    // the random pick happens now, at placement, but the actual stat
    // change (and its animation) waits until resolution starts.
    const board = match.boards[username];
    const others = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const other = board[l][d];
        if (other && other !== unit) others.push({ laneIdx: l, depthIdx: d });
      }
    }
    if (others.length > 0) {
      const chosen = others[Math.floor(Math.random() * others.length)];
      match.pendingRallyBuffs.push({ side: username, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, buffAtk: 1, buffHp: 1 });
    }
  }

  return { ok: true };
}

export function castSpell(match, username, uid, lane, depth) {
  if (match.phase !== 'placing') return { error: '\u0421\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0444\u0430\u0437\u0430 \u0440\u0430\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: '\u0422\u0430\u043a\u043e\u0439 \u043a\u0430\u0440\u0442\u044b \u043d\u0435\u0442 \u0432 \u0440\u0443\u043a\u0435.' };
  const card = cardById(hand[idx].id);
  if (!card || card.type !== 'spell') return { error: '\u042d\u0442\u0430 \u043a\u0430\u0440\u0442\u0430 \u043d\u0435 \u0437\u0430\u043a\u043b\u0438\u043d\u0430\u043d\u0438\u0435.' };
  if (match.mana[username] < card.cost) return { error: '\u041d\u0435 \u0445\u0432\u0430\u0442\u0430\u0435\u0442 \u043c\u0430\u043d\u044b.' };

  if (card.dmg) {
    if (lane < 0 || lane >= LANES) return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u043b\u043e\u0441\u0430.' };
  } else if (card.heal || card.buffHp || card.buffAtk) {
    const unit = depth != null && match.boards[username][lane] && match.boards[username][lane][depth];
    if (!unit) return { error: '\u0422\u0430\u043c \u043d\u0435\u0442 \u0441\u0432\u043e\u0435\u0433\u043e \u0431\u043e\u0439\u0446\u0430.' };
  }

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  match.pendingSpells.push({
    side: username,
    cardId: card.id,
    kind: card.dmg ? 'damage' : (card.heal ? 'heal' : 'buff'),
    laneIdx: lane,
    depthIdx: depth,
    dmg: card.dmg,
    heal: card.heal,
    buffHp: card.buffHp,
    buffAtk: card.buffAtk,
  });
  return { ok: true };
}

export function sacrifice(match, username, uid) {
  if (match.phase !== 'placing') return { error: '\u0421\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0444\u0430\u0437\u0430 \u0440\u0430\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438.' };
  if (match.sacrifices[username] >= 1) return { error: '\u0412 \u044d\u0442\u043e\u043c \u0440\u0430\u0443\u043d\u0434\u0435 \u0443\u0436\u0435 \u043f\u0440\u0438\u043d\u0435\u0441\u0435\u043d\u0430 \u0436\u0435\u0440\u0442\u0432\u0430.' };
  const hand = match.hands[username];
  const idx = hand.findIndex((c) => c.uid === uid);
  if (idx === -1) return { error: '\u0422\u0430\u043a\u043e\u0439 \u043a\u0430\u0440\u0442\u044b \u043d\u0435\u0442 \u0432 \u0440\u0443\u043a\u0435.' };
  hand.splice(idx, 1);
  match.mana[username] += 1;
  match.sacrifices[username] += 1;
  return { ok: true };
}

// ---------- End turn + resolution ----------
// Returns { events, roundOver } where events is an ordered list the client
// replays for animation. Only called once both players are ready.
// Both functions stop the instant either hero's HP reaches 0 — the match
// ends immediately, so nothing after the lethal blow gets a chance to
// apply (which also avoids accidentally dragging both players down to a
// "draw" just because a later lane/spell still had something queued).
function anyHeroDown(match) {
  const [nameA, nameB] = match.players;
  return match.hp[nameA] <= 0 || match.hp[nameB] <= 0;
}

function resolveSpells(match, events) {
  const queue = match.pendingSpells;
  match.pendingSpells = [];
  for (const spell of queue) {
    if (anyHeroDown(match)) break; // match already decided — stop applying further spells
    if (spell.kind === 'damage') {
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const info = frontUnit(board, spell.laneIdx);
      if (info) {
        const applied = Math.max(0, spell.dmg - (info.unit.armor || 0));
        info.unit.hp -= applied;
        const died = info.unit.hp <= 0;
        events.push({
          type: 'spell', kind: 'damage', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: info.depth,
          amount: applied, died,
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
    } else if (spell.kind === 'buff') {
      // Permanent stat increase (e.g. Кольчуга) — unlike heal, this raises
      // the ceiling itself: both current and max HP go up, not just a
      // refill up to the old cap.
      const board = match.boards[spell.side];
      const unit = board[spell.laneIdx] && board[spell.laneIdx][spell.depthIdx];
      if (unit) {
        if (spell.buffAtk) unit.atk += spell.buffAtk;
        if (spell.buffHp) { unit.hp += spell.buffHp; unit.maxHp += spell.buffHp; }
        events.push({
          type: 'spell', kind: 'buff', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: spell.side, targetDepth: spell.depthIdx,
          buffAtk: spell.buffAtk || 0, buffHp: spell.buffHp || 0,
        });
      }
    }
  }
}

function resolveCombat(match, events) {
  const [nameA, nameB] = match.players;
  for (let l = 0; l < LANES; l++) {
    if (anyHeroDown(match)) break; // match already decided — stop resolving further lanes
    const orderA = actingOrder(match.boards[nameA], l);
    const orderB = actingOrder(match.boards[nameB], l);
    const waves = Math.max(orderA.length, orderB.length);
    for (let w = 0; w < waves; w++) {
      if (anyHeroDown(match)) break; // ...or further waves within this lane
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

      // Synergy units fight with their live effective attack (base + 1
      // per adjacent ally on their own board), recomputed fresh right
      // now — the neighbours that earned this bonus might not be there
      // by the next wave or the next round.
      const aAtk = aUnit ? effectiveAtk(match.boards[nameA], l, aInfo.depth) : 0;
      const bAtk = bUnit ? effectiveAtk(match.boards[nameB], l, bInfo.depth) : 0;

      // Armor reduces incoming damage per hit (never goes negative, never
      // consumed) — only units can have it, heroes always take the full
      // hit. The event carries the *actual* damage applied so the client's
      // popup number always matches the real HP change.
      let aApplied = 0, bApplied = 0;
      let aLifesteal = 0, bLifesteal = 0;
      if (aUnit) {
        if (aTarget) {
          aApplied = Math.max(0, aAtk - (aTarget.unit.armor || 0));
          aTarget.unit.hp -= aApplied;
        } else {
          aApplied = aAtk;
          match.hp[nameB] -= aApplied;
          // A unit with lifesteal that lands its hit directly on the
          // enemy hero heals its own owner's hero for its attack value.
          if (aUnit.lifesteal) {
            aLifesteal = aAtk;
            match.hp[nameA] = match.hp[nameA] + aLifesteal;
          }
        }
      }
      if (bUnit) {
        if (bTarget) {
          bApplied = Math.max(0, bAtk - (bTarget.unit.armor || 0));
          bTarget.unit.hp -= bApplied;
        } else {
          bApplied = bAtk;
          match.hp[nameA] -= bApplied;
          if (bUnit.lifesteal) {
            bLifesteal = bAtk;
            match.hp[nameB] = match.hp[nameB] + bLifesteal;
          }
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
        aDamage: aApplied,
        bDamage: bApplied,
        aLifesteal,
        bLifesteal,
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
  const preBoards = { [nameA]: displayBoard(match.boards[nameA]), [nameB]: displayBoard(match.boards[nameB]) };

  const events = [];

  // Rally buffs (e.g. Паладин) apply right at the very start of
  // resolution — before spells or combat — using preBoards (just
  // captured above) as the "before" picture the client reveals first,
  // so the stat increase can be animated rather than appearing already
  // baked in.
  const rallyQueue = match.pendingRallyBuffs;
  match.pendingRallyBuffs = [];
  for (const buff of rallyQueue) {
    const unit = match.boards[buff.side][buff.laneIdx] && match.boards[buff.side][buff.laneIdx][buff.depthIdx];
    if (!unit) continue;
    unit.atk += buff.buffAtk;
    unit.hp += buff.buffHp;
    unit.maxHp += buff.buffHp;
    events.push({
      type: 'rallyBuff', side: buff.side, laneIdx: buff.laneIdx,
      targetDepth: buff.depthIdx, buffAtk: buff.buffAtk, buffHp: buff.buffHp,
    });
  }

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
    // End-of-round triggers (e.g. Повар) — fire after combat has fully
    // settled but before anything about the *next* round starts. Only
    // reachable here because both heroes are confirmed still alive (the
    // branch above already caught anyone at 0 or below) — nothing here
    // can retroactively undo a match that's already decided.
    for (const name of match.players) {
      const board = match.boards[name];
      for (let l = 0; l < LANES; l++) {
        for (let d = 0; d < DEPTH; d++) {
          const unit = board[l][d];
          if (unit && unit.cookHeal) {
            match.hp[name] += unit.atk;
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: unit.atk });
          }
        }
      }
    }

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
  // committed.boards[other] is already display-ready (computed once when
  // frozen); the live match.boards[other] is not, so it needs computing
  // fresh here — applying displayBoard twice would double-count Synergy.
  const opponentBoard = stillPlacing ? (committed.boards[other] || freshBoard()) : displayBoard(match.boards[other]);
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
    myBoard: displayBoard(match.boards[username]),
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

// ---------- PVE bot ----------
// Plays the AI's whole turn in one go, right when the human ends theirs —
// same timing as the old client-side bot, just running here instead so
// PVE gets the exact same authoritative treatment as PVP (the human
// can't see or influence what the bot does beyond what its own board
// exposes as targets). Reuses placeCard/castSpell so the bot is held to
// the same rules as everyone else — it just never fails a legal check
// because it only ever proposes moves it already knows it can afford.
export function aiPlaceCards(match, aiName) {
  let guard = 0;
  while (guard++ < 20) {
    const hand = match.hands[aiName];
    const mana = match.mana[aiName];
    const affordable = hand.filter((c) => cardById(c.id).cost <= mana);
    if (affordable.length === 0) break;

    const creatures = affordable.filter((c) => cardById(c.id).type === 'creature');
    const openSlots = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (!match.boards[aiName][l][d]) openSlots.push([l, d]);
      }
    }
    if (creatures.length && openSlots.length) {
      const pick = creatures[Math.floor(Math.random() * creatures.length)];
      const slot = openSlots[Math.floor(Math.random() * openSlots.length)];
      const result = placeCard(match, aiName, pick.uid, slot[0], slot[1]);
      if (result.ok) continue;
      break;
    }

    const dmgSpell = affordable.find((c) => cardById(c.id).dmg);
    if (dmgSpell) {
      const humanName = otherPlayer(match, aiName);
      let bestLane = -1, bestAtk = -1;
      for (let l = 0; l < LANES; l++) {
        const info = frontUnit(match.boards[humanName], l);
        if (info && info.unit.atk > bestAtk) { bestAtk = info.unit.atk; bestLane = l; }
      }
      const lane = bestLane >= 0 ? bestLane : Math.floor(Math.random() * LANES);
      const result = castSpell(match, aiName, dmgSpell.uid, lane);
      if (result.ok) continue;
      break;
    }

    break; // nothing affordable left to usefully play
  }
}
