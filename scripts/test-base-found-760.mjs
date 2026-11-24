// @timeout 120000
// #760 (Aaron / rokhm1, playing Empire): "I sit in front of his base, ready to
// activate the system and attack - and suddenly, Han Solo leads the strike team
// to Geonosis??" The AI Rebel stripped a base the Empire had already found.
//
// Two levers (default OFF until measured; this test sets them itself):
//   SWR_BASE_STRIP_GUARD - while Imperial ground stands next to a hidden base,
//     missions that move units out of the Rebel Base space are penalised
//     (except a winnable strike on the threatening neighbour), and the unit
//     pickers keep a garrison home.
//   SWR_BASE_FOUND - a hidden base the Empire has publicly narrowed to <= 6
//     candidates counts as EXPOSED (archive: captured by next round 70% at 4-6
//     candidates vs 28% at 7+), switching on the revealed-base defences.
// The non-vacuous control runs the same board in a child with both levers off.
// Run: node scripts/test-base-found-760.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHILD = process.env.BF_CHILD === '1';
if (!CHILD) { process.env.SWR_BASE_STRIP_GUARD = '1'; process.env.SWR_BASE_FOUND = '1'; }
process.env.SWR_RANKER = '0';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const AI = await import('../src/play/randomAI.ts');
const { readGameLog, snapshotToCodec } = await import('./lib/log-reader.mjs');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };
const AARON = join(ROOT, 'logs', '79f97900df78dab5.json');
function aaronBoard() {
  const L = readGameLog(AARON);
  const s = L.snapshots.find((x) => x.turn === 7 && x.at === 'turn-start');
  return codec.decode(snapshotToCodec(s.state), createGame(data, { seed: 1 }).catalog);
}
let k = 0; const unit = (t, side) => ({ instanceId: `bf${k++}`, typeId: t, side, damage: 0 });
/** Hidden base; `imperialNext` ground units on a neighbour of the base, and
 *  optionally `imperialNext2` on a second neighbour. */
function synth({ imperialNext = 0, imperialNext2 = 0, baseGround = 4 } = {}) {
  const G = createGame(data, { seed: 21, autoSetupUnits: true });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.map.rebelBaseSpace.units = [];
  G.rebelBaseRevealed = false; G.empireSearchedRuledOut = [];
  const base = G.rebelBaseSystemId;
  const nb = (G.catalog.adjacency[base] ?? []).find((s) => !G.catalog.systems[s]?.isRemote) ?? G.catalog.adjacency[base][0];
  for (let i = 0; i < baseGround; i++) G.map.rebelBaseSpace.units.push(unit('rebel-trooper', 'Rebel'));
  for (let i = 0; i < imperialNext; i++) G.map.systems[nb].units.push(unit('stormtrooper', 'Empire'));
  const nb2 = (G.catalog.adjacency[base] ?? []).find((s) => !G.catalog.systems[s]?.isRemote && s !== nb);
  for (let i = 0; i < imperialNext2; i++) G.map.systems[nb2].units.push(unit('stormtrooper', 'Empire'));
  return { G, base, nb, nb2 };
}

if (CHILD) {
  const out = {};
  if (existsSync(AARON)) { const G = aaronBoard(); out.geonosis = AI.rebelMissionTargetScore(G, 'lead-the-strike-team', 'geonosis', null); out.exposed = AI.rebelBaseExposed(G); }
  console.log(JSON.stringify(out)); process.exit(0);
}
// The legacy arm is the scorer before ANY base guard, so it also turns off the
// #850 known-base guard (this board is narrowed to 3 with Imperial ground near).
const legacy = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, BF_CHILD: '1', SWR_BASE_STRIP_GUARD: '0', SWR_BASE_FOUND: '0', SWR_KNOWN_BASE_GUARD: '0' }, encoding: 'utf8' }).trim().split('\n').pop());

console.log('[ Aaron\'s board: turn 7, base at Endor, Imperial stack at Bespin ]');
if (!existsSync(AARON)) console.log('  (skip) reporter log absent on this machine');
else {
  const G = aaronBoard();
  check('the Empire had narrowed the base to 3 public candidates', AI.rebelPublicBaseCandidates(G).length === 3, AI.rebelPublicBaseCandidates(G).join(','));
  check('so the base counts as EXPOSED', AI.rebelBaseExposed(G) === true);
  check('and THREATENED (Imperial ground next to Endor)', AI.rebelBaseThreatened(G) === true);
  check('control: with both levers off it is not treated as exposed', legacy.exposed === false, JSON.stringify(legacy));
  const geo = AI.rebelMissionTargetScore(G, 'lead-the-strike-team', 'geonosis', null);
  check(`Lead the Strike Team to Geonosis no longer beats passing (${geo})`, geo < 0.5, String(geo));
  check(`control: the legacy scorer rated it ${legacy.geonosis} — the move Aaron saw`, legacy.geonosis >= 30, JSON.stringify(legacy));
}

console.log('[ the guard only bites when the base is threatened ]');
{
  const farOf = (g) => Object.keys(g.G.map.systems).find((s) => !g.G.catalog.systems[s].isRemote && s !== g.base && !(g.G.catalog.adjacency[g.base] ?? []).includes(s));
  const withFar = (g) => { const far = farOf(g); g.G.map.systems[far].loyalty = 'imperial'; g.G.map.systems[far].units.push(unit('stormtrooper', 'Empire')); return far; };
  const calm = synth({ imperialNext: 0 }); const far = withFar(calm);
  check('no Imperial ground near the base: not threatened', AI.rebelBaseThreatened(calm.G) === false);
  const garrison = synth({ imperialNext: 2 }); withFar(garrison);
  check('a 2-unit garrison next to a base holding 4 troopers is NOT a threat (the over-trigger fix)', AI.rebelBaseThreatened(garrison.G) === false);
  const threat = synth({ imperialNext: 3, imperialNext2: 3 }); withFar(threat);
  check('6 Imperial ground next to a 4-trooper base: threatened', AI.rebelBaseThreatened(threat.G) === true);
  const a = AI.rebelMissionTargetScore(calm.G, 'lead-the-strike-team', far, null);
  const b = AI.rebelMissionTargetScore(threat.G, 'lead-the-strike-team', far, null);
  check(`a distant strike loses 45 when the base is threatened (${a} -> ${b})`, a - b === 45, `${a} ${b}`);
  const nbScore = AI.rebelMissionTargetScore(threat.G, 'lead-the-strike-team', threat.nb, null);
  const ref = synth({ imperialNext: 3 }); // same neighbour, but no second stack: not threatened
  const nbRef = AI.rebelMissionTargetScore(ref.G, 'lead-the-strike-team', ref.nb, null);
  check(`a winnable strike on a threatening neighbour (4 troopers vs 3) is NOT penalised (${nbScore} vs ${nbRef})`, nbScore === nbRef && nbScore > 0, `${nbScore} ${nbRef}`);
}

console.log('[ a well-hidden base is not exposed ]');
{
  const { G } = synth({ imperialNext: 0 });
  check(`many public candidates (${AI.rebelPublicBaseCandidates(G).length}) -> not exposed`, AI.rebelBaseExposed(G) === false);
  G.empireSearchedRuledOut = AI.rebelPublicBaseCandidates(G).filter((s) => s !== G.rebelBaseSystemId).slice(0, -5);
  check(`narrowed to ${AI.rebelPublicBaseCandidates(G).length} -> exposed`, AI.rebelBaseExposed(G) === true);
}

console.log('[ the strike-team picker keeps a garrison home when threatened ]');
{
  const pickCount = (threatened) => {
    const { G } = synth({ imperialNext: threatened ? 3 : 0, imperialNext2: threatened ? 3 : 0, baseGround: 4 });
    const ids = G.map.rebelBaseSpace.units.map((u) => u.instanceId);
    G.phase = 'Command'; G.currentPlayer = 'Rebel';
    G.pendingChoice = { kind: 'LeadStrikeTeamUnits', side: 'Rebel', availableUnitIds: ids, max: 4, targetSystemId: Object.keys(G.map.systems)[0] };
    let sent = null;
    const phases = globalThis.__phases;
    return { G, ids };
  };
  const phases = await import('../src/engine/phases.ts');
  const orig = phases.resolveLeadStrikeTeamUnits;
  const run = (threatened) => {
    const { G } = pickCount(threatened); let sent = null;
    const spy = (g, picked) => { sent = picked.length; return { ok: true }; };
    // stepOnce calls phases.resolveLeadStrikeTeamUnits through the module namespace
    try { phases.resolveLeadStrikeTeamUnits = spy; } catch { /* ESM namespace is read-only */ }
    AI.stepOnce(G, 'Rebel');
    return sent ?? (4 - G.map.rebelBaseSpace.units.length);
  };
  const calmSent = run(false), threatSent = run(true);
  check(`unthreatened: sends all 4 troopers (sent ${calmSent})`, calmSent === 4);
  check(`threatened: keeps half home (sent ${threatSent})`, threatSent === 2);
}
console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
