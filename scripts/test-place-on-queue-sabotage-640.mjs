// #640 — "Temporary Alliance failed to place units on the build queue when used
// in a sabotaged system."
//
// The reporter was right. RR "Build Units":
//   "When an ability allows a player to place units on the build queue, these
//    units are taken from the supply.
//     > If the ability is resolved in a system, it can be performed even if
//       there is a sabotage marker in the system."
//
// The sabotage entry's "abilities cannot 'build' or 'deploy' units in a system
// that contains a sabotage marker" is about the Refresh-Phase build step using
// the system's resource icons — not about a card ability that PLACES onto the
// queue. Temporary Alliance (Rebel) and Brilliant Administrator (Empire) were
// the only two paths that wrongly no-op'd on sabotage; the queueBuildFromIcons
// path (Construct Factory / Address Delays / Establish Trade Relations) never
// did. RR also says "Sabotage markers affect both factions equally", so this is
// asserted symmetrically.
//
// Run: node scripts/test-place-on-queue-sabotage-640.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** Build a game and run an Assignment action card at `systemId`, with that
 *  system optionally sabotaged. Returns the pendingChoice that resulted. */
function playCardAt(cardId, side, pickSystem, { sabotage }) {
  const G = createGame(data, { seed: 11, autoSetupUnits: true });
  G.phase = 'Command'; G.currentPlayer = side; G.passedThisCommand = [];
  const f = side === 'Rebel' ? G.rebel : G.empire;
  // Make sure the card is in hand and its required leader is in the pool.
  if (!f.actionHand.includes(cardId)) f.actionHand.push(cardId);
  for (const lid of (G.catalog.actions[cardId].leaderRequirement ?? [])) {
    if (!f.leaderPool.includes(lid)) f.leaderPool.push(lid);
    f.eliminatedLeaders = f.eliminatedLeaders.filter((l) => l !== lid);
    for (const list of Object.values(f.leadersOnBoard)) {
      const i = list.indexOf(lid); if (i >= 0) list.splice(i, 1);
    }
  }
  G.pendingChoice = { kind: 'PlayAssignmentActionCard', side, candidates: [cardId] };
  const played = phases.playAssignmentActionCard(G, cardId);
  if (!played.ok) return { G, error: `play failed: ${played.reason}` };
  const pc = G.pendingChoice;
  if (!pc || pc.kind !== 'ActionCardSystemPick') {
    return { G, error: `expected a system pick, got ${pc?.kind ?? 'none'}` };
  }
  const systemId = pickSystem(G, pc.candidates);
  if (!systemId) return { G, error: 'no candidate system matched' };
  G.map.systems[systemId].sabotage = !!sabotage;
  const r = phases.resolveActionCardSystemPick(G, systemId);
  return { G, systemId, resolveOk: r.ok, resolveReason: r.reason, choice: G.pendingChoice };
}

// A candidate that actually has resource icons — otherwise the card legitimately
// no-ops for "no-build-icons" and the test would prove nothing.
const withIcons = (G, cands) =>
  cands.find((sid) => G.catalog.systems[sid]?.buildSlot && (G.catalog.systems[sid]?.resources?.length ?? 0) > 0);

console.log('[ #640 — Temporary Alliance (Rebel) places on the queue despite sabotage ]');
{
  const clean = playCardAt('temporary-alliance', 'Rebel', withIcons, { sabotage: false });
  check('clean system: card resolves', !clean.error, clean.error ?? '');
  check('clean system: posts the build pick',
    clean.choice?.kind === 'TemporaryAllianceBuildPick', `got ${clean.choice?.kind}`);

  const sab = playCardAt('temporary-alliance', 'Rebel', withIcons, { sabotage: true });
  check('sabotaged system: card resolves', !sab.error, sab.error ?? '');
  check('sabotaged system: STILL posts the build pick (RR "Build Units")',
    sab.choice?.kind === 'TemporaryAllianceBuildPick', `got ${sab.choice?.kind}`);
  check('sabotaged system: same icon count as the clean run',
    sab.choice?.icons?.length === clean.choice?.icons?.length,
    `sab=${sab.choice?.icons?.length} clean=${clean.choice?.icons?.length}`);
  check('sabotaged system: no sabotage-blocks-build no-op was logged',
    !G_log(sab.G).some((e) => e.payload?.reason === 'sabotage-blocks-build'),
    'engine still logged sabotage-blocks-build');
  check('the sabotage marker is NOT consumed (only Construct Factory removes it)',
    sab.G.map.systems[sab.systemId].sabotage === true, 'marker was cleared');
}

console.log('\n[ #640 — Brilliant Administrator (Empire) gets the same treatment ]');
{
  // RR: "Sabotage markers affect both factions equally."
  const impWithIcons = (G, cands) =>
    cands.find((sid) => G.catalog.systems[sid]?.buildSlot && (G.catalog.systems[sid]?.resources?.length ?? 0) > 0);
  const clean = playCardAt('brilliant-administrator', 'Empire', impWithIcons, { sabotage: false });
  check('clean system: posts the build pick',
    clean.choice?.kind === 'BrilliantAdministratorBuildPick', clean.error ?? `got ${clean.choice?.kind}`);

  const sab = playCardAt('brilliant-administrator', 'Empire', impWithIcons, { sabotage: true });
  check('sabotaged system: STILL posts the build pick',
    sab.choice?.kind === 'BrilliantAdministratorBuildPick', sab.error ?? `got ${sab.choice?.kind}`);
  check('sabotaged system: no sabotage-blocks-build no-op was logged',
    !G_log(sab.G).some((e) => e.payload?.reason === 'sabotage-blocks-build'),
    'engine still logged sabotage-blocks-build');
}

console.log('\n[ regression guard — the Refresh build step STILL respects sabotage ]');
{
  // The fix must not leak into the normal build step: RR is explicit that a
  // sabotage marker "prevents the system from using its resource icons to build
  // units ... during the Refresh Phase."
  const src = readFileSync(join(ROOT, 'src/engine/phases.ts'), 'utf8');
  check('Refresh build step still skips sabotaged systems',
    /ss\.destroyed \|\| ss\.sabotage\) continue;/.test(src), 'the build-step sabotage skip is gone');
  check('deploy targeting still excludes sabotaged systems',
    /ss\.destroyed \|\| ss\.sabotage\) return false;/.test(src), 'the deploy sabotage filter is gone');
}

function G_log(G) { return (G?.log ?? G?.eventLog ?? []); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
