// #817 (cgjuna, playing Empire): "Rebel AI used hidden fleet to Ilum,
// abandoning the base which it knows I know is in Endor. This is a poor
// decision given the state of the board."
//
// Replayed from the reporter's board (scripts/fixtures/hidden-fleet-narrowed-
// 817.json, captured just after the move; the 17 units at Ilum are put back in
// the Rebel Base space). The Empire had publicly ruled out everything but
// Dantooine and Endor, Imperial ground sat two jumps from Endor, and Hidden
// Fleet carried every ground unit out. SWR_HF_BASE_GUARD would not have fired
// (it weighs the threat against the garrison BEFORE the move, one hop out).
//
// Pins: with the base narrowed to 3 or fewer public candidates and Imperial
// ground within two jumps, the ground and half the ships stay home; the card
// is still played with the rest. SWR_HF_NARROW_GUARD=0 reproduces the report.
// Controls: a base the Empire has NOT narrowed, or no Imperial ground nearby,
// sails as before.
// Run: node scripts/test-hf-narrowed-base-817.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
const raw = readFileSync(join(ROOT, 'scripts/fixtures/hidden-fleet-narrowed-817.json'), 'utf8');

/** The moment of the choice: every unit back in the base, the Rebel picking
 *  which units Hidden Fleet takes to Ilum. */
function board(mutate) {
  const G = codec.decode(raw, catalog);
  const ilum = G.map.systems.ilum;
  G.map.rebelBaseSpace.units.push(...ilum.units.filter((u) => u.side === 'Rebel'));
  ilum.units = ilum.units.filter((u) => u.side !== 'Rebel');
  mutate?.(G);
  G.currentPlayer = 'Rebel';
  G.pendingChoice = { kind: 'HiddenFleetUnitPick', side: 'Rebel', targetSystemId: 'ilum',
    candidateUnitIds: G.map.rebelBaseSpace.units.map((u) => u.instanceId) };
  return G;
}
/** What the AI sends: [ground sent, ground left, ships sent, ships left]. */
function sends(G) {
  ai.stepOnce(G, 'Rebel');
  const theater = (u) => G.catalog.unitTypes[u.typeId]?.theater;
  const at = (ss) => ({ ground: ss.units.filter((u) => u.side === 'Rebel' && theater(u) === 'ground').length,
                       ships: ss.units.filter((u) => u.side === 'Rebel' && theater(u) === 'space').length });
  const went = at(G.map.systems.ilum), home = at(G.map.rebelBaseSpace);
  return { groundSent: went.ground, groundHome: home.ground, shipsSent: went.ships, shipsHome: home.ships };
}

if (process.argv[2] === '--off') { console.log(`RESULT ${JSON.stringify(sends(board()))}`); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ the reporter\'s board ]');
{
  const G = board();
  check('the base is hidden at Endor', G.rebelBaseSystemId === 'endor' && !G.rebelBaseRevealed);
  const c = ai.rebelPublicBaseCandidates(G).sort();
  check('the Empire has narrowed it to Dantooine and Endor', c.join(',') === 'dantooine,endor', c.join(','));
  check('the 17 that moved are back in the base beside the trooper that stayed (18; 9 ground)', G.map.rebelBaseSpace.units.length === 18
    && G.map.rebelBaseSpace.units.filter((u) => G.catalog.unitTypes[u.typeId]?.theater === 'ground').length === 9,
    `${G.map.rebelBaseSpace.units.length} units`);
  check('the guard recognises the situation', ai.hiddenFleetWouldStripNarrowedBase(G));
}

console.log('[ the ground stays home ]');
{
  const r = sends(board());
  check('no ground unit leaves the base', r.groundSent === 0, JSON.stringify(r));
  check('…and part of the fleet still goes to Ilum (the card is not wasted)', r.shipsSent > 0 && r.shipsHome > 0, JSON.stringify(r));
  const off = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--off'], { env: { ...process.env, SWR_HF_NARROW_GUARD: '0' }, encoding: 'utf8' });
  const o = JSON.parse((off.stdout.match(/RESULT (.*)/) ?? [])[1] ?? '{}');
  check('control: with SWR_HF_NARROW_GUARD=0 the ground sails (the reported move)', o.groundSent > 0, off.stdout + off.stderr.slice(-200));
}

console.log('[ it only fires on a nearly-found base ]');
{
  // Un-narrow it: forget the Empire's searches, so many worlds are possible.
  const wide = board((G) => { G.empireSearchedRuledOut = []; G.empire.probeHand = []; });
  check('control: a base the Empire has not narrowed sails as before', !ai.hiddenFleetWouldStripNarrowedBase(wide)
    && sends(wide).groundSent > 0);
  // No Imperial ground near Endor.
  const quiet = board((G) => {
    for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => !(u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.theater === 'ground'));
  });
  check('control: with no Imperial ground nearby it sails as before', !ai.hiddenFleetWouldStripNarrowedBase(quiet)
    && sends(quiet).groundSent > 0);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
