// #850 (mrvvfh, playing Empire): "I know for sure the base is at Nal Hutta
// because I found out by the card long range probe. I have a fleet adjacent,
// but with only a little ground force - and the rebel just removes his best
// (and only) defense ... by playing lead the strike team in kashyyyk". The base
// fell that round. The report carried no encoded board and the uploaded log has
// no snapshots, so this rebuilds the same shape on the #817 board (base hidden
// at Endor): the base space holds one airspeeder, a single Imperial trooper
// stands one jump away, and the Empire's Long Range Probe has just said "yes".
//
// Pins: the engine records a "yes" (not a "no") and forgets it when the base
// moves; the AI Rebel's public candidate set collapses to the confirmed world;
// with that, Lead the Strike Team keeps the airspeeder home and its targets
// take the -45 base-strip penalty, while the old #760 threat test alone would
// not have fired. Controls: an unconfirmed (wide) base, or one with no Imperial
// ground within two jumps, sends as before; SWR_KNOWN_BASE_GUARD=0 reproduces
// the reported strike.
// Run: node scripts/test-known-base-guard-850.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
const catalog = createGame(data, { seed: 1, autoSetupUnits: true }).catalog;
handlers.registerAll();
const raw = readFileSync(join(ROOT, 'scripts/fixtures/hidden-fleet-narrowed-817.json'), 'utf8');
const isGround = (G, u) => G.catalog.unitTypes[u.typeId]?.theater === 'ground';

/** Endor hidden; nothing ruled out (many candidates); the base space holds one
 *  airspeeder; the only Imperial ground on the map is one trooper at Bespin,
 *  next door. `confirm` runs the Empire's Long Range Probe at Endor. */
function board({ confirm = true, trooper = true } = {}) {
  const G = codec.decode(raw, catalog);
  G.empireSearchedRuledOut = []; G.empire.probeHand = [];
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => !(u.side === 'Empire' && isGround(G, u)));
  const speeder = G.map.rebelBaseSpace.units.find((u) => u.typeId === 'airspeeder')
    ?? { ...G.map.rebelBaseSpace.units.find((u) => isGround(G, u)), typeId: 'airspeeder' };
  G.map.rebelBaseSpace.units = [speeder];
  if (trooper) G.map.systems.bespin.units.push({ instanceId: 'u-850-trooper', typeId: 'stormtrooper', side: 'Empire', damage: 0 });
  if (confirm) registry.invokeByKey(G, 'long-range-probe', registry.makeContext('Empire', { id: 'long-range-probe' }, { targetSystemId: 'endor' }));
  G.currentPlayer = 'Rebel';
  return G;
}
/** How many units Lead the Strike Team takes from the base to Hoth. */
function strikeSends(G) {
  G.pendingChoice = { kind: 'LeadStrikeTeamUnits', side: 'Rebel', targetSystemId: 'hoth',
    availableUnitIds: G.map.rebelBaseSpace.units.map((u) => u.instanceId), max: 4 };
  ai.stepOnce(G, 'Rebel');
  return (G.map.systems.hoth?.units ?? []).filter((u) => u.side === 'Rebel' && isGround(G, u)).length;
}

if (process.argv[2] === '--off') { console.log(`RESULT ${strikeSends(board())}`); process.exit(0); }

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

console.log('[ the engine remembers a Long Range Probe "yes" ]');
{
  const G = board();
  check('a "yes" at the base is recorded', G.empireBaseConfirmed === 'endor', String(G.empireBaseConfirmed));
  const H = board({ confirm: false });
  registry.invokeByKey(H, 'long-range-probe', registry.makeContext('Empire', { id: 'long-range-probe' }, { targetSystemId: 'hoth' }));
  check('a "no" is not (it is a rule-out instead)', H.empireBaseConfirmed === undefined && H.empireSearchedRuledOut.includes('hoth'));
  M.resetEmpireSearchedForBaseMove(G);
  check('the record is cleared when the base moves', G.empireBaseConfirmed === undefined);
  const S = board(); S.rebelBaseSystemId = 'dantooine';
  check('a stale record naming the old world is ignored', ai.rebelPublicBaseCandidates(S).length > 3);
}

console.log('[ the AI Rebel knows the Empire knows ]');
{
  const wide = board({ confirm: false }), G = board();
  check(`unconfirmed: many public candidates (${ai.rebelPublicBaseCandidates(wide).length})`, ai.rebelPublicBaseCandidates(wide).length > 3);
  check('confirmed: the candidates are just Endor', ai.rebelPublicBaseCandidates(G).join(',') === 'endor', ai.rebelPublicBaseCandidates(G).join(','));
  check('the old threat test (#760) does not fire: one trooper cannot outnumber the base', !ai.rebelBaseThreatened(G));
  check('the known-base guard does', ai.strikeWouldStripKnownBase(G));
}

console.log('[ Lead the Strike Team keeps the base\'s defender home ]');
{
  check('confirmed + trooper next door: the airspeeder stays', strikeSends(board()) === 0);
  const off = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--off'], { env: { ...process.env, SWR_KNOWN_BASE_GUARD: '0' }, encoding: 'utf8' });
  check('control: SWR_KNOWN_BASE_GUARD=0 sends it (the reported move)', /RESULT 1/.test(off.stdout), off.stdout + off.stderr.slice(-300));
  check('control: an unconfirmed base sends it as before', strikeSends(board({ confirm: false })) === 1);
  check('control: no Imperial ground within two jumps sends it as before', strikeSends(board({ trooper: false })) === 1);
  const G = board(), W = board({ confirm: false });
  const d = ai.rebelMissionTargetScore(W, 'lead-the-strike-team', 'kashyyyk', null) - ai.rebelMissionTargetScore(G, 'lead-the-strike-team', 'kashyyyk', null);
  check('a strike away from the base (Kashyyyk, as reported) scores 45 lower while the base is known', d >= 45, `delta ${d}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
