// #756 — "when I as the Empire Player played the Long Range Probe, and guessed
// right, I should get a confirmation that the Rebel base is in that system. But
// that information is nowhere showing in the interface. At least show that
// information in the Log. I had to ask my opponent in Messages to learn about
// that information."
//
// The reporter was right, and the cause was online per-seat redaction, not the
// mission. redactStateForViewer scrubs every surviving log entry whose JSON
// mentions the hidden base system — a blunt substring match that is correct for
// the Rebel's own moves but swallowed the Empire's OWN probe answer, because a
// successful Long Range Probe's answer necessarily names the base. A WRONG guess
// survived the scrub ("not at Alderaan" never mentions the base), so only a
// correct guess — the one the mission is played for — went silent.
//
// Second cause, same report: the result notice was pushed with no side tag, so
// online it popped for BOTH seats, and acknowledgeNotices(G, side) clears every
// untagged notice — whichever seat dismissed first wiped the Empire's answer.
//
// Run: node scripts/test-long-range-probe-answer-756.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const { redactStateForViewer } = await import('../src/adapter/redact.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Resolve one unopposed Long Range Probe at `pickTarget(G)` and hand back the
 *  finished state. */
function probeAt(pickTarget) {
  const G = createGame(data, { seed: 11, autoSetupUnits: true });
  const target = pickTarget(G);
  G.rebel.leadersOnBoard[target] = []; // unopposed — no Rebel leader there
  if (!G.empire.missionHand.includes('long-range-probe')) G.empire.missionHand.push('long-range-probe');
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== 'admiral-piett');
  G.empire.leadersOnMissions.push({ missionId: 'long-range-probe', leaderIds: ['admiral-piett'] });
  G.phase = 'Command'; G.currentPlayer = 'Empire';
  const r = phases.revealMission(G, 'Empire', 'long-range-probe', target);
  if (!r.ok) throw new Error(`reveal rejected: ${r.reason}`);
  if (G.pendingChoice?.kind === 'OpposeMission') phases.resolveOpposition(G, null);
  return { G, target };
}
const probeEntries = (G) => G.turnLog.filter((e) => e.kind === 'probe-result');

console.log('[ the engine answers the probe either way ]');
{
  const hit = probeAt((G) => G.rebelBaseSystemId);
  const miss = probeAt((G) => Object.keys(G.map.systems).find((s) => s !== G.rebelBaseSystemId));
  check('a correct guess logs isBase=true', probeEntries(hit.G).at(-1)?.payload?.isBase === true,
    JSON.stringify(probeEntries(hit.G)));
  check('a wrong guess logs isBase=false', probeEntries(miss.G).at(-1)?.payload?.isBase === false,
    JSON.stringify(probeEntries(miss.G)));
  check('a wrong guess also rules the system out on the map',
    (miss.G.empireSearchedRuledOut ?? []).includes(miss.target));
}

console.log('[ the answer survives the Empire seat\'s redaction (#756 core) ]');
{
  const { G, target } = probeAt((Gg) => Gg.rebelBaseSystemId);
  check('the base really is still hidden in this game', !G.rebelBaseRevealed);
  const emp = redactStateForViewer(G, 'Empire');
  const got = emp.turnLog.filter((e) => e.kind === 'probe-result');
  check('the Empire still sees its own probe-result entry', got.length === 1,
    `kept ${got.length} of ${probeEntries(G).length}`);
  check('…naming the system it asked about', got[0]?.payload?.systemId === target,
    JSON.stringify(got[0]?.payload));
  check('…with the yes answer intact', got[0]?.payload?.isBase === true, JSON.stringify(got[0]?.payload));
  check('the base location is still masked everywhere else in the view',
    emp.rebelBaseSystemId !== target,
    `rebelBaseSystemId=${emp.rebelBaseSystemId}`);
}

console.log('[ the exemption does not leak the base to anyone else ]');
{
  const { G, target } = probeAt((Gg) => Gg.rebelBaseSystemId);
  const spec = redactStateForViewer(G, null);
  check('a spectator gets no probe-result at all',
    spec.turnLog.every((e) => e.kind !== 'probe-result'));
  check("a spectator's log never names the base system",
    !JSON.stringify(spec.turnLog).includes(target));
  // Rebel-tagged entries naming the base must still be scrubbed for the Empire:
  // the exemption is keyed on the VIEWER'S OWN side, not on the kind alone.
  const G2 = structuredClone(G);
  G2.turnLog.push({ seq: G2.turnLog.length, turn: G2.timeMarker, phase: G2.phase,
    side: 'Rebel', kind: 'probe-result', payload: { systemId: target, isBase: true, source: 'forged' } });
  const emp2 = redactStateForViewer(G2, 'Empire');
  check('a Rebel-tagged probe-result is still dropped for the Empire',
    emp2.turnLog.filter((e) => e.kind === 'probe-result').every((e) => e.side === 'Empire'));
}

console.log('[ the result notice belongs to the Empire seat ]');
{
  const { G } = probeAt((Gg) => Gg.rebelBaseSystemId);
  const n = (G.pendingNotices ?? []).find((x) => x.id.startsWith('lrp-'));
  check('the probe notice exists', !!n, JSON.stringify(G.pendingNotices));
  check('…and is addressed to the Empire', n?.side === 'Empire', JSON.stringify(n));
  const before = (G.pendingNotices ?? []).length;
  phases.acknowledgeNotices(G, 'Rebel');
  check('the Rebel dismissing their modals cannot wipe it',
    (G.pendingNotices ?? []).some((x) => x.id === n.id), `${before} -> ${JSON.stringify(G.pendingNotices)}`);
  phases.acknowledgeNotices(G, 'Empire');
  check('the Empire can dismiss it', !(G.pendingNotices ?? []).some((x) => x.id === n.id));
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
