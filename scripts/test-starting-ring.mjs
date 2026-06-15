// Droid rings (R2-D2 / C-3PO) in the opening hand attach immediately at game
// start, chaining when both are present. Run: node scripts/test-starting-ring.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'), missions: loadJson('missions.json'),
  objectives: loadJson('objectives.json'), tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass=0,fail=0; const check=(n,ok,x='')=>{console.log(`  ${ok?'✓':'✗'} ${n}${ok?'':' — '+x}`);ok?pass++:fail++;};

const G = createGame(data, { seed: 4, roeMissions: true, roeUnits: true });
// Reset to a clean, deterministic starting state: both ring cards in hand, no
// rings attached, no pending choice from a random starting ring.
G.pendingChoice = undefined;
G.leaderAttachments = {};
G.rebel.actionHand = ['resourceful-astromech', 'human-cyborg-relations'];

const posted = phases.flushStartingRings(G);
let c = G.pendingChoice;
check('first starting ring offered at game start', posted && c?.kind === 'AttachRingPick' && c.viaStartingHand === true);
const ring1 = c?.ringId;
check('it is one of the two droid rings', ring1 === 'r2d2' || ring1 === 'c3po', ring1);

const target1 = c.candidates[0];
phases.resolveAttachRing(G, target1);
c = G.pendingChoice;
check('chains to the SECOND starting ring', c?.kind === 'AttachRingPick' && c.viaStartingHand === true && c.ringId !== ring1,
  `kind=${c?.kind} ring=${c?.ringId}`);
check('first leader (now ringed) excluded from second ring candidates', !c.candidates.includes(target1));

const target2 = c.candidates[0];
phases.resolveAttachRing(G, target2);
check('no more ring prompts', G.pendingChoice?.kind !== 'AttachRingPick', G.pendingChoice?.kind);
check('R2-D2 ring attached to some leader', Object.values(G.leaderAttachments).some(a => a.includes('r2d2')));
check('C-3PO ring attached to some leader', Object.values(G.leaderAttachments).some(a => a.includes('c3po')));
check('both ring cards left the hand', !G.rebel.actionHand.includes('resourceful-astromech') && !G.rebel.actionHand.includes('human-cyborg-relations'));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
