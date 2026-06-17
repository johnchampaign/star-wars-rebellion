// #317 — Crippling Blow ("3+ health of Imperial ground units destroyed in a
// combat you initiated") must count units destroyed by a CARD effect during the
// combat (e.g. Baze's Loyalty), not only dice kills. The reporter killed a
// stormtrooper (1 HP) with Baze's Loyalty and an AT-ST (2 HP) with dice = 3 HP,
// but the card kill wasn't counted, so the objective didn't fire.
// Run: node scripts/test-crippling-blow-317.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const { combatObjectivesTriggered } = await import('../src/engine/objectives.ts');

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

const opts = (seed) => ({ seed, expansion: { enabled: true, roeUnits: true, roeMissions: true, cinematicCombat: true } });

// A Rebel-initiated, Rebel-won ground combat report where an AT-ST (2 HP) died
// to dice and a stormtrooper (1 HP) died to Baze's Loyalty.
function makeReport({ withCardKill }) {
  return {
    systemId: 'alderaan', attackerSide: 'Rebel', winner: 'Rebel',
    addedLeaders: [], drawnTactics: { side: 'Rebel', spaceCount: 0, groundCount: 0 },
    structureDestructions: [], retreatDestructions: [],
    cardDestructions: withCardKill ? [{ side: 'Empire', typeId: 'stormtrooper' }] : [],
    rounds: [{
      round: 1,
      attacks: [{
        side: 'Rebel', theater: 'ground', attackerUnits: 4, dice: [],
        tacticsPlayed: [], hitsRolled: 3, bonusDamage: 0, blockedDamage: 0,
        damageApplied: 3, destroyed: [{ typeId: 'at-st', instanceId: 'x1' }],
      }],
    }],
  };
}

console.log('\n[ #317 Baze\'s Loyalty kill + dice kill = 3 ground HP → Crippling Blow fires ]');
{
  const G = createGame(data, opts(60));
  G.rebel.objectiveHand = ['crippling-blow-1'];
  const fired = combatObjectivesTriggered(G, makeReport({ withCardKill: true }));
  check('Crippling Blow fires (card kill counted)', fired.includes('crippling-blow-1'),
    `fired=${JSON.stringify(fired)}`);
}

console.log('\n[ #317 without the card kill (only the 2-HP AT-ST) → does NOT fire ]');
{
  const G = createGame(data, opts(61));
  G.rebel.objectiveHand = ['crippling-blow-1'];
  const fired = combatObjectivesTriggered(G, makeReport({ withCardKill: false }));
  check('Crippling Blow does not fire at only 2 HP', !fired.includes('crippling-blow-1'),
    `fired=${JSON.stringify(fired)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
