// #396 — Secret Facility: "you MAY reveal" (optional) at the start of your Command
// turn, and on reveal you place "1 Shield Bunker and 1 triangle ground unit" — the
// triangle unit is a player choice (Stormtrooper OR Assault Tank with RoE).
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
const armed = (G) => (G.empire.armedActionCards ?? []).some((a) => a.cardId === 'secret-facility');
const setup = (exp) => {
  const G = createGame(data, exp ? { seed: 2, expansion: exp } : { seed: 2 });
  G.empire.armedActionCards = [{ cardId: 'secret-facility', probeSystemId: SYS, armedAt: 1 }];
  return G;
};
const ROE = { enabled: true, roeUnits: true, roeMissions: true };

console.log('\n[ #396 the reveal is OPTIONAL — an offer is posted, not auto-fired ]');
{
  const G = setup(ROE);
  phases.offerArmedRevealsAtCommandStart(G);
  check('a reveal OFFER is posted (not auto-fired)', G.pendingChoice?.kind === 'ArmedCardRevealOffer', G.pendingChoice?.kind);
  check('nothing deployed yet', !has(G, 'shield-bunker'));
}

console.log('\n[ #396 declining keeps the facility armed for later, deploys nothing ]');
{
  const G = setup(ROE);
  phases.offerArmedRevealsAtCommandStart(G);
  const r = phases.resolveArmedCardRevealOffer(G, false);
  check('decline ok', r.ok, r.reason);
  check('the facility is STILL armed', armed(G));
  check('no Shield Bunker / units placed', !has(G, 'shield-bunker') && !has(G, 'stormtrooper') && !has(G, 'assault-tank'));
  check('no lingering choice', G.pendingChoice === undefined, G.pendingChoice?.kind);
}

console.log('\n[ #396 revealing (RoE) → Shield Bunker placed + triangle-unit choice → deploy ]');
{
  const G = setup(ROE);
  phases.offerArmedRevealsAtCommandStart(G);
  const r = phases.resolveArmedCardRevealOffer(G, true);
  check('reveal ok', r.ok, r.reason);
  check('Shield Bunker placed', has(G, 'shield-bunker'));
  check('triangle-unit choice posted (Stormtrooper vs Assault Tank)', G.pendingChoice?.kind === 'SecretFacilityUnitPick');
  check('both unit types offered', (G.pendingChoice?.candidates ?? []).includes('stormtrooper') && (G.pendingChoice?.candidates ?? []).includes('assault-tank'));
  const r2 = phases.resolveSecretFacilityUnitPick(G, 'assault-tank');
  check('unit pick ok', r2.ok, r2.reason);
  check('chosen Assault Tank deployed, Stormtrooper not forced', has(G, 'assault-tank') && !has(G, 'stormtrooper'));
  check('facility no longer armed (consumed)', !armed(G));
  check('fully resolved', G.pendingChoice === undefined && !G.pendingArmedReveals);
}

console.log('\n[ base game: reveal → no unit choice, Shield Bunker + Stormtrooper deploy ]');
{
  const G = setup(null);
  phases.offerArmedRevealsAtCommandStart(G);
  check('offer posted', G.pendingChoice?.kind === 'ArmedCardRevealOffer');
  phases.resolveArmedCardRevealOffer(G, true);
  check('no unit choice in base game', G.pendingChoice === undefined, G.pendingChoice?.kind);
  check('Shield Bunker + Stormtrooper deployed', has(G, 'shield-bunker') && has(G, 'stormtrooper'));
}

console.log('\n[ #396 Sweep the Area is ALSO "you may reveal" — declining keeps it armed ]');
{
  const M = await import('../src/engine/mechanics.ts');
  const G = createGame(data, { seed: 2, expansion: ROE });
  G.empire.armedActionCards = [{ cardId: 'sweep-the-area', probeSystemId: SYS, armedAt: 1 }];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  (G.rebel.leadersOnBoard[SYS] ??= []).push('mon-mothma');
  G.pendingArmedReveals = { phase: 'command-end', remaining: [...G.empire.armedActionCards] };
  G.pendingChoice = { kind: 'ArmedCardRevealOffer', side: 'Empire', cardId: 'sweep-the-area', systemId: SYS };
  const dec = phases.resolveArmedCardRevealOffer(G, false);
  check('decline ok', dec.ok, dec.reason);
  check('Sweep stays armed after declining', (G.empire.armedActionCards ?? []).some((a) => a.cardId === 'sweep-the-area'));
  check('Mon Mothma NOT captured on decline', !(G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'mon-mothma'));
}

console.log('\n[ #396 Sweep the Area — revealing captures the leader ]');
{
  const M = await import('../src/engine/mechanics.ts');
  const G = createGame(data, { seed: 2, expansion: ROE });
  G.empire.armedActionCards = [{ cardId: 'sweep-the-area', probeSystemId: SYS, armedAt: 1 }];
  M.deployUnit(G, 'Empire', 'stormtrooper', SYS);
  (G.rebel.leadersOnBoard[SYS] ??= []).push('mon-mothma');
  G.pendingArmedReveals = { phase: 'command-end', remaining: [...G.empire.armedActionCards] };
  G.pendingChoice = { kind: 'ArmedCardRevealOffer', side: 'Empire', cardId: 'sweep-the-area', systemId: SYS };
  const rev = phases.resolveArmedCardRevealOffer(G, true);
  check('reveal ok', rev.ok, rev.reason);
  check('Mon Mothma captured on reveal', (G.empire.capturedLeaders ?? []).some((c) => c.leaderId === 'mon-mothma'));
  check('Sweep consumed (no longer armed)', !(G.empire.armedActionCards ?? []).some((a) => a.cardId === 'sweep-the-area'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
