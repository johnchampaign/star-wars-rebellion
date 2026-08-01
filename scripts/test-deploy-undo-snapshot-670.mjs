// #670 — "Deployment during the unit deployment phase can no longer be undone.
// It's now one-click-and-done, which is prone to misclicks."
//
// The Refresh deploy step (units coming off the build queue) had no undo. The
// Setup undo mechanism could not be reused: codec encode() strips
// pendingChoice / pendingMission / pendingCombat / refreshPaused, so a snapshot
// taken mid-DeployUnitPick would discard refreshPaused.pendingDeployPicks —
// the queue of units still to place — and restoring it would silently drop the
// rest of the deployment.
//
// This pins the structuredClone-based snapshot used instead, and specifically
// that it does NOT reintroduce issue #29 (two unit instances sharing an
// instanceId). #29 happened because the module-level id counter RESET on page
// reload while saved units kept higher ids. An in-session clone/restore only
// ever leaves the counter AHEAD of the restored state, which cannot collide.
//
// Run: node scripts/test-deploy-undo-snapshot-670.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

// The snapshot helpers the UI will use. `catalog` is shared, immutable and
// large, so it is detached rather than cloned.
const snapshotGame = (g) => { const { catalog, ...rest } = g; void catalog; return structuredClone(rest); };
const restoreGame = (snap, catalog) => ({ ...structuredClone(snap), catalog });

/** Every instanceId on the board + base space, so duplicates are detectable. */
function allInstanceIds(G) {
  const ids = [];
  for (const ss of Object.values(G.map.systems)) for (const u of ss.units) ids.push(u.instanceId);
  for (const u of G.map.rebelBaseSpace?.units ?? []) ids.push(u.instanceId);
  return ids;
}
const dupes = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);

/** Drive a fresh game to a Rebel DeployUnitPick in the Refresh phase. */
function toDeployPick(seed) {
  const G = createGame(data, { seed, roeUnits: true, roeMissions: true });
  M.buildToQueue(G, 'Rebel', 'rebel-trooper', 1);
  M.buildToQueue(G, 'Rebel', 'x-wing', 1);
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  phases.pass(G, 'Rebel'); phases.pass(G, 'Empire');
  // Turn 2 carries a recruit icon as well as a build icon, so answer whatever
  // the Refresh puts up until the deploy step is reached.
  for (let i = 0; i < 40 && G.pendingChoice && G.pendingChoice.kind !== 'DeployUnitPick'; i++) {
    const pc = G.pendingChoice;
    if (pc.kind === 'RecruitActionCardPick') { phases.resolveRecruitActionCardPick(G, pc.drawnIds[0]); continue; }
    if (pc.kind === 'BuildPick') {
      // Decline every build slot — we only need to reach the deploy step.
      phases.resolveBuildPicks(G, (pc.picks ?? []).map(() => ''));
      continue;
    }
    break;
  }
  return G;
}

console.log('\n[ a mid-choice state can be snapshotted and restored ]');
{
  const G = toDeployPick(670);
  check('reached a DeployUnitPick', G.pendingChoice?.kind === 'DeployUnitPick',
    `pendingChoice=${G.pendingChoice?.kind ?? 'none'}`);

  const snap = snapshotGame(G);
  check('the pending choice survives the snapshot', snap.pendingChoice?.kind === 'DeployUnitPick',
    'codec encode() drops this — that is why it could not be reused');
  check('the remaining deploy queue survives the snapshot',
    (snap.refreshPaused?.pendingDeployPicks?.length ?? 0) > 0,
    'restoring without this would silently drop the rest of the deployment');

  const target = G.pendingChoice.candidates[0];
  const before = allInstanceIds(G).length;
  const r = phases.resolveDeployUnitPick(G, target);
  check('the deploy resolves', r.ok, r.reason);
  check('a unit reached the board', allInstanceIds(G).length === before + 1);

  // Undo: restore the snapshot.
  const restored = restoreGame(snap, G.catalog);
  check('undo returns to the pending choice', restored.pendingChoice?.kind === 'DeployUnitPick');
  check('undo removes the deployed unit', allInstanceIds(restored).length === before,
    `${allInstanceIds(restored).length} vs ${before}`);
  check('undo keeps the catalog usable', !!restored.catalog?.unitTypes?.['rebel-trooper']);
}

console.log('\n[ #29: redeploying after an undo cannot collide on instanceId ]');
{
  const G = toDeployPick(670);
  check('reached a DeployUnitPick', G.pendingChoice?.kind === 'DeployUnitPick',
    `pendingChoice=${G.pendingChoice?.kind ?? 'none'}`);
  const snap = snapshotGame(G);
  const idsBefore = new Set(allInstanceIds(G));
  const newIdIn = (g) => allInstanceIds(g).filter((id) => !idsBefore.has(id));

  // Place it once, undo, then place the SAME unit somewhere else — the path
  // that would reuse an id if the counter ever rewound.
  const r1 = phases.resolveDeployUnitPick(G, G.pendingChoice.candidates[0]);
  check('first deploy resolves', r1.ok, r1.reason);
  const firstId = newIdIn(G)[0];

  const G2 = restoreGame(snap, G.catalog);
  check('undo restored a live DeployUnitPick', G2.pendingChoice?.kind === 'DeployUnitPick',
    `pendingChoice=${G2.pendingChoice?.kind ?? 'none'}`);
  const c2 = G2.pendingChoice.candidates;
  const r2 = phases.resolveDeployUnitPick(G2, c2[c2.length > 1 ? 1 : 0]);
  check('the redeploy resolves after undo', r2.ok, r2.reason);

  const ids = allInstanceIds(G2);
  check('no duplicate instanceIds after undo + redeploy', dupes(ids).length === 0,
    `dupes=${JSON.stringify(dupes(ids))}`);
  const secondId = newIdIn(G2)[0];
  check('the new unit got a FRESH id, not the rolled-back one',
    !!firstId && !!secondId && secondId !== firstId,
    `first=${firstId} second=${secondId} — the module counter must not rewind`);
}

console.log('\n[ repeated undo/redeploy stays collision-free ]');
{
  const G = toDeployPick(672);
  let cur = G;
  const snap = snapshotGame(G);
  for (let i = 0; i < 5; i++) {
    cur = restoreGame(snap, G.catalog);
    const c = cur.pendingChoice.candidates;
    phases.resolveDeployUnitPick(cur, c[i % c.length]);
  }
  const ids = allInstanceIds(cur);
  check('still no duplicate instanceIds after 5 undo/redeploy cycles',
    dupes(ids).length === 0, `dupes=${JSON.stringify(dupes(ids))}`);
  check('board is not accumulating phantom units',
    ids.length === allInstanceIds(restoreGame(snap, G.catalog)).length + 1,
    'each restore should discard the previous placement');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
