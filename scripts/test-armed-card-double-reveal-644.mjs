// #644 — "Unit placements from secure the plans/secret facility combo fire
// twice." The reporter's save is unambiguous: `secret-facility` is a ONE-OF-A-
// KIND action card (48 cards, no `copies` field), yet their Empire discard held
// it TWICE while it was still sitting in `armedActionCards` pointed at Ilum —
// and the log shows two Shield Bunker + Stormtrooper pairs deployed there on
// consecutive Empire Command turns.
//
// CAUSE: the reveal removed the card from `armedActionCards` with `indexOf`,
// i.e. by OBJECT IDENTITY. `pendingArmedReveals.remaining` and
// `armedActionCards` start out holding the same objects, but BOTH survive the
// codec — one JSON round-trip (save/resume, an online snapshot, an AI-search
// clone) turns them into equal-but-distinct objects, `indexOf` returns -1, the
// splice silently no-ops, and the card stays armed to fire again next turn.
//
// This test recreates that break the way codec.decode() actually does it: a
// JSON round-trip of the two fields, taken between posting the offer and
// resolving it. Run: node scripts/test-armed-card-double-reveal-644.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

handlers.registerAll();

const SYS = 'ilum';
const countDeploys = (G, typeId) => G.turnLog.filter((e) =>
  e.kind === 'deploy' && e.payload?.systemId === SYS && e.payload?.typeId === typeId).length;
const countDiscards = (G) => G.empire.actionDiscard.filter((c) => c === 'secret-facility').length;
const stillArmed = (G) => (G.empire.armedActionCards ?? []).filter((a) => a.cardId === 'secret-facility').length;

function armedGame() {
  const G = createGame(data, { seed: 5, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.phase = 'Command';
  G.currentPlayer = 'Empire';
  G.timeMarker = 3;
  // Ilum is remote; clear it so the reveal's combat has nothing to resolve.
  G.map.systems[SYS].units = [];
  G.empire.armedActionCards = [{ cardId: 'secret-facility', probeSystemId: SYS, armedAt: 3 }];
  return G;
}

/** Exactly what codec.decode() does to these two fields: fresh objects,
 *  equal by value, distinct by reference. */
const roundTrip = (G) => {
  G.empire.armedActionCards = JSON.parse(JSON.stringify(G.empire.armedActionCards));
  if (G.pendingArmedReveals) G.pendingArmedReveals = JSON.parse(JSON.stringify(G.pendingArmedReveals));
};

/** Drive one Empire Command-turn-start reveal to completion. */
function revealOnce(G) {
  phases.offerArmedRevealsAtCommandStart(G);
  if (G.pendingChoice?.kind !== 'ArmedCardRevealOffer') return false;
  roundTrip(G); // <-- the save/resume that used to break the disarm
  phases.resolveArmedCardRevealOffer(G, true);
  // RoE units in play → the Empire picks Stormtrooper vs Assault Tank.
  if (G.pendingChoice?.kind === 'SecretFacilityUnitPick') {
    phases.resolveSecretFacilityUnitPick(G, G.pendingChoice.candidates[0]);
  }
  return true;
}

console.log('[ #644 — an armed card can only ever be revealed once ]');
{
  const G = armedGame();

  check('turn A: the reveal offer is posted', revealOnce(G));
  check('turn A: one Shield Bunker placed', countDeploys(G, 'shield-bunker') === 1,
    `n=${countDeploys(G, 'shield-bunker')}`);
  check('turn A: the card is DISARMED despite the codec round-trip',
    stillArmed(G) === 0, `armed=${JSON.stringify(G.empire.armedActionCards)}`);
  check('turn A: discarded exactly once', countDiscards(G) === 1, `n=${countDiscards(G)}`);

  // The Empire's NEXT Command turn — this is where the report's second pair
  // of units came from.
  G.pendingChoice = undefined;
  const offeredAgain = revealOnce(G);
  check('turn B: no second offer', offeredAgain === false);
  check('turn B: still only one Shield Bunker', countDeploys(G, 'shield-bunker') === 1,
    `n=${countDeploys(G, 'shield-bunker')}`);
  check('turn B: still only one triangle ground unit',
    countDeploys(G, 'stormtrooper') + countDeploys(G, 'assault-tank') === 1,
    `n=${countDeploys(G, 'stormtrooper') + countDeploys(G, 'assault-tank')}`);
  check('turn B: still discarded exactly once', countDiscards(G) === 1, `n=${countDiscards(G)}`);
}

// Belt and braces: even a hand-crafted STALE offer (a queue entry for a card
// that is already spent) must not resolve a second time.
{
  const G = armedGame();
  revealOnce(G);
  const stale = { cardId: 'secret-facility', probeSystemId: SYS, armedAt: 3 };
  G.pendingArmedReveals = { phase: 'command-start', remaining: [stale] };
  G.pendingChoice = { kind: 'ArmedCardRevealOffer', side: 'Empire', cardId: 'secret-facility', systemId: SYS };
  phases.resolveArmedCardRevealOffer(G, true);
  check('a stale offer for a spent card is a no-op', countDeploys(G, 'shield-bunker') === 1,
    `n=${countDeploys(G, 'shield-bunker')}`);
  check('a stale offer does not re-discard the card', countDiscards(G) === 1, `n=${countDiscards(G)}`);
}

// Declining must NOT disarm — "you may reveal" keeps it for a later turn.
{
  const G = armedGame();
  phases.offerArmedRevealsAtCommandStart(G);
  roundTrip(G);
  phases.resolveArmedCardRevealOffer(G, false);
  check('declining keeps the card armed', stillArmed(G) === 1,
    `armed=${JSON.stringify(G.empire.armedActionCards)}`);
  check('declining places nothing', countDeploys(G, 'shield-bunker') === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
