// #521 — the Master Yoda ring reroll is "Once per GAME round" (mission card
// text). A single combat can span several combat rounds; the reroll must be
// offered/used AT MOST ONCE across the whole game round, not once per combat
// round. Regression: combat.ts reset the global once-per-round flag at each
// combat-round boundary, so a Rebel who rerolled in combat round 1 was offered
// the reroll AGAIN in combat round 2.
// Run: node scripts/test-yoda-once-per-round-521.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const opts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, roeUnits: true }, // standard (non-cinematic) combat
});

// Find a seed where: (a) Yoda is offered+used in combat round 1, and (b) the
// combat survives into round 2 (so the bug would re-offer). Then assert the
// reroll is offered AT MOST ONCE for the whole combat.
let scenarioFound = false, yodaOffers = 0, reachedRound2 = false;
for (let s = 500; s < 700 && !scenarioFound; s++) {
  const G = createGame(data, opts(s));
  G.map.systems['felucia'].units = [];
  // Big stacks on both sides so combat lasts multiple rounds.
  for (let i = 0; i < 12; i++) M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  for (let i = 0; i < 12; i++) M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.placeLeader(G, 'Rebel', 'luke-skywalker', 'felucia');
  M.attachRing(G, 'luke-skywalker', 'yoda');
  combat.beginCombat(G, 'Rebel', 'kashyyyk', 'felucia');
  combat.runCombat(G);

  let localOffers = 0, localReachedR2 = false, usedInR1 = false, maxRoundSeen = 0;
  let guard = 0;
  while (G.pendingCombat && guard++ < 400) {
    if (G.pendingCombat.round > maxRoundSeen) maxRoundSeen = G.pendingCombat.round;
    if (G.pendingCombat.round >= 2) localReachedR2 = true;
    // Machine stalled without a pending choice (some resolvers don't self-nudge) — advance it.
    if (!G.pendingChoice) { combat.runCombat(G); continue; }
    const pc = G.pendingChoice;
    if (pc.kind === 'YodaReroll' && pc.context === 'combat') {
      localOffers++;
      // Reroll the first blank die if there is one, else skip.
      const pa = G.pendingCombat.pendingAttack;
      const blank = pa?.dice?.findIndex((d) => d.face === 'blank') ?? -1;
      // Only an ACTUAL reroll spends the once-per-GAME-round power. Declining
      // deliberately does not (#540: "you may reroll" — players save it for the
      // Death Star Plans roll later in the same combat), so a round-1 offer that
      // we SKIP leaves the power available and round 2 is then correctly offered
      // it again. This flag used to be set on the offer rather than the use, so
      // whether the test passed depended on whether the scanned seed happened to
      // roll a blank in round 1 — any change upstream that shifts the RNG stream
      // could land it on a declining seed and "fail" on correct behaviour.
      if (G.pendingCombat.round === 1 && blank >= 0) usedInR1 = true;
      combat.resolveYodaReroll(G, blank >= 0 ? blank : null);
      continue;
    }
    if (pc.kind === 'SpecialDieSpend') { combat.resolveSpecialDieSpend(G, { draws: 0, playCardIds: [] }); continue; }
    if (pc.kind === 'CombatAddLeaderPick') { combat.resolveCombatAddLeaderPick(G, null); continue; }
    if (pc.kind === 'CombatStartActionCards') { combat.resolveCombatStartActionCards(G, []); continue; }
    if (pc.kind === 'CombatAttackerTactics') { combat.resolveCombatAttackerTactics(G, { damageBoostCardIds: [] }); continue; }
    if (pc.kind === 'CombatDefenderTactics') { combat.resolveCombatDefenderTactics(G, { blockCardIds: [], sacrificeCardIds: [] }); continue; }
    if (pc.kind === 'OneInAMillionOffer') { combat.resolveOneInAMillionCombat(G, []); continue; }
    if (pc.kind === 'CombatAssignDamage') {
      const out = pc.targetsByHit.map((t) => t[0] ?? null);
      combat.resolveCombatAssignDamage(G, out); continue;
    }
    if (pc.kind === 'RetreatDecision') { combat.resolveRetreatDecision(G, null, null); continue; }
    break;
  }
  // We want a run that used Yoda in round 1 AND reached round 2 — that's the
  // configuration the bug corrupts.
  if (usedInR1 && localReachedR2) {
    scenarioFound = true;
    yodaOffers = localOffers;
    reachedRound2 = localReachedR2;
  }
}

console.log('\n[ #521 Master Yoda ring — once per GAME round, not per combat round ]');
check('found a multi-round combat that used Yoda in round 1', scenarioFound,
  'no seed produced a combat that both used Yoda in round 1 and reached round 2');
check('combat reached round 2', reachedRound2);
check('Yoda reroll offered at most once for the whole combat', yodaOffers <= 1,
  `offered ${yodaOffers} times`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
