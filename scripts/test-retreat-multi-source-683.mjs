// #683 — RR p.5 RETREATING: "A player cannot retreat to a system that his
// opponent moved units from to initiate the combat."
// One activation can move units in from SEVERAL adjacent systems at once, but
// the engine recorded only the first move order's source, so the defender was
// still offered the attacker's other source systems as retreat destinations —
// and since the attacker usually empties a source completely, those systems
// contain no enemy units and looked perfectly legal.
// Run: node scripts/test-retreat-multi-source-683.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const combat = await import('../src/engine/combat.ts');
const M = await import('../src/engine/mechanics.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

/** Pick a target system that has at least 3 neighbours, so we can have two
 *  attacker sources plus at least one genuinely legal retreat destination. */
const pickTarget = (G) => {
  for (const [sid, adj] of Object.entries(G.catalog.adjacency)) {
    if ((adj?.length ?? 0) >= 3 && G.map.systems[sid]) return sid;
  }
  throw new Error('no system with 3+ neighbours');
};

/** Board with the Rebel defending `target` and the Empire arriving from two
 *  different adjacent systems (both emptied by the move). */
const setup = () => {
  const G = createGame(data, { seed: 11 });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const target = pickTarget(G);
  const [srcA, srcB, escape] = G.catalog.adjacency[target];
  // Defender: Rebel ships + a leader in the target system (both required to retreat).
  M.deployUnit(G, 'Rebel', 'corellian-corvette', target);
  M.deployUnit(G, 'Rebel', 'corellian-corvette', target);
  G.rebel.leadersOnBoard[target] = ['mon-mothma'];
  // Attacker: Imperial ships now in the target, having come from srcA and srcB.
  M.deployUnit(G, 'Empire', 'star-destroyer', target);
  M.deployUnit(G, 'Empire', 'star-destroyer', target);
  G.empire.leadersOnBoard[target] = ['darth-vader'];
  // Make `escape` a legal Rebel destination (own loyalty), and leave srcA/srcB
  // empty + neutral — exactly the state that made them look retreatable.
  G.map.systems[escape].loyalty = 'rebel';
  return { G, target, srcA, srcB, escape };
};

const startCombat = (G, target, sources) => {
  combat.beginCombat(G, 'Empire', sources, target);
  const c = G.pendingCombat;
  if (!c) throw new Error('combat did not begin');
  return c;
};

console.log('\n[ #683 both attacker source systems are banned as retreat destinations ]');
{
  const { G, target, srcA, srcB, escape } = setup();
  const c = startCombat(G, target, [srcA, srcB]);
  check('combat records BOTH source systems',
    JSON.stringify(c.attackerSourceSystemIds?.slice().sort()) === JSON.stringify([srcA, srcB].sort()),
    JSON.stringify(c.attackerSourceSystemIds));
  check('scalar source stays populated for older readers',
    c.attackerSourceSystemId === srcA, c.attackerSourceSystemId);

  const dests = combat.legalRetreatDestinations(G, c, 'Rebel');
  check('srcA not offered', !dests.includes(srcA), JSON.stringify(dests));
  check('srcB not offered (the bug: only srcA used to be banned)', !dests.includes(srcB), JSON.stringify(dests));
  check('a legitimate adjacent system is still offered', dests.includes(escape), JSON.stringify(dests));

  // The attacker retreating back to its OWN source is legal (RR bans it for the
  // defender only) — guard against over-correcting the filter. Give srcA
  // Imperial loyalty so it survives RR rule 3's "prefer your own units/loyalty"
  // pass, which would otherwise drop an empty neutral system on its own.
  G.map.systems[srcA].loyalty = 'imperial';
  const attackerDests = combat.legalRetreatDestinations(G, c, 'Empire');
  check('attacker may still retreat to its own source', attackerDests.includes(srcA),
    JSON.stringify(attackerDests));
}

console.log('\n[ #683 a single-source attack still bans exactly that one system ]');
{
  const { G, target, srcA, srcB } = setup();
  const c = startCombat(G, target, srcA);
  check('scalar call still works', c.attackerSourceSystemId === srcA, c.attackerSourceSystemId);
  check('list holds just the one source',
    JSON.stringify(c.attackerSourceSystemIds) === JSON.stringify([srcA]),
    JSON.stringify(c.attackerSourceSystemIds));
  check('the untouched neighbour is NOT banned', !(c.attackerSourceSystemIds ?? []).includes(srcB));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
