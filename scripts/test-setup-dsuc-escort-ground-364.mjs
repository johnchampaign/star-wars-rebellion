// Empire setup can't short the DSUC's escort or leave an Imperial world without
// ground (RoE p.4/p.8, RR p.15). Includes a random-play fuzz: whatever order the
// Empire deploys and pulls back in, setup must still finish, legally.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');

const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'),
  actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'),
  tactics: lj('tactics.json'), probes: lj('probes.json'),
};

let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

const DSUC = 'death-star-under-construction';
const newGame = (seed) => createGame(data, { seed, autoSetupUnits: false, expansion: { enabled: true, roeUnits: true } });
const remoteOf = (G) => Object.keys(G.map.systems).find((id) => G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed);
const imperials = (G) => Object.keys(G.map.systems).filter((id) => G.map.systems[id].loyalty === 'imperial' || G.map.systems[id].subjugated);
const count = (G, sys, typeId) => G.map.systems[sys].units.filter((u) => u.side === 'Empire' && u.typeId === typeId).length;
const ground = (G, sys) => G.map.systems[sys].units.filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
const bare = (G) => imperials(G).filter((s) => ground(G, s) === 0);
const pendingOf = (G, typeId) => G.pendingDeployment.Empire.filter((t) => t === typeId).length;
const totalEmpire = (G) => Object.values(G.map.systems).reduce((n, ss) => n + ss.units.filter((u) => u.side === 'Empire').length, 0)
  + (G.pendingDeployment?.Empire.length ?? 0);
const hasFullEscort = (G, sys) => count(G, sys, DSUC) === 1 && count(G, sys, 'tie-fighter') >= 4 && count(G, sys, 'stormtrooper') >= 1;

console.log('[ escort units cannot be pulled away from a standing DSUC ]');
{
  const G = newGame(3);
  const site = remoteOf(G);
  phases.setupDeployUnit(G, 'Empire', DSUC, site);
  const t = phases.setupUndoDeployUnit(G, 'Empire', 'tie-fighter', site);
  const st = phases.setupUndoDeployUnit(G, 'Empire', 'stormtrooper', site);
  check('pulling an escort TIE is refused', !t.ok && t.reason === 'dsuc-escort-required', t.reason);
  check('pulling the escort Stormtrooper is refused', !st.ok && st.reason === 'dsuc-escort-required', st.reason);
  check('refusal leaves the escort in place', hasFullEscort(G, site));
  check('panel helper marks the TIE as locked', phases.setupUnitIsDsucEscort(G, 'Empire', 'tie-fighter', site));
  check('a Rebel unit is never locked', !phases.setupUnitIsDsucEscort(G, 'Rebel', 'tie-fighter', site));
}

console.log('[ a reinforcement above the escort can still be pulled back ]');
{
  const G = newGame(3);
  const site = remoteOf(G);
  phases.setupDeployUnit(G, 'Empire', DSUC, site);
  phases.setupDeployUnit(G, 'Empire', 'tie-fighter', site);
  check('five TIEs on the site', count(G, site, 'tie-fighter') === 5, count(G, site, 'tie-fighter'));
  const a = phases.setupUndoDeployUnit(G, 'Empire', 'tie-fighter', site);
  check('the fifth comes back', a.ok, a.reason);
  const b = phases.setupUndoDeployUnit(G, 'Empire', 'tie-fighter', site);
  check('the fourth does not', !b.ok && b.reason === 'dsuc-escort-required', b.reason);
}

console.log('[ pulling the DSUC takes its escort with it ]');
{
  const G = newGame(3);
  const site = remoteOf(G);
  const before = G.pendingDeployment.Empire.length;
  phases.setupDeployUnit(G, 'Empire', DSUC, site);
  const r = phases.setupUndoDeployUnit(G, 'Empire', DSUC, site);
  check('DSUC pull-back accepted', r.ok, r.reason);
  check('site is empty again', G.map.systems[site].units.filter((u) => u.side === 'Empire').length === 0);
  check('all six units returned to the pool', G.pendingDeployment.Empire.length === before, G.pendingDeployment.Empire.length);
  check('the site can be chosen afresh', G.empireDeployTarget == null, G.empireDeployTarget);
}

console.log('[ the auto-escort leaves a world its only ground unit (the reported board) ]');
{
  const G = newGame(3);
  const site = remoteOf(G);
  const im = imperials(G);
  const last = im[im.length - 1];
  for (const s of im) phases.setupDeployUnit(G, 'Empire', 'stormtrooper', s);
  while (pendingOf(G, 'stormtrooper') > 0) phases.setupDeployUnit(G, 'Empire', 'stormtrooper', last);
  phases.setupDeployUnit(G, 'Empire', DSUC, site);
  check('escort Stormtrooper arrived', count(G, site, 'stormtrooper') === 1, count(G, site, 'stormtrooper'));
  check('no Imperial world was stripped', bare(G).length === 0, bare(G).join());
  check('it came from the world with spares', count(G, last, 'stormtrooper') === 13 - im.length, count(G, last, 'stormtrooper'));
}

console.log('[ auto-fill finds the escort Stormtrooper after all were placed elsewhere ]');
{
  const G = newGame(3);
  const im = imperials(G);
  while (pendingOf(G, 'stormtrooper') > 0) phases.setupDeployUnit(G, 'Empire', 'stormtrooper', im[0]);
  const r = phases.setupAutoFill(G, 'Empire');
  check('auto-fill succeeds', r.ok, r.reason);
  check('site has the full escort', hasFullEscort(G, G.empireDeployTarget));
  check('no Imperial world is bare', bare(G).length === 0, bare(G).join());
}

console.log('[ setup refuses to spend the last ground units away from a bare world ]');
{
  const G = newGame(3);
  const im = imperials(G);
  const [first, target] = im;
  const site = remoteOf(G);
  phases.setupDeployUnit(G, 'Empire', DSUC, site);
  phases.setupDeployUnit(G, 'Empire', 'stormtrooper', first);
  // Spend ground on `first` until only as many remain as bare worlds.
  const groundPending = () => G.pendingDeployment.Empire.filter((t) => G.catalog.unitTypes[t]?.theater === 'ground');
  while (groundPending().length > bare(G).length) {
    const r = phases.setupDeployUnit(G, 'Empire', groundPending()[0], first);
    if (!r.ok) { check('spare ground deploys freely', false, r.reason); break; }
  }
  const type = groundPending()[0];
  const siteUnits = G.map.systems[site].units.length;
  const onWorld = phases.setupDeployUnit(G, 'Empire', type, first);
  check('refused on a world that already has ground', !onWorld.ok && onWorld.reason === 'imperial-world-needs-ground', onWorld.reason);
  const onSite = phases.setupDeployUnit(G, 'Empire', type, site);
  check('refused on the Death Star site too', !onSite.ok && onSite.reason === 'imperial-world-needs-ground', onSite.reason);
  check('a refusal places nothing', G.map.systems[site].units.length === siteUnits);
  check('panel helper offers only the bare worlds', JSON.stringify(phases.setupRequiredGroundWorlds(G, type)) === JSON.stringify(bare(G)));
  check('accepted on a bare world', phases.setupDeployUnit(G, 'Empire', type, target).ok);
  const ship = G.pendingDeployment.Empire.find((t) => G.catalog.unitTypes[t]?.theater === 'space');
  check('space units are unaffected', phases.setupRequiredGroundWorlds(G, ship) === null);
}

console.log('[ a refused remote does not get claimed as the Death Star site ]');
{
  const G = newGame(3);
  const im = imperials(G);
  const groundPending = () => G.pendingDeployment.Empire.filter((t) => G.catalog.unitTypes[t]?.theater === 'ground');
  phases.setupDeployUnit(G, 'Empire', 'stormtrooper', im[0]);
  while (groundPending().length > bare(G).length) phases.setupDeployUnit(G, 'Empire', groundPending()[0], im[0]);
  const r = phases.setupDeployUnit(G, 'Empire', groundPending()[0], remoteOf(G));
  check('refused', !r.ok && r.reason === 'imperial-world-needs-ground', r.reason);
  check('remote not claimed', G.empireDeployTarget == null, G.empireDeployTarget);
}

console.log('[ fuzz: any deploy / pull-back order finishes setup legally ]');
{
  const GAMES = 400;
  let wedged = 0, illegal = 0, lost = 0, refusals = 0, finished = 0;
  for (let seed = 1; seed <= GAMES; seed++) {
    const G = newGame(seed);
    const startTotal = totalEmpire(G);
    let x = seed * 2654435761 >>> 0;
    const rnd = (n) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x % n; };
    const useAutoFill = seed % 3 === 0; // a third of games bail out to auto-fill partway
    const stopAt = useAutoFill ? 5 + rnd(25) : Infinity;
    for (let step = 0; step < 400 && G.pendingDeployment?.Empire.length; step++) {
      if (step >= stopAt) break;
      const pool = G.pendingDeployment.Empire;
      if (rnd(5) === 0) {
        const placed = [];
        for (const [sid, ss] of Object.entries(G.map.systems)) for (const u of ss.units) if (u.side === 'Empire') placed.push([u.typeId, sid]);
        if (placed.length) {
          const [t, s] = placed[rnd(placed.length)];
          // The undo of the very last unit can't run: setup has moved on.
          if (pool.length > 1 && !phases.setupUndoDeployUnit(G, 'Empire', t, s).ok) refusals++;
          continue;
        }
      }
      const t = pool[rnd(pool.length)];
      const targets = t === DSUC
        ? Object.keys(G.map.systems).filter((id) => G.catalog.systems[id]?.isRemote && !G.map.systems[id].destroyed)
        : [...imperials(G), ...(G.empireDeployTarget ? [G.empireDeployTarget] : [])];
      if (!phases.setupDeployUnit(G, 'Empire', t, targets[rnd(targets.length)]).ok) refusals++;
    }
    if (G.pendingDeployment?.Empire.length) {
      // Finish by hand whatever random play left (a stuck pool is a wedge).
      if (useAutoFill) phases.setupAutoFill(G, 'Empire');
      else {
        for (let guard = 0; guard < 200 && G.pendingDeployment?.Empire.length; guard++) {
          const t = G.pendingDeployment.Empire[0];
          const req = phases.setupRequiredGroundWorlds(G, t);
          const dest = t === DSUC ? (G.empireDeployTarget ?? remoteOf(G)) : (req ? req[0] : imperials(G)[0]);
          if (!phases.setupDeployUnit(G, 'Empire', t, dest).ok) break;
        }
      }
    }
    if (G.pendingDeployment?.Empire.length) { wedged++; continue; }
    finished++;
    const site = G.empireDeployTarget;
    if (bare(G).length > 0 || !site || !hasFullEscort(G, site)) illegal++;
    if (totalEmpire(G) !== startTotal) lost++;
  }
  check(`all ${GAMES} games finished the Empire's deployment`, finished === GAMES && wedged === 0, `${wedged} wedged`);
  check('every one ended with full escort and no bare world', illegal === 0, `${illegal} illegal`);
  check('no unit was lost or duplicated', lost === 0, `${lost} games`);
  check('the fuzz actually exercised refusals', refusals > 0, refusals);
}

console.log('[ plain auto-fill still produces the same legal start ]');
{
  const G = newGame(3);
  const r = phases.setupAutoFill(G, 'Empire');
  const site = G.empireDeployTarget;
  check('auto-fill ok', r.ok, r.reason);
  check('site has exactly the six mandated units', G.map.systems[site].units.filter((u) => u.side === 'Empire').length === 6);
  check('no bare world', bare(G).length === 0);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
