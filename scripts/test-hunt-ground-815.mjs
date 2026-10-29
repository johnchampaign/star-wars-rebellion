// @timeout 180000
// #815 (fl4qs5, playing Rebel): "empire has ground forces and space in bothowi.
// Empire moves to nal hutta with only space forces leaving behind all ground.
// ... it would be impossible for empire to discover rebel base without ground
// forces."
//
// Replayed from the reporter's board (scripts/fixtures/hunt-ground-815.json,
// captured just after the move; rewound here). Only Felucia, Kessel and
// Toydaria could still hide the base (it was Kessel). Bothawui held a Star
// Destroyer, six TIEs, six stormtroopers and an AT-ST. RR "Revealing the Rebel
// Base": ships without ground units never reveal the base. The move planner
// filled the SD's 6 capacity with TIEs before troops, so even the heuristic's
// top move (Toydaria, a live candidate) arrived with no ground and searched
// nothing.
//
// Pins: with SWR_HUNT_GROUND on, a move into an unsearched candidate carries at
// least one ground unit; SWR_HUNT_GROUND=0 reproduces the report (none); a move
// into a non-candidate (Nal Hutta, already searched) is unchanged.
// Run: node scripts/test-hunt-ground-815.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/hunt-ground-815.json'), 'utf8');

// Units Admiral Piett moved Bothawui -> Nal Hutta, and Tarkin Mygeeto -> Dantooine.
const PIETT = ['s100015', 's100023', 's100019', 's100025', 's100021', 's100027', 'u1000012'];
const TARKIN = ['u1000019', 'u1000020', 'u1000037', 'u1000047', 'u1000048', 's100040', 'u1000038'];
function board() {
  const G = codec.decode(raw, catalog);
  const mv = (ids, from, to) => { for (const id of ids) { const s = G.map.systems[from].units; const i = s.findIndex((u) => u.instanceId === id); if (i >= 0) G.map.systems[to].units.push(...s.splice(i, 1)); } };
  mv(PIETT, 'nal-hutta', 'bothawui');
  mv(TARKIN, 'dantooine', 'mygeeto');
  delete G.empire.leadersOnBoard['nal-hutta'];
  delete G.empire.leadersOnBoard.dantooine;
  G.empire.leaderPool.push('admiral-piett', 'grand-moff-tarkin');
  G.currentPlayer = 'Empire'; G.pendingChoice = undefined;
  G.passedThisCommand = (G.passedThisCommand ?? []).filter((s) => s !== 'Empire');
  return G;
}
const ground = (G, sid) => G.map.systems[sid].units.filter((u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground').length;
function moveTo(target) {
  const G = board();
  const ok = AI.tryCommandAction(G, 'Empire', { kind: 'activate', leaderId: 'admiral-piett', targetSystemId: target });
  return { ok, ground: ground(G, target), units: G.map.systems[target].units.filter((u) => u.side === 'Empire').length };
}

if (process.argv[2] === '--child') {
  console.log('RESULT ' + JSON.stringify({ toydaria: moveTo('toydaria'), nalHutta: moveTo('nal-hutta') }));
  process.exit(0);
}

let fail = 0;
const check = (name, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) fail++; };
const run = (env) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child'], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) { console.log(r.stdout, r.stderr); throw new Error('child produced no result'); }
  return JSON.parse(line.slice(7));
};

const G0 = board();
check('board: base is hidden at Kessel', !G0.rebelBaseRevealed && G0.rebelBaseSystemId === 'kessel');
check('board: Bothawui holds the SD, TIEs and 7 ground', ground(G0, 'bothawui') === 7
  && G0.map.systems.bothawui.units.some((u) => u.typeId === 'star-destroyer'));
check('board: Toydaria is unsearched, Nal Hutta already searched',
  !(G0.empireSearchedRuledOut ?? []).includes('toydaria') && (G0.empireSearchedRuledOut ?? []).includes('nal-hutta'));

const on = run({ SWR_HUNT_GROUND: '1' });
// SWR_SEARCH_IN_FORCE also loads ground first on a narrowed candidate (#539);
// the control isolates this lever.
const off = run({ SWR_HUNT_GROUND: '0', SWR_SEARCH_IN_FORCE: '0' });
check('ON: the move into the Toydaria candidate lands ground', on.toydaria.ok && on.toydaria.ground >= 1, JSON.stringify(on.toydaria));
check('ON: carrier still full (7 units arrive)', on.toydaria.units === 7, JSON.stringify(on.toydaria));
check('OFF reproduces the report: Toydaria gets ships only', off.toydaria.ok && off.toydaria.ground === 0, JSON.stringify(off.toydaria));
check('non-candidate move unchanged (Nal Hutta, already searched)', JSON.stringify(on.nalHutta) === JSON.stringify(off.nalHutta), `${JSON.stringify(on.nalHutta)} vs ${JSON.stringify(off.nalHutta)}`);
check("SWR_HUNT_GROUND defaults ON (opt-out via '0')",
  /SWR_HUNT_GROUND === '0'\) return false/.test(readFileSync(join(ROOT, 'src/play/randomAI.ts'), 'utf8')));

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
