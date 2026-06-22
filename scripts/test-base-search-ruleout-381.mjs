// #381 — The Empire "Base search" panel must mark systems whose probe the
// Empire DREW during play as ruled out, not just the ones removed at setup.
//
// Root cause was removeProbeForSystem() (called at setup for the DSUC system /
// Dagobah) populating G.empireProbeRuledOut on the LIVE state. That left a
// truthy-but-partial array, and the panel's `if (G.empireProbeRuledOut)`
// short-circuit then trusted it and ignored probes drawn during play. In
// hotseat the field must stay undefined so the panel derives rule-outs from
// the visible deck; online, redactStateForViewer recomputes it from scratch.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

// RoE setup removes the DSUC system's probe via removeProbeForSystem — the exact
// path that used to seed G.empireProbeRuledOut.
const G = createGame(data, { seed: 7, roeMissions: true, roeUnits: true });

check('live empireProbeRuledOut stays undefined after setup probe-removal',
  G.empireProbeRuledOut === undefined, `got ${JSON.stringify(G.empireProbeRuledOut)}`);

// Empire draws a probe during play — its system must be derivable as ruled out
// from the (visible, hotseat) deck.
const drawn = M.drawProbe(G, 1);
const drawnSys = G.catalog.probes[drawn[0]]?.systemId;
check('a probe was drawn into hand', !!drawnSys && G.empire.probeHand.includes(drawn[0]));
check('drawing a probe still does not create the live mirror field',
  G.empireProbeRuledOut === undefined);

// Replicate the panel's hotseat derivation (empireRuledOutSystems' deck branch).
const inDeck = new Set((G.probeDeck ?? []).map((pid) => G.catalog.probes[pid]?.systemId).filter(Boolean));
const ruledOut = new Set();
for (const p of Object.values(G.catalog.probes)) {
  const sid = p.systemId;
  if (!sid || inDeck.has(sid) || sid === G.rebelBaseSystemId) continue;
  ruledOut.add(sid);
}
check('drawn-probe system is ruled out by deck derivation', ruledOut.has(drawnSys),
  `${drawnSys} not in ${[...ruledOut].join(',')}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
