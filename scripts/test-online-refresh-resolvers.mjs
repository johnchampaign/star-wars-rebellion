// Online soft-lock: the Refresh-phase resolvers resolveHandLimitDiscard,
// declineDeployUnit, resolveLeaderPoolEliminate, resolveAssignSecondLeader were
// missing from the online adapter + shim, so an online game that hit a hand-limit
// discard (>10 missions) could never submit the discard to the server — it looped
// discard ↔ build with "Move rejected: no-pending-build", surviving reload
// (server-persisted). This verifies those actions now route through the adapter.
// Run: node scripts/test-online-refresh-resolvers.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const { rebellionAdapter } = await import('../src/adapter/rebellionAdapter.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

console.log('\n[ resolveHandLimitDiscard routes through the online adapter and resolves ]');
{
  const G = createGame(data, { seed: 7, autoSetupUnits: true });
  // Pad the Rebel mission hand to 11 (one over the limit) with a discardable card.
  const disc = 'sabotage';
  G.rebel.missionHand = [disc, 'build-alliance', 'public-uprising', 'infiltration', 'plant-false-lead',
    'support-of-mon-calamari', 'contingency-plan', 'hidden-fleet', 'demolition', 'heist', 'plan-the-assault'];
  G.pendingChoice = { kind: 'HandLimitDiscard', side: 'Rebel', count: 1, discardable: [disc] };
  G.pendingHandLimitDiscards = { logStart: G.turnLog.length, queue: [{ side: 'Rebel', count: 1, discardable: [disc] }] };

  const r = rebellionAdapter.tryApplyAction(G, { kind: 'resolveHandLimitDiscard', missionIds: [disc] }, 'Rebel');
  check('action is RECOGNIZED (not "Illegal action: resolveHandLimitDiscard")',
    !(r.reason ?? '').startsWith('Illegal action'), r.reason);
  check('discard resolved ok', r.ok, r.reason);
  check('the HandLimitDiscard choice is cleared', r.state.pendingChoice?.kind !== 'HandLimitDiscard',
    r.state.pendingChoice?.kind);
  check('the chosen mission left the hand', !r.state.rebel.missionHand.includes(disc) || r.state.rebel.missionHand.filter((m) => m === disc).length === 0);
}

console.log('\n[ the other three previously-unwired resolvers also route (no "Illegal action") ]');
{
  // With no matching pending choice they return the engine's own "no-pending"
  // reason — which PROVES they reach the resolver instead of being an unknown action.
  const G = createGame(data, { seed: 7, autoSetupUnits: true });
  for (const [action, label] of [
    [{ kind: 'declineDeployUnit' }, 'declineDeployUnit'],
    [{ kind: 'resolveLeaderPoolEliminate', leaderId: 'mon-mothma' }, 'resolveLeaderPoolEliminate'],
    [{ kind: 'resolveAssignSecondLeader', leaderId: null }, 'resolveAssignSecondLeader'],
  ]) {
    const r = rebellionAdapter.tryApplyAction(G, action, 'Rebel');
    check(`${label} routes to its resolver (not unknown action)`,
      !(r.reason ?? '').startsWith('Illegal action'), r.reason);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
