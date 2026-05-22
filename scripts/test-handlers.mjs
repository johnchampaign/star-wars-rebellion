// Effect handler tests. Run: node scripts/test-handlers.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { register } = await import('tsx/esm/api');
register();

const { createGame } = await import('../src/engine/setup.ts');
const phases = await import('../src/engine/phases.ts');
const M = await import('../src/engine/mechanics.ts');
const Handlers = await import('../src/engine/handlers/registry.ts');

function loadJson(p) { return JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf-8')); }
const data = {
  systems: loadJson('systems.json'), adjacency: loadJson('adjacency.json'),
  leaders: loadJson('leaders.json'), actions: loadJson('actions.json'),
  missions: loadJson('missions.json'), objectives: loadJson('objectives.json'),
  tactics: loadJson('tactics.json'), probes: loadJson('probes.json'),
};

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
}

// Set effectKey on each mission to the mission id (for these tests). Real
// data extraction left effectKey empty — handlers look up by missionId when
// effectKey is empty (see runMissionEffect).
function bindEffectKeys(G) {
  for (const m of Object.values(G.catalog.missions)) {
    if (!m.effectKey) m.effectKey = m.id;
  }
}

// ---------- Sabotage ----------
console.log('\n[ Sabotage ]');
{
  const G = createGame(data, { seed: 300 });
  bindEffectKeys(G);
  // Find sabotage in Rebel hand, assign Han or someone with spec-ops 1+.
  // Mon Mothma has 0 specOps. Find any Rebel with specOps ≥ 1.
  const specOpsLeader = Object.values(G.catalog.leaders).find(l => l.side === 'Rebel' && l.skills.specOps >= 1 && G.rebel.leaderPool.includes(l.id));
  if (!specOpsLeader) {
    // No starting Rebel with specOps. Force one.
    const luke = G.catalog.leaders['luke-skywalker'];
    luke.skills.specOps = 1;
    var actorId = 'luke-skywalker';
  } else { var actorId = specOpsLeader.id; }
  phases.assignLeader(G, 'Rebel', 'sabotage', [actorId]);
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  const r = phases.revealMission(G, 'Rebel', 'sabotage', 'felucia');
  check('reveal Sabotage', r.ok, r.reason);
  check('sabotage marker placed on felucia', G.map.systems['felucia'].sabotage === true);
}

// ---------- Build Alliance ----------
console.log('\n[ Build Alliance ]');
{
  const G = createGame(data, { seed: 301 });
  bindEffectKeys(G);
  phases.assignLeader(G, 'Rebel', 'build-alliance', ['mon-mothma']); // diplomacy 3
  phases.skipAssignment(G, 'Rebel'); phases.skipAssignment(G, 'Empire');
  const before = G.map.systems['felucia'].loyalty;
  phases.revealMission(G, 'Rebel', 'build-alliance', 'felucia');
  const after = G.map.systems['felucia'].loyalty;
  check('felucia loyalty advances toward Rebel', after !== before, `${before} -> ${after}`);
}

// ---------- Rule by Fear ----------
console.log('\n[ Rule by Fear ]');
{
  const G = createGame(data, { seed: 302 });
  bindEffectKeys(G);
  // Empire needs to assign; we go through Rebel skip first.
  phases.skipAssignment(G, 'Rebel');
  // Now Empire's turn in Assignment.
  // Palpatine has diplomacy 3.
  phases.assignLeader(G, 'Empire', 'rule-by-fear', ['emperor-palpatine']);
  phases.skipAssignment(G, 'Empire');
  // Both done -> Command.
  phases.pass(G, 'Rebel'); // Rebel passes
  // Empire reveals. Must use Imperial system with Imperial unit; malastare is subjugated/imperial with empire units.
  // Find an Imperial system: from setup either an imperial-loyalty or subjugated.
  const imperialSys = Object.entries(G.map.systems).find(([id, s]) =>
    (s.loyalty === 'imperial' || s.subjugated) && s.units.some(u => u.side === 'Empire')
  );
  if (imperialSys) {
    const [sysId] = imperialSys;
    // "Attempt in any populous system that contains an Imperial unit. If successful, gain 1 loyalty in this system."
    // Rule by Fear is in Empire's starting hand. Reveal it.
    const r = phases.revealMission(G, 'Empire', 'rule-by-fear', sysId);
    // Note: gainLoyalty on already-imperial system is no-op. On subjugated → first step removes nothing/places imperial (depending on layered loyalty).
    check('reveal Rule by Fear', r.ok, r.reason);
  } else {
    check('imperial system found', false, 'no imperial system in setup');
  }
}

// ---------- Hit and Run (direct handler invocation) ----------
console.log('\n[ Hit and Run ]');
{
  const G = createGame(data, { seed: 303 });
  M.deployUnit(G, 'Empire', 'stormtrooper', 'yavin');
  M.deployUnit(G, 'Empire', 'stormtrooper', 'yavin');
  const before = G.map.systems['yavin'].units.length;
  const ctx = Handlers.makeContext('Rebel', { kind: 'mission', id: 'hit-and-run' }, { targetSystemId: 'yavin' });
  Handlers.invokeByKey(G, 'hit-and-run', ctx);
  const after = G.map.systems['yavin'].units.length;
  check('hit-and-run destroyed units', after < before, `${before} -> ${after}`);
}

// ---------- Gather Intel ----------
console.log('\n[ Gather Intel ]');
{
  const G = createGame(data, { seed: 304 });
  bindEffectKeys(G);
  // Empire needs intel 1; Palpatine has 2.
  phases.skipAssignment(G, 'Rebel');
  phases.assignLeader(G, 'Empire', 'gather-intel', ['emperor-palpatine']);
  phases.skipAssignment(G, 'Empire');
  phases.pass(G, 'Rebel');
  const before = G.empire.probeHand?.length ?? 0;
  // Attempt in any Rebel System.
  const rebelSys = Object.entries(G.map.systems).find(([, s]) => s.loyalty === 'rebel');
  if (rebelSys) {
    phases.revealMission(G, 'Empire', 'gather-intel', rebelSys[0]);
    const after = G.empire.probeHand?.length ?? 0;
    check('gather intel drew probe cards', after > before, `${before} -> ${after}`);
  } else {
    check('rebel system found', false);
  }
}

// ---------- Registry sanity ----------
console.log('\n[ Registry ]');
{
  const keys = Handlers.listKeys();
  check('registry populated', keys.length > 20, `got ${keys.length} keys`);
  check('sabotage registered', Handlers.has('sabotage'));
  check('construct-death-star registered', Handlers.has('construct-death-star'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
