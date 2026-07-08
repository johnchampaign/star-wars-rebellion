// #501 / #491 — RoE rulebook p.8: the Empire places its Death Star Under
// Construction (+ 4 TIE Fighters + 1 Stormtrooper) on a chosen remote system,
// then "remove the remote system's card from the probe deck and place the card
// in the box." The Rebel base is chosen from the REMAINING probe cards (RR p.15
// step 9) — so the base can NEVER be on the DSUC system (they can't share a
// system). The engine was building base candidates from "all non-Coruscant,
// non-Imperial-loyalty systems", ignoring the boxed DSUC probe, so the base
// could land on the Empire's Death Star world.
// Run: node scripts/test-base-not-on-dsuc-501-491.mjs
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

const roe = { enabled: true, roeUnits: true, roeMissions: true };

console.log('[ auto-setup: the DSUC remote is never offered / chosen as the base ]');
{
  let checkedSeeds = 0, dsucSeen = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const G = createGame(data, { seed, autoSetupUnits: true, expansion: roe });
    const dsuc = G.empireDeployTarget;
    if (!dsuc) continue; // no DSUC this config
    dsucSeen++;
    // The Empire really has its DSUC + companions on that remote.
    const hasDsuc = (G.map.systems[dsuc]?.units ?? []).some((u) => u.typeId === 'death-star-under-construction');
    if (!hasDsuc) continue;
    checkedSeeds++;
    if (G.rebelBaseSystemId === dsuc) { check(`seed ${seed}: base NOT on the DSUC remote`, false, `base=${G.rebelBaseSystemId} dsuc=${dsuc}`); }
  }
  check(`checked ${checkedSeeds} auto-setup games with a DSUC — base never coincided`, checkedSeeds > 0 && fail === 0);
}

console.log('[ interactive: DSUC deploy prunes the base-candidate list ]');
{
  const G = createGame(data, { autoSetupUnits: false, expansion: roe }); // interactive: pendingDeployment + pendingRebelBasePick
  check('setup exposes a base-candidate list', Array.isArray(G.pendingRebelBasePick) && G.pendingRebelBasePick.length > 0);
  // Pick a remote the Empire will use for its DSUC.
  const remote = Object.keys(G.catalog.systems).find((id) => G.catalog.systems[id]?.isRemote && G.map.systems[id] && G.pendingRebelBasePick?.includes(id));
  check('a remote is initially a base candidate (pre-DSUC)', !!remote, 'no remote candidate');
  if (remote) {
    // Empire deploys its DSUC onto that remote.
    const r = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
    check('Empire DSUC deploy ok', r.ok, r.reason);
    check('empireDeployTarget is that remote', G.empireDeployTarget === remote);
    check('the DSUC remote was pruned from the base candidates', !(G.pendingRebelBasePick ?? []).includes(remote));
    // And an explicit pick of it is rejected by the backstop.
    const bad = phases.pickRebelBase(G, remote);
    check('picking the DSUC remote as base is rejected', !bad.ok, `got ok=${bad.ok}`);
  }
}

console.log('[ strict order: no base pick until the Empire finishes deploying ]');
{
  const G = createGame(data, { autoSetupUnits: false, expansion: roe });
  // Empire's step-8 deployment is still pending → a base pick is refused outright.
  const anyCand = (G.pendingRebelBasePick ?? [])[0];
  const early = phases.pickRebelBase(G, anyCand);
  check('base pick refused while the Empire is still deploying',
    !early.ok && early.reason === 'empire-setup-not-complete', `ok=${early.ok} reason=${early.reason}`);

  // Finish the Empire's deployment (chooses the DSUC remote + boxes its probe).
  const af = phases.setupAutoFill(G, 'Empire');
  check('Empire auto-fill completes step 8', af.ok, af.reason);
  check('Empire has no pending deployment left', (G.pendingDeployment?.Empire?.length ?? 0) === 0);
  const dsuc = G.empireDeployTarget;
  check('a DSUC remote was chosen', !!dsuc, `dsuc=${dsuc}`);
  check('the DSUC remote is NOT in the base-candidate pool', !(G.pendingRebelBasePick ?? []).includes(dsuc));

  // Now the base pick is allowed — and can never be the DSUC remote.
  const good = (G.pendingRebelBasePick ?? [])[0];
  const rb = phases.pickRebelBase(G, good);
  check('base pick now succeeds (Empire done)', rb.ok, rb.reason);
  check('committed base is not the DSUC remote', G.rebelBaseSystemId !== dsuc, `base=${G.rebelBaseSystemId} dsuc=${dsuc}`);

  // Defense-in-depth: even if a client tried it out of order, the Empire can't
  // DSUC onto an already-committed base.
  const G2 = createGame(data, { autoSetupUnits: false, expansion: roe });
  G2.pendingDeployment.Empire = []; // pretend Empire finished (so the pick is allowed)
  const remote2 = (G2.pendingRebelBasePick ?? []).find((id) => G2.catalog.systems[id]?.isRemote);
  if (remote2) {
    phases.pickRebelBase(G2, remote2);
    G2.pendingDeployment.Empire = ['death-star-under-construction', 'tie-fighter'];
    const de = phases.setupDeployUnit(G2, 'Empire', 'death-star-under-construction', remote2);
    check('Empire DSUC onto an already-committed base is refused', !de.ok, `ok=${de.ok} reason=${de.reason}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
