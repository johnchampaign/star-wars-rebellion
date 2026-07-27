// #657 follow-up — the FIRST attempt at this fix was inert. It was applied to
// mechanics.drawAction, which has zero callers in src/: the recruit step in
// phases.ts draws by shifting `actionDeck` directly, so a depleted deck still
// silently skipped the recruit. The bundle proved it — the new log string was
// tree-shaken out of dist entirely.
//
// So this test drives the REAL recruit path rather than the helper, which is
// the whole point: a test that exercises a function nothing calls proves
// nothing about the game.
//
// Run: node scripts/test-action-deck-reshuffle-657.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const phases = await import('../src/engine/phases.ts');

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

/** Play turn 1 out so the round rolls into Refresh, where time advances to 2 —
 *  a recruit turn. `prep` runs just before the pass that triggers Refresh. */
function toRecruitTurn(seed, prep) {
  const G = createGame(data, { seed, roeUnits: true, roeMissions: true });
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  prep(G);
  phases.pass(G, 'Rebel'); phases.pass(G, 'Empire');
  return G;
}

console.log('\n[ the recruit step recycles a depleted action deck ]');
{
  let rebelPool = [];
  const G = toRecruitTurn(657, (g) => {
    for (const f of [g.rebel, g.empire]) {
      f.actionDiscard = [...f.actionDeck];  // everything is spent...
      f.actionDeck = [];                    // ...and the deck is empty
    }
    // Every Rebel action card that exists at this moment, wherever it sits.
    rebelPool = [...g.rebel.actionDeck, ...g.rebel.actionHand, ...g.rebel.actionDiscard];
  });

  check('reached the recruit turn', G.timeMarker === 2, `timeMarker=${G.timeMarker}`);
  const reshuffles = G.turnLog.filter((l) => l.kind === 'action-deck-reshuffled');
  check('a reshuffle happened during the recruit step', reshuffles.length > 0,
    `logged=${reshuffles.length}`);
  check('both sides recycled', new Set(reshuffles.map((l) => l.side)).size === 2,
    `sides=${JSON.stringify(reshuffles.map((l) => l.side))}`);
  const pick = G.pendingChoice;
  check('a recruit pick was actually offered', pick?.kind === 'RecruitActionCardPick'
    && (pick.drawnIds?.length ?? 0) === 2, `got ${pick?.kind} ${JSON.stringify(pick?.drawnIds)}`);
  check('no Rebel action card was duplicated or lost', (() => {
    const drawn = (G.refreshPaused?.pendingRecruitPicks ?? [])
      .flatMap((p) => (p.side === 'Rebel' ? p.drawnIds : []));
    const seen = [...G.rebel.actionDeck, ...G.rebel.actionHand, ...G.rebel.actionDiscard, ...drawn];
    return seen.slice().sort().join() === rebelPool.slice().sort().join();
  })(), 'card conservation broken');
}

console.log('\n[ nothing to recycle → recruit is skipped, no crash ]');
{
  let threw = null;
  let G;
  try {
    G = toRecruitTurn(658, (g) => {
      for (const f of [g.rebel, g.empire]) { f.actionDeck = []; f.actionDiscard = []; }
    });
  } catch (e) { threw = e; }
  check('no crash with both deck and discard empty', threw === null, String(threw));
  check('no spurious reshuffle logged',
    !G.turnLog.some((l) => l.kind === 'action-deck-reshuffled'));
}

console.log('\n[ a stocked deck is left alone ]');
{
  let before = 0;
  const G = toRecruitTurn(659, (g) => {
    before = g.rebel.actionDeck.length;
    g.rebel.actionDiscard = ['post-bounty'];
  });
  check('no reshuffle while the deck still had cards',
    !G.turnLog.some((l) => l.kind === 'action-deck-reshuffled' && l.side === 'Rebel'));
  check('the discard was not consumed', G.rebel.actionDiscard.includes('post-bounty'));
  check('cards were drawn from the existing deck', G.rebel.actionDeck.length < before,
    `before=${before} after=${G.rebel.actionDeck.length}`);
}

console.log('\n[ the helper is reachable and reports honestly ]');
{
  const G = createGame(data, { seed: 660, autoSetupUnits: true });
  G.empire.actionDeck = [];
  G.empire.actionDiscard = ['early-promotion', 'post-bounty'];
  check('returns true when it recycles', M.refillActionDeckFromDiscard(G, 'Empire') === true);
  check('deck refilled', G.empire.actionDeck.length === 2);
  check('returns false when there is nothing to do',
    M.refillActionDeckFromDiscard(G, 'Empire') === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
