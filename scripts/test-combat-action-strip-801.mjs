// #801 — "My assault carrier should still have a chance to attack before it
// gets destroyed. Why do I only roll 1 black die?"
//
// RAW-correct: the Rebels played Baze's Loyalty (Start of Combat: "Destroy
// 2-health worth of units in this system") and the Assault Carrier has 2
// health, so it was gone before round 1 and only the TIE rolled. But the
// combat board never named the card — the "Units removed" tally showed the
// carrier with no cause, so it read as a dice bug. playedCombatActionsFor feeds
// an "Action cards played" strip naming the card and what it destroyed.
//
// Run: node scripts/test-combat-action-strip-801.mjs
const { register } = await import('tsx/esm/api'); register();
const { playedCombatActionsFor } = await import('../src/play/combatTacticsStrip.ts');

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

// The reporter's log, verbatim shape.
const reporterLog = [
  { kind: 'combat-begin', payload: { systemId: 'geonosis', attackerSide: 'Rebel' } },
  { kind: 'choice-request', side: 'Empire', payload: { kind: 'CombatAddLeaderPick' } },
  { kind: 'combat-action-card', side: 'Rebel', payload: { card: 'baze-s-loyalty' } },
  { kind: 'destroy-unit', side: 'Empire', payload: { unit: 'u1000032', typeId: 'assault-carrier', systemId: 'geonosis', cause: 'bazes-loyalty' } },
  { kind: 'combat-action-card-effect', side: 'Rebel', payload: { card: 'baze-s-loyalty', destroyed: 'u1000032' } },
  { kind: 'cinematic-tactic-play', side: 'Rebel', payload: { cardId: 'cin-rebel-space-rogue-squadron-support', ability: 'secondary', dealt: 1 } },
];

console.log('\n[ 1. the reporter\'s Baze\'s Loyalty reaches the strip ]');
{
  const out = playedCombatActionsFor(reporterLog, 'geonosis');
  check('one action card listed', out.length === 1, JSON.stringify(out));
  check('it is the Rebel Baze\'s Loyalty', out[0]?.side === 'Rebel' && out[0]?.card === 'baze-s-loyalty', JSON.stringify(out[0]));
  check('it names the destroyed Assault Carrier by type', JSON.stringify(out[0]?.destroyed) === '["assault-carrier"]', JSON.stringify(out[0]?.destroyed));
}

console.log('\n[ 2. scoped to the current combat ]');
{
  const log = [
    { kind: 'combat-begin', payload: { systemId: 'geonosis' } },
    { kind: 'combat-action-card', side: 'Rebel', payload: { card: 'baze-s-loyalty' } },
    { kind: 'combat-end', payload: {} },
    { kind: 'combat-begin', payload: { systemId: 'naboo' } },
  ];
  check('a card from an earlier combat elsewhere is not shown', playedCombatActionsFor(log, 'naboo').length === 0);
  check('no combat → empty', playedCombatActionsFor([], 'naboo').length === 0);
}

console.log('\n[ 3. multi-pick + no-destroy cards ]');
{
  const log = [
    { kind: 'combat-begin', payload: { systemId: 'x' } },
    { kind: 'combat-action-card', side: 'Rebel', payload: { card: 'baze-s-loyalty' } },
    { kind: 'destroy-unit', side: 'Empire', payload: { unit: 'a', typeId: 'tie-fighter' } },
    { kind: 'combat-action-card-effect', side: 'Rebel', payload: { card: 'baze-s-loyalty', destroyed: 'a' } },
    { kind: 'destroy-unit', side: 'Empire', payload: { unit: 'b', typeId: 'tie-fighter' } },
    { kind: 'combat-action-card-effect', side: 'Rebel', payload: { card: 'baze-s-loyalty', destroyed: 'b' } },
    { kind: 'combat-action-card', side: 'Empire', payload: { card: 'imperial-discipline' } },
    { kind: 'combat-action-card-effect', side: 'Empire', payload: { card: 'imperial-discipline', drew: ['secret'] } },
  ];
  const out = playedCombatActionsFor(log, 'x');
  check('both picks attach to the one card', JSON.stringify(out[0]?.destroyed) === '["tie-fighter","tie-fighter"]', JSON.stringify(out));
  check('a non-destroying card is listed with nothing destroyed (and no drawn cards leak)',
    out[1]?.card === 'imperial-discipline' && out[1].destroyed.length === 0 && !JSON.stringify(out[1]).includes('secret'), JSON.stringify(out[1]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
