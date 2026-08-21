// #733 — battle-result splash appeared BEFORE the "who moved in" screen.
//        The activation report and the combat report it spawns are stamped from
//        the SAME turnLog length (activateSystem pushes its report, then
//        beginCombat stamps seq before logging combat-begin), so the seq sort
//        tied and the stable kind priority put combat first. The move is the
//        cause of the fight, so on a tie the activation must win.
// #732 — a played action card is public (RR "Action Cards": "he flips the card
//        faceup, resolves its ability, and then returns it to the game box").
//        Two things hid it: online per-seat redaction default-denied the
//        'action-card-play' kind, so the opponent's view never carried it at
//        all; and offline the only surface was the raw JSON log. Pin BOTH —
//        the entry survives redaction, and the opponent-activity banner names
//        it — while the card's SEARCH result stays private either way.
// Run: node scripts/test-report-order-732-733.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const { activateSystem } = await import('../src/engine/phases.ts');
const { nextReportKind } = await import('../src/play/reportQueue.ts');
const { PUBLIC_LOG_KINDS } = await import('../src/adapter/redact.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

/** Drive the REAL ordering rule the UI uses (src/play/reportQueue.ts) — not a
 *  copy of it — with the eligibility gate PlayTab applies to activations. */
function firstReport(G) {
  const ar = G.activationReports?.[0];
  const activationEligible = !!ar && !G.pendingMission && !G.pendingCombat && !G.pendingChoice;
  return nextReportKind({
    combat: G.combatReports?.[0],
    mission: G.missionReports?.[0],
    objective: G.objectiveReports?.[0],
    refresh: G.refreshReports?.[0],
    activation: activationEligible ? ar : undefined,
  });
}

console.log('\n[ #733 the move screen shows before the battle it caused ]');
{
  const G = createGame(data, { seed: 733, expansion: { enabled: false } });
  // Clean two-system setup: Imperial ships next door to a lone Rebel ship.
  for (const id of Object.keys(G.map.systems)) G.map.systems[id].units = [];
  const from = 'coruscant';
  const to = G.catalog.adjacency[from][0];
  M.deployUnit(G, 'Empire', 'star-destroyer', from);
  M.deployUnit(G, 'Empire', 'star-destroyer', from);
  M.deployUnit(G, 'Rebel', 'corellian-corvette', to);
  const ldr = 'darth-vader';
  if (!G.empire.leaderPool.includes(ldr)) G.empire.leaderPool.push(ldr);
  G.phase = 'Command';
  G.currentPlayer = 'Empire';

  const moving = G.map.systems[from].units.filter((u) => u.side === 'Empire').map((u) => u.instanceId);
  const res = activateSystem(G, 'Empire', ldr, to, [{ fromSystemId: from, unitInstanceIds: moving }]);
  check('activation succeeded', res.ok === true, JSON.stringify(res));

  const ar = G.activationReports?.[0];
  check('an activation report was queued', !!ar);
  check('it is flagged as having started the combat', ar?.startedCombat === true);
  // The combat this activation spawned is live (it pauses for dice/tactic
  // choices), so its report is still on pendingCombat. That report already
  // carries the seq it will keep when endCombat queues it.
  const liveReport = G.pendingCombat?.report;
  check('the spawned combat carries its start-stamped report', !!liveReport);
  // The regression itself: the two stamps tie, which is exactly why the old
  // priority-only tiebreak mis-ordered them.
  check('the two reports tie on seq (the #733 trigger)', (ar?.seq ?? -1) === (liveReport?.seq ?? -2),
    `activation seq=${ar?.seq} combat seq=${liveReport?.seq}`);

  // Model the moment both modals become eligible: the fight has fully resolved,
  // so pendingCombat/pendingChoice are clear and the report has been queued.
  G.combatReports = [liveReport];
  G.pendingCombat = undefined;
  G.pendingChoice = undefined;
  check('the MOVE screen is chosen first', firstReport(G) === 'activation', `got ${firstReport(G)}`);

  // Once the move screen is acknowledged, the battle result is next.
  G.activationReports.shift();
  check('the battle result follows it', firstReport(G) === 'combat', `got ${firstReport(G)}`);
}

console.log('\n[ #733 an activation that started no combat still yields to earlier reports ]');
{
  const G = createGame(data, { seed: 7331, expansion: { enabled: false } });
  G.activationReports = [{ side: 'Empire', leaderId: 'darth-vader', targetSystemId: 'coruscant',
    moves: [], startedCombat: false, seq: 10 }];
  G.combatReports = [{ systemId: 'coruscant', attackerSide: 'Rebel', addedLeaders: [], rounds: [],
    structureDestructions: [], retreatDestructions: [], winner: null, totalRounds: 0, seq: 10 }];
  check('a non-combat activation does NOT jump the queue', firstReport(G) === 'combat',
    `got ${firstReport(G)}`);
}

console.log('\n[ #732 a played action card is logged publicly, with a nameable id ]');
{
  const G = createGame(data, { seed: 732, expansion: { enabled: false } });
  // The banner reads cardId from 'action-card-play' and card from
  // 'combat-action-card'. Both must resolve through catalog.actions.
  const ids = Object.keys(G.catalog.actions);
  check('the catalog can name action cards', ids.length > 0 && !!G.catalog.actions[ids[0]].name);
  check('every action card has rules text for the hover', ids.every((id) => typeof G.catalog.actions[id].rulesText === 'string'));

  // Online: the opponent's seat must actually RECEIVE the play (#732). Anything
  // the card then searches for must not come with it.
  check("'action-card-play' survives per-seat redaction",
    PUBLIC_LOG_KINDS.has('action-card-play'));
  check("start-of-combat plays survive too", PUBLIC_LOG_KINDS.has('combat-action-card'));
  for (const secret of ['proceeding-as-planned-applied', 'our-most-desperate-hour-applied',
    'son-of-skywalker-applied', 'contingency-plan-applied']) {
    check(`the card's search RESULT stays private (${secret})`, !PUBLIC_LOG_KINDS.has(secret));
  }

  const src = readFileSync(join(ROOT, 'src/play/PlayTab.tsx'), 'utf-8');
  check("the banner summarizer handles 'action-card-play'",
    /e\.kind === 'action-card-play'/.test(src));
  check("the banner summarizer handles 'combat-action-card'",
    /e\.kind === 'combat-action-card'/.test(src));
  // A played card must never be hidden or payload-redacted on screen: RAW makes
  // it faceup. (What the card SEARCHES for stays private via the *-applied
  // redactions, which are separate kinds.)
  const hidden = src.slice(src.indexOf('const ONSCREEN_HIDDEN_KINDS'), src.indexOf('const OWNER_ONLY_KINDS'));
  check("'action-card-play' is not hidden or redacted on screen",
    !hidden.includes("'action-card-play'") && !hidden.includes("'combat-action-card'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
