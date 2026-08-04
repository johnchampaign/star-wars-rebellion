// #685 — RoE rulebook p.4: the Imperial player places starting units "in any
// systems that have an Imperial loyalty marker, subjugation marker, or a Death
// Star Under Construction". The remote-system deploy target therefore exists
// ONLY to hold the DSUC — and the DSUC only appears when setup hands out the
// RoE starting roster (`roeUnits && !baseSetupUnits`, per pickStartingUnits).
//
// The bug: setupDeployUnit gated the remote branch on `!baseSetupUnits` alone,
// so a game with the expansion ON but RoE UNITS OFF (base roster: a real Death
// Star, no DSUC) still let the Empire claim a remote system and deploy there.
// The reporter's game ended with an Imperial stormtrooper on neutral Dagobah.
// Run: node scripts/test-setup-remote-needs-dsuc-685.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const REMOTE = 'dagobah'; // a remote (neutral, no loyalty space) system

/** A game in the interactive Setup phase with `expansion`, ready for Empire
 *  setup deploys (autoSetupUnits:false is what fills pendingDeployment). */
const setup = (expansion) => createGame(data, { seed: 4, expansion, autoSetupUnits: false });

/** Try to deploy `typeId` to the remote system, whatever is still pending. */
const tryRemote = (G, typeId) => {
  if (!G.pendingDeployment.Empire.includes(typeId)) G.pendingDeployment.Empire.push(typeId);
  return phases.setupDeployUnit(G, 'Empire', typeId, REMOTE);
};

console.log('\n[ #685 the reporter\'s config: expansion ON, RoE units OFF -> no DSUC, no remote ]');
{
  // Exactly the reported state: enabled + roeUnits:false + baseSetupUnits:false.
  const G = setup({ enabled: true, roeUnits: false, roeMissions: true, cinematicCombat: true, baseSetupUnits: false });
  check('setup handed out a base-game Death Star, not a DSUC',
    !G.pendingDeployment.Empire.includes('death-star-under-construction'),
    JSON.stringify(G.pendingDeployment.Empire.filter((t) => t.startsWith('death-star'))));
  const r = tryRemote(G, 'stormtrooper');
  check('stormtrooper CANNOT be deployed to a neutral remote system', !r.ok, JSON.stringify(r));
  check('rejected for the right reason', r.reason === 'must-be-imperial-or-subjugated', r.reason);
  const ds = tryRemote(G, 'death-star');
  check('Death Star CANNOT be deployed to a neutral remote system either', !ds.ok, JSON.stringify(ds));
  check('no remote deploy target was claimed', !G.empireDeployTarget, String(G.empireDeployTarget));
  check('nothing Imperial ended up on the remote system',
    (G.map.systems[REMOTE]?.units ?? []).filter((u) => u.side === 'Empire').length === 0);
}

console.log('\n[ #685 regression guard: a real RoE game still gets its remote DSUC site ]');
{
  const G = setup({ enabled: true, roeUnits: true, roeMissions: true, baseSetupUnits: false });
  check('setup handed out a DSUC', G.pendingDeployment.Empire.includes('death-star-under-construction'),
    JSON.stringify(G.pendingDeployment.Empire.filter((t) => t.startsWith('death-star'))));
  const r = tryRemote(G, 'death-star-under-construction');
  check('DSUC deploys to the remote system', r.ok, JSON.stringify(r));
  check('the remote became the Empire deploy target', G.empireDeployTarget === REMOTE, String(G.empireDeployTarget));
}

console.log('\n[ #685 the pre-existing #523 case still holds: base setup units -> no remote ]');
{
  const G = setup({ enabled: true, roeUnits: true, roeMissions: true, baseSetupUnits: true });
  const r = tryRemote(G, 'stormtrooper');
  check('stormtrooper rejected from the remote system', !r.ok, JSON.stringify(r));
  check('no remote deploy target claimed', !G.empireDeployTarget, String(G.empireDeployTarget));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
