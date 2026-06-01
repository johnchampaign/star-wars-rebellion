// Turn-order regression test + log detector for the Command phase.
//
// THE BUG (issue #77, fixed in combat.ts): a mission that triggered combat
// (Public Uprising, Plan the Assault, ...) cleared pendingMission WITHOUT
// advancing the command turn, so the resolving side kept taking turns —
// "the Rebel AI played 3 missions in a row while I still had missions to
// play." Non-combat missions handed off correctly, so it only happened
// sometimes. This script guards against a regression.
//
// RAW invariant checked: during the Command phase, players ALTERNATE one
// action at a time (reveal-mission / activate-system). The only time a side
// may take consecutive actions is after the OTHER side has passed. So a
// same-side action immediately following another same-side action, while the
// opponent has NOT passed, is a turn-order violation.
//
// Two modes:
//   node scripts/test-turn-order.mjs                 # self-play: drive N fresh
//                                                     # AI-vs-AI games, ASSERT
//                                                     # zero violations (the test)
//   node scripts/test-turn-order.mjs --games 12 --seed 1
//   node scripts/test-turn-order.mjs --scan-logs      # scan logs/*.json and
//                                                     # report (historical logs
//                                                     # may predate the fix)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const argv = process.argv.slice(2);
const SCAN_LOGS = argv.includes('--scan-logs');
const GAMES = (() => { const i = argv.indexOf('--games'); return i >= 0 ? parseInt(argv[i + 1], 10) : 12; })();
const SEED0 = (() => { const i = argv.indexOf('--seed'); return i >= 0 ? parseInt(argv[i + 1], 10) : 1; })();

const COMMAND_ACTIONS = new Set(['reveal-mission', 'activate-system']);

/** Scan a turnLog for Command-phase turn-order violations. Returns an array of
 *  { turn, side, streak, kind, tag } for each same-side consecutive action
 *  taken while the opponent had NOT passed. */
function findViolations(turnLog) {
  const out = [];
  let phase = null, streakSide = null, streak = 0, passed = new Set();
  for (const e of turnLog) {
    if (e.kind === 'phase') { phase = e.payload?.phase; streakSide = null; streak = 0; passed = new Set(); continue; }
    if (phase !== 'Command') continue;
    if (e.kind === 'pass') { passed.add(e.side); streakSide = null; streak = 0; continue; }
    if (!COMMAND_ACTIONS.has(e.kind)) continue;
    const side = e.side;
    if (side === streakSide) streak++; else { streak = 1; streakSide = side; }
    const other = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (streak >= 2 && !passed.has(other)) {
      const p = e.payload || {};
      out.push({ turn: e.turn, side, streak, kind: e.kind, tag: p.missionId || p.targetSystemId || '' });
    }
  }
  return out;
}

const mod = await import('tsx/esm/api'); mod.register();

if (SCAN_LOGS) {
  // ---- Detector mode: scan uploaded logs. Informational (old logs may
  // predate the fix); does not fail the process.
  const dir = join(ROOT, 'logs');
  if (!existsSync(dir)) { console.log('No logs/ directory.'); process.exit(0); }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  let flagged = 0;
  for (const f of files) {
    let codec;
    try { codec = JSON.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')).game.codec); } catch { continue; }
    const v = findViolations(codec.state?.turnLog || []);
    if (v.length) {
      flagged++;
      const human = (() => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')).game.humanSide ?? '(none)'; } catch { return '?'; } })();
      console.log(`${f} (human=${human}): ${v.length} violation(s) — e.g. turn ${v[0].turn} ${v[0].side} x${v[0].streak} (${v[0].kind} ${v[0].tag})`);
    }
  }
  console.log(`\nScanned ${files.length} logs; ${flagged} show Command turn-order violations.`);
  console.log('(Historical logs recorded before the #77 fix are expected to flag.)');
  process.exit(0);
}

// ---- Self-play regression test: drive fresh AI-vs-AI games and assert clean.
const { createGame } = await import('../src/engine/setup.ts');
const { stepOnce: aiStep, seedAI } = await import('../src/play/randomAI.ts');
const load = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const data = {
  systems: load('systems.json'), adjacency: load('adjacency.json'), leaders: load('leaders.json'),
  actions: load('actions.json'), missions: load('missions.json'), objectives: load('objectives.json'),
  tactics: load('tactics.json'), probes: load('probes.json'),
};

function fail(msg) { console.error('FAIL:', msg); process.exit(1); }

let totalCombatMissions = 0;
let gamesDriven = 0;
for (let s = SEED0; s < SEED0 + GAMES; s++) {
  const G = createGame(data, { seed: s, autoSetupUnits: true });
  seedAI(s);
  // Drive setup, then the game, both sides via the heuristic AI (tournament pattern).
  let steps = 0;
  const CAP = 200000;
  while (!G.isGameOver && steps < CAP) {
    const side = G.currentPlayer;
    if (aiStep(G, side)) { steps++; continue; }
    const other = side === 'Rebel' ? 'Empire' : 'Rebel';
    if (aiStep(G, other)) { steps++; continue; }
    break; // stuck or done
  }
  gamesDriven++;
  // Count combat-from-mission occurrences (the path the fix touches) so we know
  // the test actually exercised it.
  const tl = G.turnLog || [];
  for (let i = 1; i < tl.length; i++) {
    if (tl[i].kind === 'combat-begin' && tl[i - 1]?.kind && tl[i - 1].kind.startsWith('reveal-mission')) totalCombatMissions++;
  }
  const violations = findViolations(tl);
  if (violations.length) {
    const v = violations[0];
    fail(`seed ${s}: ${violations.length} turn-order violation(s) — turn ${v.turn} ${v.side} took ${v.streak} consecutive Command actions while the opponent had not passed (${v.kind} ${v.tag}). The #77 bug (or a relative) is back.`);
  }
}

console.log(`OK: ${gamesDriven} AI-vs-AI games driven (seeds ${SEED0}..${SEED0 + GAMES - 1}), no Command turn-order violations.`);
console.log('PASS: turn-order regression test');
