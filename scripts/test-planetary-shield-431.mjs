// #431 — Planetary Shield's absorb is REACTIVE ("after the Imperials assign
// damage, move up to 3 damage onto a Shield Generator, cancel from ground
// units"). It used to apply at tactic-CHOICE time (round start, before any
// damage) → moved 0, and the just-damaged ground units died anyway. Now it
// DEFERS like Energy Shield's heal: resolved after the theatre's attacks, before
// destruction, so it soaks the fresh damage and saves the units.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { applyCinematicAbility, applyDeferredCinematicHeals } = await import('../src/engine/cinematicTactics.ts');
const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'), leaders: loadJson('leaders.json'),
  actions: loadJson('actions.json'), missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const SYS = 'felucia';
const opts = { seed: 700, forcedBaseSystem: 'sullust', forcedRebelLoyalty: ['naboo','corellia','kashyyyk'],
  forcedImperialLoyalty: ['alderaan','malastare','mygeeto','rodia','utapau'], expansion: { enabled: true, cinematicCombat: true } };

const G = createGame(data, opts);
G.map.systems[SYS].units = [];
M.deployUnit(G, 'Rebel', 'shield-generator', SYS);
M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
M.deployUnit(G, 'Rebel', 'rebel-trooper', SYS);
M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
combat.beginCombat(G, 'Empire', 'malastare', SYS);
const c = G.pendingCombat;
const ss = G.map.systems[SYS];
const shield = ss.units.find(u => u.typeId === 'shield-generator');
const troopers = ss.units.filter(u => u.typeId === 'rebel-trooper');
const trooperHp = G.catalog.unitTypes['rebel-trooper']?.health.value ?? 1;

console.log('[ #431: Planetary Shield absorbs damage dealt AFTER it is played ]');
check('setup: shield generator + 2 troopers present', !!shield && troopers.length === 2);

// Rebel plays Planetary Shield's TOP ability (the absorb) at round start.
applyCinematicAbility(G, c, 'Rebel', 'ground', 'cin-rebel-ground-planetary-shield', true);
check('absorb did NOT fire early (no damage moved at tactic-choice)',
  shield.damage === 0 && troopers.every(t => t.damage === 0), `shield=${shield.damage}`);
check('a deferred shield-absorb was queued', (c.cinematicDeferredHeal ?? []).some(h => h.structureTypeId === 'shield-generator'));

// NOW the Imperials assign damage: a lethal hit lands on a trooper this round.
troopers[0].damage = trooperHp; // would be destroyed without the shield
const totalBefore = troopers[0].damage;

// The reactive step runs after the theatre's attacks, before destruction.
applyDeferredCinematicHeals(G, c, 'ground');

check('the trooper was healed below lethal (saved)', troopers[0].damage < trooperHp,
  `trooper=${troopers[0].damage}/${trooperHp}`);
check('the Shield Generator soaked that damage', shield.damage === totalBefore,
  `shield=${shield.damage}, expected ${totalBefore}`);
check('no pending choice (auto-resolves, never pauses)', !G.pendingChoice, G.pendingChoice?.kind);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
