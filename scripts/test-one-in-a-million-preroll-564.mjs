// #564 — "I really don't like how One-In-A-Million is implemented. It's
// nothing like any other card / ability in the game." Third report on the
// same UX after #543 ("VERY strange") and #544 (a player who thought the card
// was BLOCKED because a toggle was off).
//
// The card: "Use during a combat or mission — instead of rolling up to two
// dice, place them on the table showing results of your choice."
//
// The decision to play it is made BEFORE the roll, blind. The old engine
// rolled first and then showed the Rebel the results before asking — a
// reactive save the card does not grant — and because that would nag on every
// eligible roll, the UI suppressed the offer behind an "arm it" toggle, which
// then made the card look broken to anyone who never found the toggle. Five
// reports (#340, #448, #543, #544, #614) patched around that one design error.
//
// Now: the offer is made in beginAttack BEFORE any die is rolled, with the pool
// (colours only) decided but unrolled. The Rebel places up to 2 dice showing
// chosen faces or declines; everything else rolls. The toggle is gone — the
// prompt fires only with the card in hand and Luke/Wedge present, so it is a
// genuine one-time decision, not a nag.
//
// The Death Star Plans objective roll keeps the post-roll window on purpose:
// the card is explicitly "an automatic success" there, so the answer is
// trivially yes and showing the dice first changes nothing.
//
// Run: node scripts/test-one-in-a-million-preroll-564.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

const SYS = 'corellia';
/** Rebel attack at SYS with Luke present and the card in hand. */
function attack(seed, { withLuke = true, withCard = true } = {}) {
  const G = createGame(data, { seed });
  G.map.systems[SYS].units = [
    { instanceId: 'sd1', typeId: 'star-destroyer', side: 'Empire', damage: 0 },
    { instanceId: 'xw1', typeId: 'x-wing', side: 'Rebel', damage: 0 },
    { instanceId: 'yw1', typeId: 'y-wing', side: 'Rebel', damage: 0 },
    { instanceId: 'cc1', typeId: 'corellian-corvette', side: 'Rebel', damage: 0 },
  ];
  G.rebel.actionHand = withCard ? ['one-in-a-million'] : [];
  G.empire.actionHand = [];
  G.rebel.leaderPool = []; G.empire.leaderPool = [];
  if (withLuke) M.placeLeader(G, 'Rebel', 'luke-skywalker', SYS);
  combat.beginCombat(G, 'Rebel', [SYS], SYS);
  const c = G.pendingCombat;
  c.activeTheater = 'space'; c.theaterStaged = []; c.theaterAttackersDone = [];
  combat.beginAttack(G, c, 'Rebel', 'space');
  return { G, c };
}

console.log('\n[ the offer comes BEFORE the roll, and the Rebel sees no faces ]');
{
  const { G, c } = attack(564);
  const pc = G.pendingChoice;
  check('a One In A Million offer is pending', pc?.kind === 'OneInAMillionOffer' && pc.context === 'combat',
    String(pc?.kind));
  check('it is flagged as the pre-roll offer', pc?.preRoll === true);
  check('NO dice have been rolled yet', (c.pendingAttack?.dice ?? []).length === 0,
    `dice=${JSON.stringify(c.pendingAttack?.dice)}`);
  check('the pool is staged unrolled (colours only)', (c.pendingAttack?.unrolledColors ?? []).length > 0);
  check('the offer exposes no die results', (pc?.faces ?? []).every((f) => f === 'unrolled'),
    JSON.stringify(pc?.faces));
  check('but it does say how many dice, and their colours',
    (pc?.colors ?? []).length === (c.pendingAttack?.unrolledColors ?? []).length && (pc?.colors ?? []).length > 0);
}

console.log('\n[ playing it: chosen dice are PLACED, the rest roll ]');
{
  const { G, c } = attack(565);
  const n = G.pendingChoice.colors.length;
  const r = combat.resolveOneInAMillionCombat(G, [{ index: 0, face: 'direct-hit' }, { index: 1, face: 'direct-hit' }]);
  check('the play resolved', r.ok === true, JSON.stringify(r));
  const dice = c.pendingAttack?.dice ?? [];
  check('all dice now exist', dice.length === n, `dice=${dice.length} pool=${n}`);
  check('the two placed dice show the chosen faces',
    dice[0]?.face === 'direct-hit' && dice[1]?.face === 'direct-hit', JSON.stringify(dice.slice(0, 2)));
  check('the staged pool is cleared', c.pendingAttack?.unrolledColors === undefined);
  check('the card is discarded', !G.rebel.actionHand.includes('one-in-a-million')
    && G.rebel.actionDiscard.includes('one-in-a-million'));
  check('the combat moved on past the offer', G.pendingChoice?.kind !== 'OneInAMillionOffer',
    String(G.pendingChoice?.kind));
}

console.log('\n[ declining: everything rolls, card stays in hand ]');
{
  const { G, c } = attack(566);
  const n = G.pendingChoice.colors.length;
  const r = combat.resolveOneInAMillionCombat(G, []);
  check('the decline resolved', r.ok === true, JSON.stringify(r));
  check('all dice were rolled', (c.pendingAttack?.dice ?? []).length === n);
  check('and every rolled die has a real face',
    (c.pendingAttack?.dice ?? []).every((d) => ['blank', 'hit', 'direct-hit', 'special'].includes(d.face)));
  check('the card is still in hand', G.rebel.actionHand.includes('one-in-a-million'));
}

console.log('\n[ the offer is a real one-time decision, not a nag ]');
{
  const { G: noLuke } = attack(567, { withLuke: false });
  check('no Luke/Wedge present → no offer, dice roll straight away',
    noLuke.pendingChoice?.kind !== 'OneInAMillionOffer' && (noLuke.pendingCombat?.pendingAttack?.dice ?? []).length > 0,
    String(noLuke.pendingChoice?.kind));
  const { G: noCard } = attack(568, { withCard: false });
  check('card not in hand → no offer',
    noCard.pendingChoice?.kind !== 'OneInAMillionOffer' && (noCard.pendingCombat?.pendingAttack?.dice ?? []).length > 0,
    String(noCard.pendingChoice?.kind));
}

console.log('\n[ validation still guards the placement ]');
{
  const { G } = attack(569);
  check('more than 2 placements is refused',
    combat.resolveOneInAMillionCombat(G, [{ index: 0, face: 'hit' }, { index: 1, face: 'hit' }, { index: 2, face: 'hit' }]).ok === false);
  check('an out-of-pool index is refused',
    combat.resolveOneInAMillionCombat(G, [{ index: 99, face: 'hit' }]).ok === false);
  check('a nonsense face is refused',
    combat.resolveOneInAMillionCombat(G, [{ index: 0, face: 'lightsaber' }]).ok === false);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
