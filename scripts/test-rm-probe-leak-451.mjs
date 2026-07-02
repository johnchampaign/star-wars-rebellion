// #451 — Rapid Mobilization leaked the Rebel's PRIVATE probe draw into the
// EMPIRE'S probe hand (M.drawProbe is the Empire Refresh helper), and the
// unused cards were then returned to the deck WITHOUT leaving the hand —
// duplicating them. Player report: the Empire held "pretty much all the probe
// cards" by round 2 with the AI Rebel playing RM every round.
// Also: codec.decode now repairs saves corrupted by the old bug.
// Run: node scripts/test-rm-probe-leak-451.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { encode, decode } = await import('../src/engine/codec.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

console.log('\n[ #451 the RM probe draw is PRIVATE — nothing enters the Empire hand ]');
{
  const G = createGame(data, { seed: 31, autoSetupUnits: true });
  const handBefore = [...(G.empire.probeHand ?? [])];
  const deckBefore = [...G.probeDeck];
  // Stage an RM establish-base branch directly.
  G.pendingRapidMobilizations = [{ twoLeaders: false }];
  G.pendingChoice = { kind: 'RapidMobilizationBranch', side: 'Rebel', twoLeaders: false, baseRevealed: false, moveUnitsAvailable: true };
  const r = phases.resolveRapidMobilizationBranch(G, 'establish-base');
  check('branch resolves ok', r.ok, r.reason);
  check('Empire probe hand UNCHANGED by the Rebel draw',
    JSON.stringify(G.empire.probeHand ?? []) === JSON.stringify(handBefore),
    `before=${handBefore.length} after=${(G.empire.probeHand ?? []).length}`);

  if (G.pendingChoice?.kind === 'RapidMobilizationBasePick') {
    const pc = G.pendingChoice;
    check('4 cards drawn for the look', pc.drawnProbeIds.length === 4, `${pc.drawnProbeIds.length}`);
    const r2 = phases.resolveRapidMobilizationBasePick(G, pc.probeSystemIds[0]);
    check('base pick resolves ok', r2.ok, r2.reason);
    // Conservation across ALL zones (deck + Empire hand + the one card under
    // the base). Note the RM continuation runs into Refresh, whose step 3
    // legitimately draws 2 probes to the Empire — so we can't assert on the
    // raw deck count; we assert total conservation and no duplication.
    const deckNow = G.probeDeck;
    const handNow = G.empire.probeHand ?? [];
    check('total probe cards conserved across deck + hand + base card',
      deckNow.length + handNow.length + 1 === deckBefore.length + handBefore.length + 1
        + 0 /* nothing created or destroyed */,
      `deck=${deckNow.length} hand=${handNow.length} (before deck=${deckBefore.length} hand=${handBefore.length})`);
    const all = [...deckNow, ...handNow];
    check('no duplicate probe ids across deck + hand', new Set(all).size === all.length);
    const baseCard = Object.values(G.catalog.probes).find((p) => p.systemId === G.rebelBaseSystemId)?.id;
    check('the new base card is out of circulation', !!baseCard && !all.includes(baseCard), baseCard);
  } else {
    // Legal-candidate shortage path: everything returns to the deck.
    check('(no-candidate path) deck fully restored', G.probeDeck.length === deckBefore.length,
      `pc=${G.pendingChoice?.kind}`);
  }
}

console.log('\n[ #451 decode() repairs a save corrupted by the old leak ]');
{
  const G = createGame(data, { seed: 32, autoSetupUnits: true });
  // Corrupt it the way the old bug did: three deck cards duplicated into the
  // Empire hand, one in-hand duplicate, and the hidden base's card in hand.
  const dupes = G.probeDeck.slice(0, 3);
  const baseCard = Object.values(G.catalog.probes).find((p) => p.systemId === G.rebelBaseSystemId)?.id;
  G.empire.probeHand = [...dupes, dupes[0], baseCard].filter(Boolean);
  const G2 = decode(encode(G), G.catalog);
  check('deck-duplicated cards removed from the hand',
    !(G2.empire.probeHand ?? []).some((pid) => G2.probeDeck.includes(pid)),
    JSON.stringify(G2.empire.probeHand));
  check('hidden base card removed from the hand', !(G2.empire.probeHand ?? []).includes(baseCard));
  check('hand fully cleaned in this constructed case', (G2.empire.probeHand ?? []).length === 0,
    JSON.stringify(G2.empire.probeHand));
  // A legitimate hand card (in hand, NOT in deck) survives decode.
  const G3 = createGame(data, { seed: 33, autoSetupUnits: true });
  const legit = G3.probeDeck.shift();
  G3.empire.probeHand = [legit];
  const G4 = decode(encode(G3), G3.catalog);
  check('a legitimate hand card survives the repair', (G4.empire.probeHand ?? []).includes(legit));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
