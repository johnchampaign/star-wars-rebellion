// #517 — the Empire had one leader (Motti) in its pool, a 14-unit stack idling at
// Dagobah, and it PASSED. Root cause: the move-scorer rated Dagobah's own system
// highest (base-candidate + time bonus), but you can't pull a system's units INTO
// itself — so the executor rejected that no-op self-activation and fell through to
// pass, leaving the stack idle. The no-op guard only fired when the target had no
// own units; it now also fires when a resident stack has nothing pullable and no
// enemy present, so the AI instead activates a NEIGHBOR that marches the stack.
// Run: node scripts/test-idle-stack-activation-517.mjs
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

console.log('[ #517 — an idle stack must not make the last leader pass ]');
{
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  G.phase = 'Command'; G.currentPlayer = 'Empire'; G.passedThisCommand = [];
  G.timeMarker = 8; // late game — every Empire activation gets a big time bonus
  // Strip ALL Empire force + leaders to isolate one idle stack and one pool leader.
  for (const ss of Object.values(G.map.systems)) ss.units = ss.units.filter((u) => u.side !== 'Empire');
  G.empire.leadersOnBoard = {};
  // Pick a system with at least one neighbor to serve as the idle-stack home.
  const STACK = Object.keys(G.map.systems).find((s) => (G.catalog.adjacency[s] ?? []).length > 0);
  const nbr = (G.catalog.adjacency[STACK] ?? [])[0];
  const mk = (t) => ({ instanceId: t + Math.random(), typeId: t, side: 'Empire', damage: 0 });
  // A big mixed stack that the AI would love to have advance — but it sits on its
  // own system, which (pre-fix) out-scored every neighbor and self-activated to a
  // no-op. Neighbor is empty so the ONLY way to move the stack is to activate nbr.
  G.map.systems[STACK].units = [mk('star-destroyer'), mk('star-destroyer'), mk('stormtrooper'), mk('stormtrooper'), mk('stormtrooper'), mk('assault-tank')];
  // One pool leader with tactic values (Motti-like) — can legally activate.
  G.empire.leaderPool = ['motti'];

  const acts = ai.bestCommandAction(G, 'Empire');
  const top = acts[0];
  const passScore = acts.find((a) => a.kind === 'pass')?.score ?? 0.5;
  // The no-op self-activation of the stack's OWN system must not be the top pick.
  const selfNoop = acts.find((a) => a.kind === 'activate' && a.targetSystemId === STACK);
  check('the stack\'s own-system activation is NOT above pass', !selfNoop || selfNoop.score <= passScore, `selfScore=${selfNoop?.score} pass=${passScore}`);

  // Actually step: the AI must ACTIVATE (mobilize the stack), not pass.
  ai.seedAI(1);
  const ok = ai.stepOnce(G, 'Empire');
  const passed = (G.passedThisCommand ?? []).includes('Empire');
  const mottiPlaced = Object.values(G.empire.leadersOnBoard).some((l) => l.includes('motti'));
  check('the AI activates its leader instead of passing', ok && !passed && mottiPlaced, `passed=${passed} placed=${mottiPlaced} top=${top?.kind}:${top?.targetSystemId}`);
  // And the stack actually advanced off its home system (pulled into the neighbor).
  const stillHome = G.map.systems[STACK].units.filter((u) => u.side === 'Empire').length;
  check('the idle stack advanced (units left the home system)', stillHome < 6, `remaining=${stillHome} neighbor=${nbr}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
