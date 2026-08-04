// #686 follow-up — Intercept Transmissions must also rule out the systems
// whose probe cards it hands to the Empire.
//
// The original #686 fix taught recordEmpireSearched to read the Empire's probe
// hand, and made Rapid Mobilization re-record after handing over the vacated
// base's card. But that is not the only route a probe card reaches the Empire:
// Intercept Transmissions ("he gives you all cards belonging to systems that
// contain an Imperial unit") pushes a whole batch into the hand and never
// re-records. Nothing else does either — recordEmpireSearched only runs as
// part of applyInvariants, i.e. after a unit moves or dies.
//
// So between resolving the mission and the next unit move, the map stopped
// crossing those systems off and the Rebel AI's decoy scorer — which penalises
// ruled-out systems by -100 — could still offer one as an Interrogation Droid
// bluff the Empire dismisses on sight. Same visible symptom as #686, different
// route in.
//
// Run: node scripts/test-intercept-transmissions-ruleout-686.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const registry = await import('../src/engine/handlers/registry.ts');
const handlers = await import('../src/engine/handlers/index.ts');
handlers.registerAll();

const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8'));
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${ok ? '' : ' — ' + x}`); ok ? pass++ : fail++; };

const KEY = 'intercept-transmissions';

// invokeByKey returns true for an UNREGISTERED key, so an effect that silently
// vanished would sail through every assertion below. Pin registration first.
console.log('\n[ the handler under test is actually registered ]');
check(`'${KEY}' is registered`, registry.has(KEY) === true);
if (!registry.has(KEY)) {
  console.log('\nFAILURES — cannot test an unregistered effect');
  process.exit(1);
}

/** A board where the target system is a plausible base hiding spot the Empire
 *  cannot otherwise rule out: NEUTRAL loyalty, not subjugated, and holding only
 *  an Imperial SHIP (ground would risk subjugation, which recordEmpireSearched
 *  already crosses off for unrelated reasons — that would make the assertion
 *  pass with or without the fix). */
function board(seed) {
  const G = createGame(data, {
    seed, autoSetupUnits: true,
    expansion: { enabled: true, roeUnits: true, roeMissions: true },
  });
  const target = Object.keys(G.map.systems).find((sid) =>
    sid !== G.rebelBaseSystemId
    && Object.values(G.catalog.probes).some((p) => p.systemId === sid));
  const ss = G.map.systems[target];
  ss.loyalty = 'neutral';
  ss.subjugated = false;
  ss.units = ss.units.filter((u) => u.side !== 'Empire');
  M.deployUnit(G, 'Empire', 'tie-fighter', target);
  const probeId = Object.values(G.catalog.probes).find((p) => p.systemId === target).id;
  // The handler only inspects the first 8 cards, so the target's card has to be
  // in that window for it to be handed over at all.
  G.probeDeck = [probeId, ...G.probeDeck.filter((p) => p !== probeId)];
  G.empire.probeHand = [];
  M.recordEmpireSearched(G);
  return { G, target, probeId, ss };
}

console.log('\n[ preconditions: the target is genuinely unknown before the mission ]');
const { G, target, probeId } = board(686);
{
  check('target is neutral and unsubjugated',
    G.map.systems[target].loyalty === 'neutral' && !G.map.systems[target].subjugated);
  check('target holds an Imperial unit (so its card gets handed over)',
    G.map.systems[target].units.some((u) => u.side === 'Empire'));
  check('target is NOT already ruled out',
    !(G.empireSearchedRuledOut ?? []).includes(target),
    `ruledOut=${JSON.stringify(G.empireSearchedRuledOut)}`);
  check('target is not the base', target !== G.rebelBaseSystemId);
}

console.log('\n[ #686 resolving Intercept Transmissions rules the system out ]');
{
  const ctx = registry.makeContext('Rebel', { kind: 'mission', id: 'intercept-transmissions' });
  const ok = registry.invokeByKey(G, KEY, ctx);
  check('the effect resolved', ok === true);
  check('the probe card reached the Empire hand',
    (G.empire.probeHand ?? []).includes(probeId),
    `hand=${JSON.stringify(G.empire.probeHand)}`);
  check('the bug: its system is now crossed off for the Empire',
    (G.empireSearchedRuledOut ?? []).includes(target),
    `target=${target} ruledOut=${JSON.stringify(G.empireSearchedRuledOut)}`);
  check('every handed-over card had its system ruled out', (() => {
    const out = new Set(G.empireSearchedRuledOut ?? []);
    return (G.empire.probeHand ?? []).every((pid) => {
      const sid = G.catalog.probes[pid]?.systemId;
      return !sid || sid === G.rebelBaseSystemId || out.has(sid);
    });
  })());
  check('the real base was NOT crossed off',
    !(G.empireSearchedRuledOut ?? []).includes(G.rebelBaseSystemId),
    `base=${G.rebelBaseSystemId}`);
}

console.log(fail === 0 ? `\nALL PASS — ${pass} passed, 0 failed` : `\nFAILURES — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
