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
// A match that reaches this many completed rounds with both heroes still
// alive ends immediately — whoever has more HP wins (tied HP is a draw),
// same as any other match-over check. See tryEndTurn()'s round-advance
// branch, where this is checked right before a new round would start.
export const MAX_ROUNDS = 15;

// Rarity is purely descriptive right now (no gameplay effect beyond the
// deck copy limit below) — it mainly informs display. Legendary is a
// genuine top rarity tier (no card uses it yet). Mythic is different: it
// isn't its own independent tier but a *skin* — a reskinned, slightly
// re-tuned variant of an existing Rare/Epic/Legendary card. A mythic
// card therefore carries both `rarity: 'mythic'` (for display/color) AND
// `baseRarity` naming which tier's card it's a skin of ('rare' | 'epic'
// | 'legendary') — the deck copy limit always comes from `baseRarity`,
// never a fixed mythic-specific number. No skins exist yet, so no card
// currently sets `baseRarity`; this is scaffolding for when one does.
export const CARD_POOL = [
  { id: 'c1', name: '\u041a\u0440\u0435\u0441\u0442\u044c\u044f\u043d\u0438\u043d', type: 'creature', cost: 2, atk: 1, hp: 3, rarity: 'common' },
  { id: 'c2', name: '\u0429\u0438\u0442\u043e\u043d\u043e\u0441\u0435\u0446', type: 'creature', cost: 2, atk: 1, hp: 5, armor: 1, rarity: 'common' },
  { id: 'c3', name: '\u0421\u0442\u0440\u0430\u0436\u043d\u0438\u043a', type: 'creature', cost: 2, atk: 2, hp: 1, rarity: 'common' },
  { id: 'c4', name: '\u041d\u0430\u0451\u043c\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 3, rarity: 'common' },
  { id: 'c6', name: '\u041c\u043e\u043b\u043e\u0442\u043e\u0431\u043e\u0435\u0446', type: 'creature', cost: 4, atk: 5, hp: 2, rarity: 'common' },
  { id: 'c7', name: '\u041a\u0430\u043c\u0435\u043d\u043d\u0430\u044f \u0421\u0442\u0435\u043d\u0430', type: 'creature', cost: 2, atk: 0, hp: 4, wallGrow: true, rarity: 'rare' },
  { id: 'c8', name: '\u041f\u0430\u043b\u0430\u0434\u0438\u043d', type: 'creature', cost: 5, atk: 4, hp: 2, rallyBuff: true, rarity: 'rare' },
  { id: 'c10', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446', type: 'creature', cost: 1, atk: 1, hp: 1, rarity: 'common' },
  { id: 'c11', name: '\u0421\u0442\u0440\u0430\u0436 \u0434\u0432\u043e\u0440\u0446\u0430', type: 'creature', cost: 2, atk: 2, hp: 2, lifesteal: true, rarity: 'rare' },
  { id: 'c12', name: '\u041b\u0435\u0433\u0438\u043e\u043d\u0435\u0440', type: 'creature', cost: 3, atk: 2, hp: 3, lifesteal: true, synergy: 1, rarity: 'epic' },
  { id: 's1', name: '\u041a\u043e\u043b\u044c\u0447\u0443\u0433\u0430', type: 'spell', cost: 2, buffHp: 3, buffAtk: 1, rarity: 'common' },
  // Unlike every other spell, this one can target ANY cell — empty or
  // occupied by anyone — because it doesn't actually touch whatever's
  // there; the cell is just where the player points it. Heals the
  // caster's own hero and draws them a card from their own deck. See
  // castSpell()'s `card.healHero` branch and resolveSpells()'s
  // 'wellspring' kind further down.
  { id: 's2', name: '\u0420\u043e\u0434\u043d\u0438\u043a', type: 'spell', cost: 2, healHero: 2, drawCard: 1, rarity: 'rare' },
  { id: 'c13', name: '\u041f\u043e\u0432\u0430\u0440', type: 'creature', cost: 3, atk: 2, hp: 2, cookHeal: true, rarity: 'rare' },
  { id: 'c14', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446 \u0441 \u0434\u0443\u0431\u0438\u043d\u043e\u0439', type: 'creature', cost: 3, atk: 3, hp: 1, rarity: 'common' },
  { id: 'c15', name: '\u041a\u0440\u0435\u043f\u043a\u0438\u0439 \u0440\u0430\u0431\u043e\u0442\u044f\u0433\u0430', type: 'creature', cost: 4, atk: 3, hp: 4, rarity: 'common' },
  { id: 'c16', name: '\u0420\u043e\u0434\u043d\u0430\u044f \u0442\u0435\u0442\u0443\u0448\u043a\u0430', type: 'creature', cost: 3, atk: 1, hp: 2, auntBuff: true, rarity: 'common' },
  // Перед своей атакой в бою (каждый раунд, пока жива) навсегда даёт +1/+1
  // всем союзным юнитам на поле, включая себя — см. applyDawnBuff() в
  // resolveCombat() ниже. Эффект накопительный: чем дольше она остаётся
  // в бою, тем сильнее становится вся команда.
  { id: 'c17', name: '\u0410\u043d\u043d\u0430\u0431\u044d\u043b\u044c \u0420\u0430\u0441\u0441\u0432\u0435\u0442\u043d\u0430\u044f', type: 'creature', cost: 2, atk: 1, hp: 1, dawnBuff: true, rarity: 'legendary' },
  // Battlecry: heals her owner's hero by a fixed amount the instant she's
  // placed (see placeCard() below) — immediate, not deferred like
  // rallyBuff/auntBuff, since the hero's own HP is already visible to its
  // owner during their own placing phase (nothing dramatic to reveal).
  { id: 'c18', name: '\u041c\u043e\u043d\u0430\u0445\u0438\u043d\u044f', type: 'creature', cost: 2, atk: 1, hp: 2, healOnPlay: 2, rarity: 'rare' },
  // End-of-round trigger, 50% chance per round: heals her owner's hero by
  // an amount equal to HER OWN current HP at that exact moment (not a
  // fixed number, and not attack like Повар's cookHeal) — see the
  // cowHeal check alongside cookHeal's, further down.
  { id: 'c19', name: '\u041a\u043e\u0440\u043e\u0432\u0430', type: 'creature', cost: 2, atk: 0, hp: 4, cowHeal: true, rarity: 'rare' },
  { id: 'c20', name: '\u0421\u0442\u0440\u0430\u0436 \u0432\u043e\u0440\u043e\u0442', type: 'creature', cost: 3, atk: 3, hp: 3, armor: 1, rarity: 'rare' },
  // Synergy 1 = +1 atk per adjacent ally, same rule as Легионер. On top
  // of that, shootHero fires TWICE per lifetime-in-a-round-cycle: once as
  // a battlecry the instant she's placed (queued via match.pendingShots,
  // revealed at the start of resolution so the opponent sees it), and
  // again at the end of every round she survives (alongside cookHeal/
  // cowHeal, further down) — both times hitting the enemy hero for
  // damage equal to her CURRENT effective attack (base + synergy) at
  // that exact moment.
  { id: 'c21', name: '\u0410\u0440\u0431\u0430\u043b\u0435\u0442\u0447\u0438\u043a', type: 'creature', cost: 3, atk: 1, hp: 4, synergy: 1, shootHero: true, rarity: 'rare' },
  // Same permanent +1/+1-to-a-random-ally idea as Паладин/Родная тетушка,
  // but recurring instead of a one-time battlecry: fires again at the
  // START of every round he's still alive (see applyBishopBuffs() in
  // tryEndTurn, same moment rallyBuff/heal/shot queues are drained), each
  // time picking a fresh random OTHER ally anywhere on the board — same
  // self-exclusion rule as Паладин, never buffs himself.
  { id: 'c22', name: '\u0415\u043f\u0438\u0441\u043a\u043e\u043f', type: 'creature', cost: 3, atk: 1, hp: 3, bishopBuff: true, rarity: 'epic' },
  // 0 base attack — per the zero-attack rule, she never acts alone. Her
  // synergy is double Легионер/Арбалетчик's (+2 per adjacent ally
  // instead of +1), so even a single neighbour already gets her
  // swinging, and a full ring of four makes her hit as hard as +8.
  { id: 'c23', name: '\u0411\u0430\u043b\u043b\u0438\u0441\u0442\u0430', type: 'creature', cost: 3, atk: 0, hp: 4, synergy: 2, rarity: 'rare' },
  // Первый удар (First Strike): fights in its own combat pass BEFORE
  // every other unit — see resolveCombat()/resolveCombatPass() below,
  // which runs a firstStrike-only pass first, then a second pass for
  // everyone else. A target this kills in that first pass is already
  // gone by the time normal units get their turn.
  { id: 'c24', name: '\u041b\u0443\u0447\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 2, firstStrike: true, rarity: 'rare' },
];

export function cardById(id) {
  return CARD_POOL.find((c) => c.id === id);
}

// Max copies of a single card allowed in a deck, by rarity: Common/Rare/
// Epic can go up to 3 copies each; Legendary is a single (at most 1
// copy) — no card uses that tier yet, but the rule is ready for when one
// does. Mythic is NOT an independent tier here: a mythic card is a skin
// of a Rare/Epic/Legendary card, so its limit is whatever `baseRarity`
// says (falling back to 'rare' — the loosest of the three skinnable
// tiers — only as a defensive default if a future mythic card somehow
// omits it). Unknown/missing rarity altogether falls back to the common
// case (3) rather than silently allowing something looser.
export function maxCopiesForCard(card) {
  if (!card) return 3;
  const effectiveRarity = card.rarity === 'mythic' ? (card.baseRarity || 'rare') : card.rarity;
  if (effectiveRarity === 'legendary') return 1;
  return 3; // common, rare, epic (and mythic skinning any of those)
}

// The actual number of copies of this card a deck can use right now:
// never more than the rarity ceiling (maxCopiesForCard), and never more
// than however many copies the account has actually bought. Owning 1
// Повар caps its deck slot at 1, owning 2 caps it at 2, owning 3+ caps
// it at the rarity ceiling (3, since Повар is Rare) — buying more past
// that ceiling doesn't raise the deck cap further, it just banks extra
// copies (useful for a future dust-conversion/crafting sink, say).
export function deckSlotCapForCard(card, ownedCount) {
  return Math.min(maxCopiesForCard(card), Math.max(0, ownedCount || 0));
}

export function defaultDeckCounts() {
  // A starting deck given to every new account: exactly 3 copies each of
  // 10 cards — every Common creature, Кольчуга, and Родная тетушка. 10×3
  // = 30 exactly. Паладин (Rare) is deliberately NOT part of the
  // starter set — new accounts start without him and can buy him later
  // through the shop, same as any other non-starter card.
  return { c1: 3, c2: 3, c3: 3, c4: 3, c6: 3, c7: 3, s1: 3, c14: 3, c15: 3, c16: 3 };
}

// How many copies of each card a brand-new account already owns.
// Deliberately kept as exactly the starter deck's own counts (not a
// separately-curated table) — those are the cards (and quantities)
// new players already have in hand from day one, so it would be
// inconsistent to call any of them "not owned yet". Everything else
// starts at 0 copies, until bought in the shop.
export function defaultOwnedCounts() {
  return { ...defaultDeckCounts() };
}

// ---------- Shop ----------
// Only Rare/Epic/Legendary cards are ever sold — Common has no defined
// shop price (every account already starts owning most Commons anyway),
// and Mythic is priced by whichever rarity it's a skin of, same
// convention as maxCopiesForCard's baseRarity fallback.
function shopRarityOf(card) {
  return card.rarity === 'mythic' ? (card.baseRarity || 'rare') : card.rarity;
}

export const SHOP_PRICES = {
  gold: { rare: 60, epic: 400, legendary: 1500 },
  dust: { rare: 120, epic: 600, legendary: 3000 },
  crystals: { rare: 12, epic: 60, legendary: 300 },
};

export function shopPriceForCard(card, currency) {
  const table = SHOP_PRICES[currency];
  if (!table || !card) return null;
  const price = table[shopRarityOf(card)];
  return price == null ? null : price;
}

// Cards a shop list can ever draw from: any sellable rarity tier. Owning
// a card already (even several copies) does NOT remove it from the pool
// — accounts can hold unlimited copies of the same card, so the shop
// keeps offering it. NOTE: right now this pool is only 5 cards (Каменная
// Стена, Паладин, Страж дворца, Легионер, Повар qualify; Common cards
// like Ополченец are excluded, having no defined shop price) — until
// more Rare+ cards exist, the 6-slot daily lists below necessarily
// repeat cards. That's expected, not a bug.
export function shoppableCards() {
  return CARD_POOL.filter((c) => {
    const r = shopRarityOf(c);
    return r === 'rare' || r === 'epic' || r === 'legendary';
  });
}

// Picks `count` card ids at random from `pool`, WITH replacement — so it
// always returns exactly `count` ids even if the pool has fewer distinct
// cards than that (see shoppableCards' note above).
export function pickRandomShopCards(pool, count) {
  const result = [];
  if (!pool.length) return result;
  for (let i = 0; i < count; i++) {
    result.push(pool[Math.floor(Math.random() * pool.length)].id);
  }
  return result;
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
    const n = Math.max(0, Math.min(maxCopiesForCard(base), Math.floor(counts[id]) || 0));
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

// Same cardinal-neighbour rule as Synergy, but returns the actual
// coordinates of each occupied neighbour instead of just a count — used
// by Родная тетушка to pick which adjacent ally to bless.
function adjacentAllyPositions(board, laneIdx, depthIdx) {
  const positions = [];
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dl, dd] of deltas) {
    const l = laneIdx + dl, d = depthIdx + dd;
    if (l >= 0 && l < LANES && d >= 0 && d < DEPTH && board[l][d]) positions.push({ laneIdx: l, depthIdx: d });
  }
  return positions;
}

// The attack a unit actually fights with right now — base atk plus its
// Synergy bonus (a per-adjacent-ally multiplier, e.g. Synergy 1 = +1 atk
// per neighbour, Synergy 2 would be +2, etc.), recomputed fresh every
// time since the board changes every round. Non-synergy units (synergy
// falsy/0) just return their atk.
export function effectiveAtk(board, laneIdx, depthIdx) {
  const unit = board[laneIdx][depthIdx];
  if (!unit) return 0;
  const bonus = unit.synergy ? countAdjacentAllies(board, laneIdx, depthIdx) * unit.synergy : 0;
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
    pendingHeals: [],
    pendingShots: [],
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
    synergy: card.synergy || 0,
    shootHero: !!card.shootHero,
    cookHeal: !!card.cookHeal,
    cowHeal: !!card.cowHeal,
    wallGrow: !!card.wallGrow,
    firstStrike: !!card.firstStrike,
    dawnBuff: !!card.dawnBuff,
    bishopBuff: !!card.bishopBuff,
    placedThisRound: true, // lets the owner reposition it (and shows it dimmed client-side) until this round resolves
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
          match.pendingRallyBuffs.push({ side: username, laneIdx: l, depthIdx: d, buffAtk: 2, buffHp: 2, sourceUid: unit.uid });
        }
      }
    }
  }

  // Родная тетушка: picks exactly one ADJACENT ally (same cardinal-neighbour
  // rule as Synergy — directly above/below/left/right, no diagonals) and
  // gives it a permanent +1/+1. Does nothing if she has no neighbour yet.
  if (card.auntBuff) {
    // Same deferred-queue mechanism as Паладин's rallyBuff (see above) —
    // the random pick happens now, at placement, but the actual stat
    // change (and its animation) waits until resolution starts.
    const board = match.boards[username];
    const neighbours = adjacentAllyPositions(board, lane, depth);
    if (neighbours.length > 0) {
      const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
      match.pendingRallyBuffs.push({ side: username, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, buffAtk: 1, buffHp: 1, sourceUid: unit.uid });
    }
  }

  // Монахиня: heals her owner's hero — queued, not applied immediately,
  // so BOTH players see it happen as a revealed, animated event at the
  // very start of resolution (same moment as rallyBuff/auntBuff below),
  // instead of silently changing HP during placing while the opponent's
  // board (and this placement) is still hidden from them.
  if (card.healOnPlay) {
    match.pendingHeals.push({ side: username, amount: card.healOnPlay, sourceUid: unit.uid, laneIdx: lane, depthIdx: depth });
  }

  // Арбалетчик: battlecry shot at the enemy hero — same deferred
  // reasoning as Монахиня's heal above (opponent needs to actually see
  // it fire). The damage amount itself isn't computed until resolution
  // starts, since her Synergy bonus could still change between now and
  // then (more allies might get placed this same round).
  if (card.shootHero) {
    match.pendingShots.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  return { ok: true };
}

// Repositions a unit the caller placed *this same round* to a different
// empty slot on their own board — only while still in the placing phase,
// and only for units not yet locked in by a resolved round.
export function moveUnit(match, username, uid, lane, depth) {
  if (match.phase !== 'placing') return { error: '\u0421\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0444\u0430\u0437\u0430 \u0440\u0430\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438.' };
  if (lane < 0 || lane >= LANES || !Number.isInteger(depth) || depth < 0 || depth >= DEPTH) return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
  const board = match.boards[username];
  let fromLane = -1, fromDepth = -1;
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d] && board[l][d].uid === uid) { fromLane = l; fromDepth = d; break; }
    }
  }
  if (fromLane === -1) return { error: '\u0422\u0430\u043a\u043e\u0433\u043e \u0431\u043e\u0439\u0446\u0430 \u043d\u0435\u0442 \u043d\u0430 \u043f\u043e\u043b\u0435.' };
  const unit = board[fromLane][fromDepth];
  if (!unit.placedThisRound) return { error: '\u042d\u0442\u043e\u0433\u043e \u0431\u043e\u0439\u0446\u0430 \u0443\u0436\u0435 \u043d\u0435\u043b\u044c\u0437\u044f \u043f\u0435\u0440\u0435\u0441\u0442\u0430\u0432\u0438\u0442\u044c.' };
  if (fromLane === lane && fromDepth === depth) return { ok: true };
  if (board[lane][depth]) return { error: '\u0421\u043b\u043e\u0442 \u0437\u0430\u043d\u044f\u0442.' };
  board[fromLane][fromDepth] = null;
  board[lane][depth] = unit;
  return { ok: true };
}

// Pulls a unit the caller placed *this same round* back off the board and
// into their hand, refunding its mana cost and undoing anything it hadn't
// actually resolved yet — so it's as if the card was never played this
// turn. Only legal while still in the placing phase and only for units
// still flagged placedThisRound (same restriction as moveUnit — once a
// round resolves, a unit is locked in for good).
export function returnToHand(match, username, uid) {
  if (match.phase !== 'placing') return { error: '\u0421\u0435\u0439\u0447\u0430\u0441 \u043d\u0435 \u0444\u0430\u0437\u0430 \u0440\u0430\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438.' };
  const board = match.boards[username];
  let foundLane = -1, foundDepth = -1;
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d] && board[l][d].uid === uid) { foundLane = l; foundDepth = d; break; }
    }
  }
  if (foundLane === -1) return { error: '\u0422\u0430\u043a\u043e\u0433\u043e \u0431\u043e\u0439\u0446\u0430 \u043d\u0435\u0442 \u043d\u0430 \u043f\u043e\u043b\u0435.' };
  const unit = board[foundLane][foundDepth];
  if (!unit.placedThisRound) return { error: '\u042d\u0442\u043e\u0433\u043e \u0431\u043e\u0439\u0446\u0430 \u0443\u0436\u0435 \u043d\u0435\u043b\u044c\u0437\u044f \u0432\u0435\u0440\u043d\u0443\u0442\u044c \u0432 \u0440\u0443\u043a\u0443.' };
  const hand = match.hands[username];
  if (hand.length >= MAX_HAND) return { error: '\u0420\u0443\u043a\u0430 \u0443\u0436\u0435 \u043f\u043e\u043b\u043d\u0430.' };

  const card = cardById(unit.id);
  board[foundLane][foundDepth] = null;
  match.mana[username] += card ? card.cost : 0;

  // Any rally/aunt buff this specific placement queued for OTHER units
  // (Паладин, Родная тетушка) is undone too — the unit granting it is
  // being un-played, so it never should have gone out in the first place.
  // Buffs still queued that were meant to land ON this unit are left
  // alone: they already no-op safely once their target slot comes up
  // empty at resolution time (see the `if (!unit) continue;` guard in
  // tryEndTurn's rally-buff drain).
  match.pendingRallyBuffs = match.pendingRallyBuffs.filter((b) => b.sourceUid !== uid);
  match.pendingHeals = match.pendingHeals.filter((h) => h.sourceUid !== uid);
  match.pendingShots = match.pendingShots.filter((s) => s.sourceUid !== uid);

  hand.push({ id: unit.id, uid: nextUid('card') });
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
  } else if (card.healHero) {
    // Родник: any cell works, occupied or empty, friendly or not — the
    // cell is purely where the player points it, not something the
    // spell reads or changes.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.heal || card.buffHp || card.buffAtk) {
    const unit = depth != null && match.boards[username][lane] && match.boards[username][lane][depth];
    if (!unit) return { error: '\u0422\u0430\u043c \u043d\u0435\u0442 \u0441\u0432\u043e\u0435\u0433\u043e \u0431\u043e\u0439\u0446\u0430.' };
  }

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  match.pendingSpells.push({
    side: username,
    cardId: card.id,
    kind: card.dmg ? 'damage' : (card.healHero ? 'wellspring' : (card.heal ? 'heal' : 'buff')),
    laneIdx: lane,
    depthIdx: depth,
    dmg: card.dmg,
    heal: card.heal,
    healHero: card.healHero,
    drawCard: card.drawCard,
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
    } else if (spell.kind === 'wellspring') {
      // Родник: heals the caster's own hero and draws them a card from
      // their own deck — the targeted cell itself is never touched.
      match.hp[spell.side] += spell.healHero;
      const hand = match.hands[spell.side];
      const beforeLen = hand.length;
      if (spell.drawCard) draw(match.decks[spell.side], hand, spell.drawCard);
      const drew = hand.length > beforeLen;
      events.push({
        type: 'spell', kind: 'wellspring', side: spell.side, cardId: spell.cardId,
        laneIdx: spell.laneIdx, depthIdx: spell.depthIdx, targetSide: spell.side,
        healAmount: spell.healHero, drew,
      });
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

// Аннабэль Рассветная: right before HER OWN attack in a given wave,
// permanently buffs every allied unit currently alive (anywhere on the
// board, not just her lane) by +1/+1 — including herself. Reuses the
// exact 'rallyBuff' event shape (one event per target) so the client's
// existing rally-buff animation just works here too, no new client code
// needed — and since it's pushed to `events` right before this wave's
// own 'wave' event, her own hit this same round already reflects the
// fresh buff (aAtk/bAtk below are computed *after* this runs).
function applyDawnBuff(match, side, events, sourceUid) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u) {
        u.atk += 1;
        u.hp += 1;
        u.maxHp += 1;
        events.push({ type: 'rallyBuff', side, laneIdx: l, targetDepth: d, buffAtk: 1, buffHp: 1, sourceUid });
      }
    }
  }
}

// Епископ: at the start of every round he's alive, picks ONE random
// OTHER allied unit anywhere on the board (never himself — same
// self-exclusion rule as Паладин) and permanently gives it +1/+1. Runs
// once per Епископ found, each with its own fresh random pick — several
// copies on the board each trigger independently, potentially
// compounding on top of each other's picks within the very same round.
// Reuses the 'rallyBuff' event shape, same as applyDawnBuff above.
function applyBishopBuffs(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (!unit || !unit.bishopBuff) continue;
        const targets = [];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            if (l2 === l && d2 === d) continue; // never himself
            if (board[l2][d2]) targets.push({ laneIdx: l2, depthIdx: d2 });
          }
        }
        if (targets.length === 0) continue;
        const chosen = targets[Math.floor(Math.random() * targets.length)];
        const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
        targetUnit.atk += 1;
        targetUnit.hp += 1;
        targetUnit.maxHp += 1;
        events.push({
          type: 'rallyBuff', side, laneIdx: chosen.laneIdx,
          targetDepth: chosen.depthIdx, buffAtk: 1, buffHp: 1, sourceUid: unit.uid,
        });
      }
    }
  }
}

// One full pass over every lane's combat, but only units for which
// `isEligible(unit)` returns true actually get to act this pass —
// everyone else just sits there (still targetable, still able to block,
// exactly like a 0-attack unit already does within a single pass). This
// is what lets First Strike work: call this once with an eligibility
// filter that only admits firstStrike units, then again with the
// opposite filter for the normal exchange — units killed in the first
// call are already gone (frontUnit/actingOrder re-scan the live board
// each time) by the time the second call's targets are picked.
function resolveCombatPass(match, events, isEligible) {
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
      const aEligible = !!(aUnit && isEligible(aUnit));
      const bEligible = !!(bUnit && isEligible(bUnit));

      if (aEligible && aUnit.dawnBuff) applyDawnBuff(match, nameA, events, aUnit.uid);
      if (bEligible && bUnit.dawnBuff) applyDawnBuff(match, nameB, events, bUnit.uid);

      // Synergy units fight with their live effective attack (base + 1
      // per adjacent ally on their own board), recomputed fresh right
      // now — the neighbours that earned this bonus might not be there
      // by the next wave or the next round.
      const aAtk = aEligible ? effectiveAtk(match.boards[nameA], l, aInfo.depth) : 0;
      const bAtk = bEligible ? effectiveAtk(match.boards[nameB], l, bInfo.depth) : 0;

      // A unit whose current effective attack is 0 or less (e.g. Корова,
      // base 0 attack), or one that isn't eligible this particular pass
      // (not First Strike during the First Strike pass, or already
      // spent during the normal pass), doesn't attack this wave at all —
      // it picks no target and deals no damage, and doesn't show up as
      // an attacker in the event below. It can still BE attacked/blocked
      // normally by the other side, same as always.
      const aAttacks = !!(aEligible && aAtk > 0);
      const bAttacks = !!(bEligible && bAtk > 0);
      if (!aAttacks && !bAttacks) continue; // nobody eligible acted this wave — nothing to animate or apply
      const aTarget = aAttacks ? frontUnit(match.boards[nameB], l) : null;
      const bTarget = bAttacks ? frontUnit(match.boards[nameA], l) : null;

      // Armor reduces incoming damage per hit (never goes negative, never
      // consumed) — only units can have it, heroes always take the full
      // hit. The event carries the *actual* damage applied so the client's
      // popup number always matches the real HP change.
      let aApplied = 0, bApplied = 0;
      let aLifesteal = 0, bLifesteal = 0;
      if (aAttacks) {
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
      if (bAttacks) {
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
        attackerA: aAttacks ? { side: nameA, uid: aUnit.uid, depth: aInfo.depth } : null,
        attackerB: bAttacks ? { side: nameB, uid: bUnit.uid, depth: bInfo.depth } : null,
        targetAHero: !!(aAttacks && !aTarget),
        targetBHero: !!(bAttacks && !bTarget),
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

// Первый удар (First Strike): units with this flag fight in their own
// pass BEFORE everyone else — resolveCombat below runs resolveCombatPass
// twice, first admitting only firstStrike units, then admitting
// everyone else. A First Strike unit killed by another First Strike unit
// never gets to act in the (later) normal pass, same as it would if it
// simply died mid-combat any other time; a First Strike unit that lands
// a kill in its own pass means that target is already gone by the time
// the normal pass picks targets.
function resolveCombat(match, events) {
  resolveCombatPass(match, events, (unit) => !!unit.firstStrike);
  resolveCombatPass(match, events, (unit) => !unit.firstStrike);
}

export function tryEndTurn(match, username) {
  if (match.phase !== 'placing') return { ready: false };
  match.readyToEnd[username] = true;
  const [nameA, nameB] = match.players;
  if (!match.readyToEnd[nameA] || !match.readyToEnd[nameB]) {
    return { ready: false };
  }

  match.phase = 'resolving';

  // Both sides' placements are locked in the instant resolution starts —
  // units placed this round stop being "provisional" (dimmed and
  // repositionable client-side) right now, even though combat hasn't
  // actually played out yet. This has to happen *before* preBoards is
  // captured below, since that's the snapshot the client reveals first:
  // my own units should already read as solid, and the opponent's newly
  // revealed units should play their entrance animation (which is
  // suppressed for anything still flagged as mid-placement).
  for (const name of match.players) {
    const board = match.boards[name];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (board[l][d]) board[l][d].placedThisRound = false;
      }
    }
  }

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

  // Монахиня's heal lands here too — same moment as rally buffs above,
  // right at the start of resolution, so both players see it as a
  // revealed event instead of a silent HP change during placing.
  const healQueue = match.pendingHeals;
  match.pendingHeals = [];
  for (const heal of healQueue) {
    match.hp[heal.side] += heal.amount;
    events.push({ type: 'heroHeal', side: heal.side, amount: heal.amount, sourceUid: heal.sourceUid, laneIdx: heal.laneIdx, depthIdx: heal.depthIdx });
  }

  // Арбалетчик's battlecry shot — also right here, using the board as it
  // stands right now (both sides fully revealed for this round) to work
  // out her live Synergy-boosted attack.
  const shotQueue = match.pendingShots;
  match.pendingShots = [];
  for (const shot of shotQueue) {
    const unit = match.boards[shot.side][shot.laneIdx] && match.boards[shot.side][shot.laneIdx][shot.depthIdx];
    if (!unit) continue;
    const targetSide = match.players.find((p) => p !== shot.side);
    const amount = effectiveAtk(match.boards[shot.side], shot.laneIdx, shot.depthIdx);
    match.hp[targetSide] -= amount;
    events.push({
      type: 'heroShot', side: shot.side, targetSide, amount,
      laneIdx: shot.laneIdx, depthIdx: shot.depthIdx, sourceUid: shot.sourceUid,
    });
  }

  // Епископ fires here too — at the very start of resolution, same
  // moment as everything else above, before spells or combat.
  applyBishopBuffs(match, events);

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
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: unit.atk, laneIdx: l, depthIdx: d });
          }
          // Корова: 50/50 per round — heals for her own CURRENT hp at
          // this exact moment (not a fixed number, not attack), so a
          // heavily-damaged Корова gives back much less than a fresh one.
          if (unit && unit.cowHeal && Math.random() < 0.5) {
            match.hp[name] += unit.hp;
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: unit.hp, laneIdx: l, depthIdx: d });
          }
          // Арбалетчик: fires again at the end of every round she
          // survives, same as her battlecry — enemy hero takes damage
          // equal to her live (Synergy-boosted) attack right now.
          if (unit && unit.shootHero) {
            const targetSide = match.players.find((p) => p !== name);
            const amount = effectiveAtk(board, l, d);
            match.hp[targetSide] -= amount;
            events.push({
              type: 'heroShot', side: name, targetSide, amount,
              laneIdx: l, depthIdx: d, sourceUid: unit.uid,
            });
          }
          // Каменная Стена: grows sturdier at the end of every round she
          // survives — permanently +2 to her OWN hp (and maxHp). Reuses
          // the rallyBuff event/animation, targeting her own cell, with
          // buffAtk:0 since only her hp changes.
          if (unit && unit.wallGrow) {
            unit.hp += 2;
            unit.maxHp += 2;
            events.push({
              type: 'rallyBuff', side: name, laneIdx: l,
              targetDepth: d, buffAtk: 0, buffHp: 2, sourceUid: unit.uid,
            });
          }
        }
      }
    }

    // An end-of-round shot (Арбалетчик) can itself bring a hero to 0 —
    // something none of the OTHER end-of-round triggers could ever do
    // (they only ever add HP to their own owner's hero). Re-check for a
    // decided match here, same logic as the pre-loop check above, before
    // letting the round actually advance.
    if (match.hp[nameA] <= 0 || match.hp[nameB] <= 0) {
      match.phase = 'over';
      match.status = 'finished';
      if (match.hp[nameA] <= 0 && match.hp[nameB] <= 0) winner = null;
      else winner = match.hp[nameA] > 0 ? nameA : nameB;
      match.winner = winner;
    } else if (match.round >= MAX_ROUNDS) {
      // Round limit reached and both heroes still standing — whoever has
      // more HP right now wins; exactly equal HP is a draw. No new round
      // starts (phase goes straight to 'over', same as any other
      // match-ending branch).
      match.phase = 'over';
      match.status = 'finished';
      if (match.hp[nameA] === match.hp[nameB]) winner = null;
      else winner = match.hp[nameA] > match.hp[nameB] ? nameA : nameB;
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
