// #752 — "I don't exactly know why, but the rebel ai really starts doing weird
// things, attacked my star destroyer or similar strong fleets (assault carrier
// plus ties, etc) with 1 or 2 x-wings now 3 times or so. the ai should be
// focused more on really doing productive attacks."
//
// The reporter is right, and the cause is an asymmetry in bestCommandAction.
// The Rebel branch of the activation scorer had only the POSITIVE half of an
// attack gate — +12 when the Rebel outweighs the defender 1.2x — and nothing
// that penalised an attack it would obviously lose. The Empire has had that
// negative half (the #653 rout guard) for months; the Rebel never got it, so a
// hopeless target could enter the candidate list on positional value alone and
// MCTS would then take it.
//
// This is the reporter's own board (issue #752, turn 8), rewound by the two
// things the complained-of activation changed: the X-wing that flew Sullust ->
// Corellia and died there, and Lando leaving the pool for Corellia. What the
// AI faced at that moment:
//
//   corellia   IMPERIAL-loyal, 7 Imperial units (assault carrier, 2 TIE
//              fighters, TIE striker, 3 stormtroopers) = strength 16,
//              Admiral Piett present
//   naboo      3 Imperial units = strength 8
//   sullust    the entire Rebel force in range: 1 trooper + 1 X-wing
//   base       nal-hutta, still hidden
//
// and what it scored, with the guard off:
//   corellia   +3, from `sys.loyalty === 'imperial'` alone — the reporter's
//              move, logged as `activate lando-calrissian -> corellia score 3`
//   naboo     +12, booked as a WINNABLE attack, because the old estimate
//              summed every Rebel unit within one hop in all six directions
//              while `plannedMoveOrders` would deliver a single X-wing
//              (strength 2) into 8 of defence
//
// Hence the guard prices `plannedMoveOrders` — what the executor will really
// commit — rather than everything parked next door, the same correction #653
// made for the Empire, and fires only on a pure attack (we hold nothing in the
// target) so that reinforcing a contested system and the revealed-base stand
// are left alone.
//
// Run: node scripts/test-rebel-rout-guard-752.mjs
//   Counterfactual (run automatically as a child process): SWR_REBEL_ROUT=0
//   restores the old behaviour, and both suicide attacks reappear as
//   candidates. If they did not, the guard would not be what removes them and
//   this test would be vacuous.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = join(dirname(__filename), '..');
const { register } = await import('tsx/esm/api');
register();

const codec = await import('../src/engine/codec.ts');
const setup = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const fixture = readFileSync(join(ROOT, 'scripts/fixtures/rebel-suicide-attack-752.json'), 'utf-8');
const G = codec.decode(fixture, setup.buildCatalog(data));

// ---- rewind the activation being complained about -------------------------
// The snapshot is taken AFTER it resolved, so the X-wing is already dead and
// Lando is already on Corellia; without this the pool offers no Rebel leader
// and no Rebel unit is in range, and the board proves nothing.
G.map.systems['sullust'].units.push({ instanceId: 'u1000075', typeId: 'x-wing', side: 'Rebel' });
delete G.rebel.leadersOnBoard['corellia'];
if (!G.rebel.leaderPool.includes('lando-calrissian')) G.rebel.leaderPool.push('lando-calrissian');

const strength = (u) => {
  const t = G.catalog.unitTypes[u.typeId];
  return (t.attack.red ?? 0) + (t.attack.black ?? 0) + (t.attack.green ?? 0) + (t.health?.value ?? 0);
};
const defenceAt = (sid) => G.map.systems[sid].units
  .filter((u) => u.side === 'Empire').reduce((a, u) => a + strength(u), 0);
const rebelInRange = G.map.systems['sullust'].units
  .filter((u) => u.side === 'Rebel').reduce((a, u) => a + strength(u), 0);

const guardOff = process.env.SWR_REBEL_ROUT === '0';
console.log(guardOff
  ? 'Rebel rout guard #752 — COUNTERFACTUAL (SWR_REBEL_ROUT=0)'
  : 'Rebel rout guard #752');

const acts = ai.bestCommandAction(G, 'Rebel');
const targeted = (sid) => acts.some((a) => a.kind === 'activate' && a.targetSystemId === sid);

if (guardOff) {
  // Child run: succeed only if BOTH suicide attacks come back.
  for (const sid of ['corellia', 'naboo']) {
    console.log(`  ${sid}: defence ${defenceAt(sid)}, candidate=${targeted(sid)}`);
  }
  process.exit(targeted('corellia') && targeted('naboo') ? 0 : 1);
}

// The fixture has to sit inside the guard's firing range, or it proves nothing.
// Even counting Sullust's trooper as well as the X-wing — more than the planner
// would actually send — both targets are routs.
check('corellia is a rout (best case 4 v 16)',
  rebelInRange < defenceAt('corellia') * 0.6, `${rebelInRange} v ${defenceAt('corellia')}`);
check('naboo is a rout (best case 4 v 8)',
  rebelInRange < defenceAt('naboo') * 0.6, `${rebelInRange} v ${defenceAt('naboo')}`);
// ...and the Rebel must be ABLE to move, or the pre-existing no-op troop guard
// would drop these for a different reason entirely.
check('the Rebel can still act (a unit is in range and a leader is free)',
  rebelInRange > 0 && G.rebel.leaderPool.length > 0);

check('no activation targets the 16-strength fleet at corellia', !targeted('corellia'),
  'the reported move is still a candidate');
check('no activation targets the 8-strength garrison at naboo', !targeted('naboo'),
  'the phantom "winnable attack" is still a candidate');
// The Rebel must not be paralysed by the guard — it should still have somewhere
// to go. A guard that removes every option is a different bug, not a fix.
check('the Rebel still has activations to choose from',
  acts.some((a) => a.kind === 'activate'), 'the guard sank every target');

const child = spawnSync(process.execPath, [__filename], {
  env: { ...process.env, SWR_REBEL_ROUT: '0' }, encoding: 'utf-8',
});
process.stdout.write(child.stdout.split('\n').map((l) => (l ? `    | ${l}` : l)).join('\n'));
check('counterfactual: SWR_REBEL_ROUT=0 brings both routs back as candidates',
  child.status === 0, 'the guard is not what removes them — test is vacuous');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
