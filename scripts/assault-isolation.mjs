// Assault-isolation harness.
//
// The full-game self-play tournament can't measure the Empire's ASSAULT-force
// composition, because the AI Empire reaches a base assault in only ~17% of
// games — the harness saturates on the find-and-reach problem upstream, so any
// change to force strength comes back byte-identical.
//
// This harness isolates the assault: it script-reveals a Rebel base, places a
// FIXED, realistic Rebel defense, then drops a chosen Empire force into the
// system and resolves combat to the finish — repeatedly, over many seeds — and
// reports the Empire's BASE-CAPTURE rate. Capturing requires clearing BOTH
// theaters (no Rebel unit left), so a fighter-heavy force that can't touch
// ground troops can win the space battle and still never capture.
//
// Combat is pure-dice (leader pools emptied, no action cards) so the only
// variable is the Empire force composition. Forces are normalized to equal
// build-resource COST (the Empire's real currency), not unit count.
//
// Usage: node scripts/assault-isolation.mjs [games]
import { readFileSync } from 'node:fs';
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const combat = await import('../src/engine/combat.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(new URL('../assets/' + p, import.meta.url), 'utf8'));
const data = { systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') };

const GAMES = parseInt(process.argv[2] ?? '300', 10);

// Fixed, plausible mid-game Rebel base defense (pure units, no structures/leaders).
const REBEL_DEFENSE = [
  ['mon-cala-cruiser', 1], ['corellian-corvette', 2], // space
  ['rebel-trooper', 3], ['airspeeder', 1],            // ground
];

// Empire assault variants, each ~24 build resources (TIE/trooper=1, carrier/at-st=2, SD/AT-AT=3).
const VARIANTS = {
  'TIE-heavy (AI-like)':  [['tie-fighter', 12], ['star-destroyer', 3], ['at-at', 1]],          // ground: 1
  'balanced':             [['star-destroyer', 3], ['at-at', 3], ['stormtrooper', 4], ['at-st', 1]], // mixed
  'ground-heavy':         [['star-destroyer', 2], ['at-at', 4], ['stormtrooper', 6]],            // ground: 10
};

const cost = (force) => {
  const C = { 'tie-fighter': 1, 'stormtrooper': 1, 'at-st': 2, 'assault-carrier': 2, 'star-destroyer': 3, 'at-at': 3 };
  return force.reduce((s, [t, n]) => s + (C[t] ?? 0) * n, 0);
};

function pickBaseSystem(G) {
  // A normal (non-remote) system both sides can occupy.
  for (const [id, ss] of Object.entries(G.map.systems)) {
    if (!ss.remote && !ss.destroyed) return id;
  }
  return Object.keys(G.map.systems)[0];
}

function clearBoard(G) {
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leaderPool = []; G.empire.leaderPool = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  G.rebel.actionHand = []; G.empire.actionHand = [];
}

function runAssault(seed, empireForce) {
  seedAI(seed);
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true, roeMissions: true } });
  clearBoard(G);
  const base = pickBaseSystem(G);
  G.rebelBaseSystemId = base;
  G.rebelBaseRevealed = true;

  for (const [t, n] of REBEL_DEFENSE) for (let k = 0; k < n; k++) M.deployUnit(G, 'Rebel', t, base);
  for (const [t, n] of empireForce) for (let k = 0; k < n; k++) M.deployUnit(G, 'Empire', t, base);

  combat.beginCombat(G, 'Empire', base, base);
  let guard = 0;
  while (G.pendingCombat && guard++ < 8000) {
    const did = aiStep(G, 'Empire') || aiStep(G, 'Rebel');
    if (!did) {
      combat.runCombat(G);
      if (G.pendingCombat && !G.pendingChoice) break; // genuinely stuck
    }
  }
  M.recomputeGameEnd(G);
  const captured = G.winReason === 'base-captured' || G.winReason === 'base-destroyed';
  // Diagnostics: surviving Rebel units by theater.
  let rebSpace = 0, rebGround = 0;
  for (const u of G.map.systems[base].units) {
    if (u.side !== 'Rebel') continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (t?.theater === 'ground') rebGround++; else rebSpace++;
  }
  return { captured, rebSpace, rebGround, stuck: !!G.pendingCombat };
}

console.log(`Assault-isolation harness — ${GAMES} games per variant`);
console.log(`Rebel defense (fixed): ${REBEL_DEFENSE.map(([t, n]) => n + '×' + t).join(', ')}\n`);
for (const [name, force] of Object.entries(VARIANTS)) {
  let cap = 0, stuck = 0, surviveSpace = 0, surviveGround = 0;
  const ground = force.filter(([t]) => ({ 'at-at': 1, 'stormtrooper': 1, 'at-st': 1 }[t])).reduce((s, [, n]) => s + n, 0);
  for (let i = 0; i < GAMES; i++) {
    const r = runAssault(7000 + i, force);
    if (r.captured) cap++;
    if (r.stuck) stuck++;
    surviveSpace += r.rebSpace; surviveGround += r.rebGround;
  }
  const pct = (100 * cap / GAMES).toFixed(0);
  console.log(`${name.padEnd(22)} cost=${cost(force)} groundUnits=${ground}  →  CAPTURE ${pct}%  (${cap}/${GAMES})`);
  console.log(`${''.padEnd(22)} avg surviving Rebel units: space=${(surviveSpace / GAMES).toFixed(2)} ground=${(surviveGround / GAMES).toFixed(2)}${stuck ? `  [stuck:${stuck}]` : ''}\n`);
}
