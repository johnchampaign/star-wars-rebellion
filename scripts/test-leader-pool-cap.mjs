// Audit #13: RoE leader-pool 8-cap — the player CHOOSES which leader to
// eliminate (one per choice, chained); the AI drops the lowest-value leader.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };
const empLeaders = (G) => Object.values(G.catalog.leaders).filter((l) => l.side === 'Empire').map((l) => l.id);

console.log('[ #13: over cap → posts an elimination choice; resolver chains to 8 ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true } });
  G.empire.leaderPool = empLeaders(G).slice(0, 10); // 10 > cap 8
  G.empire.actionHand = []; // no Ambitions of Power in hand
  const posted = M.enforceLeaderPoolCap(G, 'Empire');
  check('over cap → posts LeaderPoolEliminate (Empire)',
    posted === true && G.pendingChoice?.kind === 'LeaderPoolEliminate' && G.pendingChoice.side === 'Empire');
  check('overBy = 2', G.pendingChoice.overBy === 2);
  check('candidates list the pool (10)', G.pendingChoice.candidates.length === 10);
  const pick = G.pendingChoice.candidates[0];
  phases.resolveLeaderPoolEliminate(G, pick);
  check('chosen leader removed from pool', !G.empire.leaderPool.includes(pick));
  check('chosen leader eliminated', (G.empire.eliminatedLeaders ?? []).includes(pick));
  check('still over by 1 → re-posts', G.pendingChoice?.kind === 'LeaderPoolEliminate' && G.pendingChoice.overBy === 1);
  phases.resolveLeaderPoolEliminate(G, G.pendingChoice.candidates[0]);
  check('now at cap 8 → no further choice', G.empire.leaderPool.length === 8 && G.pendingChoice == null);
}

console.log('[ #13: AI eliminates the LOWEST-value leader ]');
{
  const G = createGame(data, { seed: 5, expansion: { enabled: true } });
  const pool = empLeaders(G).slice(0, 9); // 9 > cap 8, exactly one to drop
  G.empire.leaderPool = [...pool];
  G.empire.actionHand = [];
  const value = (lid) => {
    const l = G.catalog.leaders[lid];
    return (l.tacticValues?.space ?? 0) + (l.tacticValues?.ground ?? 0)
      + Object.values(l.skills ?? {}).reduce((a, b) => a + (b ?? 0), 0)
      + Object.values(l.minorSkills ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  };
  const worst = [...pool].sort((a, b) => value(a) - value(b))[0];
  M.enforceLeaderPoolCap(G, 'Empire');
  check('AI faces the elimination choice', G.pendingChoice?.kind === 'LeaderPoolEliminate');
  stepOnce(G, 'Empire'); // AI resolves
  check('AI eliminated the lowest-value leader', (G.empire.eliminatedLeaders ?? []).includes(worst), `worst=${worst}`);
  check('AI pool now at cap', G.empire.leaderPool.length === 8 && G.pendingChoice == null);
}

console.log('[ #13: base game unaffected (cap is RoE-gated) ]');
{
  const G = createGame(data, { seed: 5 }); // no expansion
  G.empire.leaderPool = empLeaders(G).slice(0, 10);
  const posted = M.enforceLeaderPoolCap(G, 'Empire');
  check('base game: no elimination choice, pool untouched', !posted && G.pendingChoice == null && G.empire.leaderPool.length === 10);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #13 leader-pool-cap tests passed');
process.exit(fail ? 1 : 0);
