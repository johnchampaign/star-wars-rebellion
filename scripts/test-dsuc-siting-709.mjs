// #709 — "Since deployment happen after the systems get's loyal I think an
// empire human player would choose a remote system on the right side of the
// map in this case like dagobah or tatooine. While the death star is very safe
// from the rebels attacking from their loyal planets ..."
//
// The reporter is pointing at a real RoE opening: the Empire picks its Death
// Star Under Construction site AFTER seeing where starting loyalty landed, and
// the AI was throwing that information away — first by always picking Dagobah
// (map order), then by picking uniformly at random. Both ignore the board.
//
// Now the site is chosen by distance from Rebel-loyal space: BFS from every
// Rebel-loyal system, take the remotes tied at the farthest distance, and draw
// among them with the game rng (one draw, same as the uniform pick it
// replaces, so seeds and replays are unaffected). His companion suggestion —
// escorting the site with a carrier and ground — was measured separately and
// LOSES (SWR_DSUC_GARRISON, −5.4pp), so this is deliberately siting only.
//
// Run: node scripts/test-dsuc-siting-709.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const bfs = (G, sources) => {
  const dist = new Map(sources.map((s) => [s, 0]));
  let frontier = sources.slice();
  for (let d = 1; frontier.length && d <= 8; d++) {
    const next = [];
    for (const s of frontier) for (const a of (G.catalog.adjacency[s] ?? [])) {
      if (!dist.has(a)) { dist.set(a, d); next.push(a); }
    }
    frontier = next;
  }
  return (id) => Math.min(dist.get(id) ?? 9, 9);
};

console.log('\n[ the DSUC site maximises distance from Rebel-loyal space ]');
{
  let checked = 0, optimal = 0, sitesSeen = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    // autoSetupUnits drives the auto-fill path that owns the pick.
    const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
    const site = G.empireDeployTarget;
    if (!site) continue;
    checked++;
    sitesSeen.add(site);
    const rebelLoyal = Object.entries(G.map.systems)
      .filter(([, ss]) => ss.loyalty === 'rebel').map(([id]) => id);
    if (rebelLoyal.length === 0) { optimal++; continue; } // nothing to be far from
    const away = bfs(G, rebelLoyal);
    const remotes = Object.keys(G.map.systems).filter(
      (id) => G.catalog.systems[id]?.isRemote && !G.map.systems[id]?.destroyed && id !== site);
    const bestOther = Math.max(...remotes.map(away));
    if (away(site) >= bestOther) optimal++;
  }
  check('a site was chosen in every setup', checked >= 55, `only ${checked}/60`);
  check('every chosen site is at the maximum available distance', optimal === checked,
    `${optimal}/${checked} optimal`);
  check('and the pick still varies across seeds (ties are sampled, not fixed)',
    sitesSeen.size >= 2, `only ${[...sitesSeen].join(',')}`);
  console.log(`    sites used across 60 seeds: ${[...sitesSeen].join(', ')}`);
}

console.log('\n[ the site is a remote system, always ]');
{
  for (const seed of [7, 19]) {
    const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
    check(`seed ${seed}: ${G.empireDeployTarget} is remote`,
      G.catalog.systems[G.empireDeployTarget]?.isRemote === true);
  }
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
