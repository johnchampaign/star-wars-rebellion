// Player report #797 — "After deploying as Empire, the Rebel AI does not
// deploy units." Online game, human Empire vs server-AI Rebel.
//
// Setup is concurrent online, so canAct (and the client's `yourTurn`) is true
// for BOTH seats for the whole phase (#736, so the last placement can be
// undone). The server's turn clock derived "who's on the move" from yourTurn,
// so once the Empire finished placing, every poll/submit still booked the
// EMPIRE (human) as the actor. The AI-due flag (actor_is_ai) never went up, the
// off-Cloudflare AI worker never saw the game, and the AI Rebel sat at setup
// forever. currentActorOf must read the state during Setup instead.
//
// Run: node scripts/test-online-ai-setup-clock-797.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api');
register();

const gs = await import('../functions/_lib/gameServer.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

// What GET /api/games/:id hands currentActorOf for the human Empire seat.
const viewResult = (state, you) => ({
  you, gameOver: false,
  yourTurn: rebellionAdapter.canAct(state, you),
  view: rebellionAdapter.viewFor(state, you),
});

const state = gs.newInitialState(data, 'Rebel', {
  enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true, baseSetupUnits: false,
});
state.expansion.missionSetLocked.Empire = true;

check('setup starts with the human Empire on the clock',
  gs.currentActorOf(viewResult(state, 'Empire')) === 'Empire');

// The human Empire places every starting unit (the AI stands in for their clicks).
let guard = 0;
while (state.phase === 'Setup' && rebellionAdapter.currentActor(state) === 'Empire' && guard++ < 500) {
  if (!stepOnce(state, 'Empire')) break;
}
check('Empire finished placing, still in Setup, Rebel AI to move',
  state.phase === 'Setup' && rebellionAdapter.currentActor(state) === 'Rebel'
  && (state.pendingDeployment?.Empire ?? []).length === 0);

const r = viewResult(state, 'Empire');
check('the Empire seat still "may act" (setup undo, #736)', r.yourTurn === true);
const actor = gs.currentActorOf(r);
check('turn clock books the AI Rebel, not the human (#797)', actor === 'Rebel', `got ${actor}`);
check('so recordTurnTiming would raise the AI-due flag', !!(actor && r.view.aiSides?.includes(actor)));

// The reporter's actual (redacted) board from the issue.
const reported = {
  phase: 'Setup', currentPlayer: 'Rebel', isGameOver: false, aiSides: ['Rebel'],
  pendingDeployment: { Rebel: ['x-wing', 'rebel-trooper'], Empire: [] },
};
check("reporter's board: the AI Rebel is on the clock",
  gs.currentActorOf({ you: 'Empire', yourTurn: true, gameOver: false, view: reported }) === 'Rebel');

// And the AI actually completes setup once it's driven.
check('runServerAI deploys the Rebel and leaves Setup', gs.runServerAI(state) && state.phase !== 'Setup',
  `phase ${state.phase}`);

// Outside Setup, behaviour is unchanged (yourTurn still decides).
const cmd = { you: 'Empire', yourTurn: false, gameOver: false, view: { phase: 'Command' } };
check('Command phase: not your turn -> the other seat', gs.currentActorOf(cmd) === 'Rebel');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
