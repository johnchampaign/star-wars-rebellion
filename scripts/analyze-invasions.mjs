// Analyze uploaded human games: how is the Rebel-base invasion executed?
// Decodes each logs/<hash>.json codec, finds reveal-base, and prints the
// Empire's action sequence from that point to game end — to learn the
// real invasion choreography (staging, mission use, multi-source moves).
//
// Usage: node scripts/analyze-invasions.mjs [logsDir]

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const dir = process.argv[2] ? process.argv[2] : join(ROOT, 'logs');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

function loadGame(file) {
  const raw = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
  const wrap = raw.game ?? raw;
  let st = null;
  if (typeof wrap.codec === 'string') { try { st = JSON.parse(wrap.codec).state; } catch { /**/ } }
  if (!st && wrap.turnLog) st = wrap;
  // humanSide is recorded on the upload WRAPPER (not inside the engine codec).
  // Older uploads predate it → unknown. Never infer it from outcomes.
  const humanSide = wrap.humanSide ?? raw.humanSide ?? null;
  return { st, humanSide };
}
function loadTurnLog(file) { return loadGame(file).st; }

const summary = [];
for (const f of files) {
  const { st, humanSide } = loadGame(f);
  if (!st) continue;
  const log = st.turnLog ?? [];
  if (log.length === 0) continue;
  const reveal = log.find((e) => e.kind === 'reveal-base');
  if (!reveal) continue;
  const baseSys = reveal.payload?.systemId ?? null;
  const revealTurn = reveal.turn ?? 0;
  const idx = log.indexOf(reveal);
  // Empire actions after the reveal.
  const after = log.slice(idx + 1);
  const empAct = after.filter((e) =>
    (e.side === 'Empire' && ['activate-system', 'reveal-mission', 'place-leader'].includes(e.kind)) ||
    ['combat-begin', 'combat-end', 'deploy', 'build-queue'].includes(e.kind));
  // Count signals.
  const baseCombats = after.filter((e) => e.kind === 'combat-begin' && e.payload?.systemId === baseSys
    && e.payload?.attackerSide === 'Empire').length;
  const activationsToBase = after.filter((e) => e.kind === 'activate-system' && e.side === 'Empire'
    && e.payload?.targetSystemId === baseSys).length;
  // Who controlled which side. humanSide is the RECORDED field (or unknown);
  // the Empire is human iff humanSide==='Empire', AI otherwise.
  const empireController = humanSide === 'Empire' ? 'human' : humanSide === 'Rebel' ? 'AI' : 'unknown';
  summary.push({
    file: f.slice(0, 12), winner: st.winner, reason: st.winReason, endTurn: st.timeMarker,
    humanSide: humanSide ?? 'unknown', empireController,
    revealTurn, baseSys, turnsToEnd: (st.timeMarker ?? 0) - revealTurn,
    baseInvasions: baseCombats, activationsToBase, postRevealEmpireActions: empAct.length,
  });
}

console.log(`\n=== ${summary.length} uploaded games with a base reveal (of ${files.length} files) ===\n`);
const known = summary.filter((s) => s.empireController !== 'unknown');
console.log(`Empire controller recorded: ${known.length}/${summary.length} games`
  + (known.length < summary.length ? ` (${summary.length - known.length} predate the humanSide field — controller unknown, do NOT infer it)` : ''));
console.log(`Empire base-capture wins: ${summary.filter((s) => s.winner === 'Empire' && s.reason === 'base-captured').length}`);
for (const s of summary.sort((a, b) => (b.winner === 'Empire') - (a.winner === 'Empire'))) {
  console.log(`  ${s.file}  Empire=${s.empireController.padEnd(7)} ${String(s.winner).padEnd(7)} ${String(s.reason).padEnd(16)} reveal@T${s.revealTurn} end@T${s.endTurn} (${s.turnsToEnd}t)  base=${s.baseSys}  invasions=${s.baseInvasions}`);
}

// Detailed choreography for the first 2 confirmed human-Empire base-capture wins.
const wins = summary.filter((s) => s.winner === 'Empire' && s.reason === 'base-captured'
  && s.empireController === 'human');
for (const w of (wins.length ? wins : summary.filter((s) => s.winner === 'Empire' && s.reason === 'base-captured')).slice(0, 2)) {
  const st = loadTurnLog(files.find((f) => f.startsWith(w.file)));
  const log = st.turnLog;
  const idx = log.findIndex((e) => e.kind === 'reveal-base');
  console.log(`\n--- ${w.file}: Empire invasion choreography (base ${w.baseSys}, reveal T${w.revealTurn}) ---`);
  for (const e of log.slice(idx)) {
    if (e.side === 'Empire' && ['activate-system', 'reveal-mission', 'place-leader', 'pass'].includes(e.kind)) {
      const p = e.payload ?? {};
      console.log(`  T${e.turn} ${e.kind}${p.targetSystemId ? ' -> ' + p.targetSystemId : ''}${p.missionId ? ' (' + p.missionId + ')' : ''}${p.leaderId ? ' [' + p.leaderId + ']' : ''}${p.orders ? ' x' + p.orders : ''}`);
    } else if (['combat-begin', 'combat-end', 'reveal-base'].includes(e.kind)) {
      const p = e.payload ?? {};
      console.log(`  T${e.turn} ${e.kind} @${p.systemId}${p.attackerSide ? ' by ' + p.attackerSide : ''}${p.winner ? ' -> ' + p.winner : ''}`);
    }
  }
}
console.log('');
