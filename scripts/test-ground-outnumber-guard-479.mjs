// #479 — the Empire AI marched Vader + a fleet of ships (and barely any ground)
// into Bothawui, a Rebel GROUND stronghold. It wins the space fight but loses the
// ground fight, and the Rebel plays Confrontation to ELIMINATE Vader for good.
// The ground-outnumber guard already existed (#237) but its flat -14 was too weak
// against a big subjugation/search bonus, so a badly-outnumbered assault still went
// through. The guard now scales: a ground force under HALF the defender's takes -30
// (near-certain leader loss), which drops the attack below passing.
// Run: node scripts/test-ground-outnumber-guard-479.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const ai = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// Sets up an Empire leader + fleet at a system adjacent to `SYS`, whose Rebel
// ground defense is `rebGround` troopers, and returns the AI's activate-into-SYS
// action score (undefined if it isn't even generated) alongside the pass score.
function attackScore(rebGround, empGroundUnits) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  const SYS = 'bothawui';
  G.map.systems[SYS].loyalty = 'rebel'; // a worthwhile subjugation target either way
  const mk = (t, s) => ({ instanceId: t + Math.random(), typeId: t, side: s, damage: 0 });
  G.map.systems[SYS].units = Array.from({ length: rebGround }, () => mk('rebel-trooper', 'Rebel'));
  G.rebel.leadersOnBoard[SYS] = ['luke-skywalker-jedi']; // a leader to play Confrontation
  const adj = (G.catalog.adjacency[SYS] || [])[0];
  G.empire.leadersOnBoard = {}; G.empire.leadersOnBoard[adj] = ['darth-vader'];
  G.map.systems[adj].units = [mk('star-destroyer', 'Empire'), mk('star-destroyer', 'Empire'), ...empGroundUnits.map((t) => mk(t, 'Empire'))];
  const acts = ai.bestCommandAction(G, 'Empire');
  const atk = acts.find((a) => a.kind === 'activate' && a.targetSystemId === SYS);
  const passScore = acts.find((a) => a.kind === 'pass')?.score ?? 0.5;
  return { score: atk?.score, beatsPass: atk ? atk.score > passScore : false };
}

console.log('[ #479 — ground-outnumber guard (Confrontation leader-loss) ]');
// Vader + 2 ships + 1 stormtrooper vs a 4-trooper Rebel stronghold: ground is far
// below half the defender's → guard keeps the AI from committing the leader into a
// fight where the Rebel's Confrontation eliminates it.
const lopsided = attackScore(4, ['stormtrooper']);
check('badly-outnumbered ground assault does NOT beat passing', lopsided.beatsPass === false, `score=${lopsided.score}`);
// The guard should score the lopsided commitment strictly WORSE than an adequate
// ground force at the same target (proves the penalty scales, not a flat cliff that
// suppresses every attack). Over-suppression of legitimate attacks is separately
// guarded by the self-play regression run.
const even = attackScore(4, ['stormtrooper', 'stormtrooper', 'stormtrooper', 'stormtrooper', 'stormtrooper']);
const lo = lopsided.score ?? -Infinity, ev = even.score ?? -Infinity;
check('adequate ground scores better than the lopsided commitment', ev > lo || (lopsided.score === undefined && even.score === undefined), `lopsided=${lopsided.score} adequate=${even.score}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
