// jocke01: "The empire always uses 'gather intel' regardless of the amount of
// units on the rebel base... on the first turn it's such a waste to send
// palpatine on this mission. He could either a) move a fleet to subjugate a
// rebel planet ... or b) oppose mothmas build alliance."
//
// Running Gather Intel early is deliberate and evidence-backed (the mission
// table notes human Empire wins depend on two probe-draw missions in T1+T2 to
// set up the subjugation search), so the mission choice is NOT what changed.
// Who gets sent on it is.
//
// planAssignment ranked leaders by skill fit and greedily took the best. Gather
// Intel costs 1 intel icon; the turn-1 Empire pool is Vader (0 intel),
// Palpatine (2), Tagge (0), Tarkin (1) — so Tarkin alone covers it, but
// fit-order sent Palpatine, the best activator on the board, in 60 of 60
// measured games. The Empire also reserves 3 leaders, so from a pool of 4 that
// is the ENTIRE turn's assignment: the one leader it commits is the one the
// Command phase most wants back.
//
// The planner now compares equally-sized leader sets by opportunity cost —
// tactic total, since RAW gates activating a system on having tactic values at
// all — while leaving portrait/bespoke pairings free to outvote it.
//
// Run: node scripts/test-assign-opportunity-cost.mjs
//   Counterfactual: SWR_ASSIGN_OPP=0 node scripts/test-assign-opportunity-cost.mjs
//   must FAIL — that flag restores pure best-skill-first staffing.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const game = (seed) => {
  ai.seedAI(seed);
  return createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true } });
};

/** Step the AI until the Empire's first leader assignment is logged. */
function firstEmpireAssignment(G) {
  let guard = 0;
  while (!G.isGameOver && guard++ < 400) {
    const before = G.turnLog.length;
    const side = G.currentPlayer;
    if (!ai.stepOnce(G, side)) {
      const o = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (!ai.stepOnce(G, o)) break;
    }
    for (const e of G.turnLog.slice(before)) {
      if (e.kind === 'assign-leader' && e.side === 'Empire') return e;
    }
    if (G.timeMarker > 1) break; // past turn 1 — no assignment happened
  }
  return null;
}

const tactics = (G, lid) => {
  const l = G.catalog.leaders[lid];
  return (l?.tacticValues.space ?? 0) + (l?.tacticValues.ground ?? 0);
};
const intelOf = (G, lid) => G.catalog.leaders[lid]?.skills.intel ?? 0;

console.log('\n[ the setup is the one from the report ]');
{
  const G = game(1);
  const pool = G.empire.leaderPool;
  check('turn-1 pool holds both Palpatine and a cheaper adequate leader',
    pool.includes('emperor-palpatine') && pool.includes('grand-moff-tarkin'), pool.join(','));
  check('Gather Intel costs a single intel icon',
    G.catalog.missions['gather-intel'].skillCost === 1);
  check('Tarkin alone satisfies it', intelOf(G, 'grand-moff-tarkin') >= 1);
  check('Palpatine is the better activator (so spending him is the waste)',
    tactics(G, 'emperor-palpatine') > tactics(G, 'grand-moff-tarkin'),
    `palp=${tactics(G, 'emperor-palpatine')} tarkin=${tactics(G, 'grand-moff-tarkin')}`);
}

console.log('\n[ the bug: turn 1 must not spend the best activator on a 1-icon mission ]');
{
  let assigned = 0, usedPalpatine = 0, adequate = 0;
  const SEEDS = 25;
  for (let s = 1; s <= SEEDS; s++) {
    const G = game(s);
    const e = firstEmpireAssignment(G);
    if (!e) continue;
    assigned++;
    const ls = e.payload.leaderIds ?? [];
    if (ls.includes('emperor-palpatine')) usedPalpatine++;
    // Whoever went must still be able to do the job.
    const cost = G.catalog.missions[e.payload.missionId]?.skillCost ?? 0;
    const fit = ls.reduce((a, l) => a + (G.catalog.leaders[l]?.skills[
      G.catalog.missions[e.payload.missionId]?.skill] ?? 0), 0);
    if (fit >= cost) adequate++;
  }
  check('the Empire still makes a turn-1 assignment', assigned === SEEDS, `${assigned}/${SEEDS}`);
  check('the assigned leaders still meet the mission cost', adequate === assigned,
    `${adequate}/${assigned}`);
  check('Palpatine is no longer sent on it', usedPalpatine === 0,
    `used in ${usedPalpatine}/${assigned} games`);
}

console.log('\n[ control: when only Palpatine can do the job, he still goes ]');
{
  // Leave Palpatine as the ONLY intel-capable leader. If the change were a
  // blanket "never use the good leader" it would strand the mission here.
  //
  // The pool has to stay bigger than EMPIRE_RESERVE_LEADERS (3) or the planner
  // stops before assigning anything at all — filtering the 4-leader starting
  // pool down to 3 makes the Empire skip the phase for an unrelated reason and
  // the control passes/fails on nothing. So pad it back out with leaders that
  // have no intel and cannot take the mission.
  const PADDING = ['general-veers', 'motti', 'moff-jerjerrod', 'general-tagge'];
  let sent = 0, tried = 0;
  for (let s = 1; s <= 10; s++) {
    const G = game(s);
    const keep = G.empire.leaderPool.filter(
      (lid) => lid === 'emperor-palpatine' || intelOf(G, lid) === 0);
    for (const p of PADDING) {
      if (keep.length >= 5) break;
      if (G.catalog.leaders[p] && intelOf(G, p) === 0 && !keep.includes(p)) keep.push(p);
    }
    G.empire.leaderPool = keep;
    // Since SWR_EMPIRE_CALIB (2026-09-04) the Empire keeps ~56% of its pool back
    // for the Command phase and Gather Intel is no longer the runaway top value,
    // so with the full starting hand the planner may legitimately spend its one
    // or two slots on Rule by Fear / Capture with the padding leaders and hold
    // Palpatine for activations — which is what the recorded humans do. The
    // control's question is narrower: when the ONLY mission on offer needs him,
    // is he still sent? So the hand is just Gather Intel here.
    G.empire.missionHand = ['gather-intel'];
    if (!keep.includes('emperor-palpatine') || keep.length <= 3) continue;
    if (keep.some((lid) => lid !== 'emperor-palpatine' && intelOf(G, lid) > 0)) continue;
    tried++;
    const e = firstEmpireAssignment(G);
    if (e && (e.payload.leaderIds ?? []).includes('emperor-palpatine')) sent++;
  }
  check('Palpatine is still used when nobody else has the skill', tried > 0 && sent === tried,
    `${sent}/${tried}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
