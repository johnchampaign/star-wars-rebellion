// #645 — "I don't see any of the played tactic cards. I need to check the log
// outside the combat screen to somehow understand what happened."
//
// The board HAD a "Tactics played" strip. It listened for the events a
// cinematic card fires when it is CANCELLED or has NO EFFECT — but not for the
// one it fires when it actually PLAYS: `cinematic-tactic-play`, which also
// carries `cardId` rather than `card`. So in a cinematic (RoE) game a card
// that got cancelled showed on the board while a card that resolved was
// invisible. The reporter's log is full of cinematic-tactic-play entries and
// the board showed him none of them.
//
// Two layers pinned here:
//   1. the ENGINE contract: a real cinematic play logs cinematic-tactic-play
//      with cardId, between combat-begin and combat-end
//   2. the DERIVATION: playedTacticsFor turns that log into a strip entry, and
//      still shows cancels / no-effects, and stops at combat-end
//
// Run: node scripts/test-tactics-strip-645.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const { playedTacticsFor } = await import('../src/play/combatTacticsStrip.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('\n[ 1. a real cinematic play reaches the strip ]');
{
  // Drive an actual cinematic combat until at least one cinematic card plays.
  let seen = null;
  for (let seed = 1; seed <= 40 && !seen; seed++) {
    const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true, cinematicCombat: true } });
    G.map.systems['corellia'].units = [
      { instanceId: 'sd1', typeId: 'star-destroyer', side: 'Empire', damage: 0 },
      { instanceId: 'st1', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
      { instanceId: 'st2', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
      { instanceId: 'cc1', typeId: 'corellian-corvette', side: 'Rebel', damage: 0 },
      { instanceId: 'rt1', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 },
      { instanceId: 'rt2', typeId: 'rebel-trooper', side: 'Rebel', damage: 0 },
    ];
    G.rebel.actionHand = []; G.empire.actionHand = [];
    G.rebel.leaderPool = []; G.empire.leaderPool = [];
    combat.beginCombat(G, 'Rebel', ['corellia'], 'corellia');
    if (!G.pendingCombat?.cinematic) continue;
    // Let the AI-ish default resolvers run the combat by auto-resolving pauses.
    const ai = await import('../src/play/randomAI.ts');
    for (let step = 0; step < 400 && G.pendingCombat; step++) {
      if (!G.pendingChoice) { combat.runCombat(G); if (!G.pendingChoice && G.pendingCombat) break; continue; }
      const side = G.pendingChoice.side;
      if (!ai.stepOnce(G, side)) break;
    }
    const plays = G.turnLog.filter((e) => e.kind === 'cinematic-tactic-play' && e.payload?.cardId);
    if (plays.length > 0) seen = { G, plays };
  }
  check('found a cinematic combat where a card actually played', !!seen, 'no play in 40 seeds');
  if (seen) {
    const { G, plays } = seen;
    const strip = playedTacticsFor(G.turnLog, 'corellia');
    check('the engine logs cinematic-tactic-play WITH a cardId', plays.every((e) => typeof e.payload.cardId === 'string'));
    check('every such play appears on the strip',
      plays.every((e) => strip.some((s) => s.card === e.payload.cardId && s.side === e.side)),
      `strip=${JSON.stringify(strip.map((s) => s.card))} plays=${JSON.stringify(plays.map((e) => e.payload.cardId))}`);
    check('and each carries a readable note (top/bottom, dmg, prevent…)',
      strip.filter((s) => plays.some((e) => e.payload.cardId === s.card)).every((s) => !!s.note),
      JSON.stringify(strip));
    check('the card names resolve in the catalog (so the board shows a name, not an id)',
      strip.every((s) => !!G.catalog.tactics[s.card]?.name), JSON.stringify(strip.map((s) => s.card)));
  }
}

console.log('\n[ 2. the derivation itself, on a hand-built log ]');
{
  const log = [
    { kind: 'phase', payload: {} },
    { kind: 'combat-begin', payload: { systemId: 'naboo' } },
    { kind: 'cinematic-tactic-play', side: 'Rebel', payload: { cardId: 'cin-rebel-ground-hold-them-back', ability: 'primary', destroyed: 'u1' } },
    { kind: 'cinematic-tactic-cancelled', side: 'Empire', payload: { card: 'cin-empire-ground-imposing-presence' } },
    { kind: 'cinematic-tactic-play', side: 'Empire', payload: { cardId: 'cin-empire-space-x', ability: 'secondary', prevent: { red: 2 }, extra: true } },
    { kind: 'cinematic-tactic-play', side: 'Empire', payload: { gained: 'stormtrooper' } }, // no card
    { kind: 'combat-end', payload: {} },
    { kind: 'cinematic-tactic-play', side: 'Rebel', payload: { cardId: 'AFTER-THE-END' } },
  ];
  const strip = playedTacticsFor(log, 'naboo');
  check('the Rebel play shows with its effect', strip[0]?.card === 'cin-rebel-ground-hold-them-back' && /destroyed/.test(strip[0].note ?? ''),
    JSON.stringify(strip[0]));
  check('the cancelled Empire card still shows, tagged', strip[1]?.card === 'cin-empire-ground-imposing-presence' && strip[1].note === 'cancelled');
  check('the prevent play reads its numbers', strip[2]?.note === 'bottom · prevent 2R · +card', strip[2]?.note);
  check('the card-less "gained" variant is skipped, not rendered as an id', strip.length === 3, JSON.stringify(strip));
  check('nothing after combat-end leaks in', !strip.some((s) => s.card === 'AFTER-THE-END'));
  check('a different system\'s combat window yields nothing', playedTacticsFor(log, 'hoth').length === 0);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
