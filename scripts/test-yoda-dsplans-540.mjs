// #540 — "I was not able to use Luke's Yoda ring on Death Star Plans."
// Two engine defects conspired:
//   1. The DSP Yoda window was gated on the roll containing a BLANK — but the
//      ring text is "reroll 1 of your dice" and on a DSP roll only ✶
//      (direct-hit) succeeds, so a hit/special/hit roll is all duds yet got no
//      offer. Gate is now "no direct-hit yet" with every die a candidate.
//   2. (covered in test-yoda-skip-305) SKIPPING the combat-context Yoda offer
//      burned the once-per-game-round ring, so a player saving it for the DSP
//      roll lost it silently.
// Plus: when the ring IS spent, the DSP flow now says so (log + notice)
// instead of silently offering nothing.
// Run: node scripts/test-yoda-dsplans-540.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const SYS = 'corellia';
// Build a game where Luke holds the Yoda ring at SYS, an Empire Death Star sits
// there, and the DSP attempt choice is pending. `spent` pre-burns the ring.
function setup(seed, { spent = false } = {}) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true } });
  G.map.systems[SYS].units = [
    { instanceId: 'ds1', typeId: 'death-star', side: 'Empire', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
  ];
  M.placeLeader(G, 'Rebel', 'luke-skywalker', SYS);
  M.attachRing(G, 'luke-skywalker', 'yoda');
  // No One-in-a-Million in hand — isolate the Yoda window.
  G.rebel.actionHand = (G.rebel.actionHand ?? []).filter((c) => c !== 'one-in-a-million');
  G.yodaRerollUsedThisRound = spent;
  G.pendingChoice = {
    kind: 'DeathStarPlansAttempt', side: 'Rebel',
    objectiveId: 'death-star-plans-2', systemId: SYS, deathStarInstanceIds: ['ds1'],
  };
  return G;
}

console.log('[ #540 — Yoda ring on the Death Star Plans roll ]');
// Seed-scan the 3-dice roll into its three shapes and assert each behavior.
let sawNoBlankOffer = false;   // no blank, no direct-hit → offer MUST fire (the fix)
let sawBlankOffer = false;     // blank present → offer fires (old behavior retained)
let sawDirectHitNoOffer = false; // already successful → no offer
let rerolledNonBlank = false;  // resolving with a NON-blank index works
for (let seed = 1; seed <= 80 && !(sawNoBlankOffer && sawBlankOffer && sawDirectHitNoOffer && rerolledNonBlank); seed++) {
  const G = setup(seed);
  const r = combat.resolveDeathStarPlansAttempt(G, true, 'ds1');
  if (!r.ok) continue;
  const d = G.dsPlansAttempt;
  const offered = G.pendingChoice?.kind === 'YodaReroll' && G.pendingChoice.context === 'dsplans';
  if (!d) {
    // Attempt finalized immediately: only legitimate when it already succeeded.
    if (!sawDirectHitNoOffer && !offered) sawDirectHitNoOffer = true;
    continue;
  }
  const faces = d.faces;
  const hasBlank = faces.includes('blank');
  const hasDH = faces.includes('direct-hit');
  if (hasDH) {
    if (!offered) sawDirectHitNoOffer = true;
  } else if (!hasBlank) {
    if (offered) {
      sawNoBlankOffer = true;
      check('no-blank offer lists EVERY die as a candidate', G.pendingChoice.blankIndices.length === faces.length, `cands=${G.pendingChoice.blankIndices.length}`);
      // Resolve by rerolling a NON-blank die (index 0 — guaranteed non-blank here).
      const before = faces[0];
      const rr = combat.resolveDsPlansYoda(G, 0);
      const ev = (G.turnLog ?? []).filter((e) => e.kind === 'yoda-reroll').pop();
      if (rr.ok && ev?.payload?.oldFace === before) rerolledNonBlank = true;
      check('non-blank reroll resolves + spends the ring', rr.ok && G.yodaRerollUsedThisRound === true, rr.reason);
    }
  } else {
    if (offered) sawBlankOffer = true;
  }
}
check('roll with NO blanks (and no ✶) still gets the Yoda offer', sawNoBlankOffer);
check('roll WITH blanks gets the offer (unchanged)', sawBlankOffer);
check('already-successful roll (✶ present) gets NO offer', sawDirectHitNoOffer);
check('a non-blank die was rerolled successfully', rerolledNonBlank);

console.log('\n[ #540 — spent ring is EXPLAINED, not silent ]');
{
  // Ring pre-spent this game round: no offer, but a log event + Rebel notice.
  let explained = false, noOffer = true;
  for (let seed = 1; seed <= 40 && !explained; seed++) {
    const G = setup(seed, { spent: true });
    combat.resolveDeathStarPlansAttempt(G, true, 'ds1');
    if (G.pendingChoice?.kind === 'YodaReroll') { noOffer = false; break; }
    const logged = (G.turnLog ?? []).some((e) => e.kind === 'yoda-reroll-unavailable');
    const noticed = (G.pendingNotices ?? []).some((n) => n.id.startsWith('yoda-spent-dsp'));
    // Rolls that immediately succeed (✶) don't need the explanation — scan on.
    if (logged && noticed) explained = true;
  }
  check('spent ring → no Yoda offer', noOffer);
  check('spent ring → yoda-reroll-unavailable logged + Rebel notice pushed', explained);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
