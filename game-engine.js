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
  { id: 'c1', name: '\u041a\u0440\u0435\u0441\u0442\u044c\u044f\u043d\u0438\u043d', type: 'creature', cost: 2, atk: 1, hp: 3, rarity: 'common' , faction: 'empire' },
  { id: 'c2', name: '\u0429\u0438\u0442\u043e\u043d\u043e\u0441\u0435\u0446', type: 'creature', cost: 2, atk: 1, hp: 5, armor: 1, rarity: 'common' , faction: 'empire' },
  { id: 'c3', name: '\u0421\u0442\u0440\u0430\u0436\u043d\u0438\u043a', type: 'creature', cost: 2, atk: 2, hp: 1, rarity: 'common' , faction: 'empire' },
  { id: 'c4', name: '\u041d\u0430\u0451\u043c\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 3, rarity: 'common' , faction: 'empire' },
  { id: 'c6', name: '\u041c\u043e\u043b\u043e\u0442\u043e\u0431\u043e\u0435\u0446', type: 'creature', cost: 4, atk: 5, hp: 2, rarity: 'common' , faction: 'empire' },
  { id: 'c7', name: '\u041a\u0430\u043c\u0435\u043d\u043d\u0430\u044f \u0421\u0442\u0435\u043d\u0430', type: 'creature', cost: 2, atk: 0, hp: 4, wallGrow: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c8', name: '\u041f\u0430\u043b\u0430\u0434\u0438\u043d', type: 'creature', cost: 5, atk: 4, hp: 2, rallyBuff: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c10', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446', type: 'creature', cost: 1, atk: 1, hp: 1, rarity: 'common' , faction: 'empire' },
  { id: 'c11', name: '\u0421\u0442\u0440\u0430\u0436 \u0434\u0432\u043e\u0440\u0446\u0430', type: 'creature', cost: 2, atk: 2, hp: 2, lifesteal: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c12', name: '\u041b\u0435\u0433\u0438\u043e\u043d\u0435\u0440', type: 'creature', cost: 3, atk: 2, hp: 3, lifesteal: true, synergy: 1, rarity: 'epic' , faction: 'empire' },
  { id: 's1', name: '\u041a\u043e\u043b\u044c\u0447\u0443\u0433\u0430', type: 'spell', cost: 2, buffHp: 3, buffAtk: 1, rarity: 'common' , faction: 'empire' },
  // Unlike every other spell, this one can target ANY cell — empty or
  // occupied by anyone — because it doesn't actually touch whatever's
  // there; the cell is just where the player points it. Heals the
  // caster's own hero and draws them a card from their own deck. See
  // castSpell()'s `card.healHero` branch and resolveSpells()'s
  // 'wellspring' kind further down.
  { id: 's2', name: '\u0420\u043e\u0434\u043d\u0438\u043a', type: 'spell', cost: 2, healHero: 2, drawCard: 1, rarity: 'rare' , faction: 'empire' },
  { id: 's3', name: '\u0414\u043e\u0441\u043f\u0435\u0445\u0438', type: 'spell', cost: 3, buffAtk: 2, buffHp: 2, buffArmor: 1, rarity: 'epic' , faction: 'empire' },
  // Мгновенный призыв: see castSpell/tryEndTurn — resolves before rally
  // buffs, heals, shots, Епископ, and the normal spell phase, calling
  // summonUnitToRandomFreeCell 3 times to fill up to 3 random empty
  // cells with a fresh c10 each (fewer if less room is available).
  { id: 's4', name: '\u041e\u0442\u0440\u044f\u0434 \u043e\u043f\u043e\u043b\u0447\u0435\u043d\u0446\u0435\u0432', type: 'spell', cost: 3, instantSummon: true, summonCardId: 'c10', summonCount: 3, rarity: 'rare' , faction: 'empire' },
  // Targets an entire enemy lane (all 3 depth positions), not a single
  // cell — see the 'wrath' spell kind in resolveSpells, which hits every
  // cell in the lane with its own sequential event.
  { id: 's5', name: '\u0413\u043d\u0435\u0432 \u043d\u0435\u0431\u0435\u0441', type: 'spell', cost: 5, wrathDmg: 7, rarity: 'rare' , faction: 'empire' },
  // endOfRoundSpell: see the endOfRoundSpellQueue extraction/resolution
  // in tryEndTurn — unlike every other spell, this one resolves AFTER
  // combat, not before.
  { id: 's6', name: '\u041a\u0440\u0435\u0441\u0442\u044c\u044f\u043d\u0441\u043a\u043e\u0435 \u043e\u043f\u043e\u043b\u0447\u0435\u043d\u0438\u0435', type: 'spell', cost: 5, endOfRoundSpell: true, summonCardId: 'c1', summonCount: 5, healAmount: 5, rarity: 'epic' , faction: 'empire' },
  // bounceToHand: see the 'skyWhirlwind' spell kind in resolveSpells.
  { id: 's7', name: '\u0412\u043e\u0437\u0434\u0443\u0448\u043d\u0430\u044f \u0431\u0443\u0440\u044f', type: 'spell', cost: 4, bounceToHand: true, bounceMilitiaChance: 0.3, rarity: 'epic' , faction: 'empire' },
  // randomBlind: see the 'randomBlind' spell kind in resolveSpells —
  // reuses match.blindedUids exactly like Рейна Ослепительная, just for
  // one random enemy unit instead of all of them.
  { id: 's8', name: '\u042f\u0440\u043a\u0438\u0439 \u0441\u0432\u0435\u0442', type: 'spell', cost: 2, randomBlind: true, rarity: 'rare' , faction: 'empire' },
  { id: 's9', name: '\u0421\u0443\u043c\u043a\u0430 \u0441 \u043f\u0440\u0438\u043f\u0430\u0441\u0430\u043c\u0438', type: 'spell', cost: 2, buffAtk: 1, buffHp: 1, buffLifesteal: true, rarity: 'rare' , faction: 'empire' },
  { id: 's10', name: '\u041d\u0430\u043f\u043b\u0435\u0447\u043d\u0438\u043a', type: 'spell', cost: 1, buffHp: 1, drawIfArmored: true, rarity: 'rare' , faction: 'empire' },
  // lifeLight: see the 'lifeLight' spell kind in resolveSpells — heals
  // own hero, then conditionally summons onto the SPECIFIC targeted
  // cell (not a random one) if that leaves the caster's hero ahead.
  { id: 's11', name: '\u0421\u0432\u0435\u0442 \u0436\u0438\u0437\u043d\u0438', type: 'spell', cost: 4, lifeLight: true, healAmount: 10, summonCardId: 'c10', rarity: 'rare' , faction: 'empire' },
  // guardCall: see the guardCallQueue extraction in tryEndTurn (fires in
  // the Мгновенный призыв phase, same as Отряд ополченцев).
  { id: 's12', name: '\u0412\u044b\u0437\u043e\u0432 \u0441\u0442\u0440\u0430\u0436\u0438', type: 'spell', cost: 4, guardCall: true, summonCardId: 'c11', rarity: 'epic' , faction: 'empire' },
  // heavenlyRays: see the 'heavenlyRays' spell kind in resolveSpells —
  // reuses applyDawnBuff (parametrized to 2) for the "buff everyone" loop.
  { id: 's13', name: '\u041d\u0435\u0431\u0435\u0441\u043d\u044b\u0435 \u043b\u0443\u0447\u0438', type: 'spell', cost: 4, heavenlyRays: true, rarity: 'epic' , faction: 'empire' },
  { id: 'c13', name: '\u041f\u043e\u0432\u0430\u0440', type: 'creature', cost: 3, atk: 2, hp: 2, cookHeal: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c14', name: '\u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446 \u0441 \u0434\u0443\u0431\u0438\u043d\u043e\u0439', type: 'creature', cost: 3, atk: 3, hp: 1, rarity: 'common' , faction: 'empire' },
  { id: 'c15', name: '\u041a\u0440\u0435\u043f\u043a\u0438\u0439 \u0440\u0430\u0431\u043e\u0442\u044f\u0433\u0430', type: 'creature', cost: 4, atk: 3, hp: 4, rarity: 'common' , faction: 'empire' },
  { id: 'c16', name: '\u0420\u043e\u0434\u043d\u0430\u044f \u0442\u0435\u0442\u0443\u0448\u043a\u0430', type: 'creature', cost: 3, atk: 1, hp: 2, auntBuff: true, rarity: 'common' , faction: 'empire' },
  // Перед своей атакой в бою (каждый раунд, пока жива) навсегда даёт +1/+1
  // всем союзным юнитам на поле, включая себя — см. applyDawnBuff() в
  // resolveCombat() ниже. Эффект накопительный: чем дольше она остаётся
  // в бою, тем сильнее становится вся команда.
  { id: 'c17', name: '\u0410\u043d\u043d\u0430\u0431\u044d\u043b\u044c \u0420\u0430\u0441\u0441\u0432\u0435\u0442\u043d\u0430\u044f', type: 'creature', cost: 2, atk: 1, hp: 1, dawnBuff: true, rarity: 'legendary' , faction: 'empire' },
  // Battlecry: heals her owner's hero by a fixed amount the instant she's
  // placed (see placeCard() below) — immediate, not deferred like
  // rallyBuff/auntBuff, since the hero's own HP is already visible to its
  // owner during their own placing phase (nothing dramatic to reveal).
  { id: 'c18', name: '\u041c\u043e\u043d\u0430\u0445\u0438\u043d\u044f', type: 'creature', cost: 2, atk: 1, hp: 2, healOnPlay: 2, rarity: 'rare' , faction: 'empire' },
  // End-of-round trigger, 50% chance per round: heals her owner's hero by
  // an amount equal to HER OWN current HP at that exact moment (not a
  // fixed number, and not attack like Повар's cookHeal) — see the
  // cowHeal check alongside cookHeal's, further down.
  { id: 'c19', name: '\u041a\u043e\u0440\u043e\u0432\u0430', type: 'creature', cost: 2, atk: 0, hp: 4, cowHeal: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c20', name: '\u0421\u0442\u0440\u0430\u0436 \u0432\u043e\u0440\u043e\u0442', type: 'creature', cost: 3, atk: 3, hp: 3, armor: 1, rarity: 'rare' , faction: 'empire' },
  // Synergy 1 = +1 atk per adjacent ally, same rule as Легионер. On top
  // of that, shootHeroStartOfTurn (reworked from the original shootHero)
  // fires TWICE per lifetime-in-a-round-cycle: once as a battlecry the
  // instant she's placed (queued via match.pendingShots, revealed at the
  // start of resolution so the opponent sees it), and again at the
  // START of every round AFTER the one she was placed in (match.round >
  // bornRound excludes her own birth round, since the battlecry already
  // covered it) — both times hitting the enemy hero for damage equal to
  // her CURRENT effective attack (base + synergy) at that exact moment.
  { id: 'c21', name: '\u0410\u0440\u0431\u0430\u043b\u0435\u0442\u0447\u0438\u043a', type: 'creature', cost: 3, atk: 1, hp: 4, synergy: 1, shootHeroStartOfTurn: true, rarity: 'rare' , faction: 'empire' },
  // Same permanent +1/+1-to-a-random-ally idea as Паладин/Родная тетушка,
  // but recurring instead of a one-time battlecry: fires again at the
  // START of every round he's still alive (see applyBishopBuffs() in
  // tryEndTurn, same moment rallyBuff/heal/shot queues are drained), each
  // time picking a fresh random OTHER ally anywhere on the board — same
  // self-exclusion rule as Паладин, never buffs himself.
  { id: 'c22', name: '\u0415\u043f\u0438\u0441\u043a\u043e\u043f', type: 'creature', cost: 3, atk: 1, hp: 3, bishopBuff: true, rarity: 'epic' , faction: 'empire' },
  // 0 base attack — per the zero-attack rule, she never acts alone. Her
  // synergy is double Легионер/Арбалетчик's (+2 per adjacent ally
  // instead of +1), so even a single neighbour already gets her
  // swinging, and a full ring of four makes her hit as hard as +8.
  { id: 'c23', name: '\u0411\u0430\u043b\u043b\u0438\u0441\u0442\u0430', type: 'creature', cost: 3, atk: 0, hp: 4, synergy: 2, rarity: 'rare' , faction: 'empire' },
  // Первый удар (First Strike): fights in its own combat pass BEFORE
  // every other unit — see resolveCombat()/resolveCombatPass() below,
  // which runs a firstStrike-only pass first, then a second pass for
  // everyone else. A target this kills in that first pass is already
  // gone by the time normal units get their turn.
  { id: 'c24', name: '\u041b\u0443\u0447\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 2, firstStrike: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c25', name: '\u0414\u0432\u043e\u0440\u0446\u043e\u0432\u0430\u044f \u0441\u0442\u0435\u043d\u0430', type: 'creature', cost: 3, atk: 0, hp: 10, armor: 1, rarity: 'epic' , faction: 'empire' },
  // See buildUnitFromCard/summonUnitToRandomFreeCell/resolveCombatPass:
  // every time its attack lands directly on the enemy hero, calls in a
  // fresh Ополченец (c10) onto a random empty cell of its own board.
  { id: 'c26', name: '\u0425\u0440\u0430\u043c\u043e\u0432\u044b\u0439 \u0431\u043e\u0435\u0446', type: 'creature', cost: 2, atk: 2, hp: 2, summonOnHeroHit: 'c10', rarity: 'epic' , faction: 'empire' },
  // Ends every round by permanently healing (+2 hp/maxHp) one random
  // OTHER ally on his own board — see the priestHeal branch inlined in
  // the end-of-round loop right next to Каменная Стена's wallGrow,
  // reusing the exact same rallyBuff event/animation.
  { id: 'c27', name: '\u0421\u0432\u044f\u0449\u0435\u043d\u043d\u0438\u043a', type: 'creature', cost: 4, atk: 1, hp: 4, priestHeal: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c28', name: '\u042d\u043b\u0438\u0442\u0430 \u0445\u0440\u0430\u043c\u0430', type: 'creature', cost: 4, atk: 2, hp: 4, synergy: 2, rarity: 'rare' , faction: 'empire' },
  { id: 'c29', name: '\u0413\u0440\u0438\u0444\u043e\u043d', type: 'creature', cost: 4, atk: 4, hp: 2, lifesteal: true, rarity: 'rare' , faction: 'empire' },
  // siegeShot: same end-of-round trigger Арбалетчик's own shootHero used
  // to have before its rework (now used by Лучник прерий instead), but
  // fires a fixed 2 damage at a random ENEMY UNIT instead of the hero —
  // see the siegeShot branch in tryEndTurn's end-of-round loop.
  { id: 'c30', name: '\u041e\u0441\u0430\u0434\u043d\u0430\u044f \u0431\u0430\u0448\u043d\u044f', type: 'creature', cost: 4, atk: 1, hp: 8, siegeShot: true, rarity: 'rare' , faction: 'empire' },
  // battlecrySummon: on placement, queues a summon (see pendingBattlecrySummons
  // in tryEndTurn) resolved onto a random free cell at the start of the
  // next resolution, same deferred-reveal pattern as Монахиня/Арбалетчик.
  { id: 'c31', name: '\u0422\u043e\u043b\u0441\u0442\u044b\u0439 \u043a\u0430\u0440\u0430\u0443\u043b\u044c\u043d\u044b\u0439', type: 'creature', cost: 4, atk: 2, hp: 3, battlecrySummon: 'c10', rarity: 'rare' , faction: 'empire' },
  { id: 'c32', name: '\u042d\u043b\u0438\u0442\u043d\u044b\u0439 \u043b\u0443\u0447\u043d\u0438\u043a', type: 'creature', cost: 4, atk: 4, hp: 3, firstStrike: true, rarity: 'rare' , faction: 'empire' },
  // Combines two existing mechanics: battlecrySummon (once, on placement)
  // and endOfRoundSummon (repeating, every round she survives) — see
  // pendingBattlecrySummons in tryEndTurn for the former, the
  // endOfRoundSummon branch in the end-of-round loop for the latter.
  { id: 'c33', name: '\u041b\u0430\u0433\u0435\u0440\u044c \u043e\u043f\u043e\u043b\u0447\u0435\u043d\u0446\u0435\u0432', type: 'creature', cost: 4, atk: 0, hp: 6, battlecrySummon: 'c10', endOfRoundSummon: 'c10', rarity: 'rare' , faction: 'empire' },
  // Защитник (Defender): never attacks in normal combat (see the
  // resolveCombat wrapper above). Her own mechanic — cannonShot — fires
  // in the end-of-round loop instead, striking her OWN lane's mirror on
  // the enemy side.
  { id: 'c34', name: '\u0418\u043c\u043f\u0435\u0440\u0441\u043a\u0430\u044f \u043f\u0443\u0448\u043a\u0430', type: 'creature', cost: 4, atk: 4, hp: 9, defender: true, cannonShot: true, rarity: 'rare' , faction: 'empire' },
  { id: 'c35', name: '\u0421\u0432\u044f\u0449\u0435\u043d\u043d\u0438\u043a \u041b\u0443\u043d\u044b', type: 'creature', cost: 4, atk: 1, hp: 3, fixedHeal: 7, rarity: 'epic' , faction: 'empire' },
  // summonOnHeroHit now stores WHICH card to summon (see the c26 refactor
  // above) — this one calls in a Страж дворца instead of an Ополченец.
  { id: 'c36', name: '\u041a\u0430\u043f\u0438\u0442\u0430\u043d \u0434\u0432\u043e\u0440\u0446\u043e\u0432\u043e\u0439 \u0441\u0442\u0440\u0430\u0436\u0438', type: 'creature', cost: 4, atk: 3, hp: 6, lifesteal: true, summonOnHeroHit: 'c11', rarity: 'epic' , faction: 'empire' },
  { id: 'c37', name: '\u041a\u0430\u043d\u043e\u043d\u0438\u0441\u0441\u0430', type: 'creature', cost: 4, atk: 5, hp: 5, armor: 2, lifesteal: true, spellResist: true, rarity: 'legendary' , faction: 'empire' },
  { id: 'c38', name: '\u0426\u0435\u043d\u0442\u0443\u0440\u0438\u043e\u043d', type: 'creature', cost: 5, atk: 5, hp: 5, armor: 3, synergy: 1, rarity: 'epic' , faction: 'empire' },
  // Топот (Trample): see applyTrampleCascade — an overkill from her
  // primary hit continues onward through the same lane, then the hero.
  { id: 'c39', name: '\u042f\u0440\u043b \u0416\u0435\u043b\u0435\u0437\u043d\u043e\u0431\u043e\u043a\u0438\u0439', type: 'creature', cost: 5, atk: 5, hp: 10, armor: 1, synergy: 3, trample: true, rarity: 'legendary' , faction: 'empire' },
  // punisherKill: see pendingPunisherKills in tryEndTurn — battlecry
  // instantly kills the first bornRound-this-turn enemy unit in the
  // mirrored lane, Чаростойкость blocks it outright (no redirect).
  { id: 'c40', name: '\u041a\u0430\u0440\u0430\u044e\u0449\u0438\u0439 \u0430\u043d\u0433\u0435\u043b', type: 'creature', cost: 6, atk: 4, hp: 6, lifesteal: true, punisherKill: true, rarity: 'epic' , faction: 'empire' },
  // Двойное омоложение (doubleHeal): see hasDoubleHeal/healHero above —
  // every hero-heal source in the file routes through that shared
  // function, so this doubles every single one of them uniformly, not
  // just her own battlecry. She's already on the board by the time her
  // own healOnPlay resolves (see pendingHeals in tryEndTurn), so it
  // doubles too.
  { id: 'c41', name: '\u0418\u043c\u043f\u0435\u0440\u0441\u043a\u0438\u0439 \u043f\u0430\u0442\u0440\u0438\u0430\u0440\u0445', type: 'creature', cost: 6, atk: 2, hp: 6, doubleHeal: true, healOnPlay: 10, rarity: 'legendary' , faction: 'empire' },
  { id: 'c42', name: '\u0420\u044b\u0446\u0430\u0440\u044c', type: 'creature', cost: 6, atk: 5, hp: 5, armor: 2, healOnPlay: 6, rarity: 'epic' , faction: 'empire' },
  // baronBuff: see applyDawnBuff (reused as-is, just triggered at
  // end-of-round instead of before each attack) — buffs every ally on
  // the board, himself included, by +1/+1 permanently.
  { id: 'c43', name: '\u0411\u0430\u0440\u043e\u043d', type: 'creature', cost: 6, atk: 4, hp: 6, armor: 1, synergy: 1, baronBuff: true, rarity: 'epic' , faction: 'empire' },
  // battlecrySummonCount parametrizes battlecrySummon's quantity (was
  // hardcoded to 1) — calls in TWO Грифоны instead of one.
  { id: 'c44', name: '\u0414\u0432\u043e\u0440\u0446\u043e\u0432\u044b\u0439 \u0433\u0440\u0438\u0444\u043e\u043d', type: 'creature', cost: 7, atk: 6, hp: 4, lifesteal: true, battlecrySummon: 'c29', battlecrySummonCount: 2, rarity: 'epic' , faction: 'empire' },
  { id: 'c45', name: '\u0410\u0445\u0438\u043b\u043b\u0435\u0441-\u043a\u0440\u0443\u0448\u0438\u0442\u0435\u043b\u044c', type: 'creature', cost: 7, atk: 0, hp: 18, armor: 2, synergy: 5, rarity: 'epic' , faction: 'empire' },
  // blindEnemiesOnPlay: see pendingBlinds/match.blindedUids in tryEndTurn
  // — a ONE-ROUND version of Защитник applied to every current enemy
  // unit (except spellResist ones), cleared right after this round's
  // combat resolves.
  { id: 'c46', name: '\u0420\u0435\u0439\u043d\u0430 \u041e\u0441\u043b\u0435\u043f\u0438\u0442\u0435\u043b\u044c\u043d\u0430\u044f', type: 'creature', cost: 7, atk: 7, hp: 10, healOnPlay: 7, blindEnemiesOnPlay: true, rarity: 'legendary' , faction: 'empire' },
  // Same cannonShot mechanic as Имперская пушка, but with a fixed damage
  // amount (not attack-based, since she has 0 atk) and a 30% chance of a
  // second, independent shot.
  { id: 'c47', name: '\u0418\u043c\u043f\u0435\u0440\u0441\u043a\u0438\u0439 \u0431\u0430\u0441\u0442\u0438\u043e\u043d', type: 'creature', cost: 8, atk: 0, hp: 25, armor: 1, cannonShot: true, cannonShotFixed: 6, cannonShotExtraChance: 0.3, rarity: 'epic' , faction: 'empire' },
  // warlordBuff: see pendingWarlordBuffs in tryEndTurn — buffs every ally
  // +1/+1 (applyDawnBuff), then permanently grants Двойной удар to every
  // currently-armored ally (himself included). Двойной удар itself is
  // implemented in actingOrder — see the comment there.
  { id: 'c48', name: '\u0418\u043c\u043f\u0435\u0440\u0441\u043a\u0438\u0439 \u043f\u043e\u043b\u043a\u043e\u0432\u043e\u0434\u0435\u0446', type: 'creature', cost: 8, atk: 5, hp: 10, armor: 1, warlordBuff: true, rarity: 'legendary' , faction: 'empire' },
  // Same punisherKill mechanic as Карающий ангел — see pendingPunisherKills
  // in tryEndTurn for the full implementation.
  { id: 'c49', name: '\u0418\u043c\u043f\u0435\u0440\u0441\u043a\u0438\u0439 \u043a\u0430\u0432\u0430\u043b\u0435\u0440\u0438\u0441\u0442', type: 'creature', cost: 5, atk: 6, hp: 3, punisherKill: true, rarity: 'rare' , faction: 'empire' },
  // healTrigger: see healHero above — every time healing lands for his
  // own side, permanently buffs a random OTHER ally +1atk/+3hp.
  { id: 'c50', name: '\u0421\u0432\u044f\u0449\u0435\u043d\u043d\u0438\u043a \u0441\u0432\u044f\u0442\u043e\u0433\u043e \u0421\u0432\u0435\u0442\u0430', type: 'creature', cost: 5, atk: 2, hp: 5, healOnPlay: 3, healTrigger: true, rarity: 'epic' , faction: 'empire' },
  // blacksmithBuff: see the end-of-round loop in tryEndTurn — always
  // improves himself +1atk/+1armor, plus a random OTHER armored ally.
  { id: 'c51', name: '\u041a\u0443\u0437\u043d\u0435\u0446', type: 'creature', cost: 4, atk: 1, hp: 6, armor: 1, blacksmithBuff: true, rarity: 'epic' , faction: 'empire' },
  // powderKeg: throws at a random SQUARE anywhere on the enemy board —
  // occupied or not, empty redirects to the hero (see the end-of-round
  // loop in tryEndTurn). explodeOnDeath: handled by the shared killUnit
  // helper, applied the instant he actually dies, from any cause.
  { id: 'c52', name: '\u041f\u043e\u0434\u0440\u044b\u0432\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 1, hp: 4, powderKeg: true, explodeOnDeath: true, rarity: 'rare' , faction: 'empire' },
  // statueBuff: see applyStatueBuffs — now fires at the START of every
  // round (moved from end-of-round), reuses adjacentAllyPositions
  // (already used by Родная тетушка). Also a Защитник — never attacks.
  { id: 'c53', name: '\u0421\u0442\u0430\u0442\u0443\u044f', type: 'creature', cost: 3, atk: 1, hp: 6, defender: true, statueBuff: true, rarity: 'rare' , faction: 'empire' },
  // weaponThrowOnDeath: see killUnit above — on death, throws his
  // weapon at a random depth in HIS OWN lane on the enemy side, empty
  // redirects to hero, Чаростойкость blocks outright.
  { id: 'c54', name: '\u041c\u0435\u0442\u0435\u043e\u0440\u0438\u0442\u043d\u044b\u0439 \u0441\u0442\u0440\u0430\u0436', type: 'creature', cost: 2, atk: 2, hp: 1, armor: 1, weaponThrowOnDeath: true, rarity: 'epic' , faction: 'empire' },
  { id: 'c55', name: '\u0421\u043b\u0435\u0434\u043e\u043f\u044b\u0442', type: 'creature', cost: 1, atk: 1, hp: 1, synergy: 1, rarity: 'rare' , faction: 'empire' },
  // musketShot: see applyMusketShot above, hooked in right before his
  // own attack in resolveCombatPass (same spot as Аннабэль's dawnBuff).
  { id: 'c56', name: '\u041c\u0443\u0448\u043a\u0435\u0442\u0435\u0440', type: 'creature', cost: 4, atk: 3, hp: 5, musketShot: true, rarity: 'rare' , faction: 'empire' },
  // lunaBlind: see applyLunaBlind above — persistent aura, re-evaluated
  // every round she's alive, checking her CURRENT lane each time.
  { id: 'c57', name: '\u041b\u0443\u043d\u0430, \u0433\u043e\u043b\u043e\u0441 \u0431\u0443\u0434\u0443\u0449\u0435\u0433\u043e', type: 'creature', cost: 4, atk: 0, hp: 1, spellResist: true, lunaBlind: true, rarity: 'legendary' , faction: 'empire' },
  // legacy: see the legacyValue transfer mechanic in killUnit above —
  // first card of the Дзен faction.
  { id: 'c58', name: '\u041e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a', type: 'creature', cost: 1, atk: 1, hp: 2, legacy: 1, rarity: 'rare' , faction: 'zen' },
  // bambooShotOnPlay: battlecry throw (see pendingBambooShots in
  // tryEndTurn). bambooShotRecurring: pre-attack throw starting the
  // round AFTER placement (see applyBambooRecurringShot, gated by
  // match.round > bornRound).
  { id: 'c59', name: '\u0411\u0430\u043c\u0431\u0443\u043a\u043e\u0432\u044b\u0439 \u0441\u0442\u0440\u0435\u043b\u043e\u043a', type: 'creature', cost: 1, atk: 2, hp: 1, bambooShotOnPlay: 2, bambooShotRecurring: 1, rarity: 'rare' , faction: 'zen' },
  // Part of the Дзен starter deck (see zenStarterDeckCounts below) —
  // granted once the faction is unlocked, a mechanism not built yet.
  { id: 'c60', name: '\u041e\u043b\u0435\u043d\u044c-\u0414\u0430\u043e\u0441', type: 'creature', cost: 2, atk: 2, hp: 1, legacy: 1, rarity: 'common' , faction: 'zen' },
  // deerSwordsman: see the depth-based stat shaping in placeCard above.
  { id: 'c61', name: '\u041e\u043b\u0435\u043d\u044c-\u043c\u0435\u0447\u043d\u0438\u043a', type: 'creature', cost: 2, atk: 2, hp: 2, deerSwordsman: true, rarity: 'common' , faction: 'zen' },
  // herbalist: see the pendingHerbalist queue in placeCard/tryEndTurn.
  { id: 'c62', name: '\u0422\u0440\u0430\u0432\u043d\u0438\u0446\u0430', type: 'creature', cost: 2, atk: 2, hp: 2, herbalist: true, rarity: 'rare' , faction: 'zen' },
  // counterattack: see the Контратака block in resolveCombatPass above.
  { id: 'c63', name: '\u0427\u0430\u0441\u0442\u043e\u043a\u043e\u043b', type: 'creature', cost: 2, atk: 1, hp: 5, defender: true, counterattack: true, rarity: 'common' , faction: 'zen' },
  // bambooGuardian: see the Наследие-transfer reaction inside killUnit.
  { id: 'c64', name: '\u0411\u0430\u043c\u0431\u0443\u043a\u043e\u0432\u044b\u0439 \u0441\u0442\u0440\u0430\u0436', type: 'creature', cost: 2, atk: 1, hp: 5, bambooGuardian: true, rarity: 'common' , faction: 'zen' },
  // Part of the Дзен starter deck (see zenStarterDeckCounts below).
  // monkGrow: see the end-of-round self-growth block above.
  { id: 'c65', name: '\u041c\u043e\u043d\u0430\u0445-\u0430\u0441\u043a\u0435\u0442', type: 'creature', cost: 3, atk: 2, hp: 2, legacy: 1, monkGrow: true, rarity: 'common' , faction: 'zen' },
  // bounceCellAndNeighbor: see the 'bounceCellAndNeighbor' spell kind in
  // resolveSpells — targets a specific enemy cell (new targeting shape,
  // see the client's highlightEnemyCellsForSpell).
  { id: 's14', name: '\u041d\u0435\u0431\u0435\u0441\u043d\u044b\u0439 \u0432\u0438\u0445\u0440\u044c', type: 'spell', cost: 2, bounceCellAndNeighbor: true, rarity: 'rare' , faction: 'zen' },
  // treeWrath: see the 'treeWrath' spell kind in resolveSpells — hero
  // always takes it, a unit in the picked cell takes it TOO (not
  // instead of the hero).
  { id: 's15', name: '\u042f\u0440\u043e\u0441\u0442\u044c \u0434\u0440\u0435\u0432\u0430', type: 'spell', cost: 2, treeWrath: true, treeWrathAmount: 4, rarity: 'rare' , faction: 'zen' },
  // Персик: token spell, only ever obtainable via Персиковый сад — never
  // part of any deck build, and permanently excluded from the shop
  // (noShop) regardless of whether Дзен itself is unlocked, in addition
  // to the temporary faction-wide lock.
  { id: 's16', name: '\u041f\u0435\u0440\u0441\u0438\u043a', type: 'spell', cost: 0, buffHp: 1, rarity: 'common', noShop: true , faction: 'zen' },
  // peachOrchard: see the end-of-round card-granting block above — the
  // value is the id of the card it hands out (Персик).
  { id: 'c66', name: '\u041f\u0435\u0440\u0441\u0438\u043a\u043e\u0432\u044b\u0439 \u0441\u0430\u0434', type: 'creature', cost: 2, atk: 0, hp: 4, peachOrchard: 's16', rarity: 'epic' , faction: 'zen' },
  // divineVines: see the end-of-round doubling block above.
  { id: 'c67', name: '\u0411\u043e\u0436\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0435 \u043b\u043e\u0437\u044b', type: 'creature', cost: 2, atk: 0, hp: 2, divineVines: true, rarity: 'epic' , faction: 'zen' },
  // Part of the Дзен starter deck (see zenStarterDeckCounts below).
  { id: 'c68', name: '\u0414\u0430\u043e\u0441 \u0441 \u043f\u043e\u0441\u043e\u0445\u043e\u043c', type: 'creature', cost: 3, atk: 1, hp: 4, legacy: 1, rarity: 'common' , faction: 'zen' },
  // timeIllusionist: see the instant swap-on-play block above.
  { id: 'c69', name: '\u0418\u043b\u043b\u044e\u0437\u0438\u043e\u043d\u0438\u0441\u0442 \u0432\u0440\u0435\u043c\u0435\u043d\u0438', type: 'creature', cost: 3, atk: 3, hp: 1, legacy: 1, timeIllusionist: true, rarity: 'rare' , faction: 'zen' },
  // foxSwordOnPlay: see pendingFoxSword above.
  { id: 'c70', name: '\u041b\u0438\u0441 \u0441 \u043c\u0435\u0447\u043e\u043c', type: 'creature', cost: 3, atk: 3, hp: 2, foxSwordOnPlay: 1, rarity: 'common' , faction: 'zen' },
  // Part of the Дзен starter deck (see zenStarterDeckCounts below).
  { id: 'c71', name: '\u0411\u043e\u0436\u0435\u0441\u0442\u0432\u0435\u043d\u043d\u0430\u044f \u0447\u0435\u0440\u0435\u043f\u0430\u0445\u0430-\u043c\u043e\u043d\u0430\u0445', type: 'creature', cost: 3, atk: 2, hp: 3, armor: 1, lifesteal: true, rarity: 'common' , faction: 'zen' },
  // daoistSwordsman: see the hero-hit rally-buff hook in the wave
  // combat loop above.
  { id: 'c72', name: '\u0414\u0430\u043e\u0441-\u043c\u0435\u0447\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 3, daoistSwordsman: true, rarity: 'rare' , faction: 'zen' },
  // waitressOnPlay: see the pendingWaitress queue in placeCard/tryEndTurn.
  { id: 'c73', name: '\u0421\u0435\u0441\u0442\u0440\u0430 \u0434\u043e\u043c\u0430 \u0412\u043a\u0443\u0441\u0430', type: 'creature', cost: 3, atk: 2, hp: 2, waitressOnPlay: true, rarity: 'rare' , faction: 'zen' },
  // drunkenDisciple: see applyDrunkenDisciple above, hooked in at the
  // same pre-attack point as Мушкетер's musketShot.
  { id: 'c74', name: '\u041f\u044c\u044f\u043d\u044b\u0439 \u0443\u0447\u0435\u043d\u0438\u043a', type: 'creature', cost: 3, atk: 3, hp: 5, drunkenDisciple: true, rarity: 'rare' , faction: 'zen' },
  { id: 'c75', name: '\u0421\u0431\u043e\u0440\u0449\u0438\u043a \u0442\u0440\u0430\u0432', type: 'creature', cost: 3, atk: 2, hp: 3, legacy: 1, healOnPlay: 2, rarity: 'rare' , faction: 'zen' },
  { id: 's17', name: '\u0414\u0432\u043e\u0439\u043d\u043e\u0439 \u0443\u0434\u0430\u0440', type: 'spell', cost: 3, buffAtk: 1, buffHp: 1, buffDoubleStrike: true, rarity: 'rare' , faction: 'zen' },
  { id: 's18', name: '\u041f\u0435\u0441\u043d\u044c \u041b\u0443\u043d\u0435', type: 'spell', cost: 3, songToTheMoon: true, rarity: 'rare' , faction: 'zen' },
  { id: 's19', name: '\u0421\u0438\u043b\u0430 \u0433\u043e\u0440', type: 'spell', cost: 3, mountainStrength: true, rarity: 'rare' , faction: 'zen' },
  // broomOnPlay: see the depth-based placement block above (instant
  // Наследие 2 on first cell; pendingBroomBounce on last cell).
  { id: 'c76', name: '\u0414\u0430\u043e\u0441 \u0441 \u043c\u0435\u0442\u043b\u043e\u0439', type: 'creature', cost: 3, atk: 4, hp: 2, broomOnPlay: true, rarity: 'epic' , faction: 'zen' },
  // musicalDaoist: see applyMusicalDaoist above, start-of-round hook.
  { id: 'c77', name: '\u041c\u0443\u0437\u044b\u043a\u0430\u043b\u044c\u043d\u044b\u0439 \u0414\u0430\u043e\u0441', type: 'creature', cost: 3, atk: 3, hp: 3, musicalDaoist: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c78', name: '\u0421\u0442\u043e\u0439\u043a\u0438\u0439 \u0414\u0430\u043e\u0441', type: 'creature', cost: 3, atk: 2, hp: 2, spellResist: true, steadfastDaoist: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c79', name: '\u0421\u043e\u0441\u043d\u043e\u0432\u044b\u0439 \u043e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a', type: 'creature', cost: 4, atk: 1, hp: 6, fixedHeal: 2, rarity: 'common' , faction: 'zen' },
  // bellOnPlay: see the pendingBellBounce queue in placeCard/tryEndTurn.
  { id: 'c80', name: '\u0414\u0430\u043e\u0441 \u0441 \u043a\u043e\u043b\u043e\u043a\u043e\u043b\u044c\u0447\u0438\u043a\u043e\u043c', type: 'creature', cost: 4, atk: 2, hp: 1, bellOnPlay: true, rarity: 'rare' , faction: 'zen' },
  // calmNunOnPlay: see the pendingCalmNun queue in placeCard/tryEndTurn.
  { id: 'c81', name: '\u0421\u043f\u043e\u043a\u043e\u0439\u043d\u0430\u044f \u043c\u043e\u043d\u0430\u0445\u0438\u043d\u044f', type: 'creature', cost: 4, atk: 2, hp: 3, legacy: 2, calmNunOnPlay: true, rarity: 'rare' , faction: 'zen' },
  // valleyBarn: see applyValleyBarn above, start-of-round hook.
  { id: 'c82', name: '\u0410\u043c\u0431\u0430\u0440 \u0434\u043e\u043b\u0438\u043d\u044b', type: 'creature', cost: 4, atk: 0, hp: 8, valleyBarn: true, rarity: 'rare' , faction: 'zen' },
  // Reuses the exact same bounceToHand mechanic as Воздушная буря, but
  // WITHOUT bounceMilitiaChance — no extra summon chance at all.
  { id: 's20', name: '\u0423\u0440\u0430\u0433\u0430\u043d', type: 'spell', cost: 4, bounceToHand: true, rarity: 'rare' , faction: 'zen' },
  { id: 's21', name: '\u0411\u0443\u0440\u043d\u044b\u0439 \u0440\u043e\u0441\u0442', type: 'spell', cost: 4, buffAtk: 2, buffHp: 4, buffHeroHeal: 4, rarity: 'rare' , faction: 'zen' },
  { id: 'c83', name: '\u0422\u0440\u0443\u0441\u043b\u0438\u0432\u044b\u0439 \u0443\u0431\u0438\u0439\u0446\u0430', type: 'creature', cost: 4, atk: 3, hp: 5, doubleStrike: true, cowardlyAssassin: true, rarity: 'rare' , faction: 'zen' },
  { id: 'c84', name: '\u041d\u0435\u0431\u0435\u0441\u043d\u044b\u0439 \u0432\u043e\u0438\u043d', type: 'creature', cost: 4, atk: 4, hp: 3, firstStrike: true, heavenlyWarrior: true, rarity: 'rare' , faction: 'zen' },
  // stork: see the end-of-round card-copying block above.
  { id: 'c85', name: '\u0410\u0438\u0441\u0442 \u0441 \u043f\u0435\u0440\u043e\u043c', type: 'creature', cost: 3, atk: 0, hp: 4, stork: true, rarity: 'epic' , faction: 'zen' },
  // rockEffect: see the immunity checks added to every bounce-to-hand
  // mechanic above. armoredDragon: see the Наследие-receiving reaction
  // right next to Бамбуковый страж's own.
  { id: 'c86', name: '\u0414\u0440\u0430\u043a\u043e\u043d \u0432 \u0434\u043e\u0441\u043f\u0435\u0445\u0430\u0445', type: 'creature', cost: 4, atk: 3, hp: 5, armor: 2, rockEffect: true, armoredDragon: true, rarity: 'epic' , faction: 'zen' },
  // Reuses the exact same instantSummon mechanic as Отряд ополченцев,
  // just summoning Бамбуковый страж (c64) instead of Ополченец (c10).
  { id: 's22', name: '\u0411\u0430\u043c\u0431\u0443\u043a\u043e\u0432\u0430\u044f \u0437\u0430\u0449\u0438\u0442\u0430', type: 'spell', cost: 4, instantSummon: true, summonCardId: 'c64', summonCount: 3, rarity: 'epic' , faction: 'zen' },
  // Reuses the exact same wellspring mechanic as Родник, just with a
  // bigger heal amount and a bigger draw amount.
  { id: 's23', name: '\u041f\u0435\u0440\u0441\u0438\u043a\u043e\u0432\u044b\u0439 \u0440\u0430\u0439', type: 'spell', cost: 4, healHero: 6, drawCard: 3, rarity: 'epic' , faction: 'zen' },
  // Reuses the exact same mountainStrength mechanic as Сила гор, plus
  // the new optional mountainArmor field for the extra +3 armor.
  { id: 's24', name: '\u0421\u0438\u043b\u0430 \u0433\u043e\u0440 \u0422\u044f\u043d\u044c-\u0428\u0430\u043d\u044c', type: 'spell', cost: 4, mountainStrength: true, mountainArmor: 3, rarity: 'epic' , faction: 'zen' },
  { id: 's25', name: '\u041f\u043e\u0441\u043e\u0445 \u0434\u0438\u043a\u043e\u0433\u043e \u0432\u0435\u043f\u0440\u044f', type: 'spell', cost: 4, buffAtk: 2, buffHp: 2, buffLifesteal: true, buffTrample: true, buffLegacy: 2, rarity: 'legendary' , faction: 'zen' },
  // mysteriousMaid: see applyMysteriousMaidShift (battlecry + hero-hit
  // hook) and applyInsight (Понимание) above.
  { id: 'c87', name: '\u0422\u0430\u0438\u043d\u0441\u0442\u0432\u0435\u043d\u043d\u0430\u044f \u0441\u043b\u0443\u0436\u0430\u043d\u043a\u0430 \u0421\u044e\u0430\u043d\u044c', type: 'creature', cost: 4, atk: 1, hp: 1, insightEffect: 1, mysteriousMaid: true, rarity: 'legendary' , faction: 'zen' },
  { id: 'c88', name: '\u041f\u043e\u0432\u0430\u0440 \u0434\u043e\u043c\u0430 \u0412\u043a\u0443\u0441\u0430', type: 'creature', cost: 5, atk: 2, hp: 3, cookBuff: true, rarity: 'common' , faction: 'zen' },
  // warriorSheep: see the Наследие-receiving heal reaction right next
  // to Дракон в доспехах's own; her own battlecry reuses healOnPlay.
  { id: 'c89', name: '\u041e\u0432\u0446\u0430-\u0432\u043e\u0438\u043d', type: 'creature', cost: 5, atk: 4, hp: 6, healOnPlay: 6, warriorSheep: true, rarity: 'rare' , faction: 'zen' },
  { id: 'c90', name: '\u0421\u043c\u0435\u043b\u044b\u0439 \u0443\u0447\u0438\u0442\u0435\u043b\u044c', type: 'creature', cost: 5, atk: 1, hp: 8, braveTeacher: true, rarity: 'rare' , faction: 'zen' },
  // New card reusing the name freed up by c68's rename to Даос с
  // посохом. drawOnDeath: see killUnit above. copyOnLegacy: see the
  // Наследие-receiving reaction right next to Овца-воин's own.
  { id: 'c91', name: '\u041e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a-\u0414\u0430\u043e\u0441', type: 'creature', cost: 5, atk: 7, hp: 3, drawOnDeath: true, copyOnLegacy: true, rarity: 'epic' , faction: 'zen' },
  // shurikenMaster: see applyShurikenMaster above, pre-attack hook.
  { id: 'c92', name: '\u041c\u0430\u0441\u0442\u0435\u0440 \u0441\u044e\u0440\u0438\u043a\u0435\u043d\u043e\u0432', type: 'creature', cost: 5, atk: 5, hp: 2, shurikenMaster: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c93', name: '\u0414\u0435\u043d\u0435\u0436\u043d\u043e\u0435 \u0434\u0435\u0440\u0435\u0432\u043e', type: 'creature', cost: 5, atk: 3, hp: 9, moneyTree: true, rarity: 'epic' , faction: 'zen' },
  { id: 's26', name: '\u0414\u0443\u0445\u043e\u0432\u043d\u044b\u0439 \u0449\u0438\u0442', type: 'spell', cost: 5, buffAtk: 2, buffHp: 2, buffSpellResist: true, rarity: 'epic' , faction: 'zen' },
  // Потомок дракона: never shows up in the shop or a starter deck —
  // the ONLY way to get one is Странствующий ученик transforming into
  // it upon receiving Наследие (see transformOnLegacy below).
  { id: 'c94', name: '\u041f\u043e\u0442\u043e\u043c\u043e\u043a \u0434\u0440\u0430\u043a\u043e\u043d\u0430', type: 'creature', cost: 5, atk: 6, hp: 6, firstStrike: true, doubleStrike: true, lifesteal: true, spellResist: true, rarity: 'legendary', noShop: true , faction: 'zen' },
  { id: 'c95', name: '\u0421\u0442\u0440\u0430\u043d\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439 \u0443\u0447\u0435\u043d\u0438\u043a', type: 'creature', cost: 5, atk: 3, hp: 3, transformOnLegacy: 'c94', rarity: 'legendary' , faction: 'zen' },
  // Росток Женьшеня: never shows up in the shop or a starter deck —
  // the ONLY way to get one is Бессмертный фикус generating it each
  // round end (see peachOrchard below, same mechanic as Персиковый сад).
  { id: 's27', name: '\u0420\u043e\u0441\u0442\u043e\u043a \u0416\u0435\u043d\u044c\u0448\u0435\u043d\u044f', type: 'spell', cost: 0, healHero: 6, rarity: 'common', noShop: true , faction: 'zen' },
  { id: 'c96', name: '\u0411\u0435\u0441\u0441\u043c\u0435\u0440\u0442\u043d\u044b\u0439 \u0444\u0438\u043a\u0443\u0441', type: 'creature', cost: 5, atk: 0, hp: 25, peachOrchard: 's27', rarity: 'legendary' , faction: 'zen' },
  { id: 'c97', name: '\u0411\u0435\u0441\u0441\u043c\u0435\u0440\u0442\u043d\u044b\u0439 \u0442\u0438\u0433\u0440', type: 'creature', cost: 6, atk: 7, hp: 7, immortalTiger: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c98', name: '\u0410\u0440\u0445\u0430\u0442 \u0432 \u0434\u043e\u0441\u043f\u0435\u0445\u0430\u0445', type: 'creature', cost: 6, atk: 6, hp: 6, armor: 4, armoredArhat: true, rarity: 'epic' , faction: 'zen' },
  { id: 's28', name: '\u0421\u043e\u0441\u043d\u043e\u0432\u044b\u0439 \u043b\u0435\u0441', type: 'spell', cost: 6, pineForest: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c99', name: '\u0421\u0432\u0438\u043d\u044c\u044f \u041c\u0430\u0441\u0442\u0435\u0440 \u0414\u0437\u0435\u043d', type: 'creature', cost: 6, atk: 8, hp: 8, lifesteal: true, trample: true, legacy: 1, rarity: 'legendary' , faction: 'zen' },
  { id: 'c100', name: '\u041f\u044c\u044f\u043d\u044b\u0439 \u0414\u0430\u043e\u0441', type: 'creature', cost: 6, atk: 5, hp: 10, doubleStrike: true, drunkenDaoistOnPlay: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c101', name: '\u0428\u0435\u0444 \u0434\u043e\u043c\u0430 \u0412\u043a\u0443\u0441\u0430', type: 'creature', cost: 7, atk: 2, hp: 10, healOnPlay: 6, fixedHeal: 6, chefDoubleHero: true, rarity: 'epic' , faction: 'zen' },
  { id: 'c102', name: '\u041d\u0443\u0430\u043b\u044c \u041e\u0431\u043b\u0430\u0447\u043d\u044b\u0439', type: 'creature', cost: 7, atk: 10, hp: 5, nualOnPlay: true, rarity: 'legendary' , faction: 'zen' },
  { id: 'c103', name: '\u041c\u0443\u0434\u0440\u044b\u0439 \u043e\u043b\u0435\u043d\u044c', type: 'creature', cost: 4, atk: 2, hp: 2, wiseDeerOnPlay: true, rarity: 'epic' , faction: 'zen' },
  // First card of the new (locked, not-yet-unlockable) Дикари faction
  // — see savagesStarterDeckCounts below, same "future unlock step"
  // placeholder pattern already established for zenStarterDeckCounts.
  { id: 'c104', name: '\u0412\u043e\u043b\u043a \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 1, atk: 2, hp: 1, rarity: 'common' , faction: 'savages' },
  // Reworked from \u0417\u0430\u0449\u0438\u0442\u043d\u0438\u043a+temporaryDefender to the new, more general
  // \u0421\u043e\u043d mechanic (see the sleep field in buildUnitFromCard/resolveCombat
  // below) \u2014 identical timing (can't attack during its own bornRound,
  // a normal attacker from the next round on), just under its own name
  // instead of piggybacking on \u0417\u0430\u0449\u0438\u0442\u043d\u0438\u043a.
  { id: 'c105', name: '\u0421\u0442\u0435\u0440\u0432\u044f\u0442\u043d\u0438\u043a', type: 'creature', cost: 1, atk: 1, hp: 2, sleep: true, vultureDraw: true, rarity: 'rare', faction: 'savages' },
  { id: 'c106', name: '\u042f\u0449\u0435\u0440\u0438\u0446\u0430 \u0441\u0442\u0435\u043f\u0435\u0439', type: 'creature', cost: 1, atk: 1, hp: 1, lizardHealBuff: true, rarity: 'rare', faction: 'savages' },
  { id: 'c107', name: '\u0412\u043e\u0438\u043d \u0441 \u043a\u043e\u043f\u044c\u0435\u043c', type: 'creature', cost: 2, atk: 2, hp: 1, spearmanOnPlay: true, rarity: 'common', faction: 'savages' },
  { id: 'c108', name: '\u0428\u0430\u043c\u0430\u043d \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 2, atk: 1, hp: 3, insightEffect: 1, manaAura: 1, rarity: 'rare', faction: 'savages' },
  // Same \u0417\u0430\u0449\u0438\u0442\u043d\u0438\u043a\u2192\u0421\u043e\u043d rework as \u0421\u0442\u0435\u0440\u0432\u044f\u0442\u043d\u0438\u043a right above.
  { id: 'c109', name: '\u0413\u043b\u0443\u043f\u044b\u0439 \u0434\u0438\u043a\u0430\u0440\u044c', type: 'creature', cost: 2, atk: 4, hp: 3, sleep: true, rarity: 'common', faction: 'savages' },
  { id: 'c110', name: '\u041b\u0443\u0447\u043d\u0438\u043a \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 2, atk: 1, hp: 5, shootHero: true, rarity: 'rare', faction: 'savages' },
  { id: 'c111', name: '\u0421\u0443\u0441\u043b\u0438\u043a', type: 'creature', cost: 2, atk: 1, hp: 4, squirrelHealBuff: true, rarity: 'rare', faction: 'savages' },
  { id: 'c112', name: '\u0411\u0440\u043e\u043d\u0435\u043d\u043e\u0441\u0435\u0446', type: 'creature', cost: 2, atk: 2, hp: 2, armor: 1, armadilloHealBuff: true, rarity: 'rare', faction: 'savages' },
  // Same on-death draw as \u041e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a-\u0414\u0430\u043e\u0441 (drawOnDeath), but only a 50%
  // chance rather than guaranteed \u2014 see chanceDrawOnDeath in killUnit
  // below, a separate probability-gated field so the two mechanics
  // never collide should a future unit ever carry both.
  { id: 'c113', name: '\u041a\u0430\u043a\u0442\u0443\u0441 \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 2, atk: 1, hp: 4, defender: true, chanceDrawOnDeath: 0.5, rarity: 'rare', faction: 'savages' },
  // \u0421\u043e\u043d (Sleep): see the sleep field in buildUnitFromCard/resolveCombat
  // below \u2014 can't attack during its own bornRound, a normal attacker
  // from the next round on (same timing \u0417\u0430\u0449\u0438\u0442\u043d\u0438\u043a+temporaryDefender used
  // to give \u0421\u0442\u0435\u0440\u0432\u044f\u0442\u043d\u0438\u043a/\u0413\u043b\u0443\u043f\u044b\u0439 \u0434\u0438\u043a\u0430\u0440\u044c, now generalized under its own
  // name). mountainWarriorBuff: at the end of any round it took damage
  // in (same roundStartHp snapshot comparison as \u0414\u0435\u043d\u0435\u0436\u043d\u043e\u0435 \u0434\u0435\u0440\u0435\u0432\u043e),
  // permanently gains +1 attack/+2 health \u2014 see the end-of-round loop
  // in tryEndTurn.
  { id: 'c114', name: '\u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d', type: 'creature', cost: 2, atk: 2, hp: 6, sleep: true, mountainWarriorBuff: true, rarity: 'rare', faction: 'savages' },
  // First \u0414\u0438\u043a\u0430\u0440\u0438 spell. Pure reuse of the existing generic buff-spell
  // mechanism (buffAtk/buffHp/buffTrample, castSpell's own-unit-target
  // validation, and resolveSpells' unit-mutation branch) already built
  // for \u0414\u043e\u0441\u043f\u0435\u0445\u0438/\u0414\u0432\u043e\u0439\u043d\u043e\u0439 \u0443\u0434\u0430\u0440/\u041f\u043e\u0441\u043e\u0445 \u0434\u0438\u043a\u043e\u0433\u043e \u0432\u0435\u0442\u0440\u0430 \u2014 no new code needed.
  { id: 's29', name: '\u042f\u0440\u043e\u0441\u0442\u044c \u043a\u0430\u0431\u0430\u043d\u0430', type: 'spell', cost: 2, buffAtk: 2, buffHp: 3, buffTrample: true, rarity: 'rare', faction: 'savages' },
  // Same bonus-draw idea as \u041d\u0430\u043f\u043b\u0435\u0447\u043d\u0438\u043a (drawIfArmored), just keyed off
  // \u0421\u043e\u043d instead of Armor \u2014 see drawIfAsleep in castSpell/resolveSpells.
  { id: 's30', name: '\u0417\u0430\u043f\u043e\u0437\u0434\u0430\u043b\u0430\u044f \u043f\u043e\u0441\u0442\u0430\u0432\u043a\u0430', type: 'spell', cost: 2, buffAtk: 2, buffHp: 2, drawIfAsleep: true, rarity: 'rare', faction: 'savages' },
  // Same on-death self-damage mechanic as \u041f\u043e\u0434\u0440\u044b\u0432\u043d\u0438\u043a (explodeOnDeath), just
  // with its own explodeOnDeathAmount (3 instead of the default 5) \u2014
  // see the amount parametrization added to killUnit above.
  { id: 'c115', name: '\u042f\u0440\u043e\u0441\u0442\u043d\u044b\u0439 \u0448\u0430\u043c\u0430\u043d', type: 'creature', cost: 2, atk: 4, hp: 1, manaAura: 1, explodeOnDeath: true, explodeOnDeathAmount: 3, rarity: 'epic', faction: 'savages' },
  // Same on-heal trigger point as \u042f\u0449\u0435\u0440\u0438\u0446\u0430 \u0441\u0442\u0435\u043f\u0435\u0439/\u0421\u0443\u0441\u043b\u0438\u043a/\u0411\u0440\u043e\u043d\u0435\u043d\u043e\u0441\u0435\u0446
  // above (applyLizardWarriorTrigger, called from healHero), but shoots
  // a spear at a random enemy unit instead of buffing himself \u2014 see
  // that helper for the targeting/damage logic.
  { id: 'c116', name: '\u042f\u0449\u0435\u0440-\u0432\u043e\u0438\u043d', type: 'creature', cost: 2, atk: 3, hp: 2, lizardWarriorShot: true, rarity: 'epic', faction: 'savages' },
  // heroHitDoubleStrike: see applyFollowupAttack/resolveCombatPass above
  // \u2014 whenever her own attack lands directly on the enemy hero,
  // immediately makes one more full normal attack (not a flat bonus
  // hit) against whatever's currently in front of her.
  { id: 'c117', name: '\u041f\u044b\u043b\u043a\u0430\u044f \u043e\u0445\u043e\u0442\u043d\u0438\u0446\u0430', type: 'creature', cost: 2, atk: 2, hp: 3, heroHitDoubleStrike: true, rarity: 'epic', faction: 'savages' },
  // Pure reuse of \u0414\u0435\u043d\u0435\u0436\u043d\u043e\u0435 \u0434\u0435\u0440\u0435\u0432\u043e's exact moneyTree mechanic (end-of-round
  // draw if damaged this round, via the match.roundStartHp snapshot) \u2014
  // same convention already used for shootHero (\u0410\u0440\u0431\u0430\u043b\u0435\u0442\u0447\u0438\u043a/\u041b\u0443\u0447\u043d\u0438\u043a
  // \u043f\u0440\u0435\u0440\u0438\u0439) and drawOnDeath (\u041e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a-\u0414\u0430\u043e\u0441): identical behavior reuses
  // the same field under a differently-named card, no new code needed.
  { id: 'c118', name: '\u0421\u0442\u0435\u043f\u043d\u043e\u0435 \u043f\u0443\u0433\u0430\u043b\u043e', type: 'creature', cost: 2, atk: 0, hp: 4, moneyTree: true, rarity: 'epic', faction: 'savages' },
  // Part of the \u0414\u0438\u043a\u0430\u0440\u0438 starter deck (see savagesStarterDeckCounts above).
  // healOnDeath: see killUnit above \u2014 on death (from anything), heals
  // its owner's hero for a fixed amount, reusing the exact 'endOfRound'
  // event/heal-orb animation already built for \u0421\u043e\u0441\u043d\u043e\u0432\u044b\u0439 \u043e\u0442\u0448\u0435\u043b\u044c\u043d\u0438\u043a's own
  // recurring fixedHeal (cardId-driven, so it works fine even though the
  // unit is already gone from the board by the time this fires).
  { id: 'c119', name: '\u0414\u0435\u0442\u0435\u043d\u044b\u0448 \u043a\u0430\u0431\u0430\u043d\u0430', type: 'creature', cost: 3, atk: 2, hp: 2, healOnDeath: 2, rarity: 'common', faction: 'savages' },
  // Part of the \u0414\u0438\u043a\u0430\u0440\u0438 starter deck (see savagesStarterDeckCounts above) \u2014
  // the faction's own analogue of \u041a\u043e\u043b\u044c\u0447\u0443\u0433\u0430 (s1, Empire's starter-deck buff
  // spell: cost 2, same +4 total stats, common rarity). Pure reuse of
  // the existing generic buff-spell mechanism, no new code needed.
  { id: 's31', name: '\u0421\u0438\u043b\u0430 \u043a\u0430\u0431\u0430\u043d\u0430', type: 'spell', cost: 3, buffAtk: 2, buffHp: 2, rarity: 'common', faction: 'savages' },
  // randomShotOnPlay: battlecry throw at a random enemy unit.
  // randomShotRecurring: same shot again before her own attack, starting
  // the round AFTER placement (bambooShotRecurring's exact timing) \u2014 see
  // applyRandomEnemyShot/pendingMarksmanShots above for both.
  { id: 'c120', name: '\u0414\u0438\u043a\u0430\u0440\u044c-\u0441\u0442\u0440\u0435\u043b\u043e\u043a', type: 'creature', cost: 3, atk: 3, hp: 2, randomShotOnPlay: 1, randomShotRecurring: 1, rarity: 'rare', faction: 'savages' },
  // noisyBuff: see placeCard above \u2014 same adjacent-ally targeting as
  // \u0420\u043e\u0434\u043d\u0430\u044f \u0442\u0435\u0442\u0443\u0448\u043a\u0430's own auntBuff, just +2 attack only instead of +1/+1.
  { id: 'c121', name: '\u0428\u0443\u043c\u043d\u0430\u044f \u0434\u0438\u043a\u0430\u0440\u043a\u0430', type: 'creature', cost: 3, atk: 3, hp: 1, noisyBuff: true, rarity: 'rare', faction: 'savages' },
  // boarRiderSpear: see resolveCombatPass above \u2014 whenever his own
  // attack lands directly on the enemy hero, throws a spear at a random
  // enemy unit for 2 damage (reuses applyRandomEnemyShot, same as
  // \u0414\u0438\u043a\u0430\u0440\u044c-\u0441\u0442\u0440\u0435\u043b\u043e\u043a).
  { id: 'c122', name: '\u0412\u0441\u0430\u0434\u043d\u0438\u043a \u043d\u0430 \u043a\u0430\u0431\u0430\u043d\u0435', type: 'creature', cost: 3, atk: 2, hp: 3, boarRiderSpear: true, rarity: 'rare', faction: 'savages' },
  // selfHpGrowthOnDamage: see the end-of-round loop above \u2014 same
  // roundStartHp-based "took damage this round" check and permanent-
  // growth reasoning as \u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d, just +hp only, no upper bound
  // (reuses the same rallyBuff event, buffAtk: 0). sleep: see the sleep
  // field/isAsleep in resolveCombat above \u2014 can't attack during its own
  // bornRound.
  { id: 'c123', name: '\u0411\u0435\u0433\u0435\u043c\u043e\u0442', type: 'creature', cost: 3, atk: 3, hp: 7, sleep: true, selfHpGrowthOnDamage: 3, rarity: 'rare', faction: 'savages' },
  // Pure reuse of the existing manaAura mechanic (same as \u0428\u0430\u043c\u0430\u043d
  // \u043f\u0440\u0435\u0440\u0438\u0439) \u2014 no new code needed.
  { id: 'c124', name: '\u0411\u0430\u043e\u0431\u0430\u0431', type: 'creature', cost: 3, atk: 0, hp: 5, manaAura: 1, rarity: 'rare', faction: 'savages' },
  // prairieFlowerGrowth: see the end-of-round loop above \u2014 same
  // roundStartHp-based permanent-growth family as \u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d/
  // \u0411\u0435\u0433\u0435\u043c\u043e\u0442, but +2 attack AND +2 health this time.
  { id: 'c125', name: '\u0426\u0432\u0435\u0442\u043e\u043a \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 3, atk: 0, hp: 6, prairieFlowerGrowth: true, rarity: 'rare', faction: 'savages' },
  // prairieEagleReact: see the every-round scan in tryEndTurn above \u2014
  // unlike every other "placed this exact round" reaction in the game,
  // this one persists for as long as he's alive, not just his own
  // placement round.
  { id: 'c126', name: '\u0421\u0442\u0435\u043f\u043d\u043e\u0439 \u043e\u0440\u0435\u043b', type: 'creature', cost: 3, atk: 2, hp: 4, prairieEagleReact: true, rarity: 'rare', faction: 'savages' },
  // Pure reuse of \u0413\u043d\u0435\u0432 \u043d\u0435\u0431\u0435\u0441's exact wrathDmg mechanic (hits every depth
  // position in the chosen enemy lane, \u0427\u0430\u0440\u043e\u0441\u0442\u043e\u0439\u043a\u043e\u0441\u0442\u044c respected, never
  // falls through to the hero) \u2014 no new server logic needed, only a
  // different cost/amount. The falling-rock visual (vs. \u0413\u043d\u0435\u0432 \u043d\u0435\u0431\u0435\u0441's
  // lightning) is a client-only presentation choice, same as art/desc.
  { id: 's32', name: '\u041a\u0430\u043c\u0435\u043d\u043d\u044b\u0439 \u0433\u0440\u0430\u0434', type: 'spell', cost: 3, wrathDmg: 3, rarity: 'rare', faction: 'savages' },
  // Pure reuse of the existing endOfRoundSummon mechanic (same as
  // \u041b\u0430\u0433\u0435\u0440\u044c \u043e\u043f\u043e\u043b\u0447\u0435\u043d\u0446\u0435\u0432's own recurring summon) \u2014 no new code needed,
  // just summons \u0412\u043e\u043b\u043a \u043f\u0440\u0435\u0440\u0438\u0439 (c104) instead of \u041e\u043f\u043e\u043b\u0447\u0435\u043d\u0435\u0446 (c10).
  { id: 'c127', name: '\u041e\u0445\u043e\u0442\u043d\u0438\u043a \u043d\u0430 \u0432\u043e\u043b\u043a\u043e\u0432', type: 'creature', cost: 3, atk: 4, hp: 2, endOfRoundSummon: 'c104', rarity: 'epic', faction: 'savages' },
  // boneShamanBuff: see applyBoneShamanBuffs above \u2014 reuses applyDawnBuff
  // (same "whole side including the caster" shape as \u0411\u0430\u0440\u043e\u043d), just at
  // start-of-round instead of end-of-round.
  { id: 'c128', name: '\u0428\u0430\u043c\u0430\u043d \u043a\u043e\u0441\u0442\u0435\u0439', type: 'creature', cost: 3, atk: 1, hp: 2, boneShamanBuff: true, rarity: 'epic', faction: 'savages' },
  // Same on-heal trigger point as \u042f\u0449\u0435\u0440\u0438\u0446\u0430 \u0441\u0442\u0435\u043f\u0435\u0439/\u0421\u0443\u0441\u043b\u0438\u043a/\u0411\u0440\u043e\u043d\u0435\u043d\u043e\u0441\u0435\u0446
  // above (applyBadgerHealTrigger, called from healHero), but +1
  // attack AND +1 health.
  { id: 'c129', name: '\u0411\u0430\u0440\u0441\u0443\u043a', type: 'creature', cost: 3, atk: 2, hp: 4, lifesteal: true, badgerHealBuff: true, rarity: 'epic', faction: 'savages' },
  // bigCactusHeal: see the end-of-round loop above \u2014 roundStartHp-based
  // "took damage this round" check (\u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d family) combined
  // with \u041a\u043e\u0440\u043e\u0432\u0430's own 60% coin flip, healing the hero for a fixed 3.
  { id: 'c130', name: '\u0411\u043e\u043b\u044c\u0448\u043e\u0439 \u043a\u0430\u043a\u0442\u0443\u0441 \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 3, atk: 2, hp: 5, bigCactusHeal: true, rarity: 'epic', faction: 'savages' },
  // Pure reuse of \u041a\u0440\u0435\u0441\u0442\u044c\u044f\u043d\u0441\u043a\u043e\u0435 \u043e\u043f\u043e\u043b\u0447\u0435\u043d\u0438\u0435's exact endOfRoundSpell mechanic
  // (summons N units onto random free cells, then heals the hero, both
  // resolved AFTER combat) \u2014 no new server logic needed, just a
  // different summonCardId/summonCount/healAmount.
  { id: 's33', name: '\u0420\u0430\u0441\u0441\u0432\u0435\u0442', type: 'spell', cost: 3, endOfRoundSpell: true, summonCardId: 'c111', summonCount: 2, healAmount: 3, rarity: 'epic', faction: 'savages' },
  // axeWarriorGrowth: see the end-of-round loop above \u2014 same
  // roundStartHp-based permanent-growth family as \u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d/\u0426\u0432\u0435\u0442\u043e\u043a
  // \u043f\u0440\u0435\u0440\u0438\u0439, just +1 attack AND +1 health this time.
  { id: 'c131', name: '\u0412\u043e\u0438\u043d \u0441 \u0442\u043e\u043f\u043e\u0440\u043e\u043c', type: 'creature', cost: 3, atk: 3, hp: 5, axeWarriorGrowth: true, rarity: 'rare', faction: 'savages' },
  // prairieWarlockBuff: see the end-of-round loop above \u2014 same
  // target-selection/timing as \u0421\u0432\u044f\u0449\u0435\u043d\u043d\u0438\u043a (one random OTHER ally,
  // end-of-round), but +2 attack only instead of +2 health only.
  { id: 'c132', name: '\u041a\u043e\u043b\u0434\u0443\u043d \u043f\u0440\u0435\u0440\u0438\u0439', type: 'creature', cost: 4, atk: 2, hp: 3, prairieWarlockBuff: true, rarity: 'rare', faction: 'savages' },
  // Plain stat-and-keyword card \u2014 reuses the existing trample mechanic
  // as-is, no new code needed.
  { id: 'c133', name: '\u0411\u0435\u0440\u0441\u0435\u0440\u043a', type: 'creature', cost: 4, atk: 4, hp: 4, trample: true, rarity: 'rare', faction: 'savages' },
  // Pure reuse of the existing healOnPlay mechanic \u2014 no new code needed.
  { id: 'c134', name: '\u0412\u043e\u0438\u043d \u0441 \u043c\u043e\u043b\u043e\u0442\u043e\u043c', type: 'creature', cost: 4, atk: 3, hp: 4, healOnPlay: 2, rarity: 'rare', faction: 'savages' },
  // carnivorousPlantBite: see the end-of-round loop above \u2014 same
  // roundStartHp-based "took damage this round" check as \u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u043e\u0438\u043d,
  // but bites the enemy hero directly for its own current attack
  // instead of buffing itself, reusing the heroShot event.
  { id: 'c135', name: '\u0425\u0438\u0449\u043d\u043e\u0435 \u0440\u0430\u0441\u0442\u0435\u043d\u0438\u0435', type: 'creature', cost: 4, atk: 2, hp: 5, carnivorousPlantBite: true, rarity: 'rare', faction: 'savages' },
  // Pure reuse of \u0411\u0443\u0440\u043d\u044b\u0439 \u0440\u043e\u0441\u0442's exact buffAtk/buffHp/buffHeroHeal mechanism
  // (permanently buffs a targeted own unit, then heals the caster's own
  // hero) \u2014 no new code needed, just different amounts (4/4/4 instead
  // of 2/4/4).
  { id: 's34', name: '\u0414\u0438\u043a\u0430\u044f \u0441\u0438\u043b\u0430', type: 'spell', cost: 4, buffAtk: 4, buffHp: 4, buffHeroHeal: 4, rarity: 'rare', faction: 'savages' },
  // \u041a\u0430\u043f\u043a\u0430\u043d: targets a specific enemy unit and kills it outright
  // regardless of its current hp, then heals the caster's own hero for
  // hp equal to that unit's own mana cost \u2014 see the 'trapKill' branch
  // in castSpell/resolveSpells. \u0427\u0430\u0440\u043e\u0441\u0442\u043e\u0439\u043a\u043e\u0441\u0442\u044c/\u0429\u0438\u0442 blocks the kill (and
  // therefore the heal too), same as every other targeted spell here.
  { id: 's35', name: '\u041a\u0430\u043f\u043a\u0430\u043d', type: 'spell', cost: 4, trapKill: true, rarity: 'rare', faction: 'savages' },
  // \u041c\u0430\u043c\u043e\u043d\u0442: plain stat-stick, starter deck member (see
  // savagesStarterDeckCounts) \u2014 no special fields at all.
  { id: 'c136', name: '\u041c\u0430\u043c\u043e\u043d\u0442', type: 'creature', cost: 6, atk: 4, hp: 6, rarity: 'common', faction: 'savages' },
  // \u0414\u0435\u0432\u0443\u0448\u043a\u0430 \u0441 \u0431\u0438\u0432\u043d\u0435\u043c: pure reuse of the existing endOfRoundSummon
  // mechanic (same as \u041e\u0445\u043e\u0442\u043d\u0438\u043a \u043d\u0430 \u0432\u043e\u043b\u043a\u043e\u0432) \u2014 no new code needed.
  { id: 'c137', name: '\u0414\u0435\u0432\u0443\u0448\u043a\u0430 \u0441 \u0431\u0438\u0432\u043d\u0435\u043c', type: 'creature', cost: 4, atk: 0, hp: 2, endOfRoundSummon: 'c136', rarity: 'epic', faction: 'savages' },
  // \u0412\u0435\u0440\u0445\u043e\u0432\u043d\u044b\u0439 \u0448\u0430\u043c\u0430\u043d: see applyHighShamanManaBuff above for the
  // pre-attack mana-buff mechanic.
  { id: 'c138', name: '\u0412\u0435\u0440\u0445\u043e\u0432\u043d\u044b\u0439 \u0448\u0430\u043c\u0430\u043d', type: 'creature', cost: 4, atk: 5, hp: 5, highShamanManaBuff: true, rarity: 'epic', faction: 'savages' },
  // \u041e\u0434\u043d\u043e\u0433\u043b\u0430\u0437\u0430\u044f \u0442\u0432\u0430\u0440\u044c: see applyOneEyedBeastHealTrigger above \u2014 same
  // "every heal" trigger shape as \u0411\u0430\u0440\u0441\u0443\u043a, just +3/+3 instead of +1/+1.
  { id: 'c139', name: '\u041e\u0434\u043d\u043e\u0433\u043b\u0430\u0437\u0430\u044f \u0442\u0432\u0430\u0440\u044c', type: 'creature', cost: 4, atk: 4, hp: 10, oneEyedBeastHealBuff: true, rarity: 'epic', faction: 'savages' },
  // \u0424\u0430\u043d\u0430\u0442\u0438\u043a \u0441 \u0442\u043e\u043f\u043e\u0440\u0430\u043c\u0438: see applyAxeFanaticThrow above for the
  // pre-attack mirrored-row axe-throw mechanic.
  { id: 'c140', name: '\u0424\u0430\u043d\u0430\u0442\u0438\u043a \u0441 \u0442\u043e\u043f\u043e\u0440\u0430\u043c\u0438', type: 'creature', cost: 4, atk: 2, hp: 4, axeFanaticThrow: true, rarity: 'epic', faction: 'savages' },
  // \u0411\u0438\u043b\u043b \u0438 \u0411\u0438\u043b\u043b\u0438: see the coinFlipAttack roll in tryEndTurn, right
  // before resolveCombat, for the every-round 50/50 mechanic.
  { id: 'c141', name: '\u0411\u0438\u043b\u043b \u0438 \u0411\u0438\u043b\u043b\u0438', type: 'creature', cost: 4, atk: 8, hp: 8, trample: true, coinFlipAttack: true, rarity: 'legendary', faction: 'savages' },
  // \u0422\u043e\u0442\u0435\u043c \u0434\u0438\u043a\u0430\u0440\u0435\u0439: see applySavageTotemBuffs above for the start-of-
  // round attack-only buff mechanic.
  { id: 'c142', name: '\u0422\u043e\u0442\u0435\u043c \u0434\u0438\u043a\u0430\u0440\u0435\u0439', type: 'creature', cost: 5, atk: 0, hp: 8, savageTotemBuff: true, rarity: 'rare', faction: 'savages' },
  // \u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u0435\u043b\u0438\u043a\u0430\u043d: pure stat-stick with the existing \u0421\u043e\u043d (sleep) flag
  // \u2014 no new fields or logic needed.
  { id: 'c143', name: '\u0413\u043e\u0440\u043d\u044b\u0439 \u0432\u0435\u043b\u0438\u043a\u0430\u043d', type: 'creature', cost: 5, atk: 9, hp: 9, sleep: true, rarity: 'rare', faction: 'savages' },
  // \u0412\u043e\u0436\u0434\u044c \u0434\u0438\u043a\u0430\u0440\u0435\u0439: see the savageChiefBuff battlecry in placeCard above
  // for the adjacent-ally +2/+2 + trample mechanic.
  { id: 'c144', name: '\u0412\u043e\u0436\u0434\u044c \u0434\u0438\u043a\u0430\u0440\u0435\u0439', type: 'creature', cost: 5, atk: 5, hp: 5, trample: true, savageChiefBuff: true, rarity: 'epic', faction: 'savages' },
  // \u0414\u0438\u043a\u0430\u0440\u043a\u0430 \u0441 \u0442\u043e\u043f\u043e\u0440\u0430\u043c\u0438: see applyAxeWomanStartOfRoundThrows and the
  // axeWomanThrow pre-attack hook above \u2014 throws twice per round,
  // reusing applyAxeFanaticThrow's exact mirrored-row mechanic both
  // times.
  { id: 'c145', name: '\u0414\u0438\u043a\u0430\u0440\u043a\u0430 \u0441 \u0442\u043e\u043f\u043e\u0440\u0430\u043c\u0438', type: 'creature', cost: 5, atk: 3, hp: 4, axeWomanThrow: true, rarity: 'epic', faction: 'savages' },
  // \u041a\u0430\u0439 \u041a\u0440\u043e\u0432\u0430\u0432\u044b\u0439: see applyKaiBloodyLifestealGrants (start-of-round
  // lifesteal grant) and applyKaiBloodyHealTrigger (on-heal self-buff
  // + one-time trample grant) above.
  { id: 'c146', name: '\u041a\u0430\u0439 \u041a\u0440\u043e\u0432\u0430\u0432\u044b\u0439', type: 'creature', cost: 5, atk: 4, hp: 4, kaiBloodyLifestealGrant: true, kaiBloodyHealBuff: true, rarity: 'legendary', faction: 'savages' },
  // \u041c\u0438\u043d\u043e\u0442\u0430\u0432\u0440: same roundStartHp-based "took damage this round" family
  // as \u0412\u043e\u0438\u043d \u0441 \u0442\u043e\u043f\u043e\u0440\u043e\u043c, just +1/+2 instead of +1/+1.
  { id: 'c147', name: '\u041c\u0438\u043d\u043e\u0442\u0430\u0432\u0440', type: 'creature', cost: 6, atk: 7, hp: 9, minotaurGrowth: true, rarity: 'epic', faction: 'savages' },
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

// The Дзен starter deck — granted to an account once it unlocks the
// Дзен faction (not built yet; this is just the composition the future
// unlock step will hand out, kept here so that step has something
// ready to call). Олень-Даос, Олень-мечник, Монах-аскет,
// Даос с посохом (formerly Отшельник-Даос), Божественная черепаха-монах, Сосновый отшельник (formerly Сосновый страж),
// Повар дома Вкуса, Частокол, Бамбуковый страж, and Лис с мечом are
// confirmed part of it so far, at 3 copies each, same as every card in
// the Empire starter deck.
export function zenStarterDeckCounts() {
  return { c60: 3, c61: 3, c65: 3, c68: 3, c71: 3, c79: 3, c88: 3, c63: 3, c64: 3, c70: 3 };
}

// The Дикари starter deck — same "granted once the faction unlocks"
// placeholder reasoning as zenStarterDeckCounts above (the faction
// itself is locked, hidden from new accounts, and its unlock
// conditions aren't built yet). Волк прерий, Воин с копьем, Глупый
// дикарь, Детеныш кабана, and Сила кабана are the confirmed cards so
// far, at 3 copies each same as every other starter deck.
export function savagesStarterDeckCounts() {
  return { c104: 3, c107: 3, c109: 3, c119: 3, s31: 3, c136: 3 };
}

// ---------- Factions ----------
// The full canonical set of faction ids that exist in the client's own
// UI (tabs), whether or not they have any cards yet. Server-authoritative
// list so the client never has to guess which factions to render tabs
// for — it asks the server (see /api/factions in server.js).
export const FACTION_IDS = ['empire', 'pirates', 'savages', 'inferno', 'frost', 'zen', 'mystery'];

// Which factions every account starts unlocked with, day one — every
// OTHER faction in FACTION_IDS is locked by default until some future
// unlock condition (not built yet) grants it. Only Империя (empire)
// starts unlocked; everything else — Пираты, Дикари, Инферно, Холод,
// Дзен, Мистерия — is locked from day one, whether or not it has any
// cards yet.
export function defaultUnlockedFactions() {
  return ['empire'];
}

// Dispatches to whichever starter-deck function matches a given faction
// id — used when actually granting a faction's starter deck to an
// account upon unlock. Factions with no dedicated starter deck function
// (no cards yet, or never meant to grant one) return an empty object,
// which is a safe no-op to merge into an account's owned cards.
export function starterDeckCountsForFaction(factionId) {
  if (factionId === 'empire') return defaultDeckCounts();
  if (factionId === 'zen') return zenStarterDeckCounts();
  if (factionId === 'savages') return savagesStarterDeckCounts();
  return {};
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
// `unlockedFactions`, when provided (an array or Set of faction ids),
// additionally excludes any card whose faction isn't in that set — this
// is how a locked faction's cards stay out of an account's shop
// entirely, server-side, rather than relying on the client to hide
// them. Omitting it (or passing nothing) skips the faction check
// entirely, for any caller that doesn't need it.
export function shoppableCards(unlockedFactions) {
  const unlockedSet = unlockedFactions ? new Set(unlockedFactions) : null;
  return CARD_POOL.filter((c) => {
    if (c.locked || c.noShop) return false;
    if (unlockedSet && !unlockedSet.has(c.faction)) return false;
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

// Двойной удар (Double Strike): a unit with this flag appears TWICE in
// its own side's acting order for a lane, so it gets two full turns
// through the ordinary wave machinery below — each one independently
// picks the CURRENT front target (redirecting to whoever's now in
// front, or the hero, if its first swing already cleared the original
// target), and each one fully applies armor/lifesteal/trample/events
// exactly like any other attack. No bespoke "extra swing" logic needed;
// this is the only place Double Strike is implemented.
function actingOrder(board, laneIdx) {
  const order = [];
  for (let d = 0; d < DEPTH; d++) {
    const unit = board[laneIdx][d];
    if (unit) {
      order.push({ unit, depth: d });
      if (unit.doubleStrike) order.push({ unit, depth: d });
    }
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

// Same cardinal-neighbour rule as adjacentAllyPositions below, but
// returns every valid grid-adjacent coordinate regardless of whether
// it's occupied — used by Небесный вихрь, which picks a random
// NEIGHBOURING CELL (empty or not) rather than a random neighbouring
// ally.
function adjacentCellPositions(laneIdx, depthIdx) {
  const positions = [];
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dl, dd] of deltas) {
    const l = laneIdx + dl, d = depthIdx + dd;
    if (l >= 0 && l < LANES && d >= 0 && d < DEPTH) positions.push({ laneIdx: l, depthIdx: d });
  }
  return positions;
}

// Same cardinal-neighbour rule as Synergy, but returns the actual
// coordinates of each occupied neighbour instead of just a count — used
// by Родная тетушка to pick which adjacent ally to bless.
// Same cardinal-neighbour rule as Synergy, but returns the actual
// coordinates of each occupied neighbour instead of just a count — used
// by Родная тетушка to pick which adjacent ally to bless. Shielded
// units (Щит) are never eligible, on either side of the pool: this is
// the single most-reused "random ally neighbour" selector in the game
// (Родная тетушка, Спокойная монахиня, Смелый учитель, etc.), so
// excluding them here protects all of them at once.
function adjacentAllyPositions(board, laneIdx, depthIdx) {
  const positions = [];
  const deltas = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [dl, dd] of deltas) {
    const l = laneIdx + dl, d = depthIdx + dd;
    if (l >= 0 && l < LANES && d >= 0 && d < DEPTH && board[l][d] && !board[l][d].shieldEffect) positions.push({ laneIdx: l, depthIdx: d });
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
    pendingBambooShots: [],
    pendingMarksmanShots: [],
    pendingHerbalist: [],
    pendingFoxSword: [],
    pendingWaitress: [],
    pendingBroomBounce: [],
    pendingBellBounce: [],
    pendingCalmNun: [],
    pendingMysteriousMaid: [],
    pendingShamanInsight: [],
    pendingBraveTeacher: [],
    pendingNualFrontStab: [],
    pendingNualQuadStab: [],
    pendingWiseDeerDebuff: [],
    pendingWiseDeerBuff: [],
    pendingSpearmanBuff: [],
    // Понимание (Insight): revealedTo[username] is the list of the
    // OPPONENT's hand-card uids that `username` has been shown face-up
    // — persists until that card leaves the opponent's hand (played,
    // discarded, etc.), at which point it naturally stops appearing
    // (it's simply no longer IN the opponent's hand to match against).
    revealedTo: { [nameA]: [], [nameB]: [] },
    // Денежное дерево: hp snapshot at the start of each round's
    // resolution, re-populated fresh every round in tryEndTurn — starts
    // empty here so a card placed before the very first resolution
    // ever runs still has somewhere safe to record its own baseline.
    roundStartHp: {},
    pendingBattlecrySummons: [],
    pendingPunisherKills: [],
    pendingBlinds: [],
    pendingWarlordBuffs: [],
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
// Every field a battlefield unit carries, derived from its card — shared
// by placeCard (a player-placed unit) and summonUnitToRandomFreeCell (a
// mid-combat reinforcement, e.g. Храмовый боец's Ополченец). `placedThisRound`
// is the one thing that varies by caller: true for something the player
// just placed this turn (lets them reposition it, shows dimmed
// client-side), false for anything appearing outside the placing phase.
// `bornRound` records exactly which round this unit first appeared on
// the board — used by Карающий ангел to tell "appeared this same turn"
// (whether normally placed OR instant-summoned) apart from anyone who
// was already there from an earlier round.
// Шаман прерий (Мана 1): sums the manaAura value across every unit
// CURRENTLY alive on a side's board — the total extra mana that side's
// owner gets on top of the standard match.maxMana each round, for as
// long as whatever's granting it stays alive and on the battlefield.
// Recomputed fresh every time it's needed rather than tracked as a
// running total, so it's always correct regardless of how units came
// and went.
function manaAuraTotal(match, side) {
  const board = match.boards[side];
  let total = 0;
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.manaAura) total += u.manaAura;
    }
  }
  return total;
}

function buildUnitFromCard(card, placedThisRound, bornRound) {
  return {
    id: card.id,
    uid: nextUid('unit'),
    atk: card.atk,
    hp: card.hp,
    maxHp: card.hp,
    armor: card.armor || 0,
    lifesteal: !!card.lifesteal,
    synergy: card.synergy || 0,
    shootHero: !!card.shootHero,
    shootHeroStartOfTurn: !!card.shootHeroStartOfTurn,
    cookHeal: !!card.cookHeal,
    cowHeal: !!card.cowHeal,
    wallGrow: !!card.wallGrow,
    firstStrike: !!card.firstStrike,
    dawnBuff: !!card.dawnBuff,
    bishopBuff: !!card.bishopBuff,
    summonOnHeroHit: card.summonOnHeroHit || null,
    priestHeal: !!card.priestHeal,
    prairieWarlockBuff: !!card.prairieWarlockBuff,
    siegeShot: !!card.siegeShot,
    endOfRoundSummon: card.endOfRoundSummon || null,
    defender: !!card.defender,
    // Сон (Sleep): can't attack during its own bornRound, a normal
    // attacker from the next round on — see isAsleep in resolveCombat
    // below. Replaces the old Защитник+temporaryDefender combo that
    // used to give Стервятник/Глупый дикарь this exact timing.
    sleep: !!card.sleep,
    cannonShot: !!card.cannonShot,
    cannonShotFixed: card.cannonShotFixed || 0,
    cannonShotExtraChance: card.cannonShotExtraChance || 0,
    fixedHeal: card.fixedHeal || 0,
    healOnDeath: card.healOnDeath || 0,
    // Чаростойкость: see the siegeShot/cannonShot targeting above and the
    // 'damage' spell kind in resolveSpells — every current cross-side
    // damage-dealing mechanic checks this. No enemy-facing stat-reduction
    // mechanic exists yet to guard, but any added later must check it too.
    spellResist: !!card.spellResist,
    trample: !!card.trample,
    punisherKill: !!card.punisherKill,
    doubleHeal: !!card.doubleHeal,
    baronBuff: !!card.baronBuff,
    boneShamanBuff: !!card.boneShamanBuff,
    doubleStrike: !!card.doubleStrike,
    healTrigger: !!card.healTrigger,
    blacksmithBuff: !!card.blacksmithBuff,
    powderKeg: !!card.powderKeg,
    explodeOnDeath: !!card.explodeOnDeath,
    // Подрывник fixed this at 5 and no card defined its own value until
    // Яростный шаман needed 3 — kept as a plain default rather than a
    // dedicated Подрывник-only constant so any future card can set its
    // own amount too.
    explodeOnDeathAmount: card.explodeOnDeathAmount || 5,
    statueBuff: !!card.statueBuff,
    weaponThrowOnDeath: !!card.weaponThrowOnDeath,
    musketShot: !!card.musketShot,
    lunaBlind: !!card.lunaBlind,
    legacyValue: card.legacy || 0,
    bambooShotRecurring: card.bambooShotRecurring || 0,
    randomShotRecurring: card.randomShotRecurring || 0,
    highShamanManaBuff: !!card.highShamanManaBuff,
    axeFanaticThrow: !!card.axeFanaticThrow,
    axeWomanThrow: !!card.axeWomanThrow,
    coinFlipAttack: !!card.coinFlipAttack,
    savageTotemBuff: !!card.savageTotemBuff,
    counterattack: !!card.counterattack,
    daoistSwordsman: !!card.daoistSwordsman,
    drunkenDisciple: !!card.drunkenDisciple,
    musicalDaoist: !!card.musicalDaoist,
    steadfastDaoist: !!card.steadfastDaoist,
    valleyBarn: !!card.valleyBarn,
    cowardlyAssassin: !!card.cowardlyAssassin,
    heavenlyWarrior: !!card.heavenlyWarrior,
    rockEffect: !!card.rockEffect,
    armoredDragon: !!card.armoredDragon,
    warriorSheep: !!card.warriorSheep,
    drawOnDeath: !!card.drawOnDeath,
    chanceDrawOnDeath: card.chanceDrawOnDeath || 0,
    copyOnLegacy: !!card.copyOnLegacy,
    shurikenMaster: !!card.shurikenMaster,
    moneyTree: !!card.moneyTree,
    chefDoubleHero: !!card.chefDoubleHero,
    chefDoubleUsed: false,
    transformOnLegacy: card.transformOnLegacy || null,
    immortalTiger: !!card.immortalTiger,
    tigerBoostUsed: false,
    armoredArhat: !!card.armoredArhat,
    shieldEffect: !!card.shieldEffect,
    vultureDraw: !!card.vultureDraw,
    heroHitDoubleStrike: !!card.heroHitDoubleStrike,
    boarRiderSpear: !!card.boarRiderSpear,
    lizardHealBuff: !!card.lizardHealBuff,
    squirrelHealBuff: !!card.squirrelHealBuff,
    armadilloHealBuff: !!card.armadilloHealBuff,
    lizardWarriorShot: !!card.lizardWarriorShot,
    badgerHealBuff: !!card.badgerHealBuff,
    oneEyedBeastHealBuff: !!card.oneEyedBeastHealBuff,
    kaiBloodyLifestealGrant: !!card.kaiBloodyLifestealGrant,
    kaiBloodyHealBuff: !!card.kaiBloodyHealBuff,
    mountainWarriorBuff: !!card.mountainWarriorBuff,
    selfHpGrowthOnDamage: card.selfHpGrowthOnDamage || 0,
    prairieFlowerGrowth: !!card.prairieFlowerGrowth,
    axeWarriorGrowth: !!card.axeWarriorGrowth,
    minotaurGrowth: !!card.minotaurGrowth,
    carnivorousPlantBite: !!card.carnivorousPlantBite,
    bigCactusHeal: !!card.bigCactusHeal,
    prairieEagleReact: !!card.prairieEagleReact,
    manaAura: card.manaAura || 0,
    mysteriousMaid: !!card.mysteriousMaid,
    insightEffect: card.insightEffect || 0,
    cantAttackThisRound: false,
    bambooGuardian: !!card.bambooGuardian,
    placedThisRound,
    bornRound,
  };
}

// Храмовый боец (and any future card with this flag): the instant its
// attack lands directly on the enemy hero, summons a fresh copy of
// `cardId` onto a random EMPTY cell on its OWN owner's board. If every
// cell is already occupied, this is a silent no-op — the mechanic simply
// doesn't trigger, per spec. The new unit wasn't placed by the player
// this turn, so placedThisRound is false (no dimmed/provisional state,
// no repositioning window — placing phase for this round is already
// over by the time combat runs).
// `onlyLaneIdx` (optional) restricts the free-cell scan to just that one
// lane instead of the whole board — used by Воздушная буря, which needs
// its summon confined to the caster's own mirrored lane specifically.
// Every existing caller omits it and keeps scanning the entire board.
function summonUnitToRandomFreeCell(match, side, cardId, events, onlyLaneIdx) {
  const board = match.boards[side];
  const freeCells = [];
  for (let l = 0; l < LANES; l++) {
    if (onlyLaneIdx != null && l !== onlyLaneIdx) continue;
    for (let d = 0; d < DEPTH; d++) {
      if (!board[l][d]) freeCells.push({ l, d });
    }
  }
  if (freeCells.length === 0) return;
  const { l, d } = freeCells[Math.floor(Math.random() * freeCells.length)];
  const summonedCard = cardById(cardId);
  if (!summonedCard) return;
  const unit = buildUnitFromCard(summonedCard, false, match.round);
  board[l][d] = unit;
  events.push({ type: 'summon', side, cardId, laneIdx: l, depthIdx: d, uid: unit.uid });
}

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
  const unit = buildUnitFromCard(card, true, match.round);
  match.boards[username][lane][depth] = unit;

  // Олень-мечник: which depth he's placed at (first/last/middle of the
  // lane, regardless of which lane) permanently shapes his own starting
  // stats — applied immediately, since it's baked into the unit the
  // instant he's built, not a separate visible "buff" moment.
  if (card.deerSwordsman) {
    if (depth === 0) {
      unit.atk -= 1;
      unit.hp += 2;
      unit.maxHp += 2;
    } else if (depth === DEPTH - 1) {
      unit.atk += 2;
      unit.hp -= 1;
      unit.maxHp -= 1;
    }
    // depth === middle: no change at all.
  }

  // Иллюзионист времени: on play, instantly swaps places with a random
  // adjacent ally — applied immediately at placement time, same as
  // Олень-мечник's own instant (not deferred) effect above, since it's
  // purely a positional change with nothing else to wait on. A safe
  // no-op if she has no adjacent ally at all.
  if (card.timeIllusionist) {
    const board = match.boards[username];
    const neighbours = adjacentAllyPositions(board, lane, depth);
    if (neighbours.length > 0) {
      const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
      const otherUnit = board[chosen.laneIdx][chosen.depthIdx];
      board[chosen.laneIdx][chosen.depthIdx] = unit;
      board[lane][depth] = otherUnit;
    }
  }

  // Лис с мечом: battlecry — deals fixed damage to a random enemy
  // unit anywhere on the board. Same deferred reasoning as every other
  // battlecry (opponent needs to actually see it happen), resolved at
  // the start of the next resolution (see pendingFoxSword below).
  if (card.foxSwordOnPlay) {
    match.pendingFoxSword.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, amount: card.foxSwordOnPlay });
  }

  // Травница: same depth-based placement rule as Олень-мечник (first/
  // last/middle of the lane, regardless of which lane), but instead of
  // reshaping her own stats it triggers a hero-affecting battlecry —
  // deferred to resolution (see pendingHerbalist below) both so the
  // client can reveal her placement first and so the amount reflects
  // her CURRENT attack at resolution time, same reasoning as every
  // other "amount equals attack" battlecry in this file.
  if (card.herbalist) {
    if (depth === 0) {
      match.pendingHerbalist.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, kind: 'heal' });
    } else if (depth === DEPTH - 1) {
      match.pendingHerbalist.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, kind: 'damage' });
    }
    // depth === middle: no queued effect — she's just an ordinary body.
  }

  // Сестра дома Вкуса: same depth-based placement rule as
  // Олень-мечник/Травница (first/last/middle of the lane, regardless
  // of which lane), but the buff lands on a random ally ANYWHERE on
  // her own board (herself included — nothing excludes her) rather
  // than herself or her hero. Deferred to resolution (see
  // pendingWaitress below) so it's visibly animated.
  if (card.waitressOnPlay) {
    if (depth === 0) {
      match.pendingWaitress.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, kind: 'atk' });
    } else if (depth === DEPTH - 1) {
      match.pendingWaitress.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, kind: 'armor' });
    }
    // depth === middle: no queued effect at all.
  }

  // Даос с метлой: same depth-based placement rule as Олень-мечник/
  // Сестра дома Вкуса (first/last/middle of the lane, regardless
  // of which lane). First cell is an instant, purely self-modifying
  // effect (like Олень-мечник's own), applied immediately — permanent
  // Наследие 2. Last cell queues a deferred bounce of the FIRST
  // opposing unit in this SAME lane (see pendingBroomBounce below),
  // since it affects the OPPONENT and needs to be visibly animated.
  if (card.broomOnPlay) {
    if (depth === 0) {
      unit.legacyValue = (unit.legacyValue || 0) + 2;
    } else if (depth === DEPTH - 1) {
      match.pendingBroomBounce.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
    }
    // depth === middle: no effect at all.
  }

  // Даос с колокольчиком: battlecry — bounces a RANDOM enemy unit
  // anywhere on the board back to the opponent's hand. Same deferred
  // reasoning as every other battlecry, resolved at the start of the
  // next resolution (see pendingBellBounce below).
  if (card.bellOnPlay) {
    match.pendingBellBounce.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  // Спокойная монахиня: battlecry — doubles the hp of a random
  // ADJACENT ally. Same deferred reasoning as every other battlecry
  // (needs to be visibly animated), resolved at the start of the next
  // resolution (see pendingCalmNun below).
  if (card.calmNunOnPlay) {
    match.pendingCalmNun.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  // Смелый учитель: battlecry — increases a random ADJACENT ally's
  // attack by an amount equal to THAT ally's own CURRENT hp. Same
  // deferred reasoning as every other battlecry (needs to be visibly
  // animated, and the amount must reflect the ally's hp at RESOLUTION
  // time, not cast time).
  if (card.braveTeacher) {
    match.pendingBraveTeacher.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  // Таинственная служанка Сюань: battlecry — triggers her own
  // Понимание 1 AND the ally-buff/enemy-debuff shift, both deferred to
  // resolution (same reasoning as every other battlecry: needs to be
  // visibly animated, and Понимание specifically needs the opponent's
  // CURRENT hand at resolution time, not whatever it was at cast time).
  if (card.mysteriousMaid) {
    match.pendingMysteriousMaid.push({ side: username, sourceUid: unit.uid, insightAmount: card.insightEffect || 0 });
  }

  // Шаман прерий: Понимание on its own, no accompanying atk-shift
  // battlecry unlike Таинственная служанка Сюань above — kept as a
  // SEPARATE check (rather than folding into the mysteriousMaid branch
  // above) so a future card can carry insightEffect for flavor/display
  // purposes without accidentally triggering this reveal too.
  if (card.insightEffect && !card.mysteriousMaid) {
    match.pendingShamanInsight.push({ side: username, sourceUid: unit.uid, insightAmount: card.insightEffect });
  }

  // Нуаль Облачный: same depth-based placement rule as Олень-мечник/
  // Сестра дома Вкуса (first/last/middle of the lane, regardless of
  // which lane) — but here BOTH ends do damage to the ENEMY, so both
  // need deferring to resolution for visible animation (unlike a
  // purely self-modifying instant effect).
  if (card.nualOnPlay) {
    if (depth === 0) {
      match.pendingNualFrontStab.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
    } else if (depth === DEPTH - 1) {
      match.pendingNualQuadStab.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
    }
    // depth === middle: no queued effect at all.
  }

  // Мудрый олень: same depth-based placement rule as Нуаль Облачный/
  // Сестра дома Вкуса (first/last/middle, any lane) — first cell
  // debuffs every enemy, last cell buffs every ally, both deferred to
  // resolution for visible animation.
  if (card.wiseDeerOnPlay) {
    if (depth === 0) {
      match.pendingWiseDeerDebuff.push({ side: username, sourceUid: unit.uid });
    } else if (depth === DEPTH - 1) {
      match.pendingWiseDeerBuff.push({ side: username, sourceUid: unit.uid });
    }
    // depth === middle: no queued effect at all.
  }

  // Воин с копьем: whether an enemy "ALSO appeared this same phase"
  // directly opposite can only be known once BOTH players have
  // finished placing for the round — checking it right now, at
  // placement time, would depend on placement ORDER (whoever places
  // second would always see the other, whoever places first never
  // would). Deferred to the very start of resolution instead, where
  // both sides' placements for the round are already final.
  if (card.spearmanOnPlay) {
    match.pendingSpearmanBuff.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  // Шаман прерий (Мана 1): NOT granted immediately at placement — only
  // once he's actually confirmed on the battlefield (both players
  // pressed "Завершить ход" and resolution completed), which for a
  // unit placed THIS round means starting with the NEXT round's mana
  // refill (manaAuraTotal already picks him up naturally there, since
  // he's alive and on the board by then). No grant needed here at all.

  // Пьяный Даос: checked instantly at placement (same "no deferral
  // needed" reasoning as Олень-мечник/Иллюзионист времени, since it's
  // purely a self-modifying stat change based on board state right
  // now) — gains +1 attack and +2 health for EACH enemy currently
  // standing in the OPPOSING lane (same lane index, enemy side).
  if (card.drunkenDaoistOnPlay) {
    const enemySide = otherPlayer(match, username);
    const enemyBoard = match.boards[enemySide];
    let enemyCount = 0;
    for (let d = 0; d < DEPTH; d++) {
      if (enemyBoard[lane][d]) enemyCount++;
    }
    if (enemyCount > 0) {
      unit.atk += enemyCount * 1;
      unit.hp += enemyCount * 2;
      unit.maxHp += enemyCount * 2;
    }
  }

  // Денежное дерево: if she's placed THIS round (after the round-start
  // hp snapshot in tryEndTurn already ran, or simply because match.round
  // hasn't reached its own resolution yet for a first-ever placement),
  // she has no baseline hp recorded yet — record it right now, at the
  // moment she's placed, so "took damage this round" still works
  // correctly even for a unit that was just played.
  if (card.moneyTree) {
    match.roundStartHp[unit.uid] = unit.hp;
  }

  // Трусливый убийца: checked instantly at placement (same "no
  // deferral needed" reasoning as Олень-мечник/Иллюзионист времени,
  // since it's purely about board state) — if the OPPOSING lane (same
  // lane index, enemy side) has ANY unit at all right now, he can't
  // attack for the round he was placed in. Cleared right after that
  // round's combat resolves (see the reset alongside Рейна's blind
  // clearing in tryEndTurn), so the restriction only ever covers this
  // one round.
  if (card.cowardlyAssassin) {
    const enemySide = otherPlayer(match, username);
    const enemyBoard = match.boards[enemySide];
    const hasOpposingUnit = enemyBoard[lane].some((cell) => !!cell);
    if (hasOpposingUnit) {
      unit.cantAttackThisRound = true;
    }
  }

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

  // Повар дома Вкуса: same deferred pendingRallyBuffs queue as Паладин
  // above, but +1 attack ONLY (no hp change) and — unlike Паладин —
  // INCLUDING himself, since he's already sitting on the board by the
  // time this queue drains.
  } else if (card.cookBuff) {
    const board = match.boards[username];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const other = board[l][d];
        if (other) {
          match.pendingRallyBuffs.push({ side: username, laneIdx: l, depthIdx: d, buffAtk: 1, buffHp: 0, sourceUid: unit.uid });
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

  // Шумная дикарка: same adjacent-ally-only targeting as Родная
  // тетушка's own auntBuff right above, but +2 attack only (no hp
  // change) instead of +1/+1 — a separate field since the amounts
  // differ, same deferred pendingRallyBuffs queue either way.
  if (card.noisyBuff) {
    const board = match.boards[username];
    const neighbours = adjacentAllyPositions(board, lane, depth);
    if (neighbours.length > 0) {
      const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
      match.pendingRallyBuffs.push({ side: username, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, buffAtk: 2, buffHp: 0, sourceUid: unit.uid });
    }
  }

  // Вождь дикарей: same adjacent-ally-only targeting as Шумная
  // дикарка/Родная тетушка above, but +2/+2 AND permanently grants
  // Топот (trample) on top — same deferred pendingRallyBuffs queue,
  // just with buffTrample added (see the drain loop in tryEndTurn,
  // which now threads it through same as buffAtk/buffHp).
  if (card.savageChiefBuff) {
    const board = match.boards[username];
    const neighbours = adjacentAllyPositions(board, lane, depth);
    if (neighbours.length > 0) {
      const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
      match.pendingRallyBuffs.push({ side: username, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, buffAtk: 2, buffHp: 2, buffTrample: true, sourceUid: unit.uid });
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
  if (card.shootHero || card.shootHeroStartOfTurn) {
    match.pendingShots.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid });
  }

  // Бамбуковый стрелок: battlecry throw — same deferred reasoning as
  // every other battlecry, resolved at the start of the next resolution
  // (see pendingBambooShots below). Fixed damage, unlike Арбалетчик's
  // Synergy-based shot.
  if (card.bambooShotOnPlay) {
    match.pendingBambooShots.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, amount: card.bambooShotOnPlay });
  }

  // Дикарь-стрелок: battlecry throw at a random ENEMY UNIT (not a cell —
  // unlike Бамбуковый стрелок's own battlecry, no hero-redirect if the
  // pick comes up empty, since it's picked from actually-occupied cells
  // only) — see pendingMarksmanShots/applyRandomEnemyShot below.
  if (card.randomShotOnPlay) {
    match.pendingMarksmanShots.push({ side: username, laneIdx: lane, depthIdx: depth, sourceUid: unit.uid, amount: card.randomShotOnPlay });
  }

  // Толстый караульный: battlecry summon — same deferred reasoning as
  // Монахиня/Арбалетчик above (revealed as an animated event at the
  // start of resolution, not silently during placing). Which random
  // free cell it lands on is worked out then too, not here, since more
  // cells could still fill up before resolution starts.
  if (card.battlecrySummon) {
    match.pendingBattlecrySummons.push({ side: username, summonCardId: card.battlecrySummon, summonCount: card.battlecrySummonCount || 1, sourceUid: unit.uid });
  }

  // Карающий ангел: battlecry queued the same deferred way — checked and
  // resolved at the start of the next resolution (see
  // pendingPunisherKills in tryEndTurn), specifically AFTER Мгновенный
  // призыв has already run, so a militiaman instant-summoned this same
  // turn is already on the board and counts as "appeared this turn" too.
  if (card.punisherKill) {
    match.pendingPunisherKills.push({ side: username, laneIdx: lane, sourceUid: unit.uid });
  }

  // Рейна Ослепительная: battlecry queued the same deferred way as every
  // other battlecry — resolved at the start of the next resolution (see
  // pendingBlinds in tryEndTurn), snapshotting whoever's on the enemy
  // board at that moment (after Мгновенный призыв has already run, so a
  // this-turn instant-summon is included too).
  if (card.blindEnemiesOnPlay) {
    match.pendingBlinds.push({ side: username, sourceUid: unit.uid, laneIdx: lane, depthIdx: depth });
  }

  // Имперский полководец: battlecry queued the same deferred way as
  // every other battlecry — resolved at the start of the next
  // resolution (see pendingWarlordBuffs in tryEndTurn).
  if (card.warlordBuff) {
    match.pendingWarlordBuffs.push({ side: username, sourceUid: unit.uid });
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

  if (card.dmg || card.wrathDmg || card.bounceToHand || card.treeWrath) {
    if (lane < 0 || lane >= LANES) return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u043b\u043e\u0441\u0430.' };
  } else if (card.healHero) {
    // Родник: any cell works, occupied or empty, friendly or not — the
    // cell is purely where the player points it, not something the
    // spell reads or changes.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.heal || card.buffHp || card.buffAtk || card.buffArmor || card.buffLifesteal || card.buffDoubleStrike || card.mountainStrength || card.buffTrample || card.buffLegacy || card.buffSpellResist) {
    const unit = depth != null && match.boards[username][lane] && match.boards[username][lane][depth];
    if (!unit) return { error: '\u0422\u0430\u043c \u043d\u0435\u0442 \u0441\u0432\u043e\u0435\u0433\u043e \u0431\u043e\u0439\u0446\u0430.' };
    // Архат в доспехах: Щит makes a unit immune to being the TARGET of
    // ANY spell at all — checked here, right at cast validation, since
    // every "buff a specific own unit" spell in the game funnels
    // through this exact same branch.
    if (unit.shieldEffect) return { error: '\u042e\u043d\u0438\u0442 \u0437\u0430\u0449\u0438\u0449\u0451\u043d \u044d\u0444\u0444\u0435\u043a\u0442\u043e\u043c \u0429\u0438\u0442.' };
  } else if (card.instantSummon) {
    // Отряд ополченцев: any cell works, occupied or empty, friendly or
    // not — same as Родник, the cell is purely where the player points
    // it. The actual summons land on random EMPTY cells of their own
    // board, worked out fresh once resolution starts, not here.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.pineForest) {
    // Сосновый лес: unlike Отряд ополченцев, the target cell here is
    // NOT just a formality — it's specifically WHERE one of the
    // summoned Сосновый отшельник actually lands, so it must be a
    // real, currently-EMPTY cell on the caster's own board.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
    if (match.boards[username][lane][depth]) {
      return { error: '\u042f\u0447\u0435\u0439\u043a\u0430 \u0437\u0430\u043d\u044f\u0442\u0430.' };
    }
  } else if (card.endOfRoundSpell) {
    // Крестьянское ополчение: same "any cell" casting as Отряд
    // ополченцев — only the RESOLUTION timing differs (end of round,
    // not start), see the endOfRoundSpellQueue extraction in tryEndTurn.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.randomBlind) {
    // Яркий свет: same "any cell" casting — the player doesn't choose
    // who's blinded, it's a random enemy unit picked at resolution.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.lifeLight) {
    // Свет жизни: same "any own cell" casting as Родник — but UNLIKE
    // Родник, exactly which cell was chosen matters at resolution time
    // (the conditional summon lands there specifically, and fails
    // outright if something's occupying it by then).
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.guardCall) {
    // Вызов стражи: same "any own cell" casting as Свет жизни — the
    // targeted cell matters at resolution (the first summon lands there
    // specifically, silently failing if occupied by then), the second
    // summon lands on a random free cell regardless.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.heavenlyRays) {
    // Небесные лучи: buffs every allied unit regardless of where the
    // player clicks — same "any own cell" casting as Родник.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.songToTheMoon) {
    // Песнь Луне: same "any own cell" casting as Небесные лучи — the
    // player doesn't choose either target, both are picked randomly.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.bounceCellAndNeighbor) {
    // Небесный вихрь: targets a SPECIFIC cell on the ENEMY's board —
    // a brand new targeting shape (every prior enemy-targeting spell
    // was lane-only or fully random). Just needs valid bounds; the
    // cell can be empty or occupied, checked again at resolution.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  } else if (card.trapKill) {
    // Kapkan (\u041a\u0430\u043f\u043a\u0430\u043d): unlike the strict own-unit buff branch
    // above, an empty enemy cell is now a VALID target (per explicit user
    // correction) \u2014 the cast always succeeds on a valid cell, and it's only
    // checked again at resolution whether a unit actually ended up there by
    // then (see the 'trapKill' branch in resolveSpells). Same "any enemy
    // cell" bounds-only validation as \u041d\u0435\u0431\u0435\u0441\u043d\u044b\u0439 \u0432\u0438\u0445\u0440\u044c above.
    if (lane < 0 || lane >= LANES || depth == null || depth < 0 || depth >= DEPTH) {
      return { error: '\u041d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u0430\u044f \u043f\u043e\u0437\u0438\u0446\u0438\u044f.' };
    }
  }

  match.mana[username] -= card.cost;
  hand.splice(idx, 1);
  match.pendingSpells.push({
    side: username,
    cardId: card.id,
    kind: card.wrathDmg ? 'wrath' : (card.dmg ? 'damage' : (card.healHero ? 'wellspring' : (card.heal ? 'heal' : (card.instantSummon ? 'instantSummon' : (card.endOfRoundSpell ? 'endOfRoundSpell' : (card.bounceToHand ? 'skyWhirlwind' : (card.randomBlind ? 'randomBlind' : (card.lifeLight ? 'lifeLight' : (card.guardCall ? 'guardCall' : (card.heavenlyRays ? 'heavenlyRays' : (card.songToTheMoon ? 'songToTheMoon' : (card.bounceCellAndNeighbor ? 'bounceCellAndNeighbor' : (card.treeWrath ? 'treeWrath' : (card.mountainStrength ? 'mountainStrength' : (card.pineForest ? 'pineForest' : (card.trapKill ? 'trapKill' : 'buff')))))))))))))))),
    laneIdx: lane,
    depthIdx: depth,
    dmg: card.dmg,
    wrathDmg: card.wrathDmg,
    heal: card.heal,
    healHero: card.healHero,
    drawCard: card.drawCard,
    buffHp: card.buffHp,
    buffAtk: card.buffAtk,
    buffArmor: card.buffArmor,
    buffLifesteal: card.buffLifesteal,
    buffDoubleStrike: card.buffDoubleStrike,
    drawIfArmored: card.drawIfArmored,
    drawIfAsleep: card.drawIfAsleep,
    summonCardId: card.summonCardId,
    summonCount: card.summonCount,
    healAmount: card.healAmount,
    treeWrathAmount: card.treeWrathAmount,
    bounceMilitiaChance: card.bounceMilitiaChance,
    buffHeroHeal: card.buffHeroHeal,
    mountainArmor: card.mountainArmor,
    buffTrample: card.buffTrample,
    buffSpellResist: card.buffSpellResist,
    buffLegacy: card.buffLegacy,
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

// Подрывник (explodeOnDeath): the ONE place a unit is ever removed from
// a board because it died (as opposed to moving, being returned to
// hand, or being bounced by a spell) — every such site in this file
// routes through here so the self-damage and its explosion event fire
// at the EXACT moment and EXACT cell of death, never deferred to any
// later checkpoint.
function killUnit(match, side, laneIdx, depthIdx, events) {
  const board = match.boards[side];
  const unit = board[laneIdx][depthIdx];
  board[laneIdx][depthIdx] = null;
  // Шаман прерий (Мана 1): the bonus only lasts "while alive and on
  // the battlefield" — the instant he dies, his owner's CURRENT mana
  // drops back by that same amount, floored at 0 so it can never go
  // negative even if the bonus mana was already spent this round.
  if (unit && unit.manaAura) {
    match.mana[side] = Math.max(0, match.mana[side] - unit.manaAura);
  }
  if (unit && unit.explodeOnDeath && !anyHeroDown(match)) {
    const amount = unit.explodeOnDeathAmount;
    match.hp[side] -= amount;
    events.push({ type: 'selfExplosion', side, amount, sourceUid: unit.uid, cardId: unit.id, laneIdx, depthIdx });
  }
  // Детеныш кабана: on death (from anything), heals its owner's hero
  // for a fixed amount — reuses the exact 'endOfRound' event/heal-orb
  // animation already built for Сосновый отшельник's own recurring
  // fixedHeal; the client already drives that event's name off cardId
  // rather than board state, so it works fine here too even though the
  // unit is already gone from the board by this point.
  if (unit && unit.healOnDeath && !anyHeroDown(match)) {
    const healed = healHero(match, side, unit.healOnDeath, events);
    events.push({ type: 'endOfRound', side, cardId: unit.id, uid: unit.uid, amount: healed, laneIdx, depthIdx });
  }
  // Отшельник-Даос: on death, draws 1 card from her OWNER's own deck.
  // cardId is included (here and on every other on-death event below)
  // so the client can look up the dying unit's own name generically —
  // by the time these fire, the unit is already gone from the board
  // (nulled right above), so the client can't read it back off its own
  // board state the way it does for a still-alive unit's own events.
  if (unit && unit.drawOnDeath) {
    const beforeLen = match.hands[side].length;
    draw(match.decks[side], match.hands[side], 1);
    const drew = match.hands[side].length > beforeLen;
    events.push({ type: 'deathDraw', side, sourceUid: unit.uid, cardId: unit.id, laneIdx, depthIdx, drew });
  }
  // Кактус прерий: same on-death draw as Отшельник-Даос above, but only
  // a 50% chance (chanceDrawOnDeath) rather than guaranteed. Reuses the
  // exact same 'deathDraw' event so the client needs no new handling.
  if (unit && unit.chanceDrawOnDeath && Math.random() < unit.chanceDrawOnDeath) {
    const beforeLen = match.hands[side].length;
    draw(match.decks[side], match.hands[side], 1);
    const drew = match.hands[side].length > beforeLen;
    events.push({ type: 'deathDraw', side, sourceUid: unit.uid, cardId: unit.id, laneIdx, depthIdx, drew });
  }
  // Метеоритный страж: on death, throws his weapon at a random depth
  // within the SAME lane index on the enemy's board — his own mirrored
  // lane, same convention as Имперская пушка. Damage equals his own
  // attack. Чаростойкость blocks it outright (struck harmlessly, no
  // redirect), same as every other cross-side damage mechanic; an empty
  // square redirects to the enemy hero instead.
  if (unit && unit.weaponThrowOnDeath && !anyHeroDown(match)) {
    const targetSide = otherPlayer(match, side);
    const targetBoard = match.boards[targetSide];
    const targetDepth = Math.floor(Math.random() * DEPTH);
    const cellUnit = targetBoard[laneIdx][targetDepth];
    const resisted = !!(cellUnit && cellUnit.spellResist);
    const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
    const amount = unit.atk;
    let died = false;
    if (resisted) {
      // no-op: the weapon lands on her harmlessly
    } else if (targetUnit) {
      targetUnit.hp -= amount;
      died = targetUnit.hp <= 0;
    } else {
      match.hp[targetSide] -= amount;
    }
    events.push({
      type: 'weaponThrow', side, targetSide, amount: resisted ? 0 : amount,
      laneIdx, depthIdx, sourceUid: unit.uid,
      targetLaneIdx: laneIdx, targetDepthIdx: targetDepth,
      targetHero: !cellUnit, died, resisted,
    });
    if (died) killUnit(match, targetSide, laneIdx, targetDepth, events);
  }
  // Наследие (Отшельник and anyone who inherits it): on death, if the
  // unit is currently carrying a Legacy value (its own starting value,
  // or a larger stacked one it received from an earlier death in the
  // chain), picks ONE random ADJACENT ally and gives it +N atk / +N hp
  // (N = the carried Legacy value) AND transfers that SAME Legacy value
  // to it, stacking on top of whatever Legacy that ally might already
  // be carrying. The unit that just died never benefits from its own
  // Legacy — only the ally it transfers to does. No adjacent ally at
  // all simply lets the Legacy dissipate with nowhere to go.
  if (unit && unit.legacyValue > 0) {
    const neighbours = adjacentAllyPositions(board, laneIdx, depthIdx);
    if (neighbours.length > 0) {
      const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
      const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
      const amount = unit.legacyValue;
      targetUnit.atk += amount;
      targetUnit.hp += amount;
      targetUnit.maxHp += amount;
      targetUnit.legacyValue = (targetUnit.legacyValue || 0) + amount;
      events.push({
        type: 'legacyTransfer', side, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx,
        amount, newLegacyValue: targetUnit.legacyValue, sourceUid: unit.uid,
      });
      // Бамбуковый страж: whenever THIS specific unit is the RECIPIENT
      // of a Наследие transfer (not merely a unit that starts with the
      // effect itself), it fires a bamboo spear at a random enemy unit
      // anywhere on the board for a fixed 2 damage (reuses the exact
      // bambooShot event/visual already built for Бамбуковый стрелок),
      // and trades +1 attack for -1 health on itself — every single
      // time this triggers, so it can stack repeatedly across a long
      // chain of deaths. If that self-inflicted hp loss brings it to 0
      // or below, it dies too, routed through killUnit itself so any of
      // its OWN on-death effects (it doesn't have any right now, but a
      // future card might) still correctly fire.
      if (targetUnit.bambooGuardian) {
        const enemySide = otherPlayer(match, side);
        const enemyBoard = match.boards[enemySide];
        const enemyTargets = [];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            if (enemyBoard[l2][d2]) enemyTargets.push({ laneIdx: l2, depthIdx: d2 });
          }
        }
        if (enemyTargets.length > 0) {
          const enemyChosen = enemyTargets[Math.floor(Math.random() * enemyTargets.length)];
          const enemyUnit = enemyBoard[enemyChosen.laneIdx][enemyChosen.depthIdx];
          const resisted = !!enemyUnit.spellResist;
          const spearAmount = resisted ? 0 : 2;
          let enemyDied = false;
          if (!resisted) {
            enemyUnit.hp -= spearAmount;
            enemyDied = enemyUnit.hp <= 0;
          }
          events.push({
            type: 'bambooShot', side, targetSide: enemySide, amount: spearAmount,
            laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, sourceUid: targetUnit.uid,
            targetLaneIdx: enemyChosen.laneIdx, targetDepthIdx: enemyChosen.depthIdx,
            targetHero: false, died: enemyDied, resisted,
          });
          if (enemyDied) killUnit(match, enemySide, enemyChosen.laneIdx, enemyChosen.depthIdx, events);
        }
        targetUnit.atk += 1;
        targetUnit.hp -= 1;
        events.push({
          type: 'bambooGuardianTrade', side, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, sourceUid: targetUnit.uid,
        });
        if (targetUnit.hp <= 0) killUnit(match, side, chosen.laneIdx, chosen.depthIdx, events);
      }
      // Дракон в доспехах: whenever THIS specific unit is the RECIPIENT
      // of a Наследие transfer (same "recipient, not born-with" scoping
      // as Бамбуковый страж above), gains an ADDITIONAL permanent +2
      // attack and +2 health on top of the transfer's own +N/+N.
      if (targetUnit.armoredDragon) {
        targetUnit.atk += 2;
        targetUnit.hp += 2;
        targetUnit.maxHp += 2;
        events.push({
          type: 'rallyBuff', side, laneIdx: chosen.laneIdx,
          targetDepth: chosen.depthIdx, buffAtk: 2, buffHp: 2, sourceUid: targetUnit.uid,
        });
      }
      // Овца-воин: whenever THIS specific unit is the RECIPIENT of a
      // Наследие transfer (same "recipient, not born-with" scoping as
      // Бамбуковый страж/Дракон в доспехах above), heals her OWNER's
      // own hero for 6 — same fixed amount as her own battlecry heal.
      if (targetUnit.warriorSheep) {
        const healed = healHero(match, side, 6, events);
        events.push({
          type: 'heroHeal', side, amount: healed,
          sourceUid: targetUnit.uid, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx,
        });
      }
      // Архат в доспехах: whenever THIS specific unit is the RECIPIENT
      // of a Наследие transfer, ON TOP OF the standard +N/+N and
      // legacyValue she already received above (unchanged, standard
      // behavior for every Наследие recipient), she ALSO permanently
      // gains Щит and Кража жизни (lifesteal) — a one-time grant, not
      // reapplied on subsequent transfers (though re-setting an
      // already-true flag is harmless either way).
      if (targetUnit.armoredArhat) {
        targetUnit.shieldEffect = true;
        targetUnit.lifesteal = true;
        events.push({
          type: 'arhatShield', side, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx, sourceUid: targetUnit.uid,
        });
      }
      // Отшельник-Даос: whenever THIS specific unit is the RECIPIENT of
      // a Наследие transfer (same "recipient, not born-with" scoping as
      // Бамбуковый страж/Дракон в доспехах/Овца-воин above), copies
      // herself onto a random ADJACENT EMPTY cell — the copy does NOT
      // carry the Наследие she just received (legacyValue reset to 0),
      // matching everything else about her at that exact moment
      // (current atk/hp/armor snapshot, not her base stats).
      if (targetUnit.copyOnLegacy) {
        const emptyNeighbours = adjacentCellPositions(chosen.laneIdx, chosen.depthIdx)
          .filter((pos) => !board[pos.laneIdx][pos.depthIdx]);
        if (emptyNeighbours.length > 0) {
          const dest = emptyNeighbours[Math.floor(Math.random() * emptyNeighbours.length)];
          const copy = { ...targetUnit, uid: nextUid('unit'), legacyValue: 0, placedThisRound: true };
          board[dest.laneIdx][dest.depthIdx] = copy;
          events.push({
            type: 'hermitCopy', side, sourceLaneIdx: chosen.laneIdx, sourceDepthIdx: chosen.depthIdx,
            targetLaneIdx: dest.laneIdx, targetDepthIdx: dest.depthIdx, cardId: copy.id, sourceUid: targetUnit.uid,
            copyUid: copy.uid, atk: copy.atk, hp: copy.hp, maxHp: copy.maxHp, armor: copy.armor,
          });
        }
      }
      // Странствующий ученик: whenever THIS specific unit is the
      // RECIPIENT of a Наследие transfer, transforms ENTIRELY into
      // Потомок дракона — a full replacement, not a buff, so whatever
      // +N/+N she just received above is simply discarded along with
      // the rest of her old self (she's a different creature now).
      if (targetUnit.transformOnLegacy) {
        const newCard = cardById(targetUnit.transformOnLegacy);
        if (newCard) {
          const transformed = buildUnitFromCard(newCard, false, match.round);
          board[chosen.laneIdx][chosen.depthIdx] = transformed;
          events.push({
            type: 'discipleTransform', side, laneIdx: chosen.laneIdx, depthIdx: chosen.depthIdx,
            newCardId: newCard.id, newUid: transformed.uid, atk: transformed.atk, hp: transformed.hp,
            maxHp: transformed.maxHp, armor: transformed.armor, sourceUid: targetUnit.uid,
          });
        }
      }
    }
  }
}

// Двойное омоложение (Имперский патриарх): while he's alive anywhere on a
// side's own board, EVERY heal that side's hero receives is doubled —
// spells, lifesteal, end-of-round heals, battlecries, all of it. This is
// the single choke point every hero-heal in the file must go through so
// none of them accidentally skip the multiplier; it returns the amount
// actually applied so callers can show the real (possibly doubled)
// number in their own events instead of the raw pre-multiplier one.
function hasDoubleHeal(match, side) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d] && board[l][d].doubleHeal) return true;
    }
  }
  return false;
}
// `events` is optional so any existing caller that genuinely has none
// handy still works (just silently skips the growth animation) — every
// real call site in this file does pass it, though.
function healHero(match, side, amount, events) {
  if (amount <= 0) return 0;
  const applied = hasDoubleHeal(match, side) ? amount * 2 : amount;
  match.hp[side] += applied;
  // Имперский патриарх: every time healing actually lands for his own side
  // (including her own battlecry heal, since she's already on the board
  // when that resolves), she permanently grows +1 attack / +1 hp.
  // Reuses the existing rallyBuff event/animation, same as Бишоп or
  // Каменная Стена's own growth.
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const unit = board[l][d];
      if (unit && unit.doubleHeal) {
        unit.atk += 1;
        unit.hp += 1;
        unit.maxHp += 1;
        if (events) {
          events.push({
            type: 'rallyBuff', side, laneIdx: l,
            targetDepth: d, buffAtk: 1, buffHp: 1, sourceUid: unit.uid,
          });
        }
      }
      // Священник святого Света: every time healing actually lands for
      // his own side (his own battlecry heal included, same reasoning
      // as Имперский патриарх above), picks one random OTHER ally
      // anywhere on the board and permanently gives it +1 attack / +3
      // hp. Reuses the same rallyBuff event/animation.
      if (unit && unit.healTrigger) {
        const targets = [];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            if (l2 === l && d2 === d) continue; // never himself
            if (board[l2][d2]) targets.push({ laneIdx: l2, depthIdx: d2 });
          }
        }
        if (targets.length > 0) {
          const chosen = targets[Math.floor(Math.random() * targets.length)];
          const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
          targetUnit.atk += 1;
          targetUnit.hp += 3;
          targetUnit.maxHp += 3;
          if (events) {
            events.push({
              type: 'rallyBuff', side, laneIdx: chosen.laneIdx,
              targetDepth: chosen.depthIdx, buffAtk: 1, buffHp: 3, sourceUid: unit.uid,
            });
          }
        }
      }
    }
  }
  // Ящерица степей: every time healing actually lands for his own
  // side (his own battlecry heal, if any, included — same reasoning
  // as Имперский патриарх/Священник above), gains a PERMANENT +2
  // attack to HIMSELF. Shared with Шеф дома Вкуса's own one-time
  // hero-hp doubling below, which bypasses healHero() entirely (see
  // applyLizardHealTrigger).
  if (events) applyLizardHealTrigger(match, side, events);
  // Суслик: same "every heal" trigger as Ящерица степей right above,
  // but +1 attack AND +2 health to himself instead of +2 attack alone
  // — a separate helper since the amounts differ, shared with Шеф дома
  // Вкуса's doubling the same way.
  if (events) applySquirrelHealTrigger(match, side, events);
  // Броненосец: same "every heal" trigger as Ящерица степей/Суслик
  // above, but +1 attack AND +1 armor to himself instead — a separate
  // helper since the amounts/stats differ, shared with Шеф дома Вкуса's
  // doubling the same way.
  if (events) applyArmadilloHealTrigger(match, side, events);
  // Ящер-воин: same "every heal" trigger, but instead of buffing
  // himself, throws a spear at a random ENEMY unit for damage equal to
  // his own current attack — shared with Шеф дома Вкуса's doubling the
  // same way as every trigger above.
  if (events) applyLizardWarriorTrigger(match, side, events);
  // Барсук: same "every heal" trigger as Ящерица степей/Суслик/
  // Броненосец above, but +1 attack AND +1 health to himself — a
  // separate helper since the amounts differ, shared with Шеф дома
  // Вкуса's doubling the same way.
  if (events) applyBadgerHealTrigger(match, side, events);
  // Одноглазая тварь: same "every heal" trigger as Барсук above, but
  // +3 attack AND +3 health instead of +1/+1 — a separate helper since
  // the amount differs, shared with Шеф дома Вкуса's doubling the same
  // way.
  if (events) applyOneEyedBeastHealTrigger(match, side, events);
  // Кай Кровавый: same "every heal" trigger as every card above, but
  // +2 attack / +1 health EVERY time plus a one-time permanent Топот
  // grant — a separate helper since the shape (a conditional flag grant
  // alongside the numeric buff) is new, shared with Шеф дома Вкуса's
  // doubling the same way.
  if (events) applyKaiBloodyHealTrigger(match, side, events);
  return applied;
}

// Суслик: shared by both healHero() above and Шеф дома Вкуса's own
// one-time hero-hp doubling (which bypasses healHero() entirely) —
// same reasoning as applyLizardHealTrigger right below.
function applySquirrelHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.squirrelHealBuff) {
        u.atk += 1;
        u.hp += 2;
        u.maxHp += 2;
        events.push({
          type: 'rallyBuff', side, laneIdx: l,
          targetDepth: d, buffAtk: 1, buffHp: 2, sourceUid: u.uid,
        });
      }
    }
  }
}

// Ящерица степей: shared by both healHero() above (the OVERWHELMING
// majority of heal-hero effects in the game) and Шеф дома Вкуса's own
// one-time hero-hp doubling below, which bypasses healHero() entirely
// with a direct match.hp assignment — pulled out so both call sites
// share one implementation instead of duplicating the board scan.
function applyLizardHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const unit = board[l][d];
      if (unit && unit.lizardHealBuff) {
        unit.atk += 2;
        events.push({
          type: 'rallyBuff', side, laneIdx: l,
          targetDepth: d, buffAtk: 2, buffHp: 0, sourceUid: unit.uid,
        });
      }
    }
  }
}

// Броненосец: shared by both healHero() above and Шеф дома Вкуса's own
// one-time hero-hp doubling (which bypasses healHero() entirely) — same
// reasoning as applyLizardHealTrigger/applySquirrelHealTrigger above.
function applyArmadilloHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.armadilloHealBuff) {
        u.atk += 1;
        u.armor += 1;
        events.push({
          type: 'rallyBuff', side, laneIdx: l,
          targetDepth: d, buffAtk: 1, buffHp: 0, buffArmor: 1, sourceUid: u.uid,
        });
      }
    }
  }
}

// Ящер-воин: shared by both healHero() above and Шеф дома Вкуса's own
// one-time hero-hp doubling (which bypasses healHero() entirely) — same
// reasoning as every other heal-trigger helper above. Unlike those, this
// one doesn't buff its own side at all — it throws a spear at a random
// ENEMY unit for damage equal to its own CURRENT attack, reusing the
// exact same target-collection (Чаростойкость-respecting) and 'unitShot'
// event already built for Осадная башня's own end-of-round siegeShot.
function applyLizardWarriorTrigger(match, side, events) {
  const board = match.boards[side];
  const targetSide = otherPlayer(match, side);
  const targetBoard = match.boards[targetSide];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.lizardWarriorShot) {
        const targets = [];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            if (targetBoard[l2][d2] && !targetBoard[l2][d2].spellResist) targets.push({ laneIdx: l2, depthIdx: d2 });
          }
        }
        if (targets.length > 0) {
          const chosen = targets[Math.floor(Math.random() * targets.length)];
          const targetUnit = targetBoard[chosen.laneIdx][chosen.depthIdx];
          const amount = u.atk;
          targetUnit.hp -= amount;
          const died = targetUnit.hp <= 0;
          events.push({
            type: 'unitShot', side, targetSide, amount,
            laneIdx: l, depthIdx: d, sourceUid: u.uid,
            targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, died,
          });
          if (died) killUnit(match, targetSide, chosen.laneIdx, chosen.depthIdx, events);
        }
      }
    }
  }
}

// Барсук: shared by both healHero() above and Шеф дома Вкуса's own
// one-time hero-hp doubling (which bypasses healHero() entirely) —
// same reasoning as every other heal-trigger helper above.
function applyBadgerHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.badgerHealBuff) {
        u.atk += 1;
        u.hp += 1;
        u.maxHp += 1;
        events.push({
          type: 'rallyBuff', side, laneIdx: l,
          targetDepth: d, buffAtk: 1, buffHp: 1, sourceUid: u.uid,
        });
      }
    }
  }
}

// Одноглазая тварь: shared by both healHero() above and Шеф дома
// Вкуса's own one-time hero-hp doubling (which bypasses healHero()
// entirely) — same reasoning as applyBadgerHealTrigger right above.
function applyOneEyedBeastHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.oneEyedBeastHealBuff) {
        u.atk += 3;
        u.hp += 3;
        u.maxHp += 3;
        events.push({
          type: 'rallyBuff', side, laneIdx: l,
          targetDepth: d, buffAtk: 3, buffHp: 3, sourceUid: u.uid,
        });
      }
    }
  }
}

// Кай Кровавый: same "every heal" trigger as Барсук/Одноглазая тварь
// above, but +2 attack AND +1 health EVERY time, plus a PERMANENT
// Топот grant the first time only — once he already has trample,
// later heals still give the +2/+1 but the trample part is simply
// already true, so buffTrample comes through false on the event (per
// explicit spec: "if he already has Топот, only the atk/hp buff
// fires").
function applyKaiBloodyHealTrigger(match, side, events) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.kaiBloodyHealBuff) {
        u.atk += 2;
        u.hp += 1;
        u.maxHp += 1;
        const grantedTrample = !u.trample;
        if (grantedTrample) u.trample = true;
        events.push({
          type: 'rallyBuff', side, laneIdx: l, targetDepth: d,
          buffAtk: 2, buffHp: 1, buffTrample: grantedTrample, sourceUid: u.uid,
        });
      }
    }
  }
}

function resolveSpells(match, events) {
  const queue = match.pendingSpells;
  match.pendingSpells = [];
  for (const spell of queue) {
    if (anyHeroDown(match)) break; // match already decided — stop applying further spells
    if (spell.kind === 'wrath') {
      // Гнев небес: unlike 'damage' (front unit only), this hits EVERY
      // depth position in the chosen enemy lane — one damage event per
      // cell, in order, so the client plays them as a sequence of
      // lightning strikes rather than one simultaneous hit. An empty
      // cell still gets struck (visually) but deals nothing; a
      // Чаростойкость unit is struck too but takes no damage, same
      // resisted-no-redirect behavior as every other cross-side damage
      // mechanic — this never falls through to the hero.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      for (let d = 0; d < DEPTH; d++) {
        if (anyHeroDown(match)) break;
        const targetUnit = board[spell.laneIdx][d];
        if (!targetUnit) {
          events.push({
            type: 'spell', kind: 'wrath', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
            amount: 0, died: false, empty: true, resisted: false,
          });
        } else if (targetUnit.spellResist) {
          events.push({
            type: 'spell', kind: 'wrath', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
            amount: 0, died: false, empty: false, resisted: true,
          });
        } else {
          // Spell damage ignores armor entirely — only direct combat hits
          // are reduced by it.
          const applied = spell.wrathDmg;
          targetUnit.hp -= applied;
          const died = targetUnit.hp <= 0;
          events.push({
            type: 'spell', kind: 'wrath', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
            amount: applied, died, empty: false, resisted: false,
          });
          if (died) killUnit(match, defenderName, spell.laneIdx, d, events);
        }
      }
    } else if (spell.kind === 'skyWhirlwind') {
      // Воздушная буря: for every cell in the chosen enemy lane, a
      // non-Чаростойкость unit is bounced back to its OWNER's hand as a
      // fresh copy of its base card — losing every buff/debuff it had
      // accumulated, matching the exact "return to hand" shape already
      // used elsewhere in this file (id + a brand new uid). Чаростойкость
      // units are simply skipped, staying exactly where they are —
      // consistent with every other cross-side mechanic checking this
      // status. Afterward, a 30% chance summons a fresh Ополченец into
      // the CASTER's own mirrored lane specifically (not the whole
      // board), via summonUnitToRandomFreeCell's onlyLaneIdx scoping.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const hand = match.hands[defenderName];
      for (let d = 0; d < DEPTH; d++) {
        const targetUnit = board[spell.laneIdx][d];
        if (!targetUnit) {
          events.push({
            type: 'spell', kind: 'skyWhirlwind', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
            bounced: false, empty: true, resisted: false,
          });
          continue;
        }
        if (targetUnit.spellResist || targetUnit.rockEffect || targetUnit.shieldEffect) {
          events.push({
            type: 'spell', kind: 'skyWhirlwind', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
            bounced: false, empty: false, resisted: true, rockProtected: !!targetUnit.rockEffect,
          });
          continue;
        }
        hand.push({ id: targetUnit.id, uid: nextUid('card') });
        board[spell.laneIdx][d] = null;
        events.push({
          type: 'spell', kind: 'skyWhirlwind', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: d,
          bounced: true, empty: false, resisted: false, bouncedCardId: targetUnit.id,
        });
      }
      if (spell.bounceMilitiaChance && Math.random() < spell.bounceMilitiaChance) {
        summonUnitToRandomFreeCell(match, spell.side, 'c10', events, spell.laneIdx);
      }
    } else if (spell.kind === 'randomBlind') {
      // Яркий свет: picks ONE random enemy unit anywhere on the board
      // (Чаростойкость units are never eligible, same exclusion as
      // Рейна's blind) and adds it to match.blindedUids for this round
      // only — reuses the EXACT same mechanism/cleanup built for Рейна
      // Ослепительная (see resolveCombat/tryEndTurn), just a single
      // target instead of every enemy unit.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const targets = [];
      for (let l = 0; l < LANES; l++) {
        for (let d = 0; d < DEPTH; d++) {
          const u = board[l][d];
          if (u && !u.spellResist) targets.push({ laneIdx: l, depthIdx: d, unit: u });
        }
      }
      if (!match.blindedUids) match.blindedUids = new Set();
      if (targets.length > 0) {
        const chosen = targets[Math.floor(Math.random() * targets.length)];
        match.blindedUids.add(chosen.unit.uid);
        events.push({
          type: 'spell', kind: 'randomBlind', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName,
          targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, empty: false,
        });
      } else {
        events.push({
          type: 'spell', kind: 'randomBlind', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, empty: true,
        });
      }
    } else if (spell.kind === 'lifeLight') {
      // Свет жизни: heals own hero for a fixed amount first (via the
      // shared healHero choke point, so Двойное омоложение/Имперский
      // патриарх's growth still apply), THEN — only if that leaves the
      // caster's hero with STRICTLY MORE hp than the enemy's — attempts
      // to summon an Ополченец onto the SPECIFIC cell the player
      // targeted. If that cell is occupied by resolution time (by
      // anything, from either side reaching in — though only the
      // caster's own board is ever targeted), the summon simply fails,
      // no redirect elsewhere.
      const defenderName = otherPlayer(match, spell.side);
      const healed = healHero(match, spell.side, spell.healAmount, events);
      events.push({ type: 'heroHeal', side: spell.side, amount: healed, sourceUid: null, laneIdx: spell.laneIdx, depthIdx: spell.depthIdx });
      const qualifies = match.hp[spell.side] > match.hp[defenderName];
      let summoned = false;
      if (qualifies && !anyHeroDown(match)) {
        const board = match.boards[spell.side];
        if (!board[spell.laneIdx][spell.depthIdx]) {
          const summonedCard = cardById(spell.summonCardId);
          if (summonedCard) {
            const unit = buildUnitFromCard(summonedCard, false, match.round);
            board[spell.laneIdx][spell.depthIdx] = unit;
            events.push({ type: 'summon', side: spell.side, cardId: spell.summonCardId, laneIdx: spell.laneIdx, depthIdx: spell.depthIdx, uid: unit.uid });
            summoned = true;
          }
        }
      }
      events.push({
        type: 'spell', kind: 'lifeLight', side: spell.side, cardId: spell.cardId,
        laneIdx: spell.laneIdx, depthIdx: spell.depthIdx, qualifies, summoned,
      });
    } else if (spell.kind === 'heavenlyRays') {
      // Небесные лучи: buffs every allied unit currently on the
      // caster's board by +2/+2, reusing applyDawnBuff (parametrized to
      // 2 instead of its default 1) — the same "buff everyone" loop
      // already used by Аннабэль/Барон/Имперский полководец.
      applyDawnBuff(match, spell.side, events, null, 2);
    } else if (spell.kind === 'songToTheMoon') {
      // Песнь Луне: a random ally gets +1 attack, a random enemy gets
      // -1 attack (floored at 0 — never negative), and the caster
      // draws 1 card from their own deck. Each part independently
      // no-ops if there's nobody to target on that side.
      const defenderName = otherPlayer(match, spell.side);
      const ownBoard = match.boards[spell.side];
      const ownAllies = [];
      for (let l = 0; l < LANES; l++) {
        for (let d = 0; d < DEPTH; d++) {
          if (ownBoard[l][d] && !ownBoard[l][d].shieldEffect) ownAllies.push({ laneIdx: l, depthIdx: d });
        }
      }
      let allyLaneIdx = null, allyDepthIdx = null;
      if (ownAllies.length > 0) {
        const chosen = ownAllies[Math.floor(Math.random() * ownAllies.length)];
        const allyUnit = ownBoard[chosen.laneIdx][chosen.depthIdx];
        allyUnit.atk += 1;
        allyLaneIdx = chosen.laneIdx;
        allyDepthIdx = chosen.depthIdx;
      }
      const enemyBoard = match.boards[defenderName];
      const enemies = [];
      for (let l = 0; l < LANES; l++) {
        for (let d = 0; d < DEPTH; d++) {
          if (enemyBoard[l][d] && !enemyBoard[l][d].shieldEffect) enemies.push({ laneIdx: l, depthIdx: d });
        }
      }
      let enemyLaneIdx = null, enemyDepthIdx = null, enemyResisted = false;
      if (enemies.length > 0) {
        const chosen = enemies[Math.floor(Math.random() * enemies.length)];
        const enemyUnit = enemyBoard[chosen.laneIdx][chosen.depthIdx];
        enemyResisted = !!enemyUnit.spellResist;
        if (!enemyResisted) enemyUnit.atk = Math.max(0, enemyUnit.atk - 1);
        enemyLaneIdx = chosen.laneIdx;
        enemyDepthIdx = chosen.depthIdx;
      }
      const beforeLen = match.hands[spell.side].length;
      draw(match.decks[spell.side], match.hands[spell.side], 1);
      const drewCard = match.hands[spell.side].length > beforeLen;
      events.push({
        type: 'songToTheMoon', side: spell.side, targetSide: defenderName,
        allyLaneIdx, allyDepthIdx, enemyLaneIdx, enemyDepthIdx, enemyResisted, drewCard,
      });
    } else if (spell.kind === 'mountainStrength') {
      // Сила гор: increases the targeted unit's attack by an amount
      // equal to its OWN CURRENT hp — computed fresh right here at
      // resolution, not at cast time, so anything that changed her hp
      // in between (a heal, a buff, combat damage even) is reflected.
      // Сила гор Тянь-Шань additionally grants a fixed armor bonus
      // (mountainArmor) on top of that — a separate, optional field so
      // the original Сила гор (with no armor bonus at all) is
      // completely unaffected.
      const board = match.boards[spell.side];
      const unit = board[spell.laneIdx] && board[spell.laneIdx][spell.depthIdx];
      if (unit) {
        const amount = unit.hp;
        unit.atk += amount;
        if (spell.mountainArmor) unit.armor = (unit.armor || 0) + spell.mountainArmor;
        events.push({
          type: 'mountainStrength', side: spell.side, cardId: spell.cardId, laneIdx: spell.laneIdx,
          depthIdx: spell.depthIdx, amount, sourceUid: unit.uid, armorAmount: spell.mountainArmor || 0,
        });
      }
    } else if (spell.kind === 'pineForest') {
      // Сосновый лес: summons Сосновый отшельник onto the specifically
      // TARGETED cell (guaranteed — resolved FIRST, before either
      // random summon, since it was already validated to be empty at
      // cast time) AND onto one random free cell, then a 60% chance
      // for a THIRD onto another random free cell.
      const board = match.boards[spell.side];
      if (!board[spell.laneIdx][spell.depthIdx]) {
        const targetedCard = cardById('c79');
        if (targetedCard) {
          const unit = buildUnitFromCard(targetedCard, false, match.round);
          board[spell.laneIdx][spell.depthIdx] = unit;
          events.push({ type: 'summon', side: spell.side, cardId: 'c79', laneIdx: spell.laneIdx, depthIdx: spell.depthIdx, uid: unit.uid });
        }
      }
      summonUnitToRandomFreeCell(match, spell.side, 'c79', events);
      if (Math.random() < 0.6) {
        summonUnitToRandomFreeCell(match, spell.side, 'c79', events);
      }
    } else if (spell.kind === 'bounceCellAndNeighbor') {
      // Небесный вихрь: bounces the unit at the specifically TARGETED
      // enemy cell, plus the unit at ONE random ADJACENT cell
      // (occupancy-agnostic — the random pick could land on an empty
      // neighbour, in which case nothing happens for that part). Each
      // returned unit becomes a fresh base card in its owner's hand,
      // losing every buff/debuff — the exact same "return to hand"
      // shape used elsewhere in this file. Чаростойкость units are
      // simply skipped, staying exactly where they are.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const hand = match.hands[defenderName];
      const cellsToCheck = [{ laneIdx: spell.laneIdx, depthIdx: spell.depthIdx }];
      const neighbours = adjacentCellPositions(spell.laneIdx, spell.depthIdx);
      if (neighbours.length > 0) {
        cellsToCheck.push(neighbours[Math.floor(Math.random() * neighbours.length)]);
      }
      for (const cell of cellsToCheck) {
        const targetUnit = board[cell.laneIdx][cell.depthIdx];
        if (!targetUnit) {
          events.push({
            type: 'spell', kind: 'bounceCellAndNeighbor', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName,
            targetLaneIdx: cell.laneIdx, targetDepthIdx: cell.depthIdx, bounced: false, empty: true, resisted: false,
          });
          continue;
        }
        if (targetUnit.spellResist || targetUnit.rockEffect || targetUnit.shieldEffect) {
          events.push({
            type: 'spell', kind: 'bounceCellAndNeighbor', side: spell.side, cardId: spell.cardId,
            laneIdx: spell.laneIdx, targetSide: defenderName,
            targetLaneIdx: cell.laneIdx, targetDepthIdx: cell.depthIdx, bounced: false, empty: false, resisted: true, rockProtected: !!targetUnit.rockEffect,
          });
          continue;
        }
        hand.push({ id: targetUnit.id, uid: nextUid('card') });
        board[cell.laneIdx][cell.depthIdx] = null;
        events.push({
          type: 'spell', kind: 'bounceCellAndNeighbor', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName,
          targetLaneIdx: cell.laneIdx, targetDepthIdx: cell.depthIdx, bounced: true, empty: false, resisted: false, bouncedCardId: targetUnit.id,
        });
      }
    } else if (spell.kind === 'treeWrath') {
      // Ярость древа: a random depth within the chosen enemy lane —
      // the ENEMY HERO always takes the full amount regardless of
      // what's in that cell, and if a (non-Чаростойкость) unit is
      // there too, it ALSO takes the same amount, on top of the hero
      // damage rather than instead of it. Чаростойкость only shields
      // the unit itself; the hero still takes the hit either way.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const targetDepth = Math.floor(Math.random() * DEPTH);
      const cellUnit = board[spell.laneIdx][targetDepth];
      const resisted = !!(cellUnit && cellUnit.spellResist);
      const amount = spell.treeWrathAmount;
      match.hp[defenderName] -= amount;
      let died = false;
      if (cellUnit && !resisted) {
        cellUnit.hp -= amount;
        died = cellUnit.hp <= 0;
      }
      events.push({
        type: 'treeWrath', side: spell.side, targetSide: defenderName, amount,
        laneIdx: spell.laneIdx, targetDepthIdx: targetDepth,
        targetHero: !cellUnit, died, resisted,
      });
      if (died) killUnit(match, defenderName, spell.laneIdx, targetDepth, events);
    } else if (spell.kind === 'damage') {
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const info = frontUnit(board, spell.laneIdx);
      if (info && info.unit.spellResist) {
        // Чаростойкость: this enemy damage spell simply has no effect on
        // her — not redirected to the hero or anyone else, just resisted
        // outright. Still emits an event (0 damage, resisted:true) so the
        // pending-spell icon still clears and the client can show why
        // nothing happened.
        events.push({
          type: 'spell', kind: 'damage', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: info.depth,
          amount: 0, died: false, resisted: true,
        });
      } else if (info) {
        // Spell damage ignores armor entirely — only direct combat hits
        // are reduced by it.
        const applied = spell.dmg;
        info.unit.hp -= applied;
        const died = info.unit.hp <= 0;
        events.push({
          type: 'spell', kind: 'damage', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: info.depth,
          amount: applied, died,
        });
        if (died) killUnit(match, defenderName, spell.laneIdx, info.depth, events);
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
      const healed = healHero(match, spell.side, spell.healHero, events);
      const hand = match.hands[spell.side];
      const beforeLen = hand.length;
      if (spell.drawCard) draw(match.decks[spell.side], hand, spell.drawCard);
      const drew = hand.length > beforeLen;
      events.push({
        type: 'spell', kind: 'wellspring', side: spell.side, cardId: spell.cardId,
        laneIdx: spell.laneIdx, depthIdx: spell.depthIdx, targetSide: spell.side,
        healAmount: healed, drew,
      });
    } else if (spell.kind === 'buff') {
      // Permanent stat increase (e.g. Кольчуга, Доспехи) — unlike heal,
      // this raises the ceiling itself: both current and max HP go up,
      // not just a refill up to the old cap. Armor stacks additively
      // with whatever the unit already has (its own base, or from an
      // earlier cast of a different buff spell).
      const board = match.boards[spell.side];
      const unit = board[spell.laneIdx] && board[spell.laneIdx][spell.depthIdx];
      if (unit) {
        if (spell.buffAtk) unit.atk += spell.buffAtk;
        if (spell.buffHp) { unit.hp += spell.buffHp; unit.maxHp += spell.buffHp; }
        if (spell.buffArmor) unit.armor = (unit.armor || 0) + spell.buffArmor;
        if (spell.buffLifesteal) unit.lifesteal = true;
        // Посох дикого вепря: also grants Топот (trample) permanently,
        // and TRANSFERS the Наследие effect at the given value — using
        // the exact same legacyValue field already used by every other
        // Наследие-carrying card, so it stacks/behaves identically on
        // death (killUnit already handles legacyValue generically,
        // regardless of whether the unit was born with it or granted
        // it later by a spell).
        if (spell.buffTrample) unit.trample = true;
        if (spell.buffLegacy) unit.legacyValue = (unit.legacyValue || 0) + spell.buffLegacy;
        // Духовный щит: permanently grants Чаростойкость (spellResist).
        if (spell.buffSpellResist) unit.spellResist = true;
        // Двойной удар (the spell): permanently grants the SAME
        // doubleStrike flag already used by Имперский полководец's
        // warlordBuff — once set, actingOrder() keeps giving this unit
        // two full turns every wave, forever.
        if (spell.buffDoubleStrike) unit.doubleStrike = true;
        // Наплечник: if the TARGET already has Armor (her own, not from
        // this spell — buffArmor isn't set on this card at all), the
        // caster draws a card from their own deck as a bonus.
        // Запоздалая поставка: same bonus-draw idea, but keyed off the
        // target carrying Сон instead of Armor — checks the flag itself,
        // not whether it's currently gating the target's attack (i.e.
        // still true from the round after bornRound onward too).
        let drewCard = false;
        if ((spell.drawIfArmored && unit.armor > 0) || (spell.drawIfAsleep && unit.sleep)) {
          const beforeLen = match.hands[spell.side].length;
          draw(match.decks[spell.side], match.hands[spell.side], 1);
          drewCard = match.hands[spell.side].length > beforeLen;
        }
        events.push({
          type: 'spell', kind: 'buff', side: spell.side, cardId: spell.cardId,
          laneIdx: spell.laneIdx, targetSide: spell.side, targetDepth: spell.depthIdx,
          buffAtk: spell.buffAtk || 0, buffHp: spell.buffHp || 0, buffArmor: spell.buffArmor || 0,
          buffLifesteal: !!spell.buffLifesteal, buffDoubleStrike: !!spell.buffDoubleStrike,
          buffTrample: !!spell.buffTrample, buffLegacy: spell.buffLegacy || 0,
          buffSpellResist: !!spell.buffSpellResist, drewCard,
        });
        // Бурный рост: also heals the CASTER's own hero, alongside the
        // stat buff on the target unit — reuses the exact same
        // heroHeal event/animation already used by Родник/Монахиня.
        if (spell.buffHeroHeal) {
          const healed = healHero(match, spell.side, spell.buffHeroHeal, events);
          events.push({
            type: 'heroHeal', side: spell.side, amount: healed,
            sourceUid: unit.uid, laneIdx: spell.laneIdx, depthIdx: spell.depthIdx,
          });
        }
      }
    } else if (spell.kind === 'trapKill') {
      // Капкан: targets a specific enemy unit chosen at cast time.
      // Чаростойкость/Щит blocks the kill outright, no redirect — same
      // as every other targeted spell in this file (see nualFrontStab
      // above) — and the hero heal (equal to the killed unit's own
      // mana cost) only happens if the kill actually lands.
      const defenderName = otherPlayer(match, spell.side);
      const board = match.boards[defenderName];
      const targetUnit = board[spell.laneIdx] && board[spell.laneIdx][spell.depthIdx];
      const resisted = !!(targetUnit && (targetUnit.spellResist || targetUnit.shieldEffect));
      let died = false, healed = 0, killedCardId = null;
      if (targetUnit && !resisted) {
        killedCardId = targetUnit.id;
        const killedCard = cardById(targetUnit.id);
        died = true;
        killUnit(match, defenderName, spell.laneIdx, spell.depthIdx, events);
        healed = healHero(match, spell.side, killedCard ? killedCard.cost : 0, events);
      }
      events.push({
        type: 'spell', kind: 'trapKill', side: spell.side, cardId: spell.cardId,
        laneIdx: spell.laneIdx, targetSide: defenderName, targetDepth: spell.depthIdx,
        resisted, empty: !targetUnit, died, killedCardId,
      });
      if (healed > 0) {
        events.push({
          type: 'heroHeal', side: spell.side, amount: healed,
          sourceUid: null, laneIdx: spell.laneIdx, depthIdx: spell.depthIdx,
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
// `amount` (optional) parametrizes the buff size — defaults to 1, the
// original hardcoded value every existing caller (Аннабэль, Барон,
// Имперский полководец) still relies on. Небесные лучи is the first to
// pass a different value. `hpAmount` (optional) lets the hp side of the
// buff differ from the atk side — defaults to `amount` (same value for
// both, the original behavior every existing caller relies on) when
// omitted. Тотем дикарей is the first to pass 0 here for an atk-only buff.
function applyDawnBuff(match, side, events, sourceUid, amount, hpAmount) {
  amount = amount || 1;
  if (hpAmount === undefined) hpAmount = amount;
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u) {
        u.atk += amount;
        u.hp += hpAmount;
        u.maxHp += hpAmount;
        events.push({ type: 'rallyBuff', side, laneIdx: l, targetDepth: d, buffAtk: amount, buffHp: hpAmount, sourceUid });
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
// Статуя: at the very start of every round's resolution (same moment
// as Епископ below), picks one random ADJACENT ally (same
// cardinal-neighbour rule as Synergy/Родная тетушка — directly
// above/below/left/right, no diagonals) and permanently increases its
// hp by an amount equal to her own CURRENT attack. A safe no-op if she
// has no neighbour right now.
// Луна, голос будущего: a PERSISTENT aura, re-evaluated fresh at the
// start of every round she's alive (same moment as Епископ/Статуя
// below) — every enemy unit currently in HER mirrored lane (whichever
// lane she's actually standing in right now, re-checked each round)
// gets added to match.blindedUids for that round only, exactly like
// Рейна Ослепительная's one-shot version, just re-applied continuously
// and scoped to a single lane instead of the whole board. Чаростойкость
// units are immune, same exclusion rule. Cleared the same way (right
// after resolveCombat runs in tryEndTurn), so it never leaks into a
// round where she's no longer alive or has moved lanes.
function applyLunaBlind(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (!unit || !unit.lunaBlind) continue;
        const enemySide = otherPlayer(match, side);
        const enemyBoard = match.boards[enemySide];
        let blindedAny = false;
        for (let d2 = 0; d2 < DEPTH; d2++) {
          const eu = enemyBoard[l][d2];
          if (eu && !eu.spellResist) {
            if (!match.blindedUids) match.blindedUids = new Set();
            match.blindedUids.add(eu.uid);
            blindedAny = true;
          }
        }
        if (blindedAny) {
          events.push({ type: 'reinaBlind', side, laneIdx: l, depthIdx: d, sourceUid: unit.uid });
        }
      }
    }
  }
}

// Музыкальный Даос: at the start of every round he's alive, deals 1
// damage to EVERY enemy unit anywhere on their board — Чаростойкость
// blocks it outright, unit by unit. Multiple copies on the board each
// trigger independently (two copies deal 2 total damage per enemy).
// Небесный воин: whenever his own attack lands directly on the enemy
// hero, 50% chance to bounce a random enemy unit anywhere on the
// board back to hand — reuses the exact same random-target bounce
// logic (and the 'bellBounce' event/animation) already built for
// Даос с колокольчиком.
function applyHeavenlyWarriorHeroBounce(match, side, events, sourceUid, sourceLaneIdx, sourceDepthIdx) {
  if (Math.random() >= 0.5) return;
  const enemySide = otherPlayer(match, side);
  const enemyBoard = match.boards[enemySide];
  const targets = [];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (enemyBoard[l][d]) targets.push({ laneIdx: l, depthIdx: d });
    }
  }
  if (targets.length === 0) return;
  const chosen = targets[Math.floor(Math.random() * targets.length)];
  const targetUnit = enemyBoard[chosen.laneIdx][chosen.depthIdx];
  if (targetUnit.spellResist || targetUnit.rockEffect || targetUnit.shieldEffect) {
    events.push({
      type: 'bellBounce', side, targetSide: enemySide, laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx, sourceUid,
      targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, bounced: false, empty: false, resisted: true, rockProtected: !!targetUnit.rockEffect,
    });
    return;
  }
  match.hands[enemySide].push({ id: targetUnit.id, uid: nextUid('card') });
  enemyBoard[chosen.laneIdx][chosen.depthIdx] = null;
  events.push({
    type: 'bellBounce', side, targetSide: enemySide, laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx, sourceUid,
    targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, bounced: true, empty: false, resisted: false, bouncedCardId: targetUnit.id,
  });
}

function applyMusicalDaoist(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (!unit || !unit.musicalDaoist) continue;
        const enemySide = otherPlayer(match, side);
        const enemyBoard = match.boards[enemySide];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            const enemyUnit = enemyBoard[l2][d2];
            if (!enemyUnit) continue;
            const resisted = !!enemyUnit.spellResist;
            if (resisted) {
              events.push({
                type: 'musicalDaoistHit', side, targetSide: enemySide,
                laneIdx: l, depthIdx: d, sourceUid: unit.uid,
                targetLaneIdx: l2, targetDepthIdx: d2, amount: 0, died: false, resisted: true,
              });
              continue;
            }
            enemyUnit.hp -= 1;
            const died = enemyUnit.hp <= 0;
            events.push({
              type: 'musicalDaoistHit', side, targetSide: enemySide,
              laneIdx: l, depthIdx: d, sourceUid: unit.uid,
              targetLaneIdx: l2, targetDepthIdx: d2, amount: 1, died, resisted: false,
            });
            if (died) killUnit(match, enemySide, l2, d2, events);
          }
        }
      }
    }
  }
}

// Амбар долины: at the start of every round he's alive, gives a
// random OTHER ally (never himself) +1 attack and +1 health.
// Понимание (Insight): when a card carrying this effect is played,
// reveals N of the OPPONENT's current hand cards to the CASTER —
// permanently, until that specific card leaves their hand (played,
// etc.), at which point it naturally stops appearing (it's simply no
// longer in the opponent's hand to match a revealed uid against).
// Prioritizes cards not already revealed to this caster; if fewer than
// N remain unrevealed, reveals whatever's left (capped, never crashes
// on an empty or small hand).
function applyInsight(match, casterSide, amount, events) {
  const enemySide = otherPlayer(match, casterSide);
  const enemyHand = match.hands[enemySide];
  const alreadyRevealed = new Set(match.revealedTo[casterSide]);
  const unrevealed = enemyHand.filter((c) => !alreadyRevealed.has(c.uid));
  const count = Math.min(amount, unrevealed.length);
  const pool = [...unrevealed];
  const revealedUids = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const [chosen] = pool.splice(idx, 1);
    match.revealedTo[casterSide].push(chosen.uid);
    revealedUids.push(chosen.uid);
  }
  events.push({ type: 'insightReveal', side: casterSide, targetSide: enemySide, count, revealedUids });
}

// Таинственная служанка Сюань: +1 attack to every ally, -1 attack
// (floored at 0) to every enemy — shared by both her battlecry
// (played alongside her own Понимание 1) and her hero-hit trigger.
function applyMysteriousMaidShift(match, side, events, sourceUid) {
  const enemySide = otherPlayer(match, side);
  const ownBoard = match.boards[side];
  const enemyBoard = match.boards[enemySide];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = ownBoard[l][d];
      if (u) {
        u.atk += 1;
        events.push({ type: 'rallyBuff', side, laneIdx: l, targetDepth: d, buffAtk: 1, buffHp: 0, sourceUid });
      }
    }
  }
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = enemyBoard[l][d];
      if (u) u.atk = Math.max(0, u.atk - 1);
    }
  }
  events.push({ type: 'maidenShift', side, targetSide: enemySide, sourceUid });
}

function applyValleyBarn(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (!unit || !unit.valleyBarn) continue;
        const others = [];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            if (l2 === l && d2 === d) continue;
            if (board[l2][d2]) others.push({ laneIdx: l2, depthIdx: d2 });
          }
        }
        if (others.length === 0) continue;
        const chosen = others[Math.floor(Math.random() * others.length)];
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

function applyStatueBuffs(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (!unit || !unit.statueBuff) continue;
        const neighbours = adjacentAllyPositions(board, l, d);
        if (neighbours.length === 0) continue;
        const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
        const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
        const amount = unit.atk;
        targetUnit.hp += amount;
        targetUnit.maxHp += amount;
        events.push({
          type: 'rallyBuff', side, laneIdx: chosen.laneIdx,
          targetDepth: chosen.depthIdx, buffAtk: 0, buffHp: amount, sourceUid: unit.uid,
        });
      }
    }
  }
}

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

// Шаман костей: at the start of every round he's alive, buffs EVERY
// ally on his own side +1/+1, himself included — reuses applyDawnBuff
// exactly (same "whole side, including the caster" shape as Барон's own
// baronBuff), just triggered at start-of-round instead of end-of-round.
// Several copies on the board each trigger independently, each seeing
// whatever buffs earlier copies already applied this same pass.
function applyBoneShamanBuffs(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (unit && unit.boneShamanBuff) applyDawnBuff(match, side, events, unit.uid);
      }
    }
  }
}

// Тотем дикарей: same "start of every round it's alive" timing and
// "whole side, including itself, several copies stack independently"
// shape as Шаман костей right above — but attack only, no hp change,
// via applyDawnBuff's own hpAmount parameter (0 here).
function applySavageTotemBuffs(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (unit && unit.savageTotemBuff) applyDawnBuff(match, side, events, unit.uid, 1, 0);
      }
    }
  }
}

// Кай Кровавый: at the start of every round he's alive, permanently
// grants EVERY OTHER ally (never himself — per explicit correction)
// Кража жизни (lifesteal) — no atk/hp change at all, so this can't
// reuse applyDawnBuff (which always touches atk/hp). Only units that
// don't already have lifesteal get touched/get an event — a unit that
// already has it (from this or any other source) is silently skipped,
// so a second copy of Кай (or a round where everyone's already been
// granted it) produces no redundant events.
function applyKaiBloodyLifestealGrant(match, side, events, sourceUid) {
  const board = match.boards[side];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      const u = board[l][d];
      if (u && u.uid !== sourceUid && !u.lifesteal) {
        u.lifesteal = true;
        events.push({
          type: 'rallyBuff', side, laneIdx: l, targetDepth: d,
          buffAtk: 0, buffHp: 0, buffLifesteal: true, sourceUid,
        });
      }
    }
  }
}

function applyKaiBloodyLifestealGrants(match, events) {
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (unit && unit.kaiBloodyLifestealGrant) applyKaiBloodyLifestealGrant(match, side, events, unit.uid);
      }
    }
  }
}

// Дикарка с топорами: fires the exact same applyAxeFanaticThrow throw
// (see below) here, at the very start of every round she's alive —
// ON TOP OF the identical pre-attack hook in resolveCombatPass (see
// axeWomanThrow there), so she throws TWICE per round: once here,
// once again right before her own attack. Unlike every other
// start-of-round effect above, this one CAN reduce a hero straight to
// 0 (an empty target cell hits the hero), so — unlike Шаман
// костей/Тотем дикарей/Музыкальный Даос, none of which can ever end
// the match from here — this checks anyHeroDown between throws so a
// second/third copy never fires after the match is already decided.
function applyAxeWomanStartOfRoundThrows(match, events) {
  for (const side of match.players) {
    if (anyHeroDown(match)) break;
    const enemySide = otherPlayer(match, side);
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      if (anyHeroDown(match)) break;
      for (let d = 0; d < DEPTH; d++) {
        if (anyHeroDown(match)) break;
        const unit = board[l][d];
        if (unit && unit.axeWomanThrow) applyAxeFanaticThrow(match, side, enemySide, events, unit, l, d);
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
// Топот (Trample): once an attacker with this flag overkills its
// primary target (already dealt with by the caller, which passes in
// exactly how much damage is left over), the leftover continues to the
// next occupied cell further back in the SAME lane (skipping empty
// ones), each fighter's own armor reducing it fresh, and so on through
// as many kills as the leftover allows — finally landing on the hero
// once the whole lane is cleared. Emits its own 'trampleHit' event per
// additional fighter/hero hit; the original hit against the primary
// target is already covered by the normal 'wave' event.
function applyTrampleCascade(match, attackerSide, defenderSide, laneIdx, fromDepth, overkill, attackerUnit, events) {
  let remaining = overkill;
  const board = match.boards[defenderSide];
  for (let d = fromDepth + 1; d < DEPTH && remaining > 0; d++) {
    const targetUnit = board[laneIdx][d];
    if (!targetUnit) continue;
    const beforeHp = targetUnit.hp;
    const applied = Math.max(0, remaining - (targetUnit.armor || 0));
    targetUnit.hp -= applied;
    const died = targetUnit.hp <= 0;
    events.push({
      type: 'trampleHit', side: attackerSide, targetSide: defenderSide,
      laneIdx, targetDepth: d, amount: applied, died, sourceUid: attackerUnit.uid,
    });
    if (died) {
      killUnit(match, defenderSide, laneIdx, d, events);
      remaining = Math.max(0, applied - beforeHp);
    } else {
      remaining = 0;
    }
  }
  if (remaining > 0) {
    match.hp[defenderSide] -= remaining;
    let heroLifesteal = 0;
    if (attackerUnit.lifesteal) {
      heroLifesteal = healHero(match, attackerSide, remaining, events);
    }
    events.push({
      type: 'trampleHit', side: attackerSide, targetSide: defenderSide,
      laneIdx, targetHero: true, amount: remaining, lifesteal: heroLifesteal, sourceUid: attackerUnit.uid,
    });
  }
}

function countUnitsOnBoard(board) {
  let count = 0;
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d]) count++;
    }
  }
  return count;
}

// Мушкетер: right before his own attack in a given wave (same hook
// point as Аннабэль's dawnBuff below), if his side currently has
// STRICTLY MORE units on the battlefield than the enemy, shoots one
// random enemy unit anywhere on the board for a small fixed 1 damage.
// Чаростойкость blocks it outright (struck harmlessly, no redirect),
// same as every other cross-side damage mechanic. Silently does
// nothing if the enemy board is empty or the unit-count condition
// isn't met.
// Бамбуковый стрелок's recurring throw: right before his own attack in
// a wave (same hook point as Мушкетер's musketShot), starting from the
// round AFTER he was placed (gated by match.round > bornRound at the
// call site, never the round he's placed in) — throws 1 spear at a
// random depth within his own mirrored lane, fixed damage, empty
// redirects to the hero, Чаростойкость blocks outright. Same shape as
// his own battlecry throw above, just a smaller recurring amount.
// Пьяный ученик: right before his own attack in a wave (same hook
// point as Мушкетер's musketShot), damages himself by 1 AND deals 1
// damage to one random unit anywhere on the board — either side,
// himself included in that random pool too (nothing excludes him,
// on top of his own guaranteed separate self-hit — an unlucky roll
// can hit him a second time in the same trigger). If the self-damage
// kills him outright, the wave's own aAtk/bAtk computation right after
// this hook re-reads the board fresh and correctly sees him gone, so
// the attack itself simply doesn't happen — no special-casing needed
// here, effectiveAtk already returns 0 for an empty cell.
// Мастер сюрикенов: right before his own attack (same pre-attack hook
// point as Мушкетер/Пьяный ученик), throws a shuriken into the
// OPPOSING lane, dealing 2 damage sequentially to EVERY enemy unit
// there, from nearest (depth 0) to farthest (depth 2) — Чаростойкость
// blocks just that one hit, the shuriken still bounces on to the next
// enemy in the lane. Disappears once it reaches the last enemy (or
// there's nobody there at all — a safe no-op).
// Бессмертный тигр: right before his own attack, if there are exactly
// 5 allies on his own board (himself included), gains a PERMANENT +3
// attack, +3 health, and Топот (trample) — but only the very FIRST
// time this condition is met across the whole match, tracked via his
// own tigerBoostUsed flag so it can never fire a second time even if
// the ally count returns to exactly 5 again later.
// Мудрый олень (first cell): reduces EVERY enemy unit's attack AND
// health by 1 — a shielded (Щит) unit is skipped entirely (no
// reduction at all, matching Щит's broad "immune to debuffs directed
// against it" wording), attack floors at 0, and a unit whose health
// reaches 0 or below dies exactly like any other hp loss. All the
// individual debuff events are pushed FIRST, then deaths are resolved
// afterward, so the client sees every stat change land before any
// death animation plays.
function applyImmortalTiger(match, side, events, sourceUnit, sourceLaneIdx, sourceDepthIdx) {
  if (sourceUnit.tigerBoostUsed) return;
  const board = match.boards[side];
  let allyCount = 0;
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d]) allyCount++;
    }
  }
  if (allyCount !== 5) return;
  sourceUnit.tigerBoostUsed = true;
  sourceUnit.atk += 3;
  sourceUnit.hp += 3;
  sourceUnit.maxHp += 3;
  sourceUnit.trample = true;
  events.push({
    type: 'tigerAwaken', side, laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx, sourceUid: sourceUnit.uid,
  });
}

function applyShurikenMaster(match, side, enemySide, events, sourceUnit, sourceLaneIdx, sourceDepthIdx) {
  const enemyBoard = match.boards[enemySide];
  for (let d = 0; d < DEPTH; d++) {
    const targetUnit = enemyBoard[sourceLaneIdx][d];
    if (!targetUnit) continue;
    const resisted = !!targetUnit.spellResist;
    let died = false;
    if (!resisted) {
      targetUnit.hp -= 2;
      died = targetUnit.hp <= 0;
    }
    events.push({
      type: 'shurikenHit', side, targetSide: enemySide, laneIdx: sourceLaneIdx,
      sourceDepthIdx, targetDepthIdx: d, amount: resisted ? 0 : 2, died, resisted, sourceUid: sourceUnit.uid,
    });
    if (died) killUnit(match, enemySide, sourceLaneIdx, d, events);
  }
}

function applyDrunkenDisciple(match, side, events, sourceUnit, sourceLaneIdx, sourceDepthIdx) {
  sourceUnit.hp -= 1;
  const selfDied = sourceUnit.hp <= 0;
  events.push({
    type: 'drunkenSelfHit', side, laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx,
    amount: 1, sourceUid: sourceUnit.uid, died: selfDied,
  });
  if (selfDied) {
    killUnit(match, side, sourceLaneIdx, sourceDepthIdx, events);
  }

  const enemySide = otherPlayer(match, side);
  const candidates = [];
  for (const s of [side, enemySide]) {
    const board = match.boards[s];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (board[l][d]) candidates.push({ side: s, laneIdx: l, depthIdx: d });
      }
    }
  }
  if (candidates.length === 0) return;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  const targetUnit = match.boards[chosen.side][chosen.laneIdx][chosen.depthIdx];
  const resisted = !!targetUnit.spellResist;
  const amount = resisted ? 0 : 1;
  let died = false;
  if (!resisted) {
    targetUnit.hp -= amount;
    died = targetUnit.hp <= 0;
  }
  events.push({
    type: 'drunkenRandomHit', side, targetSide: chosen.side, amount,
    laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx,
    targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx,
    sourceUid: sourceUnit.uid, died, resisted,
  });
  if (died) killUnit(match, chosen.side, chosen.laneIdx, chosen.depthIdx, events);
}

function applyBambooRecurringShot(match, side, enemySide, events, sourceUnit, sourceLaneIdx, sourceDepthIdx) {
  const targetBoard = match.boards[enemySide];
  const targetDepth = Math.floor(Math.random() * DEPTH);
  const cellUnit = targetBoard[sourceLaneIdx][targetDepth];
  const resisted = !!(cellUnit && cellUnit.spellResist);
  const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
  const amount = sourceUnit.bambooShotRecurring;
  let died = false;
  if (resisted) {
    // no-op: the spear lands on her harmlessly
  } else if (targetUnit) {
    targetUnit.hp -= amount;
    died = targetUnit.hp <= 0;
  } else {
    match.hp[enemySide] -= amount;
  }
  events.push({
    type: 'bambooShot', side, targetSide: enemySide, amount: resisted ? 0 : amount,
    laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx,
    targetLaneIdx: sourceLaneIdx, targetDepthIdx: targetDepth,
    sourceUid: sourceUnit.uid, targetHero: !cellUnit, died, resisted,
  });
  if (died) killUnit(match, enemySide, sourceLaneIdx, targetDepth, events);
}

function applyMusketShot(match, side, enemySide, events, sourceUnit, sourceLaneIdx, sourceDepthIdx) {
  const ownCount = countUnitsOnBoard(match.boards[side]);
  const enemyCount = countUnitsOnBoard(match.boards[enemySide]);
  if (ownCount <= enemyCount) return;
  const targetBoard = match.boards[enemySide];
  const targets = [];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (targetBoard[l][d]) targets.push({ laneIdx: l, depthIdx: d });
    }
  }
  if (targets.length === 0) return;
  const chosen = targets[Math.floor(Math.random() * targets.length)];
  const targetUnit = targetBoard[chosen.laneIdx][chosen.depthIdx];
  const resisted = !!targetUnit.spellResist;
  const amount = resisted ? 0 : 1;
  let died = false;
  if (!resisted) {
    targetUnit.hp -= amount;
    died = targetUnit.hp <= 0;
  }
  events.push({
    type: 'musketShot', side, targetSide: enemySide, amount,
    laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx,
    targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx,
    sourceUid: sourceUnit.uid, resisted, died,
  });
  if (died) killUnit(match, enemySide, chosen.laneIdx, chosen.depthIdx, events);
}

// Дикарь-стрелок: shared by both his battlecry (randomShotOnPlay, via
// pendingMarksmanShots below) and his pre-attack recurring shot
// (randomShotRecurring, checked in resolveCombatPass below, gated by
// match.round > bornRound same as Бамбуковый стрелок's own recurring
// shot) — picks a random ENEMY UNIT (never the hero, and never a
// Чаростойкость one, excluded from the pool entirely rather than
// picked-then-blocked) and deals fixed damage. Silently does nothing if
// the enemy board has no legal target. Reuses the exact musketShot
// event/animation.
function applyRandomEnemyShot(match, side, enemySide, events, sourceUid, sourceLaneIdx, sourceDepthIdx, amount) {
  const targetBoard = match.boards[enemySide];
  const targets = [];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (targetBoard[l][d] && !targetBoard[l][d].spellResist) targets.push({ laneIdx: l, depthIdx: d });
    }
  }
  if (targets.length === 0) return;
  const chosen = targets[Math.floor(Math.random() * targets.length)];
  const targetUnit = targetBoard[chosen.laneIdx][chosen.depthIdx];
  targetUnit.hp -= amount;
  const died = targetUnit.hp <= 0;
  events.push({
    type: 'musketShot', side, targetSide: enemySide, amount,
    laneIdx: sourceLaneIdx, depthIdx: sourceDepthIdx,
    targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx,
    sourceUid, resisted: false, died,
  });
  if (died) killUnit(match, enemySide, chosen.laneIdx, chosen.depthIdx, events);
}

// Верховный шаман (highShamanManaBuff): fires right before his own
// attack every round he's eligible to act (see the resolveCombatPass
// pre-attack hooks) — the buff amount is read fresh from match.mana at
// that exact moment, i.e. however much of the caster's own mana is
// STILL unspent this turn. Zero (or less, though mana never actually
// goes negative) leftover mana means the trigger simply doesn't fire
// at all — no event, no-op — per explicit request. The random target
// is picked from every unit currently on the caster's own board,
// himself included (no "other ally" exclusion, unlike Колдун прерий)
// — always finds at least one candidate since he himself is on the
// board to trigger this at all. Reuses the plain 'rallyBuff' event/
// animation.
function applyHighShamanManaBuff(match, side, events, sourceUid, laneIdx, depthIdx) {
  const amount = match.mana[side];
  if (amount <= 0) return;
  const board = match.boards[side];
  const targets = [];
  for (let l = 0; l < LANES; l++) {
    for (let d = 0; d < DEPTH; d++) {
      if (board[l][d]) targets.push({ laneIdx: l, depthIdx: d });
    }
  }
  if (targets.length === 0) return;
  const chosen = targets[Math.floor(Math.random() * targets.length)];
  const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
  targetUnit.atk += amount;
  targetUnit.hp += amount;
  targetUnit.maxHp += amount;
  events.push({
    type: 'rallyBuff', side, laneIdx: chosen.laneIdx,
    targetDepth: chosen.depthIdx, buffAtk: amount, buffHp: amount, sourceUid,
  });
}

// Фанатик с топорами (axeFanaticThrow): fires right before his own
// attack every round he's eligible to act (see the resolveCombatPass
// pre-attack hooks, same family/timing as Верховный шаман above) — a
// random depth within the SAME lane index on the ENEMY's board, same
// "opposite row" targeting as Метеоритный страж's own weaponThrowOnDeath.
// Unlike Ярость древа, the hero is only hit when the rolled cell is
// EMPTY — if a unit is there, only that unit takes the damage, never
// both. Чаростойкость blocks it outright (struck harmlessly, no
// redirect to the hero), same resisted-no-redirect precedent as every
// other cross-side mechanic here. Damage equals his own CURRENT attack,
// read fresh at the moment of the throw (not his base stat).
function applyAxeFanaticThrow(match, side, enemySide, events, unit, laneIdx, depthIdx) {
  const targetBoard = match.boards[enemySide];
  const targetDepth = Math.floor(Math.random() * DEPTH);
  const cellUnit = targetBoard[laneIdx][targetDepth];
  const resisted = !!(cellUnit && cellUnit.spellResist);
  const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
  const amount = unit.atk;
  let died = false;
  if (resisted) {
    // no-op: the axe lands on her harmlessly
  } else if (targetUnit) {
    targetUnit.hp -= amount;
    died = targetUnit.hp <= 0;
  } else {
    match.hp[enemySide] -= amount;
  }
  events.push({
    type: 'axeThrow', side, targetSide: enemySide, amount: resisted ? 0 : amount,
    laneIdx, depthIdx, sourceUid: unit.uid,
    targetLaneIdx: laneIdx, targetDepthIdx: targetDepth,
    targetHero: !cellUnit, died, resisted,
  });
  if (died) killUnit(match, enemySide, laneIdx, targetDepth, events);
}

// Пылкая охотница: fires an extra attack for the unit at (side, laneIdx,
// depthIdx) against whatever's CURRENTLY in front of it on the enemy
// side of laneIdx — re-run fresh rather than reusing the primary
// attack's own target, in case anything changed it (nothing currently
// in the game can, so this always re-finds the same empty front that
// made the primary attack land on the hero in the first place, but the
// logic doesn't assume that). Goes through the exact same
// target/armor/lifesteal/death rules a normal attack would (unlike a
// flat bonus hit), including Контратака on whichever unit it hits, and
// reuses the standard 'wave' event/animation with only one side
// populated (attackerB stays null) so the client renders it identically
// to any other single-sided attack. Deliberately does NOT check
// heroHitDoubleStrike again — this call IS the extra attack, so it
// never re-triggers itself.
function applyFollowupAttack(match, side, laneIdx, depthIdx, events) {
  if (anyHeroDown(match)) return;
  const board = match.boards[side];
  const unit = board[laneIdx] && board[laneIdx][depthIdx];
  if (!unit) return;
  const targetSide = otherPlayer(match, side);
  const atk = effectiveAtk(board, laneIdx, depthIdx);
  if (atk <= 0) return;
  const target = frontUnit(match.boards[targetSide], laneIdx);
  let applied = 0;
  let lifesteal = 0;
  let died = false;
  if (target) {
    applied = Math.max(0, atk - (target.unit.armor || 0));
    target.unit.hp -= applied;
    died = target.unit.hp <= 0;
  } else {
    applied = atk;
    match.hp[targetSide] -= applied;
    if (unit.lifesteal) lifesteal = healHero(match, side, atk, events);
  }
  events.push({
    type: 'wave', lane: laneIdx, waveIndex: -1,
    attackerA: { side, uid: unit.uid, depth: depthIdx },
    attackerB: null,
    targetAHero: !target,
    targetBHero: false,
    targetADepth: target ? target.depth : null,
    targetBDepth: null,
    aDamage: applied,
    bDamage: 0,
    aLifesteal: lifesteal,
    bLifesteal: 0,
    aDied: false,
    bDied: false,
  });
  if (died) killUnit(match, targetSide, laneIdx, target.depth, events);
  // Контратака (Частокол): same reaction as any other combat exchange —
  // see the identical block in resolveCombatPass right after the main
  // wave event, for the primary attack.
  if (target && applied > 0 && target.unit.counterattack) {
    const counterAmount = Math.max(0, target.unit.atk - (unit.armor || 0));
    unit.hp -= counterAmount;
    events.push({
      type: 'counterattack', side: targetSide, targetSide: side, amount: counterAmount,
      laneIdx, depthIdx: target.depth, sourceUid: target.unit.uid,
      targetLaneIdx: laneIdx, targetDepthIdx: depthIdx,
    });
    if (unit.hp <= 0) killUnit(match, side, laneIdx, depthIdx, events);
  }
}

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
      if (aEligible && aUnit.musketShot) applyMusketShot(match, nameA, nameB, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.musketShot) applyMusketShot(match, nameB, nameA, events, bUnit, l, bInfo.depth);
      if (aEligible && aUnit.drunkenDisciple) applyDrunkenDisciple(match, nameA, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.drunkenDisciple) applyDrunkenDisciple(match, nameB, events, bUnit, l, bInfo.depth);
      if (aEligible && aUnit.shurikenMaster) applyShurikenMaster(match, nameA, nameB, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.shurikenMaster) applyShurikenMaster(match, nameB, nameA, events, bUnit, l, bInfo.depth);
      if (aEligible && aUnit.immortalTiger) applyImmortalTiger(match, nameA, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.immortalTiger) applyImmortalTiger(match, nameB, events, bUnit, l, bInfo.depth);
      if (aEligible && aUnit.bambooShotRecurring && match.round > aUnit.bornRound) applyBambooRecurringShot(match, nameA, nameB, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.bambooShotRecurring && match.round > bUnit.bornRound) applyBambooRecurringShot(match, nameB, nameA, events, bUnit, l, bInfo.depth);
      if (aEligible && aUnit.randomShotRecurring && match.round > aUnit.bornRound) applyRandomEnemyShot(match, nameA, nameB, events, aUnit.uid, l, aInfo.depth, aUnit.randomShotRecurring);
      if (bEligible && bUnit.randomShotRecurring && match.round > bUnit.bornRound) applyRandomEnemyShot(match, nameB, nameA, events, bUnit.uid, l, bInfo.depth, bUnit.randomShotRecurring);
      // Верховный шаман: no bornRound gate, unlike the recurring shots
      // above — this is his ONLY trigger (no separate on-play battlecry
      // to avoid double-firing with), so it fires before every attack of
      // his, starting the very round he's placed.
      if (aEligible && aUnit.highShamanManaBuff) applyHighShamanManaBuff(match, nameA, events, aUnit.uid, l, aInfo.depth);
      if (bEligible && bUnit.highShamanManaBuff) applyHighShamanManaBuff(match, nameB, events, bUnit.uid, l, bInfo.depth);
      // Фанатик с топорами: same "no bornRound gate" reasoning as
      // Верховный шаман right above — his only trigger, so it fires
      // before every attack of his, starting the round he's placed.
      if (aEligible && aUnit.axeFanaticThrow) applyAxeFanaticThrow(match, nameA, nameB, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.axeFanaticThrow) applyAxeFanaticThrow(match, nameB, nameA, events, bUnit, l, bInfo.depth);
      // Дикарка с топорами: same throw, same no-bornRound-gate timing —
      // this is her SECOND throw of the round (see
      // applyAxeWomanStartOfRoundThrows for her first, at start of
      // round).
      if (aEligible && aUnit.axeWomanThrow) applyAxeFanaticThrow(match, nameA, nameB, events, aUnit, l, aInfo.depth);
      if (bEligible && bUnit.axeWomanThrow) applyAxeFanaticThrow(match, nameB, nameA, events, bUnit, l, bInfo.depth);

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
      let aBeforeHp = null, bBeforeHp = null;
      if (aAttacks) {
        if (aTarget) {
          aBeforeHp = aTarget.unit.hp;
          aApplied = Math.max(0, aAtk - (aTarget.unit.armor || 0));
          aTarget.unit.hp -= aApplied;
        } else {
          aApplied = aAtk;
          match.hp[nameB] -= aApplied;
          // A unit with lifesteal that lands its hit directly on the
          // enemy hero heals its own owner's hero for its attack value.
          if (aUnit.lifesteal) {
            aLifesteal = healHero(match, nameA, aAtk, events);
          }
        }
      }
      if (bAttacks) {
        if (bTarget) {
          bBeforeHp = bTarget.unit.hp;
          bApplied = Math.max(0, bAtk - (bTarget.unit.armor || 0));
          bTarget.unit.hp -= bApplied;
        } else {
          bApplied = bAtk;
          match.hp[nameA] -= bApplied;
          if (bUnit.lifesteal) {
            bLifesteal = healHero(match, nameB, bAtk, events);
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

      // Даос-мечник: whenever his OWN normal attack lands directly on
      // the enemy hero (not a unit), every ally on his own side gains
      // +1 attack (no hp change — unlike Аннабэль/Барон's own "buff
      // everyone" effects, this one is atk-only, so a fresh small loop
      // rather than reusing applyDawnBuff).
      if (aAttacks && !aTarget && aUnit.daoistSwordsman) {
        const board = match.boards[nameA];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            const u = board[l2][d2];
            if (u) {
              u.atk += 1;
              events.push({ type: 'rallyBuff', side: nameA, laneIdx: l2, targetDepth: d2, buffAtk: 1, buffHp: 0, sourceUid: aUnit.uid });
            }
          }
        }
      }
      if (bAttacks && !bTarget && bUnit.daoistSwordsman) {
        const board = match.boards[nameB];
        for (let l2 = 0; l2 < LANES; l2++) {
          for (let d2 = 0; d2 < DEPTH; d2++) {
            const u = board[l2][d2];
            if (u) {
              u.atk += 1;
              events.push({ type: 'rallyBuff', side: nameB, laneIdx: l2, targetDepth: d2, buffAtk: 1, buffHp: 0, sourceUid: bUnit.uid });
            }
          }
        }
      }

      // Стойкий Даос: whenever his own normal attack lands directly on
      // the enemy hero (not a unit), he permanently gains +1 attack
      // AND +1 health HIMSELF — unlike Даос-мечник (buffs every ally,
      // atk-only), this is a self-only +1/+1.
      if (aAttacks && !aTarget && aUnit.steadfastDaoist) {
        aUnit.atk += 1;
        aUnit.hp += 1;
        aUnit.maxHp += 1;
        events.push({ type: 'rallyBuff', side: nameA, laneIdx: l, targetDepth: aInfo.depth, buffAtk: 1, buffHp: 1, sourceUid: aUnit.uid });
      }
      if (bAttacks && !bTarget && bUnit.steadfastDaoist) {
        bUnit.atk += 1;
        bUnit.hp += 1;
        bUnit.maxHp += 1;
        events.push({ type: 'rallyBuff', side: nameB, laneIdx: l, targetDepth: bInfo.depth, buffAtk: 1, buffHp: 1, sourceUid: bUnit.uid });
      }

      // Небесный воин: whenever his own attack lands directly on the
      // enemy hero, 50% chance to bounce a random enemy unit back to
      // hand.
      if (aAttacks && !aTarget && aUnit.heavenlyWarrior) {
        applyHeavenlyWarriorHeroBounce(match, nameA, events, aUnit.uid, l, aInfo.depth);
      }
      if (bAttacks && !bTarget && bUnit.heavenlyWarrior) {
        applyHeavenlyWarriorHeroBounce(match, nameB, events, bUnit.uid, l, bInfo.depth);
      }

      // Таинственная служанка Сюань: whenever her own attack lands
      // directly on the enemy hero, the SAME ally-buff/enemy-debuff
      // shift as her battlecry — but this does NOT re-trigger
      // Понимание, only the atk shift.
      if (aAttacks && !aTarget && aUnit.mysteriousMaid) {
        applyMysteriousMaidShift(match, nameA, events, aUnit.uid);
      }
      if (bAttacks && !bTarget && bUnit.mysteriousMaid) {
        applyMysteriousMaidShift(match, nameB, events, bUnit.uid);
      }

      // Стервятник: whenever his own attack lands directly on the
      // enemy hero, draws 1 card from his OWNER's own deck.
      if (aAttacks && !aTarget && aUnit.vultureDraw) {
        const hand = match.hands[nameA];
        if (hand.length < MAX_HAND) {
          const beforeLen = hand.length;
          draw(match.decks[nameA], hand, 1);
          const drew = hand.length > beforeLen;
          events.push({ type: 'vultureDraw', side: nameA, sourceUid: aUnit.uid, laneIdx: l, depthIdx: aInfo.depth, drew });
        }
      }
      if (bAttacks && !bTarget && bUnit.vultureDraw) {
        const hand = match.hands[nameB];
        if (hand.length < MAX_HAND) {
          const beforeLen = hand.length;
          draw(match.decks[nameB], hand, 1);
          const drew = hand.length > beforeLen;
          events.push({ type: 'vultureDraw', side: nameB, sourceUid: bUnit.uid, laneIdx: l, depthIdx: bInfo.depth, drew });
        }
      }

      // Пылкая охотница: whenever her own attack lands directly on the
      // enemy hero, immediately makes ONE MORE full normal attack — see
      // applyFollowupAttack below, which re-runs the exact same
      // target/armor/lifesteal/death/counterattack logic as any other
      // attack (unlike a flat bonus hit) against whatever is currently
      // in front of her. The front is virtually always still empty here
      // (nothing mid-wave can summon a fresh blocker into it), so it
      // almost always lands on the hero again too — but it's written to
      // handle a unit being there just as correctly.
      if (aAttacks && !aTarget && aUnit.heroHitDoubleStrike) {
        applyFollowupAttack(match, nameA, l, aInfo.depth, events);
      }
      if (bAttacks && !bTarget && bUnit.heroHitDoubleStrike) {
        applyFollowupAttack(match, nameB, l, bInfo.depth, events);
      }

      // Всадник на кабане: whenever his own attack lands directly on
      // the enemy hero, throws a spear at a random enemy UNIT for 2
      // damage — reuses the exact same applyRandomEnemyShot helper
      // (and targeting rules: real units only, Чаростойкость excluded
      // from the pool, no hero redirect) already built for Дикарь-
      // стрелок, just fired from this "landed on hero" trigger point
      // instead of a battlecry/pre-attack hook.
      if (aAttacks && !aTarget && aUnit.boarRiderSpear) {
        applyRandomEnemyShot(match, nameA, nameB, events, aUnit.uid, l, aInfo.depth, 2);
      }
      if (bAttacks && !bTarget && bUnit.boarRiderSpear) {
        applyRandomEnemyShot(match, nameB, nameA, events, bUnit.uid, l, bInfo.depth, 2);
      }

      if (aDied) killUnit(match, nameB, l, aTarget.depth, events);
      if (bDied) killUnit(match, nameA, l, bTarget.depth, events);

      // Контратака (Частокол): whenever a unit carrying this flag takes
      // damage in this normal-combat exchange, it strikes back at
      // whoever just hit it for an amount equal to its OWN current
      // attack (armor-reduced on the attacker, same convention as
      // every other combat hit) — regardless of whether it dealt any
      // damage of its own this wave (this is how a Защитник unit, which
      // never attacks normally, still punishes anyone who hits it) or
      // whether it survives the initial hit itself (aTarget.unit is
      // still a valid object reference even after killUnit above
      // removed it from the board, so its atk/counterattack flag are
      // still readable).
      if (aTarget && aApplied > 0 && aTarget.unit.counterattack) {
        const counterAmount = Math.max(0, aTarget.unit.atk - (aUnit.armor || 0));
        aUnit.hp -= counterAmount;
        events.push({
          type: 'counterattack', side: nameB, targetSide: nameA, amount: counterAmount,
          laneIdx: l, depthIdx: aTarget.depth, sourceUid: aTarget.unit.uid,
          targetLaneIdx: l, targetDepthIdx: aInfo.depth,
        });
        if (aUnit.hp <= 0) killUnit(match, nameA, l, aInfo.depth, events);
      }
      if (bTarget && bApplied > 0 && bTarget.unit.counterattack) {
        const counterAmount = Math.max(0, bTarget.unit.atk - (bUnit.armor || 0));
        bUnit.hp -= counterAmount;
        events.push({
          type: 'counterattack', side: nameA, targetSide: nameB, amount: counterAmount,
          laneIdx: l, depthIdx: bTarget.depth, sourceUid: bTarget.unit.uid,
          targetLaneIdx: l, targetDepthIdx: bInfo.depth,
        });
        if (bUnit.hp <= 0) killUnit(match, nameB, l, bInfo.depth, events);
      }

      // Топот (Trample): the overkill from the primary hit (already
      // pushed above as the normal 'wave' event) cascades onward.
      if (aDied && aUnit.trample) {
        const overkill = Math.max(0, aApplied - aBeforeHp);
        if (overkill > 0) applyTrampleCascade(match, nameA, nameB, l, aTarget.depth, overkill, aUnit, events);
      }
      if (bDied && bUnit.trample) {
        const overkill = Math.max(0, bApplied - bBeforeHp);
        if (overkill > 0) applyTrampleCascade(match, nameB, nameA, l, bTarget.depth, overkill, bUnit, events);
      }

      // Храмовый боец: the instant its attack lands directly on the
      // enemy hero (not blocked by a unit), summon a fresh Ополченец
      // onto a random empty cell of its own board — silently does
      // nothing if there's no room.
      if (aAttacks && !aTarget && aUnit.summonOnHeroHit) summonUnitToRandomFreeCell(match, nameA, aUnit.summonOnHeroHit, events);
      if (bAttacks && !bTarget && bUnit.summonOnHeroHit) summonUnitToRandomFreeCell(match, nameB, bUnit.summonOnHeroHit, events);
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
// Защитник (Defender): never gets to act in EITHER combat pass below —
// excluded from attacking entirely, regardless of First Strike or attack
// value, though still fully targetable/blockable like any other unit
// (this only ever gates attacking, never being attacked). A defender's
// own attack stat still matters for ITS OWN non-combat mechanics (e.g.
// Имперская пушка's end-of-round cannon shot uses her live attack) —
// this exclusion is scoped to the wave-combat exchange only.
// Сон (Sleep): the same attacking exclusion as Защитник, but only for
// the unit's own bornRound — from the round after, it's a normal
// attacker despite still carrying the sleep flag itself.
function resolveCombat(match, events) {
  const blinded = match.blindedUids;
  const isBlinded = (unit) => !!(blinded && blinded.has(unit.uid));
  const isAsleep = (unit) => unit.sleep && match.round === unit.bornRound;
  resolveCombatPass(match, events, (unit) => !unit.defender && !isAsleep(unit) && !isBlinded(unit) && !unit.cantAttackThisRound && !!unit.firstStrike);
  resolveCombatPass(match, events, (unit) => !unit.defender && !isAsleep(unit) && !isBlinded(unit) && !unit.cantAttackThisRound && !unit.firstStrike);
}

export function tryEndTurn(match, username) {
  if (match.phase !== 'placing') return { ready: false };
  match.readyToEnd[username] = true;
  const [nameA, nameB] = match.players;
  if (!match.readyToEnd[nameA] || !match.readyToEnd[nameB]) {
    return { ready: false };
  }

  match.phase = 'resolving';

  // Денежное дерево (and any future "took damage this round" card):
  // snapshot every unit's hp right now, before anything in this
  // round's resolution can change it — compared at the very end of
  // resolution to determine who actually took damage this round,
  // without needing to touch every single damage-dealing site
  // scattered throughout combat/spells/abilities.
  match.roundStartHp = {};
  for (const name of match.players) {
    const board = match.boards[name];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (unit) match.roundStartHp[unit.uid] = unit.hp;
      }
    }
  }

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

  // Мгновенный призыв (Отряд ополченцев): fires before ANYTHING else in
  // resolution — even before rally buffs, heals, shots, and Епископ
  // below, let alone the normal spell phase. Pulled out of pendingSpells
  // here rather than living in its own separate queue, so the
  // pending-spell-icon overlay during placing (which reads pendingSpells
  // directly) keeps working for it with no extra plumbing; whatever's
  // left in pendingSpells after this filter is everything resolveSpells
  // still needs to handle normally, later.
  const instantSummonQueue = match.pendingSpells.filter((sp) => sp.kind === 'instantSummon');
  match.pendingSpells = match.pendingSpells.filter((sp) => sp.kind !== 'instantSummon');
  for (const summonSpell of instantSummonQueue) {
    const count = summonSpell.summonCount || 1;
    for (let i = 0; i < count; i++) {
      summonUnitToRandomFreeCell(match, summonSpell.side, summonSpell.summonCardId, events);
    }
  }

  // Вызов стражи: same "fires in the Мгновенный призыв phase" timing as
  // Отряд ополченцев above, pulled out of pendingSpells the same way —
  // summons ONE Страж дворца onto the specifically targeted cell
  // (silently failing just that part if it's occupied by now) AND a
  // SECOND one onto any random free cell, independently.
  const guardCallQueue = match.pendingSpells.filter((sp) => sp.kind === 'guardCall');
  match.pendingSpells = match.pendingSpells.filter((sp) => sp.kind !== 'guardCall');
  for (const guardSpell of guardCallQueue) {
    const board = match.boards[guardSpell.side];
    if (!board[guardSpell.laneIdx][guardSpell.depthIdx]) {
      const summonedCard = cardById(guardSpell.summonCardId);
      if (summonedCard) {
        const unit = buildUnitFromCard(summonedCard, false, match.round);
        board[guardSpell.laneIdx][guardSpell.depthIdx] = unit;
        events.push({ type: 'summon', side: guardSpell.side, cardId: guardSpell.summonCardId, laneIdx: guardSpell.laneIdx, depthIdx: guardSpell.depthIdx, uid: unit.uid });
      }
    }
    summonUnitToRandomFreeCell(match, guardSpell.side, guardSpell.summonCardId, events);
  }

  // Карающий ангел: right after Мгновенный призыв above (so a
  // this-turn instant-summon already counts as "appeared this turn"),
  // checks the mirrored lane on the enemy side for the first
  // (front-to-back) unit whose bornRound matches THIS round — anyone
  // left over from an earlier round is never a valid target, and if
  // nothing at all appeared there this round, the strike simply doesn't
  // happen. A Чаростойкость unit found this way is struck but NOT
  // killed — same "explosion happens, no effect, no redirect" pattern
  // as every other cross-side mechanic that checks this status.
  const punisherKillQueue = match.pendingPunisherKills;
  match.pendingPunisherKills = [];
  for (const kill of punisherKillQueue) {
    const targetSide = otherPlayer(match, kill.side);
    const targetBoard = match.boards[targetSide];
    let targetInfo = null;
    for (let d = 0; d < DEPTH; d++) {
      const candidate = targetBoard[kill.laneIdx][d];
      if (candidate && candidate.bornRound === match.round) { targetInfo = { unit: candidate, depth: d }; break; }
    }
    if (!targetInfo) continue;
    const resisted = !!targetInfo.unit.spellResist;
    events.push({
      type: 'punisherKill', side: kill.side, targetSide,
      laneIdx: kill.laneIdx, targetDepth: targetInfo.depth,
      sourceUid: kill.sourceUid, resisted,
    });
    if (!resisted) killUnit(match, targetSide, kill.laneIdx, targetInfo.depth, events);
  }

  // Рейна Ослепительная: temporarily grants ALL current enemy units the
  // same "can't attack" restriction as Защитник, but ONLY for this
  // round's combat — match.blindedUids is cleared right after
  // resolveCombat runs below (see tryEndTurn), so it never leaks into
  // later rounds. Чаростойкость units are immune per spec, simply
  // excluded from the set. The 'reinaBlind' event just carries her own
  // cell for the light-sphere animation — no per-enemy visual needed.
  const blindQueue = match.pendingBlinds;
  match.pendingBlinds = [];
  if (!match.blindedUids) match.blindedUids = new Set();
  for (const blind of blindQueue) {
    const targetSide = otherPlayer(match, blind.side);
    const targetBoard = match.boards[targetSide];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const u = targetBoard[l][d];
        if (u && !u.spellResist) match.blindedUids.add(u.uid);
      }
    }
    events.push({
      type: 'reinaBlind', side: blind.side, laneIdx: blind.laneIdx, depthIdx: blind.depthIdx, sourceUid: blind.sourceUid,
    });
  }

  // Имперский полководец: buffs every ally +1/+1 (reusing applyDawnBuff,
  // exactly like Барон/Аннабэль's own "buff everyone" loop, himself
  // included), then PERMANENTLY grants Двойной удар to every unit on
  // his own board that currently has Armor > 0 (himself included) — a
  // one-time snapshot at the moment his battlecry resolves, not
  // retroactive to allies placed afterward.
  const warlordQueue = match.pendingWarlordBuffs;
  match.pendingWarlordBuffs = [];
  for (const warlord of warlordQueue) {
    applyDawnBuff(match, warlord.side, events, warlord.sourceUid);
    const board = match.boards[warlord.side];
    let grantedCount = 0;
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const u = board[l][d];
        if (u && u.armor > 0 && !u.doubleStrike) { u.doubleStrike = true; grantedCount++; }
      }
    }
    events.push({ type: 'warlordDoubleStrike', side: warlord.side, sourceUid: warlord.sourceUid, count: grantedCount });
  }

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
    // Вождь дикарей: the first pendingRallyBuffs source to also grant
    // Топот (trample) permanently, alongside the usual atk/hp bump.
    if (buff.buffTrample) unit.trample = true;
    events.push({
      type: 'rallyBuff', side: buff.side, laneIdx: buff.laneIdx,
      targetDepth: buff.depthIdx, buffAtk: buff.buffAtk, buffHp: buff.buffHp,
      buffTrample: !!buff.buffTrample,
    });
  }

  // Монахиня's heal lands here too — same moment as rally buffs above,
  // right at the start of resolution, so both players see it as a
  // revealed event instead of a silent HP change during placing.
  const healQueue = match.pendingHeals;
  match.pendingHeals = [];
  for (const heal of healQueue) {
    const healed = healHero(match, heal.side, heal.amount, events);
    events.push({ type: 'heroHeal', side: heal.side, amount: healed, sourceUid: heal.sourceUid, laneIdx: heal.laneIdx, depthIdx: heal.depthIdx });
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

  // Арбалетчик (reworked): fires again at the START of every round
  // AFTER the one he was placed in — NOT the round he was placed
  // (match.round > unit.bornRound excludes it), since the battlecry
  // shot above already covers that round. Checked here, at the very
  // start of resolution, same "start of round" moment as everything
  // else in this section — same damage formula as his own battlecry.
  for (const side of match.players) {
    const board = match.boards[side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const unit = board[l][d];
        if (unit && unit.shootHeroStartOfTurn && match.round > unit.bornRound) {
          const targetSide = match.players.find((p) => p !== side);
          const amount = effectiveAtk(board, l, d);
          match.hp[targetSide] -= amount;
          events.push({
            type: 'heroShot', side, targetSide, amount,
            laneIdx: l, depthIdx: d, sourceUid: unit.uid,
          });
        }
      }
    }
  }

  // Бамбуковый стрелок's battlecry throw: a random depth within the
  // SAME lane on the enemy's side (his own mirrored lane, same
  // convention as Имперская пушка), fixed damage, Чаростойкость blocks
  // outright, an empty square redirects to the hero.
  const bambooShotQueue = match.pendingBambooShots;
  match.pendingBambooShots = [];
  for (const shot of bambooShotQueue) {
    const targetSide = otherPlayer(match, shot.side);
    const targetBoard = match.boards[targetSide];
    const targetDepth = Math.floor(Math.random() * DEPTH);
    const cellUnit = targetBoard[shot.laneIdx][targetDepth];
    const resisted = !!(cellUnit && cellUnit.spellResist);
    const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
    const amount = shot.amount;
    let died = false;
    if (resisted) {
      // no-op: the spear lands on her harmlessly
    } else if (targetUnit) {
      targetUnit.hp -= amount;
      died = targetUnit.hp <= 0;
    } else {
      match.hp[targetSide] -= amount;
    }
    events.push({
      type: 'bambooShot', side: shot.side, targetSide, amount: resisted ? 0 : amount,
      laneIdx: shot.laneIdx, depthIdx: shot.depthIdx, sourceUid: shot.sourceUid,
      targetLaneIdx: shot.laneIdx, targetDepthIdx: targetDepth,
      targetHero: !cellUnit, died, resisted,
    });
    if (died) killUnit(match, targetSide, shot.laneIdx, targetDepth, events);
  }

  // Дикарь-стрелок's battlecry throw — same applyRandomEnemyShot helper
  // his own pre-attack recurring shot uses (see resolveCombatPass
  // above), just fired once here instead of gated on match.round.
  const marksmanShotQueue = match.pendingMarksmanShots;
  match.pendingMarksmanShots = [];
  for (const shot of marksmanShotQueue) {
    const targetSide = otherPlayer(match, shot.side);
    applyRandomEnemyShot(match, shot.side, targetSide, events, shot.sourceUid, shot.laneIdx, shot.depthIdx, shot.amount);
  }

  // Травница: same depth-based placement trigger as Олень-мечник, but
  // instead of reshaping her own stats she heals her own hero (first
  // cell) or strikes the enemy hero directly (last cell) — amount equal
  // to her CURRENT attack. Reuses the exact heroHeal/heroShot event
  // types already used by Родник/Монахиня and Арбалетчик/Осадная
  // башня, so no new client animation is needed. A safe no-op if she's
  // somehow no longer there by resolution time.
  const herbalistQueue = match.pendingHerbalist;
  match.pendingHerbalist = [];
  for (const entry of herbalistQueue) {
    if (anyHeroDown(match)) break;
    const board = match.boards[entry.side];
    const unit = board[entry.laneIdx] && board[entry.laneIdx][entry.depthIdx];
    if (!unit || unit.uid !== entry.sourceUid) continue;
    const amount = unit.atk;
    if (entry.kind === 'heal') {
      const healed = healHero(match, entry.side, amount, events);
      events.push({ type: 'heroHeal', side: entry.side, amount: healed, sourceUid: entry.sourceUid, laneIdx: entry.laneIdx, depthIdx: entry.depthIdx });
    } else {
      const targetSide = otherPlayer(match, entry.side);
      match.hp[targetSide] -= amount;
      events.push({
        type: 'heroShot', side: entry.side, targetSide, amount,
        laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
      });
    }
  }

  // Лис с мечом: battlecry — a random enemy unit anywhere on the
  // board takes a small fixed hit. Чаростойкость blocks it outright;
  // no unit at all on the enemy board is simply a no-op (no hero
  // redirect for this one).
  const foxSwordQueue = match.pendingFoxSword;
  match.pendingFoxSword = [];
  for (const entry of foxSwordQueue) {
    if (anyHeroDown(match)) break;
    const targetSide = otherPlayer(match, entry.side);
    const targetBoard = match.boards[targetSide];
    const targets = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (targetBoard[l][d]) targets.push({ laneIdx: l, depthIdx: d });
      }
    }
    if (targets.length === 0) continue;
    const chosen = targets[Math.floor(Math.random() * targets.length)];
    const targetUnit = targetBoard[chosen.laneIdx][chosen.depthIdx];
    const resisted = !!targetUnit.spellResist;
    const amount = resisted ? 0 : entry.amount;
    let died = false;
    if (!resisted) {
      targetUnit.hp -= amount;
      died = targetUnit.hp <= 0;
    }
    events.push({
      type: 'foxSwordStrike', side: entry.side, targetSide, amount,
      laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
      targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, died, resisted,
    });
    if (died) killUnit(match, targetSide, chosen.laneIdx, chosen.depthIdx, events);
  }

  // Сестра дома Вкуса: same "start of resolution" battlecry moment
  // as everything above — picks a random ally ANYWHERE on her own
  // board (herself included, nothing excludes her) and permanently
  // gives it +2 attack (if she was placed first) or +3 armor (if she
  // was placed last). Reuses the existing rallyBuff event/animation.
  const waitressQueue = match.pendingWaitress;
  match.pendingWaitress = [];
  for (const entry of waitressQueue) {
    const board = match.boards[entry.side];
    const allies = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (board[l][d]) allies.push({ laneIdx: l, depthIdx: d });
      }
    }
    if (allies.length === 0) continue;
    const chosen = allies[Math.floor(Math.random() * allies.length)];
    const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
    if (entry.kind === 'atk') {
      targetUnit.atk += 2;
      events.push({
        type: 'rallyBuff', side: entry.side, laneIdx: chosen.laneIdx,
        targetDepth: chosen.depthIdx, buffAtk: 2, buffHp: 0, sourceUid: entry.sourceUid,
      });
    } else {
      targetUnit.armor = (targetUnit.armor || 0) + 3;
      events.push({
        type: 'rallyBuff', side: entry.side, laneIdx: chosen.laneIdx,
        targetDepth: chosen.depthIdx, buffAtk: 0, buffHp: 0, buffArmor: 3, sourceUid: entry.sourceUid,
      });
    }
  }


  // Даос с метлой: same "start of resolution" moment as everything
  // above — bounces the FIRST opposing unit standing in the same lane
  // (reusing frontUnit, the exact "first standing unit" scan already
  // used throughout combat) back to the opponent's hand as a fresh
  // base card, losing every buff/debuff. Чаростойкость is skipped,
  // staying exactly where it is; no opposing unit at all in that lane
  // is simply a no-op.
  const broomQueue = match.pendingBroomBounce;
  match.pendingBroomBounce = [];
  for (const entry of broomQueue) {
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    const info = frontUnit(enemyBoard, entry.laneIdx);
    if (!info) {
      events.push({
        type: 'broomBounce', side: entry.side, targetSide: enemySide,
        laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
        targetDepthIdx: null, bounced: false, empty: true, resisted: false,
      });
      continue;
    }
    if (info.unit.spellResist || info.unit.rockEffect || info.unit.shieldEffect) {
      events.push({
        type: 'broomBounce', side: entry.side, targetSide: enemySide,
        laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
        targetDepthIdx: info.depth, bounced: false, empty: false, resisted: true, rockProtected: !!info.unit.rockEffect,
      });
      continue;
    }
    match.hands[enemySide].push({ id: info.unit.id, uid: nextUid('card') });
    enemyBoard[entry.laneIdx][info.depth] = null;
    events.push({
      type: 'broomBounce', side: entry.side, targetSide: enemySide,
      laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
      targetDepthIdx: info.depth, bounced: true, empty: false, resisted: false, bouncedCardId: info.unit.id,
    });
  }

  // Даос с колокольчиком: battlecry — a random enemy unit anywhere on
  // the board is bounced back to the opponent's hand as a fresh base
  // card, losing every buff/debuff. Чаростойкость is skipped, staying
  // exactly where it is; an empty enemy board is simply a no-op.
  const bellQueue = match.pendingBellBounce;
  match.pendingBellBounce = [];
  for (const entry of bellQueue) {
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    const targets = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (enemyBoard[l][d]) targets.push({ laneIdx: l, depthIdx: d });
      }
    }
    if (targets.length === 0) {
      events.push({
        type: 'bellBounce', side: entry.side, targetSide: enemySide,
        laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
        targetLaneIdx: null, targetDepthIdx: null, bounced: false, empty: true, resisted: false,
      });
      continue;
    }
    const chosen = targets[Math.floor(Math.random() * targets.length)];
    const targetUnit = enemyBoard[chosen.laneIdx][chosen.depthIdx];
    if (targetUnit.spellResist || targetUnit.rockEffect || targetUnit.shieldEffect) {
      events.push({
        type: 'bellBounce', side: entry.side, targetSide: enemySide,
        laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
        targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, bounced: false, empty: false, resisted: true, rockProtected: !!targetUnit.rockEffect,
      });
      continue;
    }
    match.hands[enemySide].push({ id: targetUnit.id, uid: nextUid('card') });
    enemyBoard[chosen.laneIdx][chosen.depthIdx] = null;
    events.push({
      type: 'bellBounce', side: entry.side, targetSide: enemySide,
      laneIdx: entry.laneIdx, depthIdx: entry.depthIdx, sourceUid: entry.sourceUid,
      targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, bounced: true, empty: false, resisted: false, bouncedCardId: targetUnit.id,
    });
  }

  // Спокойная монахиня: battlecry — doubles the hp of a random
  // ADJACENT ally (reuses adjacentAllyPositions). A safe no-op if she
  // has no adjacent ally at all.
  const calmNunQueue = match.pendingCalmNun;
  match.pendingCalmNun = [];
  for (const entry of calmNunQueue) {
    const board = match.boards[entry.side];
    const neighbours = adjacentAllyPositions(board, entry.laneIdx, entry.depthIdx);
    if (neighbours.length === 0) continue;
    const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
    const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
    const gained = targetUnit.hp;
    targetUnit.hp += gained;
    targetUnit.maxHp += gained;
    events.push({
      type: 'rallyBuff', side: entry.side, laneIdx: chosen.laneIdx,
      targetDepth: chosen.depthIdx, buffAtk: 0, buffHp: gained, sourceUid: entry.sourceUid,
    });
  }

  // Смелый учитель: same "start of resolution" battlecry moment as
  // everything above — increases a random ADJACENT ally's attack by
  // an amount equal to THAT ally's own current hp (reuses the exact
  // same dynamic-amount computation as Сила гор, just aimed at a
  // neighbor instead of a spell-targeted unit). A safe no-op if he
  // has no adjacent ally at all.
  const braveTeacherQueue = match.pendingBraveTeacher;
  match.pendingBraveTeacher = [];
  for (const entry of braveTeacherQueue) {
    const board = match.boards[entry.side];
    const neighbours = adjacentAllyPositions(board, entry.laneIdx, entry.depthIdx);
    if (neighbours.length === 0) continue;
    const chosen = neighbours[Math.floor(Math.random() * neighbours.length)];
    const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
    const amount = targetUnit.hp;
    targetUnit.atk += amount;
    events.push({
      type: 'rallyBuff', side: entry.side, laneIdx: chosen.laneIdx,
      targetDepth: chosen.depthIdx, buffAtk: amount, buffHp: 0, sourceUid: entry.sourceUid,
    });
  }

  // Нуаль Облачный (first cell): 9 damage to the first enemy directly
  // opposite in the SAME lane — Чаростойкость/Щит blocks the hit but
  // the battlecry itself still "happened" (matching every other
  // resisted-hit precedent in this file).
  const nualFrontQueue = match.pendingNualFrontStab;
  match.pendingNualFrontStab = [];
  for (const entry of nualFrontQueue) {
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    const front = frontUnit(enemyBoard, entry.laneIdx);
    if (!front) continue;
    const targetUnit = front.unit;
    const resisted = !!(targetUnit.spellResist || targetUnit.shieldEffect);
    let died = false;
    if (!resisted) {
      targetUnit.hp -= 9;
      died = targetUnit.hp <= 0;
    }
    events.push({
      type: 'nualFrontStab', side: entry.side, targetSide: enemySide, laneIdx: entry.laneIdx,
      targetDepthIdx: front.depth, amount: resisted ? 0 : 9, resisted, died, sourceUid: entry.sourceUid,
    });
    if (died) killUnit(match, enemySide, entry.laneIdx, front.depth, events);
  }

  // Нуаль Облачный (last cell): 3 damage to 4 random DISTINCT enemies
  // anywhere on the board (no lane restriction, unlike the front-cell
  // version) — fewer than 4 enemies means hitting all of them, never a
  // crash. Each hit independently respects Чаростойкость/Щит.
  const nualQuadQueue = match.pendingNualQuadStab;
  match.pendingNualQuadStab = [];
  for (const entry of nualQuadQueue) {
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    const pool = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (enemyBoard[l][d]) pool.push({ laneIdx: l, depthIdx: d });
      }
    }
    const count = Math.min(4, pool.length);
    for (let i = 0; i < count; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const [chosen] = pool.splice(idx, 1);
      const targetUnit = enemyBoard[chosen.laneIdx][chosen.depthIdx];
      const resisted = !!(targetUnit.spellResist || targetUnit.shieldEffect);
      let died = false;
      if (!resisted) {
        targetUnit.hp -= 3;
        died = targetUnit.hp <= 0;
      }
      events.push({
        type: 'nualQuadStab', side: entry.side, targetSide: enemySide, laneIdx: chosen.laneIdx,
        targetDepthIdx: chosen.depthIdx, amount: resisted ? 0 : 3, resisted, died, sourceUid: entry.sourceUid,
      });
      if (died) killUnit(match, enemySide, chosen.laneIdx, chosen.depthIdx, events);
    }
  }

  // Мудрый олень (first cell): -1 attack (floored at 0) and -1 health
  // to EVERY enemy unit on the board — Чаростойкость/Щит protects
  // individual units from just their own hit, the rest still get
  // debuffed. A unit whose hp reaches 0 from this dies normally.
  const wiseDeerDebuffQueue = match.pendingWiseDeerDebuff;
  match.pendingWiseDeerDebuff = [];
  for (const entry of wiseDeerDebuffQueue) {
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const targetUnit = enemyBoard[l][d];
        if (!targetUnit) continue;
        const resisted = !!(targetUnit.spellResist || targetUnit.shieldEffect);
        let died = false;
        if (!resisted) {
          targetUnit.atk = Math.max(0, targetUnit.atk - 1);
          targetUnit.hp -= 1;
          died = targetUnit.hp <= 0;
        }
        events.push({
          type: 'wiseDeerDebuff', side: entry.side, targetSide: enemySide, laneIdx: l,
          depthIdx: d, resisted, died, sourceUid: entry.sourceUid,
        });
        if (died) killUnit(match, enemySide, l, d, events);
      }
    }
  }

  // Мудрый олень (last cell): +2 attack and +2 health to EVERY ally
  // unit on the board (himself included) — same Щит exclusion as
  // everywhere else, since Щит blocks beneficial effects too.
  const wiseDeerBuffQueue = match.pendingWiseDeerBuff;
  match.pendingWiseDeerBuff = [];
  for (const entry of wiseDeerBuffQueue) {
    const ownBoard = match.boards[entry.side];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const targetUnit = ownBoard[l][d];
        if (!targetUnit || targetUnit.shieldEffect) continue;
        targetUnit.atk += 2;
        targetUnit.hp += 2;
        targetUnit.maxHp += 2;
        events.push({
          type: 'rallyBuff', side: entry.side, laneIdx: l,
          targetDepth: d, buffAtk: 2, buffHp: 2, sourceUid: entry.sourceUid,
        });
      }
    }
  }

  // Воин с копьем: checked here at the very start of resolution (see
  // the placement-time comment above for why) — if the cell directly
  // opposite (same lane, same depth, enemy side) has a unit that was
  // ALSO placed this exact round (bornRound === match.round,
  // regardless of which player placed first), gains a permanent
  // +1 attack / +3 health. A safe no-op if he's no longer there, or if
  // nothing (or an older unit) occupies the opposing cell.
  const spearmanBuffQueue = match.pendingSpearmanBuff;
  match.pendingSpearmanBuff = [];
  for (const entry of spearmanBuffQueue) {
    const unit = match.boards[entry.side][entry.laneIdx] && match.boards[entry.side][entry.laneIdx][entry.depthIdx];
    if (!unit || unit.shieldEffect) continue;
    const enemySide = otherPlayer(match, entry.side);
    const enemyBoard = match.boards[enemySide];
    const enemyUnit = enemyBoard[entry.laneIdx] && enemyBoard[entry.laneIdx][entry.depthIdx];
    if (enemyUnit && enemyUnit.bornRound === match.round) {
      unit.atk += 1;
      unit.hp += 3;
      unit.maxHp += 3;
      events.push({
        type: 'rallyBuff', side: entry.side, laneIdx: entry.laneIdx,
        targetDepth: entry.depthIdx, buffAtk: 1, buffHp: 3, sourceUid: entry.sourceUid,
      });
    }
  }

  // Степной орел: unlike every other "placed this exact round" check
  // above (all of which only ever look at the reacting unit's OWN
  // placement round), this one is a persistent, every-round reaction —
  // for as long as he's alive, any ally newly placed THIS round
  // (bornRound === match.round, himself excluded) that carries
  // Понимание (insightEffect) permanently grants him attack equal to
  // that unit's own insightEffect value. Two eagles each react
  // independently; one eagle reacts to every insight carrier placed the
  // same round, one buff per pairing.
  for (const side of match.players) {
    const board = match.boards[side];
    const insightArrivals = [];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const u = board[l][d];
        if (u && u.insightEffect > 0 && u.bornRound === match.round) {
          insightArrivals.push({ laneIdx: l, depthIdx: d, amount: u.insightEffect });
        }
      }
    }
    if (insightArrivals.length === 0) continue;
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const eagle = board[l][d];
        if (!eagle || !eagle.prairieEagleReact) continue;
        for (const arrival of insightArrivals) {
          if (arrival.laneIdx === l && arrival.depthIdx === d) continue;
          eagle.atk += arrival.amount;
          events.push({
            type: 'rallyBuff', side, laneIdx: l,
            targetDepth: d, buffAtk: arrival.amount, buffHp: 0, sourceUid: eagle.uid,
          });
        }
      }
    }
  }

  // Таинственная служанка Сюань: same "start of resolution" battlecry
  // moment as everything above — triggers her own Понимание first
  // (using the OPPONENT's hand as it stands right now), then the
  // ally-buff/enemy-debuff shift.
  const mysteriousMaidQueue = match.pendingMysteriousMaid;
  match.pendingMysteriousMaid = [];
  for (const entry of mysteriousMaidQueue) {
    if (entry.insightAmount > 0) applyInsight(match, entry.side, entry.insightAmount, events);
    applyMysteriousMaidShift(match, entry.side, events, entry.sourceUid);
  }

  // Шаман прерий: same Понимание effect as Таинственная служанка Сюань
  // above, but standalone — no accompanying atk-shift battlecry.
  const shamanInsightQueue = match.pendingShamanInsight;
  match.pendingShamanInsight = [];
  for (const entry of shamanInsightQueue) {
    if (entry.insightAmount > 0) applyInsight(match, entry.side, entry.insightAmount, events);
  }

  const battlecrySummonQueue = match.pendingBattlecrySummons;
  match.pendingBattlecrySummons = [];
  for (const summon of battlecrySummonQueue) {
    const count = summon.summonCount || 1;
    for (let i = 0; i < count; i++) {
      summonUnitToRandomFreeCell(match, summon.side, summon.summonCardId, events);
    }
  }

  // Епископ fires here too — at the very start of resolution, same
  // moment as everything else above, before spells or combat.
  applyBishopBuffs(match, events);
  // Статуя now fires here too (moved from end-of-round) — same "start
  // of round" moment as Епископ.
  applyStatueBuffs(match, events);
  // Шаман костей also fires here — +1/+1 to every ally including
  // himself, every round he's alive.
  applyBoneShamanBuffs(match, events);
  // Тотем дикарей also fires here — +1 attack (only) to every ally
  // including itself, every round it's alive.
  applySavageTotemBuffs(match, events);
  // Дикарка с топорами also fires here — the same mirrored-row axe
  // throw as her own pre-attack hook below, so she throws twice per
  // round in total (once here, once before her attack).
  applyAxeWomanStartOfRoundThrows(match, events);
  // Кай Кровавый also fires here — grants every OTHER ally (never
  // himself) Кража жизни, every round he's alive.
  applyKaiBloodyLifestealGrants(match, events);
  // Луна, голос будущего also fires here — re-evaluated fresh every
  // round she's alive.
  applyLunaBlind(match, events);
  // Музыкальный Даос also fires here — 1 damage to every enemy unit,
  // every round he's alive.
  applyMusicalDaoist(match, events);
  // Амбар долины also fires here — +1/+1 to a random OTHER ally,
  // every round he's alive.
  applyValleyBarn(match, events);

  // Крестьянское ополчение: unlike every other spell (all resolved
  // above, before combat), this one is explicitly an END-of-round
  // effect — pulled out of the normal spell queue here so resolveSpells
  // below never sees it, then actually resolved further down, after
  // resolveCombat.
  const endOfRoundSpellQueue = match.pendingSpells.filter((sp) => sp.kind === 'endOfRoundSpell');
  match.pendingSpells = match.pendingSpells.filter((sp) => sp.kind !== 'endOfRoundSpell');

  resolveSpells(match, events);
  // Билл и Билли: a fresh 50/50 coin flip every single round, right
  // before combat resolves — a "tails" roll sets the exact same
  // cantAttackThisRound flag Трусливый убийца uses, so he simply
  // doesn't attack that wave (still fully targetable/blockable as
  // normal). No event pushed — same silent "just doesn't attack this
  // round" precedent as every other cantAttackThisRound source. The
  // loop right after combat below already resets this flag to false
  // for every unit regardless of source, so no separate cleanup is
  // needed here — next round rolls fresh again.
  for (const name of match.players) {
    const board = match.boards[name];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        const u = board[l][d];
        if (u && u.coinFlipAttack && Math.random() < 0.5) {
          u.cantAttackThisRound = true;
        }
      }
    }
  }
  resolveCombat(match, events);
  match.blindedUids = null; // Рейна's effect only ever covers the one round it's cast for
  // Трусливый убийца: same "only covers the one round it applies to"
  // scoping as Рейна's blind above — cleared right AFTER combat has
  // already resolved for the round he was placed in, so the
  // restriction actually protected him through that round's fights
  // before disappearing for every round after.
  for (const name of match.players) {
    const board = match.boards[name];
    for (let l = 0; l < LANES; l++) {
      for (let d = 0; d < DEPTH; d++) {
        if (board[l][d]) board[l][d].cantAttackThisRound = false;
      }
    }
  }

  // Крестьянское ополчение resolves here, genuinely after this round's
  // combat has already happened — summons land on whatever's free right
  // now (post-combat), and the heal uses the same healHero() choke point
  // as everything else (so Двойное омоложение still doubles it, etc.).
  for (const spell of endOfRoundSpellQueue) {
    if (anyHeroDown(match)) break;
    const count = spell.summonCount || 1;
    for (let i = 0; i < count; i++) {
      summonUnitToRandomFreeCell(match, spell.side, spell.summonCardId, events);
    }
    if (spell.healAmount) {
      const healed = healHero(match, spell.side, spell.healAmount, events);
      events.push({ type: 'heroHeal', side: spell.side, amount: healed, sourceUid: null, laneIdx: spell.laneIdx, depthIdx: spell.depthIdx });
    }
  }

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
            const healed = healHero(match, name, unit.atk, events);
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: healed, laneIdx: l, depthIdx: d });
          }
          // Священник Луны: a flat, guaranteed heal every round she
          // survives — unlike Повар (tied to attack) or Корова (tied to
          // current hp, 50/50 chance), this is just a fixed number.
          // Reuses the exact same 'endOfRound' event/heal-orb animation.
          // Шеф дома Вкуса: on her OWN birth round, the recurring
          // fixedHeal(6) is replaced entirely by the one-time double
          // below (see chefDoubleHero) — skip it just for that round;
          // from the NEXT round onward she heals normally like anyone
          // else with fixedHeal.
          const skipFixedHealForChef = unit && unit.chefDoubleHero && match.round === unit.bornRound;
          if (unit && unit.fixedHeal && !skipFixedHealForChef) {
            const healed = healHero(match, name, unit.fixedHeal, events);
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: healed, laneIdx: l, depthIdx: d });
          }
          // Денежное дерево: at the end of the round, if this unit took
          // damage THIS round (compared against the hp snapshot taken
          // at the very start of resolution, before anything could
          // change it), draws 1 card from her owner's own deck.
          if (unit && unit.moneyTree) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              const hand = match.hands[name];
              if (hand.length < MAX_HAND) {
                const beforeLen = hand.length;
                draw(match.decks[name], hand, 1);
                const drew = hand.length > beforeLen;
                events.push({ type: 'moneyTreeDraw', side: name, sourceUid: unit.uid, laneIdx: l, depthIdx: d, drew });
              }
            }
          }
          // Горный воин: at the end of the round, if this unit took
          // damage THIS round (same roundStartHp snapshot comparison as
          // Денежное дерево above), permanently gains +1 attack and +2
          // health instead of drawing a card.
          if (unit && unit.mountainWarriorBuff) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              unit.atk += 1;
              unit.hp += 2;
              unit.maxHp += 2;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: l,
                targetDepth: d, buffAtk: 1, buffHp: 2, sourceUid: unit.uid,
              });
            }
          }
          // Бегемот: same roundStartHp-based "took damage this round"
          // check as Горный воин above, and now the exact same kind of
          // permanent growth too (no upper bound) — just +hp only, no
          // attack change. Reuses the same rallyBuff event.
          if (unit && unit.selfHpGrowthOnDamage) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              const amount = unit.selfHpGrowthOnDamage;
              unit.hp += amount;
              unit.maxHp += amount;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: l,
                targetDepth: d, buffAtk: 0, buffHp: amount, sourceUid: unit.uid,
              });
            }
          }
          // Цветок прерий: same roundStartHp-based "took damage this
          // round" permanent-growth family as Горный воин/Бегемот above,
          // but +2 attack AND +2 health this time.
          if (unit && unit.prairieFlowerGrowth) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              unit.atk += 2;
              unit.hp += 2;
              unit.maxHp += 2;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: l,
                targetDepth: d, buffAtk: 2, buffHp: 2, sourceUid: unit.uid,
              });
            }
          }
          // Воин с топором: same roundStartHp-based permanent-growth
          // family as Горный воин/Цветок прерий above, but +1 attack
          // AND +1 health this time.
          if (unit && unit.axeWarriorGrowth) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              unit.atk += 1;
              unit.hp += 1;
              unit.maxHp += 1;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: l,
                targetDepth: d, buffAtk: 1, buffHp: 1, sourceUid: unit.uid,
              });
            }
          }
          // Минотавр: same roundStartHp-based permanent-growth family
          // as Воин с топором right above, but +1 attack AND +2 health
          // instead — a separate field since the amounts differ.
          if (unit && unit.minotaurGrowth) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp) {
              unit.atk += 1;
              unit.hp += 2;
              unit.maxHp += 2;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: l,
                targetDepth: d, buffAtk: 1, buffHp: 2, sourceUid: unit.uid,
              });
            }
          }
          // Хищное растение: same roundStartHp-based "took damage this
          // round" check as Горный воин/Воин с топором above, but bites
          // the enemy HERO directly for damage equal to its own current
          // attack instead of buffing itself. Reuses the exact heroShot
          // event/animation already built for Арбалетчик's own
          // recurring hero shot.
          if (unit && unit.carnivorousPlantBite) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp && !anyHeroDown(match)) {
              const targetSide = otherPlayer(match, name);
              match.hp[targetSide] -= unit.atk;
              events.push({
                type: 'heroShot', side: name, targetSide, amount: unit.atk,
                laneIdx: l, depthIdx: d, sourceUid: unit.uid,
              });
            }
          }
          // Большой кактус прерий: same roundStartHp-based "took damage
          // this round" check as Горный воин/Бегемот/Цветок прерий
          // above, but combined with Корова's own 60% coin flip, and
          // heals the HERO for a fixed 3 instead of buffing/healing
          // itself — reuses the same 'endOfRound' event Корова's own
          // cowHeal uses.
          if (unit && unit.bigCactusHeal) {
            const startHp = match.roundStartHp[unit.uid];
            if (startHp !== undefined && unit.hp < startHp && Math.random() < 0.6) {
              const healed = healHero(match, name, 3, events);
              events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: healed, laneIdx: l, depthIdx: d });
            }
          }
          // Шеф дома Вкуса: exactly ONE time, at the end of the SAME
          // round she was placed (bornRound) — REPLACING the recurring
          // fixedHeal(6) that round would otherwise have given (see the
          // skipFixedHealForChef guard above) — doubles her owner's
          // hero's CURRENT hp. From the NEXT round onward, no more
          // doubling, just the normal fixedHeal(6) like anyone else.
          // chefDoubleUsed guards against ever firing a second time.
          if (unit && unit.chefDoubleHero && !unit.chefDoubleUsed && match.round === unit.bornRound) {
            unit.chefDoubleUsed = true;
            const before = match.hp[name];
            match.hp[name] = before * 2;
            events.push({
              type: 'chefHeroDouble', side: name, sourceUid: unit.uid,
              laneIdx: l, depthIdx: d, amount: match.hp[name] - before,
            });
            // Doubling counts as "restoring/increasing" the hero's own
            // health same as any ordinary heal — but this bypasses
            // healHero() entirely, so Ящерица степей needs its own
            // explicit trigger call right here.
            if (match.hp[name] > before) {
              applyLizardHealTrigger(match, name, events);
              applySquirrelHealTrigger(match, name, events);
              applyArmadilloHealTrigger(match, name, events);
              applyLizardWarriorTrigger(match, name, events);
              applyBadgerHealTrigger(match, name, events);
              applyOneEyedBeastHealTrigger(match, name, events);
              applyKaiBloodyHealTrigger(match, name, events);
            }
          }
          // Корова: 50/50 per round — heals for her own CURRENT hp at
          // this exact moment (not a fixed number, not attack), so a
          // heavily-damaged Корова gives back much less than a fresh one.
          if (unit && unit.cowHeal && Math.random() < 0.5) {
            const healed = healHero(match, name, unit.hp, events);
            events.push({ type: 'endOfRound', side: name, cardId: unit.id, uid: unit.uid, amount: healed, laneIdx: l, depthIdx: d });
          }
          // Лучник прерий (shootHero): fires again at the end of every
          // round she survives, same as her battlecry — enemy hero
          // takes damage equal to her live (Synergy-boosted, if any)
          // attack right now. Formerly Арбалетчик's own mechanic before
          // its rework to shootHeroStartOfTurn (see the start-of-round
          // check further up in resolution instead).
          if (unit && unit.shootHero) {
            const targetSide = match.players.find((p) => p !== name);
            const amount = effectiveAtk(board, l, d);
            match.hp[targetSide] -= amount;
            events.push({
              type: 'heroShot', side: name, targetSide, amount,
              laneIdx: l, depthIdx: d, sourceUid: unit.uid,
            });
          }
          // Осадная башня: same end-of-round trigger and crossbow-bolt
          // animation as Арбалетчик's shootHero above, but the bolt flies
          // at a random ENEMY UNIT instead of the hero, for a fixed 2
          // damage (not attack-based) — silently does nothing if the
          // enemy board is empty.
          if (unit && unit.siegeShot) {
            const targetSide = match.players.find((p) => p !== name);
            const targetBoard = match.boards[targetSide];
            const targets = [];
            for (let l2 = 0; l2 < LANES; l2++) {
              for (let d2 = 0; d2 < DEPTH; d2++) {
                // Чаростойкость: a spellResist unit is never even a
                // candidate here — she's not a legal target for this
                // enemy end-of-round damage mechanic at all.
                if (targetBoard[l2][d2] && !targetBoard[l2][d2].spellResist) targets.push({ laneIdx: l2, depthIdx: d2 });
              }
            }
            if (targets.length > 0) {
              const chosen = targets[Math.floor(Math.random() * targets.length)];
              const targetUnit = targetBoard[chosen.laneIdx][chosen.depthIdx];
              const amount = 2;
              targetUnit.hp -= amount;
              const died = targetUnit.hp <= 0;
              events.push({
                type: 'unitShot', side: name, targetSide, amount,
                laneIdx: l, depthIdx: d, sourceUid: unit.uid,
                targetLaneIdx: chosen.laneIdx, targetDepthIdx: chosen.depthIdx, died,
              });
              if (died) killUnit(match, targetSide, chosen.laneIdx, chosen.depthIdx, events);
            }
          }
          // Подрывник: throws a powder keg at a random SQUARE anywhere
          // on the enemy board — occupied or not. A Чаростойкость unit
          // is never a legal square to land on at all (treated exactly
          // like an empty one for the purposes of picking a square, same
          // convention as cannonShot). If the picked square is empty,
          // the keg explodes on the hero instead, for the same 5
          // damage. Fixed damage, not attack-based.
          if (unit && unit.powderKeg) {
            const targetSide = match.players.find((p) => p !== name);
            const targetBoard = match.boards[targetSide];
            const targetLaneIdx = Math.floor(Math.random() * LANES);
            const targetDepthIdx = Math.floor(Math.random() * DEPTH);
            const cellUnit = targetBoard[targetLaneIdx][targetDepthIdx];
            const resisted = !!(cellUnit && cellUnit.spellResist);
            const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
            const amount = 5;
            let died = false;
            if (resisted) {
              // no-op: the keg explodes on her harmlessly, same pattern
              // as every other cross-side mechanic checking this status.
            } else if (targetUnit) {
              targetUnit.hp -= amount;
              died = targetUnit.hp <= 0;
            } else {
              match.hp[targetSide] -= amount;
            }
            events.push({
              type: 'powderKegShot', side: name, targetSide, amount: resisted ? 0 : amount,
              laneIdx: l, depthIdx: d, sourceUid: unit.uid,
              targetLaneIdx, targetDepthIdx, targetHero: !cellUnit, died, resisted,
            });
            if (died) killUnit(match, targetSide, targetLaneIdx, targetDepthIdx, events);
          }
          // Лагерь ополченцев: same as her battlecry (see
          // pendingBattlecrySummons above) — summons another copy onto a
          // random free cell of her own board, but repeating at the end
          // of every round she survives instead of firing once. Silent
          // no-op if the board is full, same as every other summon here.
          if (unit && unit.endOfRoundSummon) {
            summonUnitToRandomFreeCell(match, name, unit.endOfRoundSummon, events);
          }
          // Имперская пушка: at the end of every round she survives,
          // strikes a random cell within the OPPOSING side's version of
          // her OWN lane (not any random lane on the board — specifically
          // whichever lane she herself sits in) for damage equal to her
          // live attack. If that cell is empty, the shot instead lands on
          // the enemy hero. New 'cannonShot' event carries enough for the
          // client to fly a cannonball to the right spot and explode.
          if (unit && unit.cannonShot) {
            // Имперский бастион: same mechanic as Имперская пушка, but
            // with a FIXED damage amount (cannonShotFixed) instead of her
            // live attack, and a chance (cannonShotExtraChance) of firing
            // a second, fully independent shot — its own fresh random
            // cell, which could even be the same one again.
            const shotCount = 1 + ((unit.cannonShotExtraChance && Math.random() < unit.cannonShotExtraChance) ? 1 : 0);
            for (let shotIdx = 0; shotIdx < shotCount; shotIdx++) {
              const targetSide = match.players.find((p) => p !== name);
              const targetBoard = match.boards[targetSide];
              const targetDepth = Math.floor(Math.random() * DEPTH);
              const cellUnit = targetBoard[l][targetDepth];
              // Чаростойкость: if the picked cell holds a spellResist unit,
              // the shot still lands and explodes there (visually), but
              // deals NO damage at all — not to her, not redirected to the
              // hero either. An empty cell still redirects to the hero as
              // before; this only changes the "occupied by an immune unit"
              // case specifically.
              const resisted = !!(cellUnit && cellUnit.spellResist);
              const targetUnit = (cellUnit && !resisted) ? cellUnit : null;
              const amount = unit.cannonShotFixed || effectiveAtk(board, l, d);
              let died = false;
              if (resisted) {
                // no-op: cannonball explodes on her harmlessly
              } else if (targetUnit) {
                targetUnit.hp -= amount;
                died = targetUnit.hp <= 0;
              } else {
                match.hp[targetSide] -= amount;
              }
              events.push({
                type: 'cannonShot', side: name, targetSide, amount: resisted ? 0 : amount,
                laneIdx: l, depthIdx: d, sourceUid: unit.uid,
                targetLaneIdx: l, targetDepthIdx: targetDepth,
                targetHero: !cellUnit, died, resisted,
              });
              if (died) killUnit(match, targetSide, l, targetDepth, events);
            }
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
          // Монах-аскет: grows in both attack and health at the end of
          // every round he survives — permanently +1/+1 to himself.
          // Same rallyBuff event/animation as Каменная Стена's own
          // growth, just atk-and-hp instead of hp-only.
          if (unit && unit.monkGrow) {
            unit.atk += 1;
            unit.hp += 1;
            unit.maxHp += 1;
            events.push({
              type: 'rallyBuff', side: name, laneIdx: l,
              targetDepth: d, buffAtk: 1, buffHp: 1, sourceUid: unit.uid,
            });
          }
          // Персиковый сад: at the end of every round he survives, adds
          // a fresh Персик card directly to his owner's hand — NOT
          // drawn from the deck (this card doesn't live in anyone's
          // deck at all, it can only ever be obtained this way).
          // Silently does nothing if the hand is already full, same
          // MAX_HAND respect as every other card-granting mechanic.
          if (unit && unit.peachOrchard) {
            const hand = match.hands[name];
            if (hand.length < MAX_HAND) {
              hand.push({ id: unit.peachOrchard, uid: nextUid('card') });
              events.push({ type: 'peachGiven', side: name, laneIdx: l, depthIdx: d, sourceUid: unit.uid, cardId: unit.peachOrchard });
            }
          }
          // Аист с пером: at the end of every round he survives, copies
          // a random ENEMY unit currently on the board and adds THAT
          // card to his OWNER's OWN hand (not the opponent's) — same
          // MAX_HAND respect as Персиковый сад, but the card id is
          // chosen dynamically from whatever the enemy has out right
          // now, rather than being a single fixed card.
          if (unit && unit.stork) {
            const hand = match.hands[name];
            if (hand.length < MAX_HAND) {
              const enemySide = otherPlayer(match, name);
              const enemyBoard = match.boards[enemySide];
              const enemyUnits = [];
              for (let l2 = 0; l2 < LANES; l2++) {
                for (let d2 = 0; d2 < DEPTH; d2++) {
                  if (enemyBoard[l2][d2]) enemyUnits.push(enemyBoard[l2][d2]);
                }
              }
              if (enemyUnits.length > 0) {
                const chosen = enemyUnits[Math.floor(Math.random() * enemyUnits.length)];
                hand.push({ id: chosen.id, uid: nextUid('card') });
                events.push({ type: 'storkCopy', side: name, laneIdx: l, depthIdx: d, sourceUid: unit.uid, copiedCardId: chosen.id });
              }
            }
          }
          // Божественные лозы: doubles her own CURRENT hp at the end of
          // every round she survives — an intentionally explosive
          // "snowball" epic effect (2 -> 4 -> 8 -> 16...), unlike every
          // other self-growth mechanic in this file (Каменная Стена,
          // Кузнец, Монах-аскет), which only ever adds a fixed amount.
          // Reuses the same rallyBuff event/animation — the buff amount
          // is however much hp was just gained (her pre-double value).
          if (unit && unit.divineVines) {
            const gained = unit.hp;
            unit.hp += gained;
            unit.maxHp += gained;
            events.push({
              type: 'rallyBuff', side: name, laneIdx: l,
              targetDepth: d, buffAtk: 0, buffHp: gained, sourceUid: unit.uid,
            });
          }
          // Священник: at the end of every round, picks one random OTHER
          // ally anywhere on his own board (never himself) and permanently
          // raises its hp (and maxHp) by 2 — same target-selection and
          // event/animation as Епископ, just hp-only and end-of-round
          // instead of start-of-round.
          if (unit && unit.priestHeal) {
            const targets = [];
            for (let l2 = 0; l2 < LANES; l2++) {
              for (let d2 = 0; d2 < DEPTH; d2++) {
                if (l2 === l && d2 === d) continue; // never himself
                if (board[l2][d2]) targets.push({ laneIdx: l2, depthIdx: d2 });
              }
            }
            if (targets.length > 0) {
              const chosen = targets[Math.floor(Math.random() * targets.length)];
              const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
              targetUnit.hp += 2;
              targetUnit.maxHp += 2;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: chosen.laneIdx,
                targetDepth: chosen.depthIdx, buffAtk: 0, buffHp: 2, sourceUid: unit.uid,
              });
            }
          }
          // Колдун прерий: same target-selection/timing as Священник
          // above (one random OTHER ally, end-of-round), but +2 attack
          // only instead of +2 health only.
          if (unit && unit.prairieWarlockBuff) {
            const targets = [];
            for (let l2 = 0; l2 < LANES; l2++) {
              for (let d2 = 0; d2 < DEPTH; d2++) {
                if (l2 === l && d2 === d) continue; // never himself
                if (board[l2][d2]) targets.push({ laneIdx: l2, depthIdx: d2 });
              }
            }
            if (targets.length > 0) {
              const chosen = targets[Math.floor(Math.random() * targets.length)];
              const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
              targetUnit.atk += 2;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: chosen.laneIdx,
                targetDepth: chosen.depthIdx, buffAtk: 2, buffHp: 0, sourceUid: unit.uid,
              });
            }
          }
          // Барон: at the end of every round he survives, gives every
          // allied unit on the board — including himself — a permanent
          // +1/+1. Reuses applyDawnBuff exactly (Аннабэль's own "buff
          // everyone" loop), just triggered at end-of-round instead of
          // before each of her attacks.
          if (unit && unit.baronBuff) {
            applyDawnBuff(match, name, events, unit.uid);
          }
          // Кузнец: at the end of every round he survives, always
          // improves his OWN attack and armor by 1, and separately picks
          // one random OTHER ally that currently has Armor > 0 and gives
          // that one the same +1 attack / +1 armor too (a no-op for that
          // second part if no other armored ally exists). Reuses the
          // rallyBuff event/animation, now extended to carry buffArmor.
          if (unit && unit.blacksmithBuff) {
            unit.atk += 1;
            unit.armor = (unit.armor || 0) + 1;
            events.push({
              type: 'rallyBuff', side: name, laneIdx: l,
              targetDepth: d, buffAtk: 1, buffHp: 0, buffArmor: 1, sourceUid: unit.uid,
            });
            const targets = [];
            for (let l2 = 0; l2 < LANES; l2++) {
              for (let d2 = 0; d2 < DEPTH; d2++) {
                if (l2 === l && d2 === d) continue; // never himself — already handled above
                const candidate = board[l2][d2];
                if (candidate && candidate.armor > 0) targets.push({ laneIdx: l2, depthIdx: d2 });
              }
            }
            if (targets.length > 0) {
              const chosen = targets[Math.floor(Math.random() * targets.length)];
              const targetUnit = board[chosen.laneIdx][chosen.depthIdx];
              targetUnit.atk += 1;
              targetUnit.armor += 1;
              events.push({
                type: 'rallyBuff', side: name, laneIdx: chosen.laneIdx,
                targetDepth: chosen.depthIdx, buffAtk: 1, buffHp: 0, buffArmor: 1, sourceUid: unit.uid,
              });
            }
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
      // Шаман прерий (Мана 1): each side's actual refill is the shared
      // maxMana PLUS whatever manaAura bonus THEIR OWN board currently
      // has — asymmetric on purpose, since this is a per-owner effect.
      match.mana[nameA] = match.maxMana + manaAuraTotal(match, nameA);
      match.mana[nameB] = match.maxMana + manaAuraTotal(match, nameB);
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
  const revealedUids = new Set(match.revealedTo[username] || []);
  const revealedOpponentCards = match.hands[other].filter((c) => revealedUids.has(c.uid));
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
    revealedOpponentCards,
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
