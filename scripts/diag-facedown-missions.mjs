// Why does the AI pass while holding assigned, face-down missions? (task #8,
// player reports #581 "passed with 4 leaders on missions", #617 "five facedown
// missions", #600 the Rebel doing the same.)
//
// Corpus measurement says ~30% of AI Empire pass-rounds and ~43% of AI Rebel
// pass-rounds end with at least one mission still face down. This runs RoE
// self-play and, every time a side is about to PASS during Command, classifies
// each still-assigned mission by WHY bestCommandAction produced no 'reveal' for
// it — mirroring that function's own gates, in its order:
//
//   no-skill-card          card has no skill (can't be revealed this way)
//   insufficient-skill     assigned leaders don't meet skillCost (engine rule)
//   no-legal-target        missionTargets found nothing on the board
//   all-targets-pointless  every target hit missionRevealIsPointless
//   AVAILABLE-but-passed   a reveal WAS generated and pass still outscored it
//
// The last bucket is the damning one: gates fine, scoring chose to sit there.
//
// Run: node scripts/diag-facedown-missions.mjs [games]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const AI = await import('../src/play/randomAI.ts');
const { missionTargets, missionRevealIsPointless } = await import('../src/engine/missionTargets.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json') };

const GAMES = Number(process.argv[2] ?? 15);
const tally = new Map();
const bump = (side, k) => { const key = side + '|' + k; tally.set(key, (tally.get(key) ?? 0) + 1); };
// Per-bucket mission breakdown, so a dominant bucket can be traced to the
// specific cards driving it.
const byMission = new Map();
const bumpMission = (side, k, mid) => {
  const key = side + '|' + k;
  if (!byMission.has(key)) byMission.set(key, new Map());
  const m = byMission.get(key);
  m.set(mid, (m.get(mid) ?? 0) + 1);
};
let passesSeen = 0, passesWithFacedown = 0;

/** Engine-accurate skill total for the leaders assigned to `missionId`
 *  (phases.totalSkill semantics: major + minor, minor only under RoE). */
function engineSkill(G, card, leaderIds) {
  const countsAll = (card.rulesText ?? '').toLowerCase().includes('count all skill icons during this attempt');
  const keys = countsAll ? ['diplomacy', 'intel', 'specOps', 'logistics'] : [card.skill];
  let sum = 0;
  for (const lid of leaderIds) {
    const l = G.catalog.leaders[lid];
    if (!l) continue;
    for (const k of keys) {
      sum += l.skills?.[k] ?? 0;
      if (G.expansion?.enabled) sum += l.minorSkills?.[k] ?? 0;
    }
  }
  return sum;
}

function classify(G, side, missionId) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const am = f.leadersOnMissions.find((m) => m.missionId === missionId);
  const card = G.catalog.missions[missionId];
  if (!am) return 'not-assigned';
  if (!card || !card.skill) return 'no-skill-card';
  if (engineSkill(G, card, am.leaderIds) < card.skillCost) return 'insufficient-skill';
  const t = missionTargets(G, side, missionId);
  const cand = t.permissive ? Object.keys(G.map.systems) : t.systemIds;
  if (cand.length === 0) return 'no-legal-target';
  if (cand.every((sid) => missionRevealIsPointless(G, side, missionId, sid))) return 'all-targets-pointless';
  return 'AVAILABLE-but-passed';
}

for (let seed = 1; seed <= GAMES; seed++) {
  AI.seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: true,
    expansion: { enabled: true, roteUnits: true, roteMissionsRebel: true, roteMissionsEmpire: true } });
  let guard = 0;
  while (!G.isGameOver && guard++ < 6000) {
    const side = G.currentPlayer;
    const isCmd = G.phase === 'Command' && !G.pendingChoice && !G.pendingMission && !G.pendingCombat;
    if (isCmd) {
      const f = side === 'Rebel' ? G.rebel : G.empire;
      const facedown = f.leadersOnMissions.map((m) => m.missionId);
      let about = null;
      try { about = AI.bestCommandAction(G, side)[0]; } catch { /* scoring threw — ignore */ }
      if (about && about.kind === 'pass') {
        passesSeen++;
        if (facedown.length) {
          passesWithFacedown++;
          for (const mid of facedown) {
            const k = classify(G, side, mid);
            bump(side, k);
            bumpMission(side, k, mid);
          }
        }
      }
    }
    if (!AI.stepOnce(G, side)) {
      const o = side === 'Rebel' ? 'Empire' : 'Rebel';
      if (!AI.stepOnce(G, o)) break;
    }
  }
}

console.log(`self-play games: ${GAMES}`);
console.log(`pass decisions observed: ${passesSeen}, with >=1 face-down mission: ${passesWithFacedown}`);
console.log('');
for (const side of ['Empire', 'Rebel']) {
  const rows = [...tally.entries()].filter(([k]) => k.startsWith(side + '|'))
    .map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]);
  const tot = rows.reduce((s, r) => s + r[1], 0) || 1;
  console.log(`== ${side} — ${tot} face-down missions examined at pass time ==`);
  for (const [k, n] of rows) {
    console.log(`   ${String(n).padStart(5)}  ${(100 * n / tot).toFixed(1).padStart(5)}%  ${k}`);
    const m = byMission.get(side + '|' + k);
    if (m) {
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
      console.log(`            ${top.map(([mid, c]) => `${mid}(${c})`).join(', ')}`);
    }
  }
  console.log('');
}
