// Audit #15 (B): RoE Cinematic Confrontation — the Rebel CHOOSES which Imperial
// leader to mark for elimination (was auto highest-value). End-of-round hook
// now PAUSES with a ConfrontationLeaderPick; the AI picks the strongest.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const cin = await import('../src/engine/cinematicTactics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

// Find the Empire ground unit typeId from the catalog (for the destroyed-this-
// round report entry) and two Imperial leaders for the candidate list.
function fixtures(G) {
  const groundType = Object.values(G.catalog.unitTypes).find((t) => t.side === 'Empire' && t.theater === 'ground').id;
  const impLeaders = Object.values(G.catalog.leaders).filter((l) => l.side === 'Empire').map((l) => l.id);
  return { groundType, impLeaders };
}
function makeCombat(G, leaders, groundType) {
  G.empire.leadersOnBoard['felucia'] = [...leaders]; // present; NO empire ground here
  G.rebel.cinematicTacticDiscard = ['cin-rebel-ground-confrontation'];
  return {
    systemId: 'felucia', round: 1, cinematic: true,
    cinematicEndOfRound: [{ kind: 'confrontation', side: 'Rebel' }],
    report: { rounds: [{ round: 1, attacks: [{ destroyed: [{ typeId: groundType }] }] }] },
  };
}

console.log('[ #15B: last Imperial ground destroyed → posts ConfrontationLeaderPick ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true } });
  const { groundType, impLeaders } = fixtures(G);
  const two = impLeaders.slice(0, 2);
  const c = makeCombat(G, two, groundType);
  const paused = cin.resolveCinematicEndOfRound(G, c);
  check('returns true (paused)', paused === true);
  check('posts ConfrontationLeaderPick (Rebel)', G.pendingChoice?.kind === 'ConfrontationLeaderPick' && G.pendingChoice.side === 'Rebel');
  check('candidates = the Imperial leaders present', [...G.pendingChoice.candidates].sort().join(',') === [...two].sort().join(','));
  check('candidates strongest-first (sorted by tactic value desc)', (() => {
    const v = (l) => (G.catalog.leaders[l].tacticValues.space ?? 0) + (G.catalog.leaders[l].tacticValues.ground ?? 0);
    const cd = G.pendingChoice.candidates;
    return v(cd[0]) >= v(cd[1]);
  })());
  check('queue entry cleared (no re-fire next round)', (c.cinematicEndOfRound ?? []).every((e) => e.kind !== 'confrontation'));

  // Resolve to the WEAKER candidate (player's free choice, not the suggestion).
  const pick = G.pendingChoice.candidates[1];
  const r = combat.resolveConfrontationLeaderPick(G, pick);
  check('resolver ok', r.ok === true);
  check('chosen leader marked', (G.cinematicMarkedForElimination ?? []).includes(pick));
  // RAW "…and eliminate this card." — gone for the game. It is recorded as
  // eliminated and must NEVER be offered to play again (the old code spliced it
  // out of the discard, which made availableCards treat it as back in the deck).
  check('card recorded as eliminated', (G.rebel.cinematicTacticEliminated ?? []).includes('cin-rebel-ground-confrontation'));
  check('eliminated card not offered again (even after a deck recycle)',
    !cin.cinematicSelectOptions(G, c, 'Rebel', 'ground').some((o) => o.cardId === 'cin-rebel-ground-confrontation'));
  check('pendingChoice cleared', G.pendingChoice == null);
}

console.log('[ #15B: bad-candidate rejected ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true } });
  const { groundType, impLeaders } = fixtures(G);
  const c = makeCombat(G, impLeaders.slice(0, 2), groundType);
  cin.resolveCinematicEndOfRound(G, c);
  const r = combat.resolveConfrontationLeaderPick(G, 'not-a-real-leader');
  check('rejects a non-candidate', r.ok === false && r.reason === 'not-a-candidate');
  check('choice still pending', G.pendingChoice?.kind === 'ConfrontationLeaderPick');
}

console.log('[ #15B: AI marks the strongest Imperial leader ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true } });
  const { groundType, impLeaders } = fixtures(G);
  const two = impLeaders.slice(0, 2);
  const c = makeCombat(G, two, groundType);
  // Leave pendingCombat unset: the AI finds the choice via G.pendingChoice and
  // the resolver's runCombat no-ops without a (full) pendingCombat — we're only
  // asserting WHICH leader the AI marks, not the combat re-entry.
  cin.resolveCinematicEndOfRound(G, c);
  const strongest = G.pendingChoice.candidates[0];
  stepOnce(G, 'Rebel'); // AI controls Rebel here
  check('AI marked the strongest candidate', (G.cinematicMarkedForElimination ?? []).includes(strongest), `strongest=${strongest}`);
}

console.log('[ #15B: no Imperial leader present → no choice, no mark ]');
{
  const G = createGame(data, { seed: 7, expansion: { enabled: true } });
  const { groundType } = fixtures(G);
  const c = makeCombat(G, [], groundType); // no leaders on the system
  G.empire.leadersOnBoard['felucia'] = [];
  const paused = cin.resolveCinematicEndOfRound(G, c);
  check('no pause, no choice', paused === false && G.pendingChoice == null);
  check('nothing marked', (G.cinematicMarkedForElimination ?? []).length === 0);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #15B confrontation-leader-pick tests passed');
process.exit(fail ? 1 : 0);
