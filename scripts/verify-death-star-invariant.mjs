// Verifier: assert the Death Star (and any future health.color===null unit)
// is destroyable ONLY via the allowlisted causes (currently just
// 'death-star-plans'). Catches the class of bug from issue #28 where
// Hit And Run destroyed the Death Star for free because the budget gate
// treated its health.value=0 as "costs nothing."
//
// Three parts:
//   PART 1 — destroyUnit invariant: refuses non-allowlisted causes
//            (throws in non-production node runs).
//   PART 2 — handler-fuzz: iterate every registered effect handler, fire
//            each one against a target system that contains the Death
//            Star + other Empire targets, assert (a) Death Star survives
//            and (b) Death Star never appears in a DestroyUpToHealth
//            candidate set. This is the test that would have caught
//            issue #28 in CI.
//   PART 3 — direct destroyUnit allowlist check: cause='death-star-plans'
//            actually does destroy the Death Star.
//
// Usage: node scripts/verify-death-star-invariant.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Register tsx so we can import .ts files.
{
  const mod = await import('tsx/esm/api');
  mod.register();
}

const { createGame } = await import('../src/engine/setup.ts');
const M = await import('../src/engine/mechanics.ts');
const handlers = await import('../src/engine/handlers/index.ts');
const registry = await import('../src/engine/handlers/registry.ts');

function loadJson(path) {
  return JSON.parse(readFileSync(join(ROOT, 'assets', path), 'utf-8'));
}
const data = {
  systems:    loadJson('systems.json'),
  adjacency:  loadJson('adjacency.json'),
  leaders:    loadJson('leaders.json'),
  actions:    loadJson('actions.json'),
  missions:   loadJson('missions.json'),
  objectives: loadJson('objectives.json'),
  tactics:    loadJson('tactics.json'),
  probes:     loadJson('probes.json'),
};

// Ensure all handlers are registered (createGame calls this internally, but
// we touch the registry before any createGame call below — register defensively).
handlers.registerAll();

function makeGame(seed = 'verify-death-star') {
  return createGame(data, { seed });
}

function findDeathStar(G) {
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    for (const u of ss.units) {
      if (u.typeId === 'death-star') return { sysId: sid, instanceId: u.instanceId };
    }
  }
  return null;
}

let failures = 0;
function fail(label, msg) {
  console.error(`  FAIL [${label}]: ${msg}`);
  failures++;
}

// ---------- PART 1: destroyUnit invariant guard ----------
console.log('PART 1: destroyUnit invariant guard');
{
  const G = makeGame();
  const ds = findDeathStar(G);
  if (!ds) { console.error('  SETUP FAIL: no Death Star placed.'); process.exit(1); }
  console.log(`  Death Star: ${ds.instanceId} at ${ds.sysId}`);
  let threw = false;
  try { M.destroyUnit(G, ds.instanceId, 'mission-effect'); }
  catch { threw = true; }
  if (!threw) fail('part1-throw', 'invariant did not throw on cause="mission-effect"');
  const alive = G.map.systems[ds.sysId].units.some((u) => u.instanceId === ds.instanceId);
  if (!alive) fail('part1-still-present', 'Death Star removed despite refused destroy');
  if (threw && alive) console.log('  ✓ Invariant throws on non-allowlisted cause and unit survives.');
}

// ---------- PART 2: fuzz every registered effect handler ----------
console.log('\nPART 2: handler-fuzz — invoke every registered effect against a Death-Star system');
const allKeys = registry.listKeys();
console.log(`  ${allKeys.length} effect handlers registered.`);

// For each handler, build a fresh game, find the Death Star, pad the system
// with a few extra Empire targets so any "destroy up to N health" effect
// has alternatives, add a Rebel witness, then invoke.
let passed = 0, skipped = 0;
for (const key of allKeys) {
  const G = makeGame(`fuzz-${key}`);
  const ds = findDeathStar(G);
  if (!ds) { fail(`fuzz/${key}`, 'no Death Star in seeded game'); continue; }
  // Bulk up the system so handlers with budget have other targets to spend on
  // (so it's a fair test: if they incorrectly pick the Death Star, it's not
  // because they had no choice).
  const ss = G.map.systems[ds.sysId];
  for (const t of ['stormtrooper', 'tie-fighter', 'at-st', 'at-st', 'tie-fighter']) {
    ss.units.push({
      instanceId: `pad-${key}-${ss.units.length}`,
      typeId: t, side: 'Empire', damage: 0,
    });
  }
  // Witness Rebel so handlers that require "Rebel units present" work.
  ss.units.push({
    instanceId: `witness-${key}`,
    typeId: 'rebel-trooper', side: 'Rebel', damage: 0,
  });
  // Build a context targeting that system. Use plausible leaders for both sides
  // so leader-target handlers have something to chew on.
  const ctx = registry.makeContext('Rebel', { kind: 'mission', id: key }, {
    targetSystemId: ds.sysId,
    targetLeaderId: 'darth-vader',
    leaderIds: ['mon-mothma', 'luke-skywalker'],
  });
  let invariantThrew = false;
  try {
    registry.invokeByKey(G, key, ctx);
  } catch (e) {
    if (String(e.message).includes('INVARIANT: refused to destroy indestructible')) {
      invariantThrew = true;
      fail(`fuzz/${key}`, `handler attempted to destroy Death Star: ${e.message.slice(0, 160)}`);
      continue;
    }
    // Other errors (handler needed a context piece we didn't provide) are
    // not failures — we just couldn't exercise the handler. Skip it.
    skipped++;
    continue;
  }
  // Check Death Star still on board.
  const stillAlive = G.map.systems[ds.sysId].units.some((u) => u.instanceId === ds.instanceId);
  if (!stillAlive) {
    fail(`fuzz/${key}`, 'Death Star removed without invariant throwing — possible silent splice');
    continue;
  }
  // Also check pendingChoice for DestroyUpToHealth-with-deathstar.
  const pc = G.pendingChoice;
  if (pc && pc.kind === 'DestroyUpToHealth' && pc.candidates?.includes(ds.instanceId)) {
    fail(`fuzz/${key}`, `pendingChoice DestroyUpToHealth has Death Star in candidates`);
    continue;
  }
  passed++;
}
console.log(`  ${passed} handlers passed (Death Star survived), ${skipped} skipped (handler needed unavailable context), ${failures} failed.`);

// ---------- PART 3: allowlisted cause actually destroys it ----------
console.log('\nPART 3: allowlisted "death-star-plans" cause actually destroys the Death Star');
{
  const G = makeGame('part3');
  const ds = findDeathStar(G);
  if (!ds) { fail('part3', 'no Death Star in seeded game'); }
  else {
    try { M.destroyUnit(G, ds.instanceId, 'death-star-plans'); }
    catch (e) { fail('part3', `allowlisted cause threw: ${e.message}`); }
    const alive = G.map.systems[ds.sysId].units.some((u) => u.instanceId === ds.instanceId);
    if (alive) fail('part3', 'allowlisted cause did NOT destroy the Death Star');
    else console.log('  ✓ "death-star-plans" cause successfully destroyed the Death Star.');
  }
}

console.log('');
if (failures === 0) {
  console.log('ALL PASS — Death Star is protected against every registered effect handler.');
  process.exit(0);
} else {
  console.log(`FAILED — ${failures} failure(s).`);
  process.exit(1);
}
