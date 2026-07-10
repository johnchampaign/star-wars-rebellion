// #478 — the AI Rebel never played The Long War ("discard 2 other objective
// cards" → 1 reputation): the blanket never-pay-cost-objectives rule (#183) made
// it decline every refresh while sitting on 6 unscorable objectives and needing
// reputation to win. The AI now plays it when the hand is clogged (4+ objectives
// with 2+ expendable: condition unmet, not Death Star Plans), paying the cost
// entirely with dead weight — and still declines with a small/live hand.
// Run: node scripts/test-long-war-ai-478.mjs
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

// Craft a refresh-window PlayObjective choice with only The Long War legal and
// the given objective hand, then let the AI answer (and resolve the follow-up
// discard pick). Returns observations.
function drive(hand) {
  ai.seedAI(1);
  const G = createGame(data, { seed: 7, autoSetupUnits: true, expansion: { enabled: true } });
  G.rebel.objectiveHand = [...hand];
  const repBefore = G.reputationMarker;
  G.pendingChoice = { kind: 'PlayObjective', side: 'Rebel', legal: ['the-long-war-1'], window: 'refresh', allowDecline: true };
  let guard = 0;
  while (G.pendingChoice && guard++ < 6) { if (!ai.stepOnce(G, 'Rebel')) break; }
  const declined = (G.turnLog ?? []).some((e) => e.kind === 'objective-declined');
  const discarded = (G.turnLog ?? []).filter((e) => e.kind === 'the-long-war-discard').map((e) => e.payload?.discarded).flat().filter(Boolean);
  return { G, declined, discarded, repDelta: repBefore - G.reputationMarker, hand: G.rebel.objectiveHand };
}

console.log('[ #478 — AI plays The Long War on a clogged hand ]');
{
  // 5-card hand: Long War + protected DSP + 3 dead objectives → PLAY it,
  // discard 2 dead ones, keep Death Star Plans, gain 1 reputation.
  const r = drive(['the-long-war-1', 'death-star-plans-2', 'heart-of-the-empire-2', 'popular-support-2', 'establish-outposts-3']);
  check('clogged hand → The Long War is PLAYED (not declined)', !r.declined, 'declined');
  check('2 objectives were discarded as the cost', r.discarded.length === 2, `discarded=${JSON.stringify(r.discarded)}`);
  check('Death Star Plans was NOT discarded', !r.discarded.includes('death-star-plans-2'), `discarded=${JSON.stringify(r.discarded)}`);
  check('reputation advanced by 1', r.repDelta === 1, `delta=${r.repDelta}`);
  check('Long War left the hand (scored)', !r.hand.includes('the-long-war-1'));
}
console.log('\n[ #478 — small hand still declines (option value preserved) ]');
{
  // 3-card hand (below the 4-card pressure threshold) → keep declining.
  const r = drive(['the-long-war-1', 'heart-of-the-empire-2', 'popular-support-2']);
  check('small hand → still declines', r.declined && r.repDelta === 0, `declined=${r.declined} delta=${r.repDelta}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
