// #314/#310 — RoE games no longer freeze. Two fixes:
//  1. An Immediate action card recruited during Refresh (e.g. Sweep the Area)
//     fires and posts a sub-choice (ArmCardProbePick) that now RESUMES the
//     recruit/refresh flow via the viaRecruit tag — previously it stranded the
//     Refresh phase with no prompt.
//  2. The AI builds a transport-VALID Behind Enemy Lines selection (ground needs
//     carrier capacity), so it can't reject its own pick and stall.
// Run: node scripts/test-roe-refresh-freeze-314.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

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

const roe = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });

console.log('\n[ #314 recruiting an Immediate "arm-a-probe" card during Refresh resumes the flow ]');
{
  const G = createGame(data, roe(101));
  // Stage an Empire Refresh recruit whose kept card is Sweep the Area (Immediate).
  G.phase = 'Refresh';
  G.timeMarker = 2;
  // Give the Empire a probe to arm + the recruit pick.
  G.empire.probeHand = ['probe-tatooine'];
  G.refreshPaused = { logStart: 0, pendingBuildPicks: [], pendingRecruitPicks: [
    { side: 'Empire', drawnIds: ['sweep-the-area', 'public-support'] },
  ] };
  G.pendingChoice = { kind: 'RecruitActionCardPick', side: 'Empire',
    drawnIds: ['sweep-the-area', 'public-support'], canDrawMore: false };

  const r1 = phases.resolveRecruitActionCardPick(G, 'sweep-the-area');
  check('keep Sweep the Area ok', r1.ok, r1.reason);
  check('Immediate fired → ArmCardProbePick posted, tagged viaRecruit',
    G.pendingChoice?.kind === 'ArmCardProbePick' && G.pendingChoice.viaRecruit === true,
    `pc=${G.pendingChoice?.kind} via=${G.pendingChoice?.viaRecruit}`);

  const r2 = phases.resolveArmCardProbePick(G, 'probe-tatooine');
  check('resolve arm-probe ok', r2.ok, r2.reason);
  // The recruit/refresh flow resumed instead of dead-stopping: either it ran to
  // Assignment, or it paused on a LATER refresh step (build/deploy) — not a
  // stranded Refresh with no prompt (the bug).
  const refreshContinued = G.phase === 'Assignment'
    || ['BuildPick', 'DeployUnitPick', 'RecruitActionCardPick', 'HandLimitDiscard',
        'LeaderPoolEliminate', 'AmbitionsOfPowerOffer'].includes(G.pendingChoice?.kind);
  check('recruit/refresh flow resumed (not stranded with no prompt)',
    refreshContinued, `phase=${G.phase} pc=${G.pendingChoice?.kind}`);
}

console.log('\n[ #314 smoke: full RoE games drive to completion with no freeze ]');
{
  let over = 0, stuck = 0;
  const reasons = {};
  for (let s = 1; s <= 25; s++) {
    const G = createGame(data, roe(s));
    let guard = 0;
    while (!G.isGameOver && guard++ < 8000) {
      let did = false;
      for (const side of ['Rebel', 'Empire']) { if (stepOnce(G, side)) { did = true; break; } }
      if (!did) { stuck++; const k = `${G.phase}/${G.pendingChoice?.kind ?? 'none'}`; reasons[k] = (reasons[k] || 0) + 1; break; }
    }
    if (G.isGameOver) over++;
  }
  check('25 RoE games, 0 stuck', stuck === 0, `stuck=${stuck} reasons=${JSON.stringify(reasons)}`);
  check('all 25 reached game over', over === 25, `finished=${over}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
