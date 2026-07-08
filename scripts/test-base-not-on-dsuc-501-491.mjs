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

console.log('[ interactive: Rebel-first — Empire cannot DSUC onto the committed base ]');
{
  const G = createGame(data, { autoSetupUnits: false, expansion: roe });
  const remote = Object.keys(G.catalog.systems).find((id) => G.catalog.systems[id]?.isRemote && G.map.systems[id] && G.pendingRebelBasePick?.includes(id));
  if (remote) {
    // Rebel commits the base to the remote BEFORE the Empire deploys.
    const rb = phases.pickRebelBase(G, remote);
    check('Rebel base commit ok (nothing there yet)', rb.ok, rb.reason);
    check('base committed to the remote', G.rebelBaseSystemId === remote && !G.pendingRebelBasePick);
    // Now the Empire tries to put its DSUC on the same remote — must be refused.
    const de = phases.setupDeployUnit(G, 'Empire', 'death-star-under-construction', remote);
    check('Empire DSUC on the committed base is refused', !de.ok, `got ok=${de.ok} reason=${de.reason}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
