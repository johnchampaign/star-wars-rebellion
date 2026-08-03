// #675 — "The empire player ran the mission 'Make An Example' at Alderaan. The
// card stipulates that the leader needs to be at a remote system."
//
// The card reads "Attempt on a captured leader in a REMOTE system." The target
// rule matched only on the phrase "captured leader" and returned every system
// holding a captive, so the mission could be attempted on a populous one.
// Alderaan is populous.
//
// The remote clause is now read off the card text rather than special-cased by
// id, so any other card phrased the same way is restricted automatically —
// which is what the last two assertions here pin.
//
// Run: node scripts/test-make-an-example-remote-675.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { missionTargets } = await import('../src/engine/missionTargets.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const MISSION = 'make-an-example';
const POPULOUS = 'alderaan';

function game(seed) {
  return createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
}
/** Put a captured Rebel leader at `sysId`. */
function capture(G, leaderId, sysId) {
  // A captive in a system with no Imperial units is auto-rescued immediately,
  // so garrison it first or capturedLeaders comes back empty.
  M.deployUnit(G, 'Empire', 'stormtrooper', sysId);
  M.placeLeader(G, 'Rebel', leaderId, sysId);
  M.captureLeader(G, leaderId);
  const cap = (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === leaderId);
  if (cap) cap.systemId = sysId;
  return cap;
}
const targets = (G) => missionTargets(G, 'Empire', MISSION).systemIds;

console.log('\n[ the card text still carries the remote clause ]');
{
  const G = game(675);
  const txt = (G.catalog.missions[MISSION]?.rulesText ?? '').toLowerCase();
  check('rulesText mentions a captured leader', txt.includes('captured leader'), txt);
  check('rulesText mentions remote', txt.includes('remote'), txt);
  check('Alderaan is NOT remote', G.catalog.systems[POPULOUS]?.isRemote === false);
}

console.log('\n[ #675 a captive on a populous system is not a legal target ]');
{
  const G = game(675);
  capture(G, 'princess-leia', POPULOUS);
  const t = targets(G);
  check('a captive is recorded there',
    (G.empire.capturedLeaders ?? []).some((c) => c.systemId === POPULOUS));
  check('Alderaan is not offered', !t.includes(POPULOUS), `targets=${JSON.stringify(t)}`);
  check('no populous system is offered',
    t.every((sid) => G.catalog.systems[sid]?.isRemote), `targets=${JSON.stringify(t)}`);
}

console.log('\n[ a captive on a remote system IS a legal target ]');
{
  const G = game(676);
  const remote = Object.keys(G.map.systems).find((sid) => G.catalog.systems[sid]?.isRemote);
  capture(G, 'princess-leia', remote);
  const t = targets(G);
  check(`the remote system (${remote}) is offered`, t.includes(remote), `targets=${JSON.stringify(t)}`);
}

console.log('\n[ both present: only the remote one survives ]');
{
  const G = game(677);
  const remote = Object.keys(G.map.systems).find((sid) => G.catalog.systems[sid]?.isRemote);
  capture(G, 'princess-leia', POPULOUS);
  capture(G, 'mon-mothma', remote);
  const t = targets(G);
  check('remote offered', t.includes(remote), `targets=${JSON.stringify(t)}`);
  check('populous filtered out', !t.includes(POPULOUS), `targets=${JSON.stringify(t)}`);
}

console.log('\n[ cards WITHOUT the remote clause are unaffected ]');
{
  const G = game(678);
  capture(G, 'princess-leia', POPULOUS);
  // Any other Empire mission whose text targets a captured leader but says
  // nothing about remoteness must still see the populous system.
  const others = Object.values(G.catalog.missions).filter((m) => m.side === 'Empire'
    && (m.rulesText ?? '').toLowerCase().includes('captured leader')
    && !(m.rulesText ?? '').toLowerCase().includes('remote'));
  check('found at least one such card', others.length > 0,
    'nothing to compare against — the filter could be over-broad unnoticed');
  for (const m of others.slice(0, 3)) {
    const t = missionTargets(G, 'Empire', m.id).systemIds;
    check(`${m.id} still offers the populous system`, t.includes(POPULOUS),
      `targets=${JSON.stringify(t)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
