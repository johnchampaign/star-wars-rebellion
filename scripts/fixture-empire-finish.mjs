// Behavioral fixtures for the Empire strike-fleet plan layer (#539).
//
// Real human-vs-AI game states where the AI Empire FAILS to finish an exposed (or
// about-to-be-exposed) Rebel base — the symptom the planner must fix:
//   • empire-finish-538  (#538): base REVEALED 3 turns, Empire has 3 leaders sitting
//                         ON the base with ZERO units while 40+ units idle scattered
//                         across the map — force never composed the assault.
//   • empire-finish-516  (#516): base still hidden, a huge Empire fleet locked idle
//                         on Alderaan instead of staging toward the base region.
//
// This harness DECODES each fixture and prints the diagnostic the planner must
// move: how much Empire force sits AT the base vs stranded 1/2/3+ hops away, and
// how many leaders are wasted at the base with no force to fight with. It asserts
// nothing yet — it captures the pre-planner BASELINE. The post-planner regression
// test (SWR_EMPIRE_PLANNER=1) will re-run these and require the force to converge.
//
// Run: node scripts/fixture-empire-finish.mjs [538|516|all]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FX = join(ROOT, 'scripts', 'fixtures');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

function bfs(adj, start) {
  const d = { [start]: 0 }; const q = [start];
  while (q.length) { const c = q.shift(); for (const n of adj[c] ?? []) if (d[n] == null) { d[n] = d[c] + 1; q.push(n); } }
  return d;
}
const isMobileGround = (G, u) => {
  const t = G.catalog.unitTypes[u.typeId];
  return !!t && t.theater === 'ground' && t.class !== 'structure' && !t.transport.immobile;
};
const isMobile = (G, u) => {
  const t = G.catalog.unitTypes[u.typeId];
  return !!t && !t.transport.immobile;
};

function diagnose(name) {
  const raw = JSON.parse(readFileSync(join(FX, `empire-finish-${name}.json`), 'utf8'));
  const seed = createGame(data, { seed: 1, autoSetupUnits: true, expansion: raw.state.expansion });
  const G = codec.decode(JSON.stringify(raw), seed.catalog);
  const base = G.rebelBaseSystemId;
  const revealed = !!G.rebelBaseRevealed;
  const dist = bfs(G.catalog.adjacency, base);
  // Bucket Empire mobile-ground and mobile-any force by hop-distance from the base.
  const ground = { 0: 0, 1: 0, 2: 0, 3: 0, far: 0 };
  const anyMobile = { 0: 0, 1: 0, 2: 0, 3: 0, far: 0 };
  let leadersOnBaseNoForce = 0;
  const containers = Object.entries(G.map.systems);
  for (const [sid, ss] of containers) {
    const d = dist[sid];
    const bucket = d == null ? 'far' : (d >= 3 ? (d === 3 ? 3 : 'far') : d);
    for (const u of ss.units) {
      if (u.side !== 'Empire') continue;
      if (isMobileGround(G, u)) ground[bucket]++;
      if (isMobile(G, u)) anyMobile[bucket]++;
    }
  }
  // Leaders sitting AT the base with no Empire combat unit there to fight with.
  const baseSys = G.map.systems[base];
  const empForceAtBase = (baseSys?.units ?? []).filter((u) => u.side === 'Empire' && isMobile(G, u)).length;
  const leadersAtBase = (G.empire.leadersOnBoard[base] ?? []).length;
  if (empForceAtBase === 0) leadersOnBaseNoForce = leadersAtBase;

  console.log(`\n[ empire-finish-${name} ] base=${base} revealed=${revealed} t=${G.timeMarker} empirePool=${JSON.stringify(G.empire.leaderPool)}`);
  console.log(`  Empire mobile GROUND by hop-from-base:  @base=${ground[0]}  1hop=${ground[1]}  2hop=${ground[2]}  3hop=${ground[3]}  4+=${ground.far}`);
  console.log(`  Empire mobile ANY    by hop-from-base:  @base=${anyMobile[0]}  1hop=${anyMobile[1]}  2hop=${anyMobile[2]}  3hop=${anyMobile[3]}  4+=${anyMobile.far}`);
  console.log(`  leaders wasted AT base with no force:   ${leadersOnBaseNoForce} (leaders@base=${leadersAtBase}, empForce@base=${empForceAtBase})`);
  const within2 = ground[0] + ground[1] + ground[2];
  console.log(`  => STAGED (ground within 2 hops): ${within2}   DELIVERED (ground @base): ${ground[0]}   the planner must convert staged -> delivered.`);
  return { name, base, revealed, deliveredGround: ground[0], stagedWithin2: within2, leadersWasted: leadersOnBaseNoForce };
}

const which = process.argv[2] ?? 'all';
const names = which === 'all' ? ['538', '516'] : [which];
console.log('=== Empire-finish behavioral fixtures — pre-planner baseline (#539) ===');
const rows = names.map(diagnose);
console.log('\nSummary (post-planner, DELIVERED should rise and leaders-wasted should fall):');
for (const r of rows) console.log(`  ${r.name}: delivered=${r.deliveredGround} staged<=2=${r.stagedWithin2} leadersWasted=${r.leadersWasted} (revealed=${r.revealed})`);
