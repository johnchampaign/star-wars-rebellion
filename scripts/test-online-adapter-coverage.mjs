// META-TRIPWIRE for the online-adapter soft-lock class (memory
// "online-adapter-missing-resolvers"). Any engine function the UI dispatches via
// `phases.X(` / `combat.X(` that MUTATES authoritative state must be overridden
// in src/online/onlineEngine.ts (which submits it to the server) — otherwise it
// runs on the local view only online and the game soft-locks (reverts on the
// next server poll).
//
// This test diffs the set of UI-dispatched engine calls against the onlineEngine
// override map. Every UI call must be EITHER overridden OR in READ_ONLY (pure
// query helpers that never mutate G — safe to run locally online). A new, unwired
// mutating resolver fails here immediately, before it can ship and freeze a game.
// Run: node scripts/test-online-adapter-coverage.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Pure read-only helpers the UI calls on the phases/combat namespaces. These
// compute a value from G and never mutate it, so running them locally in an
// online game is correct — they must NOT be submitted to the server. If you add
// one, it goes here; if you add anything that MUTATES, wire it into the adapter.
const READ_ONLY = new Set([
  'leaderRecruitable',
  'playableAssignmentActionCards',
  'playableImmediateActionCards',
  'totalSkill',
]);

// Engine functions actually exported (so we don't flag a local helper that just
// happens to be namespaced the same way — only real engine entry points count).
const engineSrc = read('src/engine/phases.ts') + '\n' + read('src/engine/combat.ts');
const exported = new Set([...engineSrc.matchAll(/export function ([a-zA-Z0-9]+)\s*\(/g)].map((m) => m[1]));

// Everything the UI dispatches through the engine namespaces.
const uiSrc = read('src/play/PlayTab.tsx') + '\n' + read('src/play/CombatBoardLive.tsx');
const uiCalls = new Set(
  [...uiSrc.matchAll(/\b(?:phases|combat)\.([a-zA-Z0-9]+)\s*\(/g)]
    .map((m) => m[1])
    .filter((fn) => exported.has(fn)),
);

// Everything overridden in the online shim.
const onlineSrc = read('src/online/onlineEngine.ts');
const overridden = new Set([...onlineSrc.matchAll(/^\s+([a-zA-Z0-9]+):\s*\(/gm)].map((m) => m[1]));

let pass = 0, fail = 0;
const check = (n, ok, e = '') => { if (ok) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}${e ? ' — ' + e : ''}`); fail++; } };

console.log('\n[ every UI-dispatched mutating engine resolver is wired for online play ]');
const gaps = [...uiCalls].filter((fn) => !overridden.has(fn) && !READ_ONLY.has(fn)).sort();
check(`no unwired mutating resolvers (${uiCalls.size} UI calls checked)`, gaps.length === 0,
  gaps.length ? `MISSING online override (soft-lock risk): ${gaps.join(', ')}` : '');

// Guard the whitelist against rot: a READ_ONLY entry that is no longer called by
// the UI should be pruned (keeps the list honest).
const staleWhitelist = [...READ_ONLY].filter((fn) => !uiCalls.has(fn) && !overridden.has(fn));
check('READ_ONLY whitelist has no stale (uncalled) entries', staleWhitelist.length === 0,
  staleWhitelist.length ? `prune: ${staleWhitelist.join(', ')}` : '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
