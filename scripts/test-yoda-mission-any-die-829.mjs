// #829 — "Luke (Jedi) has the Master Yoda ring ... when the leader opposed the
// Capture Rebel Operative mission there was no opportunity to reroll 1 of the
// dice, as the card says is allowed."
//
// Seek Yoda: "you may reroll 1 of your dice." #540 removed the blanks-only gate
// from the combat and Death Star Plans rerolls; the mission path kept it, on the
// stated grounds that every non-blank mission face scores. But a hit (1 success)
// can become a special (2), and a roll behind by one needs exactly that. A Rebel
// with no blank silently got no offer at all.
//
// Run: node scripts/test-yoda-mission-any-die-829.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const ai = await import('../src/play/randomAI.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'tatooine';
const MISSION = 'gather-intel'; // Empire, intel x1, "attempt in any Rebel system"
const LUKE = 'luke-skywalker-jedi';
const EMP = 'emperor-palpatine';

function build(seed) {
  const G = createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const ss = G.map.systems[SYS];
  ss.loyalty = 'rebel'; ss.subjugated = false; ss.units = [];
  for (const list of Object.values(G.empire.leadersOnBoard)) { const i = list.indexOf(EMP); if (i >= 0) list.splice(i, 1); }
  G.empire.leaderPool = G.empire.leaderPool.filter((l) => l !== EMP);
  G.empire.leadersOnMissions = [{ missionId: MISSION, leaderIds: [EMP] }];
  for (const list of Object.values(G.rebel.leadersOnBoard)) { const i = list.indexOf(LUKE); if (i >= 0) list.splice(i, 1); }
  G.rebel.leadersOnMissions = (G.rebel.leadersOnMissions ?? []).filter((m) => !m.leaderIds.includes(LUKE));
  if (!G.rebel.leaderPool.includes(LUKE)) G.rebel.leaderPool.push(LUKE);
  M.attachRing(G, LUKE, 'yoda');
  return G;
}

/** First seed whose Rebel opposing roll satisfies `want`, stopped wherever
 *  resolveOpposition stopped, plus the roll as the log recorded or stashed it. */
function find(want) {
  for (let s = 1; s <= 600; s++) {
    const G = build(s);
    if (!phases.revealMission(G, 'Empire', MISSION, SYS).ok) continue;
    if (G.pendingChoice?.kind !== 'OpposeMission') continue;
    if (!phases.resolveOpposition(G, LUKE).ok) continue;
    const pm = G.pendingMission;
    const faces = pm?.r2d2Pending?.oppFaces
      ?? [...G.turnLog].reverse().find((e) => e.kind === 'mission-roll')?.payload.opposer.faces;
    if (faces && want(faces)) return { G, faces, seed: s };
  }
  return null;
}

console.log('[ #829 — Yoda mission reroll is not limited to blanks ]');

const noBlank = find((f) => f.length > 0 && !f.includes('blank') && !f.every((x) => x === 'special'));
check('found a Rebel opposing roll with no blank', !!noBlank);
if (noBlank) {
  const { G, faces } = noBlank;
  const pc = G.pendingChoice;
  check('the reporter\'s case: a roll with no blank still gets the offer',
    pc?.kind === 'YodaReroll' && pc.context === 'mission', `faces=${faces} pc=${pc?.kind}`);
  check('every non-special die is a candidate, and no special is',
    pc?.kind === 'YodaReroll' && faces.every((f, i) => pc.blankIndices.includes(i) === (f !== 'special')),
    `faces=${faces} cands=${pc?.blankIndices}`);

  const idx = faces.findIndex((f) => f !== 'special');
  const was = faces[idx];
  const r = phases.resolveYodaMissionReroll(G, idx);
  check('rerolling a non-blank die is accepted', r.ok, r.reason);
  const ev = [...G.turnLog].reverse().find((e) => e.kind === 'yoda-reroll');
  check('the log records the real old face', ev?.payload.oldFace === was, `old=${ev?.payload.oldFace} was=${was}`);
  check('the reroll spends the once-per-round power', G.yodaRerollUsedThisRound === true);
  const roll = [...G.turnLog].reverse().find((e) => e.kind === 'mission-roll');
  const score = (f) => f === 'special' ? 2 : f === 'blank' ? 0 : 1;
  check('the new face is what the mission scored',
    roll?.payload.opposer.successes === roll?.payload.opposer.faces.reduce((n, f) => n + score(f), 0)
      && roll?.payload.opposer.faces[idx] === ev?.payload.newFace,
    JSON.stringify(roll?.payload.opposer));
}

// The guard, and the rule that the once-per-round flag still governs the offer.
const withSpecial = find((f) => f.includes('special') && f.some((x) => x !== 'special'));
check('found a Rebel opposing roll mixing a special with other faces', !!withSpecial);
if (withSpecial) {
  const { G, faces } = withSpecial;
  const r = phases.resolveYodaMissionReroll(G, faces.indexOf('special'));
  check('a special is refused (strictly-best face)', !r.ok && r.reason === 'special-not-rerollable', JSON.stringify(r));
  check('and the refusal leaves the offer standing', G.pendingChoice?.kind === 'YodaReroll');
}
const onlySpecials = find((f) => f.length > 0 && f.every((x) => x === 'special'));
if (onlySpecials) {
  check('a roll of only specials gets no offer', onlySpecials.G.pendingChoice?.kind !== 'YodaReroll',
    `pc=${onlySpecials.G.pendingChoice?.kind}`);
}
{
  let refused = 0, tried = 0;
  for (let s = 1; s <= 60; s++) {
    const G = build(s);
    G.yodaRerollUsedThisRound = true;
    if (!phases.revealMission(G, 'Empire', MISSION, SYS).ok) continue;
    if (G.pendingChoice?.kind !== 'OpposeMission') continue;
    if (!phases.resolveOpposition(G, LUKE).ok) continue;
    tried++;
    if (G.pendingChoice?.kind !== 'YodaReroll') refused++;
  }
  check('no offer once the ring is spent this round', tried > 0 && refused === tried, `${refused}/${tried}`);
}

// The AI's policy is unchanged: it rerolls a blank, and with none it declines
// (which keeps the ring) instead of gambling a scoring die on the new candidates.
if (noBlank) {
  const { seed } = noBlank;
  const G = build(seed);
  phases.revealMission(G, 'Empire', MISSION, SYS);
  phases.resolveOpposition(G, LUKE);
  const did = ai.stepOnce(G, 'Rebel');
  check('the AI answers a no-blank offer', did === true && G.pendingChoice?.kind !== 'YodaReroll', `pc=${G.pendingChoice?.kind}`);
  check('by declining, so the ring is not spent', G.yodaRerollUsedThisRound !== true);
}
const withBlank = find((f) => f.includes('blank'));
check('found a Rebel opposing roll with a blank', !!withBlank);
if (withBlank) {
  const { G, faces } = withBlank;
  check('a blank is still a candidate', G.pendingChoice?.kind === 'YodaReroll' && G.pendingChoice.blankIndices.includes(faces.indexOf('blank')));
  ai.stepOnce(G, 'Rebel');
  const ev = [...G.turnLog].reverse().find((e) => e.kind === 'yoda-reroll');
  check('the AI rerolls the blank', ev?.payload.oldFace === 'blank', JSON.stringify(ev?.payload));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
