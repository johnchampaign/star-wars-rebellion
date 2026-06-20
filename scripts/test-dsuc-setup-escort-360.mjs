// Issue #360 — RoE setup (rulebook p.8): the Imperial player "chooses any
// remote system and places 4 TIE Fighters, 1 Stormtrooper, and 1 Death Star
// Under Construction in that system." The interactive setup let the player drop
// the DSUC alone on a remote and finish with no escort there. Placing the DSUC
// must now auto-deploy its fixed 4 TIE + 1 Stormtrooper escort to the same
// remote, and only the DSUC may not finish setup without them.
// Run: node scripts/test-dsuc-setup-escort-360.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

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

const newGame = (seed) => {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true }, autoSetupUnits: false });
  return G;
};
const countAt = (G, sysId, typeId) =>
  (G.map.systems[sysId]?.units ?? []).filter((u) => u.side === 'Empire' && u.typeId === typeId).length;
const aRemote = (G) => Object.keys(G.map.systems).find((id) => G.catalog.systems[id]?.isRemote
  && !G.map.systems[id]?.destroyed);

console.log('\n[ #360 placing the DSUC alone auto-deploys its 4 TIE + 1 Stormtrooper escort ]');
{
  const G = newGame(11);
  if (!G.pendingDeployment) { check('interactive setup produced a pending deployment', false, 'no pendingDeployment'); }
  else {
    const remote = aRemote(G);
    const r = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
    check('DSUC placement accepted', r.ok, r.reason);
    check('DSUC present on the remote', countAt(G, remote, 'death-star-under-construction') === 1, String(countAt(G, remote, 'death-star-under-construction')));
    check('exactly 4 TIE Fighters auto-deployed to the remote', countAt(G, remote, 'tie-fighter') === 4, String(countAt(G, remote, 'tie-fighter')));
    check('exactly 1 Stormtrooper auto-deployed to the remote', countAt(G, remote, 'stormtrooper') === 1, String(countAt(G, remote, 'stormtrooper')));
    check('empireDeployTarget locked to the remote', G.empireDeployTarget === remote, String(G.empireDeployTarget));
  }
}

console.log('\n[ #360 the escort is NOT double-counted if the player reinforced the remote first ]');
{
  const G = newGame(12);
  const remote = aRemote(G);
  // Reinforce the remote with 2 TIEs before the DSUC (the UI allows this).
  phases.setupDeployUnit(G, 'Empire', 'tie-fighter', remote);
  phases.setupDeployUnit(G, 'Empire', 'tie-fighter', remote);
  check('2 TIEs reinforced onto the remote pre-DSUC', countAt(G, remote, 'tie-fighter') === 2, String(countAt(G, remote, 'tie-fighter')));
  phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  // Now should top up to at least 4 (2 already there + 2 escort) — never more than 4 from the escort.
  check('remote has at least the 4-TIE minimum', countAt(G, remote, 'tie-fighter') >= 4, String(countAt(G, remote, 'tie-fighter')));
  check('escort did not over-add (<= reinforced + needed)', countAt(G, remote, 'tie-fighter') === 4, String(countAt(G, remote, 'tie-fighter')));
  check('1 Stormtrooper present', countAt(G, remote, 'stormtrooper') === 1, String(countAt(G, remote, 'stormtrooper')));
}

console.log('\n[ #360 a non-DSUC unit cannot anchor a remote, and DSUC cannot go on an Imperial system ]');
{
  const G = newGame(13);
  const imperial = Object.keys(G.map.systems).find((id) => {
    const ss = G.map.systems[id];
    return ss.loyalty === 'imperial' || ss.subjugated;
  });
  const r = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', imperial);
  check('DSUC rejected on an Imperial system', !r.ok && r.reason === 'dsuc-must-be-remote', JSON.stringify(r));
}

console.log('\n[ #360 full auto-fill still distributes a complete, legal setup ]');
{
  const G = newGame(14);
  const remote = aRemote(G);
  phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
  phases.setupAutoFill(G, 'Empire');
  const pend = G.pendingDeployment?.Empire ?? [];
  check('no Imperial units left pending after auto-fill', pend.length === 0, pend.join(','));
  check('remote still holds the DSUC + 4 TIE + 1 Stormtrooper',
    countAt(G, remote, 'death-star-under-construction') === 1
    && countAt(G, remote, 'tie-fighter') === 4
    && countAt(G, remote, 'stormtrooper') === 1,
    `dsuc=${countAt(G, remote, 'death-star-under-construction')} tie=${countAt(G, remote, 'tie-fighter')} storm=${countAt(G, remote, 'stormtrooper')}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
