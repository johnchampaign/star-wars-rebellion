// #731 — "Catch them by surprise did not allow bringing captured leader.
// Specifically, dialog box for moving units during this action card does not
// account for captured leader and no other message regarding captured leader
// appeared."
//
// The reporter quoted the RR captured-leader movement rule; a second player
// (zssullivan) then quoted the FAQ, which settles it explicitly — and that
// entry is verbatim in our own reports/faq.txt:
//
//   QQ: Can captured leaders be moved with the "Independent Operation" action
//       card?
//   AA: No. However, if an Imperial card allows the Imperial player to move
//       units to an adjacent system, he can move leaders with the units as
//       long as he follows the normal movement rules.
//
// Independent Operation is the ONE carve-out. Catch Them By Surprise ("Place
// this leader in any system. Then move Imperial units from adjacent systems to
// this system") is an Imperial card that moves units between adjacent systems,
// so the escort is allowed.
//
// The escort rule was built for activateSystem (#595) and simply never
// extended to this card's resolver — so the player was offered nothing, and
// the captive was auto-rescued the instant the prison emptied.
//
// Run: node scripts/test-catch-surprise-captive-731.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const TARGET = 'corellia';
/** Ozzel placed at TARGET; Imperial units + a captured Rebel leader in an
 *  adjacent prison system, ready to be pulled in by the card. */
function board(seed) {
  const G = createGame(data, { seed, expansion: { enabled: true, roeUnits: true } });
  const prison = (G.catalog.adjacency[TARGET] ?? [])[0];
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  G.map.systems[prison].units = [
    { instanceId: 'sd1', typeId: 'star-destroyer', side: 'Empire', damage: 0 },
    { instanceId: 'st1', typeId: 'stormtrooper', side: 'Empire', damage: 0 },
  ];
  G.empire.capturedLeaders = [{ leaderId: 'princess-leia', systemId: prison }];
  G.pendingChoice = {
    kind: 'CatchThemBySurpriseMovePick', side: 'Empire',
    targetSystemId: TARGET, candidateSourceSystemIds: [prison],
  };
  return { G, prison };
}
const captiveAt = (G) => (G.empire.capturedLeaders ?? []).find((c) => c.leaderId === 'princess-leia')?.systemId;

console.log('\n[ the captive can now be escorted by the card move ]');
{
  const { G, prison } = board(731);
  check('the captive starts in the prison system', captiveAt(G) === prison, String(captiveAt(G)));
  const r = phases.resolveCatchThemBySurpriseMovePick(
    G, [{ fromSystemId: prison, unitInstanceIds: ['sd1', 'st1'] }], ['princess-leia']);
  check('the move resolved', r.ok === true, JSON.stringify(r));
  check('and the captive travelled with the units', captiveAt(G) === TARGET, String(captiveAt(G)));
  check('the move is logged as a captured-leader move',
    (G.turnLog ?? []).some((e) => e.kind === 'captured-leader-moved'
      && e.payload?.leaderId === 'princess-leia' && e.payload?.toSystemId === TARGET));
}

console.log('\n[ declining the escort is still legal — the escort is OPTIONAL ]');
{
  const { G, prison } = board(732);
  const r = phases.resolveCatchThemBySurpriseMovePick(
    G, [{ fromSystemId: prison, unitInstanceIds: ['sd1', 'st1'] }], []);
  check('the move resolved without an escort', r.ok === true, JSON.stringify(r));
  // Leaving the captive behind when the prison empties frees them — that is the
  // pre-existing invariant, and the whole reason the choice matters.
  check('a captive left behind is NOT silently dragged along', captiveAt(G) !== TARGET,
    `captive at ${captiveAt(G)}`);
}

console.log('\n[ validation mirrors the activation path, before any mutation ]');
{
  const { G, prison } = board(733);
  const before = captiveAt(G);
  const r = phases.resolveCatchThemBySurpriseMovePick(
    G, [{ fromSystemId: prison, unitInstanceIds: [] }], ['princess-leia']);
  check('escorting with NO moving units is refused', r.ok === false && /captive-escort-needs-moving-units/.test(r.reason ?? ''),
    JSON.stringify(r));
  check('  …and the board is untouched by the rejection', captiveAt(G) === before);
}
{
  const { G, prison } = board(734);
  const r = phases.resolveCatchThemBySurpriseMovePick(
    G, [{ fromSystemId: prison, unitInstanceIds: ['sd1'] }], ['luke-skywalker']);
  check('escorting a leader who is not captured is refused',
    r.ok === false && /not-a-captured-leader/.test(r.reason ?? ''), JSON.stringify(r));
}

console.log('\n[ the FAQ carve-out is real: this is not Independent Operation ]');
{
  const faq = readFileSync(join(ROOT, 'reports', 'faq.txt'), 'utf8').replace(/\s+/g, ' ');
  check('our FAQ contains the entry the reporter was quoted',
    /if an Imperial card allows the Imperial player to move units to an adjacent system, he can move leaders with the units/i.test(faq));
  const card = (data.actions.actions ?? data.actions).find?.((a) => a.id === 'catch-them-by-surprise')
    ?? Object.values(data.actions.actions ?? data.actions).find((a) => a.id === 'catch-them-by-surprise');
  check('and the card really does move units between adjacent systems',
    /move Imperial units from adjacent systems to this system/i.test(card?.rulesText ?? ''), card?.rulesText);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
