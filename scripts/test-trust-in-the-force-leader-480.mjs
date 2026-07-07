// #480 — "Trust in the Force" names TWO qualifying leaders (Jyn Erso OR Chirrut
// Imwe): "Place this leader in a subjugated system." When both are in the pool
// the PLAYER must choose which to place — the engine was auto-taking the first
// (Jyn). Now it raises a leader choice first, then the system pick, and honours
// the chosen leader. With only one eligible, no choice is raised (auto-placed).
// Run: node scripts/test-trust-in-the-force-leader-480.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const choices = await import('../src/engine/choices.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const CARD = 'trust-in-the-force';
const SYS = 'tatooine';
function setup(bothEligible) {
  const G = createGame(data, { seed: 3, expansion: { enabled: true, roeUnits: true, roeMissionsRebel: true, roeMissionsEmpire: true } });
  G.phase = 'Assignment'; G.currentPlayer = 'Rebel'; G.pendingChoice = undefined;
  // A subjugated system (legal target for the placement).
  G.map.systems[SYS].subjugated = true; G.map.systems[SYS].loyalty = 'empire';
  // Put the card in hand and the eligible leaders in the pool.
  const f = G.rebel;
  if (!f.actionHand.includes(CARD)) f.actionHand.push(CARD);
  for (const list of Object.values(f.leadersOnBoard)) { for (const lid of ['jyn-erso', 'chirrut-imwe']) { const k = list.indexOf(lid); if (k >= 0) list.splice(k, 1); } }
  for (const lid of ['jyn-erso', 'chirrut-imwe']) { const k = f.leaderPool.indexOf(lid); if (k >= 0) f.leaderPool.splice(k, 1); }
  f.leaderPool.push('jyn-erso');
  if (bothEligible) f.leaderPool.push('chirrut-imwe');
  // Open the "which card to play" choice, then select Trust in the Force.
  G.pendingChoice = { kind: 'PlayAssignmentActionCard', side: 'Rebel', candidates: [CARD] };
  return G;
}

console.log('[ both leaders eligible → a leader choice is raised, and honoured ]');
{
  const G = setup(true);
  const r = phases.playAssignmentActionCard(G, CARD);
  check('playing the card raises a generic leader Choice', r.ok && G.pendingChoice?.kind === 'Choice' && G.pendingChoice.tag === 'assignment-card-leader', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
  check('both Jyn and Chirrut are offered', (G.pendingChoice?.candidates ?? []).map((c) => c.id).sort().join(',') === 'chirrut-imwe,jyn-erso');
  // Choose Chirrut (NOT the auto-pick default of Jyn).
  const r2 = choices.resolveGenericChoice(G, ['chirrut-imwe']);
  check('choosing a leader resolves and posts the system pick', r2.ok && G.pendingChoice?.kind === 'ActionCardSystemPick', `pc=${G.pendingChoice?.kind}`);
  check('the chosen leader rides along on the system pick', G.pendingChoice?.chosenLeaderId === 'chirrut-imwe', `chosen=${G.pendingChoice?.chosenLeaderId}`);
  const r3 = phases.resolveActionCardSystemPick(G, SYS);
  check('resolving the system places CHIRRUT (the chosen one), not Jyn', r3.ok
    && (G.rebel.leadersOnBoard[SYS] ?? []).includes('chirrut-imwe')
    && !(G.rebel.leadersOnBoard[SYS] ?? []).includes('jyn-erso'),
    `at ${SYS}: ${JSON.stringify(G.rebel.leadersOnBoard[SYS])}`);
  check('Jyn stayed in the pool', G.rebel.leaderPool.includes('jyn-erso'));
}

console.log('[ only one leader eligible → no choice, auto-placed ]');
{
  const G = setup(false); // only Jyn
  const r = phases.playAssignmentActionCard(G, CARD);
  check('no leader Choice raised (straight to system pick)', r.ok && G.pendingChoice?.kind === 'ActionCardSystemPick', `pc=${G.pendingChoice?.kind}/${G.pendingChoice?.tag}`);
  const r3 = phases.resolveActionCardSystemPick(G, SYS);
  check('Jyn auto-placed at the system', r3.ok && (G.rebel.leadersOnBoard[SYS] ?? []).includes('jyn-erso'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
