// #396 — Secret Facility places "1 Shield Bunker and 1 triangle ground unit". With
// RoE units in play the triangle ground unit is Stormtrooper OR Assault Tank, so
// the player must choose. The reveal used to hardcode the Stormtrooper.
// Run: node scripts/test-secret-facility-unit-396.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };
let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

const SYS = 'utapau'; // Imperial-leaning, no Rebel units → reveal won't start combat
const has = (G, typeId) => G.map.systems[SYS].units.some((u) => u.side === 'Empire' && u.typeId === typeId);

console.log('\n[ #396 RoE: revealing Secret Facility offers a triangle-unit choice ]');
{
  const G = createGame(data, { seed: 2, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  G.empire.armedActionCards = [{ cardId: 'secret-facility', probeSystemId: SYS, armedAt: 1 }];
  phases.autoRevealArmedActionCards(G, 'Empire', 'empire-command-start');
  check('a Shield Bunker was placed immediately', has(G, 'shield-bunker'));
  check('a triangle-unit choice is posted', G.pendingChoice?.kind === 'SecretFacilityUnitPick', G.pendingChoice?.kind);
  check('both Stormtrooper and Assault Tank are offered',
    (G.pendingChoice?.candidates ?? []).includes('stormtrooper') && (G.pendingChoice?.candidates ?? []).includes('assault-tank'),
    JSON.stringify(G.pendingChoice?.candidates));
  check('no ground unit deployed yet (waiting on the player)', !has(G, 'stormtrooper') && !has(G, 'assault-tank'));
  // Choose the Assault Tank.
  const r = phases.resolveSecretFacilityUnitPick(G, 'assault-tank');
  check('resolve ok', r.ok, r.reason);
  check('the chosen Assault Tank was deployed', has(G, 'assault-tank'));
  check('the Stormtrooper was NOT force-deployed', !has(G, 'stormtrooper'));
  check('the card is fully resolved (no lingering choice)', G.pendingChoice === undefined, G.pendingChoice?.kind);
}

console.log('\n[ base game (no RoE units): no choice — Stormtrooper + Shield Bunker deploy directly ]');
{
  const G = createGame(data, { seed: 2 });
  G.empire.armedActionCards = [{ cardId: 'secret-facility', probeSystemId: SYS, armedAt: 1 }];
  phases.autoRevealArmedActionCards(G, 'Empire', 'empire-command-start');
  check('no choice posted', G.pendingChoice === undefined, G.pendingChoice?.kind);
  check('Shield Bunker + Stormtrooper deployed', has(G, 'shield-bunker') && has(G, 'stormtrooper'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
