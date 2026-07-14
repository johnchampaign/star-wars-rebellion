// #570: When a human plays a CONDITIONAL-deal cinematic tactic (Swarm Tactics
// primary — "if you have more fighters, deal 1 damage") whose condition holds,
// the game must let the playing side CHOOSE which enemy unit eats the damage,
// exactly like a plain deal (Rogue Squadron Support). Previously condDeal
// auto-assigned to the cheapest-to-kill enemy with no prompt.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(await import('tsx/esm/api')).register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const core = await import('../src/engine/combat.ts');
const lj = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: lj('systems.json'), adjacency: lj('adjacency.json'), leaders: lj('leaders.json'), actions: lj('actions.json'), missions: lj('missions.json'), objectives: lj('objectives.json'), tactics: lj('tactics.json'), probes: lj('probes.json') };
const baseOpts = (seed) => ({ seed, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'], forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } });
let fail = 0;
const check = (n, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (c ? '' : `  — ${extra}`)); if (!c) fail++; };

// Drive combat: decline the preliminary add-leader / start-action-card choices,
// have Empire play Swarm Tactics primary and Rebel decline its tactic, and stop
// as soon as a CinematicTargetPick (or anything unexpected) pauses.
function driveSelections(G) {
  core.runCombat(G);
  let guard = 0;
  while (G.pendingChoice && guard++ < 40) {
    const pc = G.pendingChoice;
    if (pc.kind === 'CombatAddLeaderPick') {
      core.resolveCombatAddLeaderPick(G, null);
    } else if (pc.kind === 'CombatStartActionCards') {
      core.resolveCombatStartActionCards(G, []); // play no start-of-combat cards
    } else if (pc.kind === 'CinematicTacticSelect') {
      if (pc.side === 'Empire') {
        const opt = pc.options.find((o) => o.cardId === 'cin-empire-space-swarm-tactics');
        if (opt && opt.primaryUsable) core.resolveCinematicTacticSelect(G, 'cin-empire-space-swarm-tactics', true);
        else core.resolveCinematicTacticSelect(G, null, false);
      } else {
        core.resolveCinematicTacticSelect(G, null, false); // Rebel declines
      }
    } else {
      break; // CinematicTargetPick or any other pause — hand back to the test
    }
  }
}

console.log('[ #570 — Swarm Tactics (condition met) posts a player target pick ]');
{
  const G = createGame(data, baseOpts(770));
  for (let i = 0; i < 3; i++) M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia'); // 3 Imperial fighters
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');                          // attacker capital
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');                                   // 1 Rebel fighter (cond: 3>1 holds)
  M.deployUnit(G, 'Rebel', 'corellian-corvette', 'felucia');
  M.deployUnit(G, 'Rebel', 'corellian-corvette', 'felucia');                       // 2 capitals → 3 targets total
  const cvA = G.map.systems.felucia.units.find((u) => u.typeId === 'corellian-corvette');
  core.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveSelections(G);
  const pc = G.pendingChoice;
  check('a CinematicTargetPick was posted (not auto-assigned)',
    !!pc && pc.kind === 'CinematicTargetPick' && pc.side === 'Empire',
    `pendingChoice=${pc?.kind}`);
  check('the pick offers 2+ Rebel targets', !!pc && pc.candidates && pc.candidates.length >= 2,
    `candidates=${pc?.candidates?.length}`);

  // Choose a corvette (2 health) — the auto-picker would have hit the x-wing
  // (cheapest to kill), so choosing the corvette proves the human's pick wins.
  const chosen = cvA.instanceId;
  check('chosen corvette IS a legal candidate', pc.candidates.includes(chosen));
  const before = G.map.systems.felucia.units.find((u) => u.instanceId === chosen)?.damage ?? -1;
  const r = core.resolveCinematicTargetPick(G, chosen);
  check('resolve ok', r.ok, r.reason);
  const after = G.map.systems.felucia.units.find((u) => u.instanceId === chosen);
  const staged = (G.pendingCombat?.theaterStaged ?? []).includes(chosen);
  check('the chosen corvette took the damage (dmg up or staged)',
    (after && after.damage === before + 1) || staged,
    `before=${before} after=${after?.damage} staged=${staged}`);
  // The x-wing (auto-pick target) should be UNTOUCHED.
  const xw = G.map.systems.felucia.units.find((u) => u.typeId === 'x-wing');
  check('the cheapest-to-kill x-wing was NOT auto-hit', !!xw && xw.damage === 0,
    `x-wing dmg=${xw?.damage}`);
}

console.log('[ #570 — Swarm Tactics with condition NOT met deals nothing, no pick ]');
{
  const G = createGame(data, baseOpts(771));
  M.deployUnit(G, 'Empire', 'tie-fighter', 'felucia');            // 1 Imperial fighter
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');                  // 2 Rebel fighters → cond fails
  M.deployUnit(G, 'Rebel', 'corellian-corvette', 'felucia');
  core.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveSelections(G);
  const pc = G.pendingChoice;
  // Condition fails → Swarm Tactics top isn't usable, so the drive declines it;
  // no CinematicTargetPick should ever appear for Empire from this card.
  check('no target pick posted when Empire is behind on fighters',
    !pc || pc.kind !== 'CinematicTargetPick', `pendingChoice=${pc?.kind}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nAll #570 target-pick tests passed');
process.exit(fail ? 1 : 0);
