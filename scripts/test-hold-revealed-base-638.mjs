// #638 — "Rebels moved the base even though they had MUCH better unit numbers
// and the death star was far away."
// #508 — the Rebel "will reveal their base even when a transport unit can't
// move troops to their hidden base ... this tweak may make it harder for the
// Imperials to smoke them out so quickly."
//
// Two reporters, opposite complaints, ONE cause: when Rapid Mobilization fired
// on a revealed base, the Rebel AI ALWAYS relocated —
//     branch = revealed ? 'establish-base' : 'move-units'
// — a bare boolean with no assessment of whether the base could be held.
//
// Self-play says always-flee is no better than a coin flip: after a reveal,
// relocated bases were captured 70 of 119 times and held bases 43 of 81 —
// ~45% either way. Fleeing costs the fleet its position and the Rebel its
// turn; it should be paid for by a real threat.
//
// shouldHoldRevealedBase weighs the Imperial force that can REACH the base
// next round (on it or one jump out) against the Rebel force standing on it,
// in the strength gates' own units (dice + health). No reachable threat →
// hold. A completed Death Star within two jumps → flee regardless (it wins by
// orbit). Otherwise hold when defence ≥ 1.25 × threat.
//
// The Rebel never flees a HIDDEN base (that branch is untouched — #551/#579
// showed relocating a hidden base strands the starting fleet). This is only
// about the revealed case, where the engine brings units and leaders along.
//
// Run: node scripts/test-hold-revealed-base-638.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { register } = await import('tsx/esm/api'); register();
const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const ai = await import('../src/play/randomAI.ts');

const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'),
  actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'),
  tactics: j('tactics.json'), probes: j('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + e}`); ok ? pass++ : fail++; };

/** A revealed base at a real system with the given garrison; Empire forces
 *  placed at the named distances (0 = on the base, 1 = adjacent, 2 = two out). */
function board(seed, { garrison, empireAt = [] }) {
  const G = createGame(data, { seed, autoSetupUnits: true, expansion: { enabled: true, roeUnits: true } });
  for (const ss of Object.values(G.map.systems)) ss.units = [];
  if (G.map.rebelBaseSpace) G.map.rebelBaseSpace.units = [];
  G.rebel.leadersOnBoard = {}; G.empire.leadersOnBoard = {};
  const base = G.rebelBaseSystemId;
  G.rebelBaseRevealed = true;
  for (const t of garrison) M.deployUnit(G, 'Rebel', t, base);
  const adj = G.catalog.adjacency[base] ?? [];
  const adj2 = [...new Set(adj.flatMap((a) => G.catalog.adjacency[a] ?? []))].filter((s) => s !== base && !adj.includes(s));
  for (const { dist, units } of empireAt) {
    const sys = dist === 0 ? base : dist === 1 ? adj[0] : adj2[0];
    for (const t of units) {
      // Death Stars are unique and consumed by setup — place directly.
      if (t === 'death-star') G.map.systems[sys].units.push({ instanceId: 'ds-fx', typeId: 'death-star', side: 'Empire', damage: 0 });
      else M.deployUnit(G, 'Empire', t, sys);
    }
  }
  return G;
}
const STRONG = ['corellian-corvette', 'corellian-corvette', 'x-wing', 'x-wing', 'y-wing',
  'rebel-trooper', 'rebel-trooper', 'rebel-trooper', 'airspeeder', 'airspeeder'];

console.log('\n[ #638 — a strong base with no reachable threat HOLDS ]');
{
  const G = board(638, { garrison: STRONG, empireAt: [{ dist: 2, units: ['star-destroyer', 'stormtrooper'] }] });
  check('Empire two jumps out cannot reach next round → hold', ai.shouldHoldRevealedBase(G) === true);
}
{
  const G = board(639, { garrison: STRONG, empireAt: [] });
  check('no Empire anywhere near → hold (fleeing buys nothing)', ai.shouldHoldRevealedBase(G) === true);
}
{
  // MUCH better numbers next to a small raiding party: hold and fight.
  const G = board(640, { garrison: STRONG, empireAt: [{ dist: 1, units: ['assault-carrier', 'stormtrooper', 'tie-fighter'] }] });
  check('a big garrison vs a small adjacent force → hold', ai.shouldHoldRevealedBase(G) === true);
}

console.log('\n[ a genuinely threatened base still FLEES ]');
{
  const G = board(641, { garrison: ['rebel-trooper', 'x-wing'],
    empireAt: [{ dist: 1, units: ['star-destroyer', 'star-destroyer', 'at-at', 'stormtrooper', 'stormtrooper', 'tie-fighter', 'tie-fighter'] }] });
  check('a token garrison facing an armada next door → flee', ai.shouldHoldRevealedBase(G) === false);
}
{
  const G = board(642, { garrison: STRONG, empireAt: [{ dist: 2, units: ['death-star'] }] });
  check('a Death Star within two jumps → flee even with a strong garrison', ai.shouldHoldRevealedBase(G) === false);
}
{
  const G = board(643, { garrison: STRONG, empireAt: [{ dist: 0, units: ['star-destroyer', 'star-destroyer', 'at-at', 'at-at', 'stormtrooper', 'stormtrooper', 'stormtrooper', 'tie-fighter', 'tie-fighter', 'tie-fighter'] }] });
  check('overwhelming force already ON the base → flee', ai.shouldHoldRevealedBase(G) === false);
}

console.log('\n[ the decision is carried out through the RAW-legal path ]');
{
  // A revealed base cannot take move-units — the card says "IF the Rebel base
  // is not revealed". So a hold is: take establish-base, draw the probes, and
  // DECLINE at the pick (RR p.11). A first cut chose move-units and 79/300
  // self-play games hung on the choice forever. Drive the whole flow.
  const run = (G) => {
    G.pendingChoice = { kind: 'RapidMobilizationBranch', side: 'Rebel', moveUnitsAvailable: false, twoLeaders: false, baseRevealed: true, endOfPhase: true };
    const before = G.rebelBaseSystemId;
    for (let i = 0; i < 6 && G.pendingChoice; i++) {
      const k = G.pendingChoice.kind;
      if (!ai.stepOnce(G, 'Rebel')) break;
      if (G.pendingChoice?.kind === k && k === 'RapidMobilizationBranch') break; // would be the old hang
    }
    return { before, after: G.rebelBaseSystemId, pending: G.pendingChoice?.kind,
      declined: (G.turnLog ?? []).some((e) => e.kind === 'rapid-mobilization-base-declined'),
      established: (G.turnLog ?? []).some((e) => e.kind === 'rapid-mobilization-base-established') };
  };
  const hold = run(board(644, { garrison: STRONG, empireAt: [] }));
  check('unthreatened revealed base: the choice RESOLVES (no hang)', hold.pending !== 'RapidMobilizationBranch', `pending=${hold.pending}`);
  check('  …and it declined the relocation, base stays put', hold.declined && hold.before === hold.after,
    JSON.stringify(hold));
  const flee = run(board(645, { garrison: ['x-wing'], empireAt: [{ dist: 1, units: ['star-destroyer', 'star-destroyer', 'at-at', 'stormtrooper', 'stormtrooper'] }] }));
  check('threatened revealed base: the choice resolves', flee.pending !== 'RapidMobilizationBranch', `pending=${flee.pending}`);
  check('  …and it relocated (or had no legal target and declined — either is a real resolution)',
    flee.established || flee.declined || flee.pending === 'RapidMobilizationBasePick', JSON.stringify(flee));
}

console.log('\n[ hidden bases are untouched — never flee a base the Empire has not found ]');
{
  const G = board(646, { garrison: ['x-wing'], empireAt: [{ dist: 1, units: ['star-destroyer', 'star-destroyer', 'at-at'] }] });
  G.rebelBaseRevealed = false;
  G.pendingChoice = { kind: 'RapidMobilizationBranch', side: 'Rebel' };
  ai.stepOnce(G, 'Rebel');
  check('a hidden base under pressure still consolidates rather than relocating',
    G.pendingChoice?.kind !== 'RapidMobilizationBasePick', `pending=${G.pendingChoice?.kind}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
