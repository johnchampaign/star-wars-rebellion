// Cinematic Combat (Phase 7b) smoke tests. Run: node scripts/test-cinematic-combat.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce } = await import('../src/play/randomAI.ts');
const { autoPlayCinematicTactic, applyCinematicAbility, resolveCinematicEndOfRound, resolveCinematicRetreatTriggers } = await import('../src/engine/cinematicTactics.ts');

/** Drive a combat to completion: resolve every pending combat choice (add-
 *  leader, tactics, damage assignment, retreat) via the AI until pendingCombat
 *  clears. Mirrors what the real AI/UI loop does. */
function driveCombat(G) {
  combat.runCombat(G);
  let guard = 0;
  while (G.pendingCombat && G.pendingChoice && guard++ < 500) {
    const side = G.pendingChoice.side;
    if (!stepOnce(G, side)) break;
  }
}

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

const baseOpts = (seed) => ({
  seed, forcedBaseSystem: 'sullust',
  forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
  forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
  expansion: { enabled: true, cinematicCombat: true },
});

// ---- Cinematic combat resolves cleanly + sets the cinematic flag ----
console.log('\n[ Cinematic: stormtroopers vs rebel troopers ]');
{
  const G = createGame(data, baseOpts(700));
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  check('cinematic flag set on combat', G.pendingCombat?.cinematic === true);
  combat.runCombat(G);
  // Combat may pause for a damage-assignment choice; if so that's fine — it
  // means the loop reached an attack with a real target. Drive any auto-
  // resolvable tail.
  check('combat advanced (resolved or paused on a real choice)',
    G.pendingCombat === undefined || G.pendingChoice != null);
}

// ---- Cinematic: NO standard tactic cards drawn ----
console.log('\n[ Cinematic: standard tactic decks untouched ]');
{
  const G = createGame(data, baseOpts(701));
  const spaceBefore = G.spaceTacticDeck.length;
  const groundBefore = G.groundTacticDeck.length;
  // Give the Empire a high-tactic-value leader at the combat system so the
  // STANDARD path would have drawn cards.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.leadersOnBoard['felucia'] = ['darth-vader']; // Vader has tactic values
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  combat.runCombat(G);
  check('space tactic deck unchanged (no cinematic draw)', G.spaceTacticDeck.length === spaceBefore,
    `${G.spaceTacticDeck.length} vs ${spaceBefore}`);
  check('ground tactic deck unchanged', G.groundTacticDeck.length === groundBefore);
}

// ---- Standard combat still draws cards when a leader is present ----
console.log('\n[ Standard (non-cinematic) still draws tactic cards ]');
{
  const G = createGame(data, {
    seed: 702, forcedBaseSystem: 'sullust',
    forcedRebelLoyalty: ['naboo', 'corellia', 'kashyyyk'],
    forcedImperialLoyalty: ['alderaan', 'malastare', 'mygeeto', 'rodia', 'utapau'],
    expansion: { enabled: true, cinematicCombat: false },
  });
  const spaceBefore = G.spaceTacticDeck.length;
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  G.empire.leadersOnBoard['felucia'] = ['darth-vader'];
  G.rebel.leadersOnBoard['felucia'] = ['admiral-ackbar'];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  check('standard combat NOT cinematic', G.pendingCombat?.cinematic === false);
  combat.runCombat(G);
  check('standard combat DID draw space tactic cards', G.spaceTacticDeck.length < spaceBefore,
    `${G.spaceTacticDeck.length} vs ${spaceBefore}`);
}

// ---- Cinematic tactic cards: deal-damage ability fires + persistent discard ----
console.log('\n[ Cinematic: advanced tactic cards deal damage + discard persists ]');
{
  const G = createGame(data, baseOpts(703));
  // Empire AT-STs (Overrun: top "deal 2 damage" needs an AT-ST present) vs a
  // tanky Rebel mon-cala on ground? No — ground. Use AT-ST vs airspeeders.
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  const discardBefore = (G.empire.cinematicTacticDiscard ?? []).length;
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const discardAfter = (G.empire.cinematicTacticDiscard ?? []).length;
  check('Empire played at least one advanced tactic card (discard grew)',
    discardAfter > discardBefore, `${discardAfter} vs ${discardBefore}`);
  // Discard should contain only cinematic Empire-ground cards.
  const allEmpireGround = (G.empire.cinematicTacticDiscard ?? []).every((id) => {
    const t = G.catalog.tactics[id];
    return t && t.cinematic && t.side === 'Empire' && t.theater === 'ground';
  });
  check('discard contains only Empire-ground cinematic cards', allEmpireGround);
}

// ---- Cinematic discard PERSISTS across separate combats ----
console.log('\n[ Cinematic: discard persists across combats ]');
{
  const G = createGame(data, baseOpts(704));
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const afterFirst = [...(G.empire.cinematicTacticDiscard ?? [])];
  // Second combat at a different system — discard from the first must remain.
  M.deployUnit(G, 'Empire', 'at-st', 'naboo');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'naboo');
  combat.beginCombat(G, 'Empire', 'felucia', 'naboo');
  driveCombat(G);
  const afterSecond = G.empire.cinematicTacticDiscard ?? [];
  check('first-combat discards still present after second combat',
    afterFirst.every((id) => afterSecond.includes(id)),
    `first=${afterFirst.length} second=${afterSecond.length}`);
}

// ---- 7c-2: destroy-without-rolling (Support of the 501st: destroy 1 triangle) ----
console.log('\n[ Cinematic 7c-2: destroy-without-rolling kills a triangle unit ]');
{
  const G = createGame(data, baseOpts(705));
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const destroyLog = G.turnLog.filter((l) => l.kind === 'cinematic-tactic-play'
    && l.payload?.cardId === 'cin-empire-ground-support-of-the-501st' && l.payload?.destroyed);
  check('Support of the 501st destroyed a triangle unit (no roll)', destroyLog.length > 0,
    `plays: ${destroyLog.length}`);
  check('combat resolved', G.pendingCombat === undefined);
}

// ---- 7c-2: gain-unit (Reinforcements: gain a TIE Fighter) ----
console.log('\n[ Cinematic 7c-2: gain-unit deploys a new unit ]');
{
  const G = createGame(data, baseOpts(706));
  M.deployUnit(G, 'Empire', 'assault-carrier', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'x-wing', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  driveCombat(G);
  const gained = G.turnLog.filter((l) => l.kind === 'cinematic-tactic-play' && l.payload?.gained === 'tie-fighter');
  check('Reinforcements gained a TIE Fighter', gained.length > 0, `gains: ${gained.length}`);
}

// ---- 7c-3: deck lock — autoPlayCinematicTactic skips a locked side ----
console.log('\n[ Cinematic 7c-3: deck lock skips a locked side ]');
{
  const G = createGame(data, baseOpts(710));
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  M.deployUnit(G, 'Rebel', 'airspeeder', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  // Lock the Empire out of ground for this round, then attempt an auto-play.
  c.cinematicDeckLock = { [`Empire:ground`]: c.round };
  const before = (G.empire.cinematicTacticDiscard ?? []).length;
  autoPlayCinematicTactic(G, c, 'Empire', 'ground');
  const after = (G.empire.cinematicTacticDiscard ?? []).length;
  check('locked side plays no card', after === before, `${after} vs ${before}`);
  check('locked-skip event logged',
    G.turnLog.some((l) => l.kind === 'cinematic-tactic-locked' && l.side === 'Empire'));
  // Same side, but ground UNLOCKED — should now play (AT-ST present → Overrun).
  c.cinematicDeckLock = {};
  autoPlayCinematicTactic(G, c, 'Empire', 'ground');
  check('unlocked side plays a card', (G.empire.cinematicTacticDiscard ?? []).length > before);
}

// ---- 7c-3: resolve-attacks-first flips the attack order in the report ----
console.log('\n[ Cinematic 7c-3: resolve-first flips attack order ]');
{
  const G = createGame(data, baseOpts(711));
  // Empire is the combat attacker. Force Rebel to resolve first in space.
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.cinematicResolveFirst = { space: 'Rebel' };
  driveCombat(G);
  // The first space attack recorded in round 1 should be the Rebel's, despite
  // the Empire being the combat attacker.
  const report = (G.combatReports ?? []).find((r) => r.systemId === 'felucia');
  const firstSpaceAttack = report?.rounds?.[0]?.attacks?.find((a) => a.theater === 'space');
  check('Rebel attacked first in space (resolve-first override)',
    firstSpaceAttack?.side === 'Rebel', `first = ${firstSpaceAttack?.side}`);
}

// ---- 7e: Energy Shield / Draw Their Fire remove accumulated damage ----
console.log('\n[ Cinematic 7e: remove-damage heals own ships ]');
{
  const G = createGame(data, baseOpts(720));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const sd = G.map.systems['felucia'].units.find((u) => u.side === 'Empire' && u.typeId === 'star-destroyer');
  sd.damage = 3;
  applyCinematicAbility(G, c, 'Empire', 'space', 'cin-empire-space-energy-shield', true);
  check('Energy Shield removed up to 2 damage (3 → 1)', sd.damage === 1, `damage = ${sd.damage}`);
}

console.log('\n[ Cinematic 7e: Draw Their Fire excludes Nebulon-B ]');
{
  const G = createGame(data, baseOpts(721));
  M.deployUnit(G, 'Rebel', 'nebulon-b-frigate', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const neb = G.map.systems['felucia'].units.find((u) => u.typeId === 'nebulon-b-frigate');
  const mc = G.map.systems['felucia'].units.find((u) => u.typeId === 'mon-cala-cruiser');
  neb.damage = 2; mc.damage = 2;
  applyCinematicAbility(G, c, 'Rebel', 'space', 'cin-rebel-space-draw-their-fire', true);
  check('Draw Their Fire healed the Mon Cal cruiser (2 → 0)', mc.damage === 0, `mc = ${mc.damage}`);
  check('Draw Their Fire skipped the Nebulon-B (still 2)', neb.damage === 2, `neb = ${neb.damage}`);
}

// ---- 7e: Tractor Beam end-of-round capture ----
console.log('\n[ Cinematic 7e: Tractor Beam captures a leader at end of round ]');
{
  const G = createGame(data, baseOpts(722));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia'); // space contest so combat begins
  G.rebel.leadersOnBoard['felucia'] = ['han-solo'];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const capturedBefore = (G.empire.capturedLeaders ?? []).length;
  applyCinematicAbility(G, c, 'Empire', 'space', 'cin-empire-space-tractor-beam', true);
  check('Tractor Beam queued an end-of-round effect', (c.cinematicEndOfRound ?? []).length === 1);
  // Simulate the Rebel fleet being wiped this round (end-of-round condition).
  G.map.systems['felucia'].units = G.map.systems['felucia'].units.filter((u) => u.typeId !== 'mon-cala-cruiser');
  resolveCinematicEndOfRound(G, c);
  const capturedAfter = (G.empire.capturedLeaders ?? []).length;
  check('Empire captured a Rebel leader (SD present, Rebels have no ships)',
    capturedAfter === capturedBefore + 1, `${capturedAfter} vs ${capturedBefore}`);
  check('captured leader is Han Solo', (G.empire.capturedLeaders ?? []).some((cl) => cl.leaderId === 'han-solo'));
}

console.log('\n[ Cinematic 7e: Tractor Beam does NOT capture when Rebels still have ships ]');
{
  const G = createGame(data, baseOpts(723));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia'); // Rebel ship present
  G.rebel.leadersOnBoard['felucia'] = ['han-solo'];
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const before = (G.empire.capturedLeaders ?? []).length;
  applyCinematicAbility(G, c, 'Empire', 'space', 'cin-empire-space-tractor-beam', true);
  resolveCinematicEndOfRound(G, c);
  check('no capture while a Rebel ship remains', (G.empire.capturedLeaders ?? []).length === before);
}

// ---- 7e: Entrapment cancels the opponent's tactic play this round ----
console.log('\n[ Cinematic 7e: Entrapment cancels the opponent card ]');
{
  const G = createGame(data, baseOpts(724));
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.round = 1;
  // Empire (attacker, plays first) cancels the Rebel's space play this round.
  applyCinematicAbility(G, c, 'Empire', 'space', 'cin-empire-space-entrapment', true);
  check('Entrapment set the Rebel space cancel flag for this round',
    c.cinematicCancel?.['Rebel:space:1'] === true);
}

// ---- 7f: Shield absorb (Armored Position / Planetary Shield) ----
console.log('\n[ Cinematic 7f: Armored Position absorbs ground damage into the Shield Bunker ]');
{
  const G = createGame(data, baseOpts(730));
  M.deployUnit(G, 'Empire', 'shield-bunker', 'felucia');
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const units = G.map.systems['felucia'].units;
  const bunker = units.find((u) => u.typeId === 'shield-bunker');
  const walkers = units.filter((u) => u.typeId === 'at-st');
  walkers[0].damage = 2; walkers[1].damage = 2; // 4 total wounded
  bunker.damage = 0;
  applyCinematicAbility(G, c, 'Empire', 'ground', 'cin-empire-ground-armored-position', true);
  const groundDmgAfter = walkers.reduce((s, u) => s + u.damage, 0);
  check('moved up to 3 damage off the AT-STs (4 → 1)', groundDmgAfter === 1, `ground dmg = ${groundDmgAfter}`);
  check('Shield Bunker soaked the 3 damage', bunker.damage === 3, `bunker dmg = ${bunker.damage}`);
}

console.log('\n[ Cinematic 7f: Planetary Shield needs a Shield Generator present ]');
{
  const G = createGame(data, baseOpts(731));
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia'); // no Shield Generator
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  const trooper = G.map.systems['felucia'].units.find((u) => u.typeId === 'rebel-trooper');
  trooper.damage = 1;
  applyCinematicAbility(G, c, 'Rebel', 'ground', 'cin-rebel-ground-planetary-shield', true);
  check('no Shield Generator → nothing absorbed (trooper still wounded)', trooper.damage === 1);
}

// ---- 7f: "play an extra card" grants a second tactic play ----
console.log('\n[ Cinematic 7f: Imposing Presence grants an extra tactic play ]');
{
  const G = createGame(data, baseOpts(732));
  M.deployUnit(G, 'Empire', 'at-st', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.round = 1;
  const before = c.cinematicExtraPlays?.['Empire:ground:1'] ?? 0;
  applyCinematicAbility(G, c, 'Empire', 'ground', 'cin-empire-ground-imposing-presence', false); // BOT = extra card
  const after = c.cinematicExtraPlays?.['Empire:ground:1'] ?? 0;
  check('Imposing Presence (bottom) granted +1 extra play', after === before + 1, `${after} vs ${before}`);
}

console.log('\n[ Cinematic 7f: Fleet Logistics top = prevent + extra play ]');
{
  const G = createGame(data, baseOpts(733));
  M.deployUnit(G, 'Rebel', 'mon-cala-cruiser', 'felucia');
  M.deployUnit(G, 'Empire', 'star-destroyer', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  c.round = 1;
  applyCinematicAbility(G, c, 'Rebel', 'space', 'cin-rebel-space-fleet-logistics', true); // TOP
  check('Fleet Logistics top granted an extra play', (c.cinematicExtraPlays?.['Rebel:space:1'] ?? 0) === 1);
  check('Fleet Logistics top also set a prevent', (c.cinematicPrevent?.Empire?.red ?? 0) >= 2);
}

// ---- Deeper item 1: Rogue One post-retreat rescue / remove-marker ----
console.log('\n[ Cinematic: Rogue One — no retreat → does not fire ]');
{
  const G = createGame(data, baseOpts(740));
  M.deployUnit(G, 'Rebel', 'u-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  G.empire.capturedLeaders = [{ leaderId: 'han-solo', ring: 'captured', systemId: 'coruscant' }];
  applyCinematicAbility(G, c, 'Rebel', 'ground', 'cin-rebel-ground-rogue-one', true);
  check('Rogue One queued a post-retreat trigger', (c.cinematicEndOfRound ?? []).some((e) => e.kind === 'rogueOne'));
  c.retreatHappenedThisRound = false;
  const paused = resolveCinematicRetreatTriggers(G, c);
  check('no retreat → no pause, no choice', !paused && G.pendingChoice == null);
}

console.log('\n[ Cinematic: Rogue One — retreat → rescue a captured leader ]');
{
  const G = createGame(data, baseOpts(741));
  M.deployUnit(G, 'Rebel', 'u-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  G.empire.capturedLeaders = [{ leaderId: 'han-solo', ring: 'captured', systemId: 'coruscant' }];
  applyCinematicAbility(G, c, 'Rebel', 'ground', 'cin-rebel-ground-rogue-one', true);
  c.retreatHappenedThisRound = true;
  const paused = resolveCinematicRetreatTriggers(G, c);
  check('retreat + target → posts a RogueOneChoice (paused)', paused && G.pendingChoice?.kind === 'RogueOneChoice');
  check('Han Solo is a rescue option', G.pendingChoice.rescuable.includes('han-solo'));
  combat.resolveRogueOneChoice(G, 'rescue:han-solo');
  check('Han Solo rescued (no longer captured)', !(G.empire.capturedLeaders ?? []).some((cl) => cl.leaderId === 'han-solo'));
}

console.log('\n[ Cinematic: Rogue One — retreat → remove a target marker ]');
{
  const G = createGame(data, baseOpts(742));
  M.deployUnit(G, 'Rebel', 'u-wing', 'felucia');
  M.deployUnit(G, 'Rebel', 'rebel-trooper', 'felucia');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'felucia');
  combat.beginCombat(G, 'Empire', 'malastare', 'felucia');
  const c = G.pendingCombat;
  G.empire.capturedLeaders = [];
  G.map.systems['felucia'].targetMarkers = [{ source: 'secure-the-plans', placedBy: 'Empire', placedAt: 0 }];
  applyCinematicAbility(G, c, 'Rebel', 'ground', 'cin-rebel-ground-rogue-one', true);
  c.retreatHappenedThisRound = true;
  resolveCinematicRetreatTriggers(G, c);
  check('only a marker option offered (no captured leaders)', G.pendingChoice?.rescuable.length === 0 && G.pendingChoice?.markerSources.includes('secure-the-plans'));
  combat.resolveRogueOneChoice(G, 'marker:secure-the-plans');
  check('target marker removed from felucia',
    !(G.map.systems['felucia'].targetMarkers ?? []).some((m) => m.source === 'secure-the-plans'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
