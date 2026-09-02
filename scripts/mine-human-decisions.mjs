// Step 1 of the imitation plan: mine (exact position, human action) pairs from
// the uploaded archive. v1 = the human's FIRST Command decision of every round.
//
// Why "first": the archive stores one full state per round (the turn-start
// snapshot) plus the event log. Reaching the first Command decision exactly
// means replaying Refresh + Assignment, which is ~10 choice kinds whose
// resolutions ARE recorded (deploy, build, recruit, ring, hand-trim, pool cap,
// assignment). Later decisions in the same round sit behind combat/opposition
// (~100 more resolver kinds) — that is v2.
//
// Method: hydrate the snapshot (codec), pump the engine, and answer every
// choice it posts with the recorded resolution. Any choice with no recorded
// mapping is answered by the heuristic AI and the sample is flagged APPROX so
// it can be excluded. Output: JSONL, one sample per (game, round).
//
// Usage: node scripts/mine-human-decisions.mjs [--limit N] [--out file.jsonl]
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotToCodec } from './lib/log-reader.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const LIMIT = Number(args[args.indexOf('--limit') + 1] || 0) || Infinity;
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(ROOT, 'reports', 'human-decisions.jsonl');

const { register } = await import('tsx/esm/api'); register();
const setup = await import('../src/engine/setup.ts');
const codec = await import('../src/engine/codec.ts');
const phases = await import('../src/engine/phases.ts');
const AI = await import('../src/play/randomAI.ts');
const j = (p) => JSON.parse(readFileSync(join(ROOT, 'assets', p), 'utf8'));
const catalog = setup.buildCatalog({ systems: j('systems.json'), adjacency: j('adjacency.json'), leaders: j('leaders.json'), actions: j('actions.json'), missions: j('missions.json'), objectives: j('objectives.json'), tactics: j('tactics.json'), probes: j('probes.json') });

const stats = { byMonth: {}, games: 0, rounds: 0, exact: 0, approx: 0, failed: 0, samples: 0, matched: 0, top3: 0, byFail: {}, fallbackKinds: {} };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

/** Answer the engine's pending choice from the recorded events. Returns
 *  'exact' | 'approx' | 'fail'. `cur` is a cursor object {i} over events. */
function answer(G, ev, cur) {
  const pc = G.pendingChoice; const side = pc.side;
  const find = (kinds, sameSide = true) => {
    for (let k = cur.i; k < ev.length; k++) {
      const e = ev[k];
      if (e.kind === 'phase' && e.payload?.phase === 'Command') return null; // ran past the round's decision point
      if (kinds.includes(e.kind) && (!sameSide || !e.side || e.side === side)) { cur.i = k + 1; return e; }
    }
    return null;
  };
  const ok = (r) => (r && r.ok) ? 'exact' : ('fail:' + (r?.reason ?? 'unknown'));
  switch (pc.kind) {
    case 'RecruitActionCardPick': { const e = find(['recruit-pick-resolved']); return e ? ok(phases.resolveRecruitActionCardPick(G, e.payload.kept)) : 'fail'; }
    case 'RecruitLeaderPick': { const e = find(['recruit-leader']); return e ? ok(phases.resolveRecruitLeaderPick(G, e.payload.leaderId)) : 'fail'; }
    case 'AttachRingPick': { const e = find(['ring-attach'], false); return e ? ok(phases.resolveAttachRing(G, e.payload.leaderId)) : 'fail'; }
    case 'DeployUnitPick': {
      // Match by unit TYPE as well as side: the deploy step posts one pick per
      // unit, and the recorded deploys for a side can be in a different order
      // than the engine's queue walk only if types differ — pin the type.
      let e = null;
      for (let k = cur.i; k < ev.length; k++) {
        const x = ev[k];
        if (x.kind === 'phase' && x.payload?.phase === 'Command') break;
        if (x._used || x.side !== side) continue;
        if ((x.kind === 'deploy' || x.kind === 'deploy-declined-to-queue') && x.payload?.typeId === pc.typeId) { e = x; ev[k] = { ...x, _used: true }; break; }
      }
      if (!e) return 'fail:no-recorded-deploy-for-' + pc.typeId;
      return e.kind === 'deploy' ? ok(phases.resolveDeployUnitPick(G, e.payload.systemId)) : ok(phases.declineDeployUnit(G));
    }
    case 'BuildPick': {
      // One choice per icon, in the engine's order. A pick that produced a
      // unit logged build-queue {typeId, slot, sourceSystemId}; a wasted icon
      // logged build-wasted-no-supply; an icon the UI skipped sends ''. Match
      // each icon to its recorded outcome by (slot, source) rather than
      // assuming one event per icon.
      const cur0 = G.refreshPaused?.pendingBuildPicks?.[0];
      const picks = [];
      if (process.env.MINE_DEBUG && !answer._bpShown) { answer._bpShown = true;
        console.log('   BuildPick picks:', JSON.stringify(cur0?.picks?.map((q) => [q.slot, q.sourceSystemId, q.legalUnitTypes])));
        console.log('   next build events:', JSON.stringify(ev.slice(cur.i, cur.i + 12).filter((e) => /build/.test(e.kind)).map((e) => [e.kind, e.side, e.payload?.typeId, e.payload?.slot, e.payload?.sourceSystemId]))); }
      for (const q of cur0?.picks ?? []) {
        let chosen = '';
        for (let k = cur.i; k < ev.length; k++) {
          const e = ev[k];
          if (e.kind === 'phase') break;
          if (e.side !== side) continue;
          if (!e._used && e.kind === 'build-queue' && e.payload.slot === q.slot && e.payload.sourceSystemId === q.sourceSystemId && (q.legalUnitTypes ?? []).includes(e.payload.typeId)) { chosen = e.payload.typeId; ev[k] = { ...e, _used: true }; break; }
          if (!e._used && e.kind === 'build-wasted-no-supply' && e.payload.slot === q.slot && e.payload.sourceSystemId === q.sourceSystemId) { ev[k] = { ...e, _used: true }; break; }
        }
        picks.push(chosen);
      }
      return ok(phases.resolveBuildPicks(G, picks));
    }
    case 'HandLimitDiscard': {
      const n = pc.count ?? 1; const ids = [];
      for (let k = 0; k < n; k++) { const e = find(['mission-hand-trim']); if (!e) return 'fail'; ids.push(e.payload.missionId); }
      return ok(phases.resolveHandLimitDiscard(G, ids));
    }
    case 'LeaderPoolEliminate': { const e = find(['leader-pool-cap-eliminate']); if (e) return ok(phases.resolveLeaderPoolEliminate(G, e.payload.leaderId)); break; }
    case 'PlayAssignmentActionCard': {
      // Peek ahead: a cancel means "no card played" (most common); an
      // action-card-play names the card that was played.
      for (let k = cur.i; k < ev.length; k++) {
        const e = ev[k];
        if (e.kind === 'choice-cancel' && e.side === side) { cur.i = k + 1; return ok(phases.cancelAssignmentActionCardPlay(G)); }
        if (e.kind === 'action-card-play' && e.side === side) { cur.i = k + 1; return ok(phases.playAssignmentActionCard(G, e.payload.cardId)); }
        if (['assign-leader', 'unassign-leader', 'skip-assignment'].includes(e.kind)) break;
      }
      break;
    }
    case 'ActionCardSystemPick': { const e = find(['place-leader']); return e ? ok(phases.resolveActionCardSystemPick(G, e.payload.systemId)) : 'fail:no-place-leader'; }
    default: break;
  }
  // Fallback: let the heuristic AI answer; mark approximate.
  bump(stats.fallbackKinds, pc.kind);
  const did = AI.stepOnce(G, side);
  return did ? 'approx' : 'fail';
}

const out = [];
const files = readdirSync(join(ROOT, 'logs')).filter((f) => f.endsWith('.json')).sort();
const seen = new Set();
for (const f of files) {
  if (stats.games >= LIMIT) break;
  let d; try { d = JSON.parse(readFileSync(join(ROOT, 'logs', f), 'utf8')); } catch { continue; }
  if (!('meta' in d)) continue;
  const players = (d.meta || {}).players || {};
  const human = Object.keys(players).find((s) => players[s] === 'human');
  if (!human) continue;
  const gid = d.gameId || f; if (seen.has(gid)) continue; seen.add(gid);
  stats.games++;
  const month = (() => { try { return (readdirSync ? '' : '') || new Date(statSync(join(ROOT, 'logs', f)).mtimeMs).toISOString().slice(0, 7); } catch { return '?'; } })();
  for (const t of d.timeline || []) {
    const s = t.snapshot; if (!s || !s.map) continue;
    const ev = t.events || []; stats.rounds++;
    let G; try { G = codec.decode(snapshotToCodec(s), catalog); } catch (x) { bump(stats.byFail, 'decode'); stats.failed++; continue; }
    if (G.isGameOver) continue;
    const cur = { i: 0 };
    // position cursor just after advance-time
    const at = ev.findIndex((e) => e.kind === 'advance-time'); cur.i = at >= 0 ? at + 1 : 0;
    let quality = 'exact'; let guard = 0; let failed = false; const fallbacks = [];
    try {
      while (G.phase !== 'Command' && !G.isGameOver && guard++ < 400) {
        if (G.pendingChoice) {
          const kindBefore = G.pendingChoice.kind;
          const q = answer(G, ev, cur);
          if (q.startsWith('fail')) { failed = true; bump(stats.byFail, `${G.phase}:${kindBefore}:${q.slice(5)}`); break; }
          if (q === 'approx') { quality = 'approx'; fallbacks.push(kindBefore); }
          continue;
        }
        if (G.phase === 'Refresh') { if (!phases.resumeRefreshTurnStart(G)) { failed = true; bump(stats.byFail, 'refresh-stalled'); break; } continue; }
        if (G.phase === 'Assignment') {
          // Replay recorded assignment actions in order until the Command phase.
          let e = null;
          for (; cur.i < ev.length; cur.i++) { const x = ev[cur.i]; if (['assign-leader', 'unassign-leader', 'skip-assignment'].includes(x.kind) || (x.kind === 'phase' && x.payload?.phase === 'Command')) { e = x; cur.i++; break; } }
          if (!e || e.kind === 'phase') { failed = true; bump(stats.byFail, 'assignment-incomplete'); break; }
          // The human can take an assignment back (#76 undo) — replay it, or
          // the re-assignment that follows fails as "leader not in pool".
          const r = e.kind === 'assign-leader' ? phases.assignLeader(G, e.side, e.payload.missionId, e.payload.leaderIds)
            : e.kind === 'unassign-leader' ? phases.unassignLeader(G, e.side, e.payload.missionId)
            : phases.skipAssignment(G, e.side);
          if (!r.ok && process.env.MINE_DEBUG && (stats._dumped = (stats._dumped || 0) + 1) <= 3) {
            const side = e.side; const F = side === 'Rebel' ? G.rebel : G.empire;
            const missing = e.kind === 'assign-leader' ? e.payload.leaderIds.join('/') + ' -> ' + e.payload.missionId : 'skip';
            console.log(`\n   ASSIGN FAIL turn ${t.turn} ${side}: ${r.reason}  wanted ${missing}`);
            console.log('     replayed pool:', F.leaderPool.join(','), '| hand:', (F.missionHand || []).join(','));
            const win = ev.slice(at + 1, ev.findIndex((x) => x.kind === 'phase' && x.payload?.phase === 'Command'));
            const mention = win.filter((x) => JSON.stringify(x).includes(e.payload.leaderIds?.[0] ?? '') || JSON.stringify(x).includes(e.payload.missionId ?? '§'));
            console.log('     recorded events mentioning it in this round:', mention.map((x) => `${x.kind}${x.side ? '@' + x.side : ''}:${JSON.stringify(x.payload).slice(0, 60)}`).join(' | '));
            const unconsumed = win.filter((x) => !x._used && !['choice-request', 'ai-decision', 'build-queue', 'deploy', 'recruit-pick-resolved', 'recruit-leader', 'phase', 'advance-time', 'mission-hand-trim', 'ring-attach', 'deploy-declined-to-queue'].includes(x.kind)).map((x) => x.kind);
            console.log('     other refresh event kinds this round:', [...new Set(unconsumed)].join(','));
          }
          if (!r.ok) { failed = true; bump(stats.byFail, `assign:${r.reason.split(':')[0]}${fallbacks.length ? ' [after AI fallback: ' + [...new Set(fallbacks)].join(',') + ']' : ' [no fallback]'}`); break; }
          continue;
        }
        failed = true; bump(stats.byFail, `phase:${G.phase}`); break;
      }
    } catch (x) { failed = true; bump(stats.byFail, 'throw:' + String(x.message).slice(0, 50)); }
    stats.byMonth[month] ??= { rounds: 0, failed: 0 }; stats.byMonth[month].rounds++;
    if (failed || G.phase !== 'Command') { stats.failed++; stats.byMonth[month].failed++; continue; }
    if (quality === 'exact') stats.exact++; else stats.approx++;
    // The human's first Command action of the round.
    const first = ev.find((e) => e.side === human && e.phase === 'Command' && ['activate-system', 'reveal-mission', 'pass'].includes(e.kind));
    if (!first) continue;
    // Only meaningful if it is the human's turn to act first; Rebel acts first in Command.
    if (G.currentPlayer !== human) { /* the AI acts first this round; the human's first action is not from this exact state */ continue; }
    let cands; try { AI.seedAI(1); cands = AI.bestCommandAction(G, human); } catch { continue; }
    const same = (c) => first.kind === 'pass' ? c.kind === 'pass'
      : first.kind === 'activate-system' ? (c.kind === 'activate' && c.leaderId === first.payload.leaderId && c.targetSystemId === first.payload.targetSystemId)
      : (c.kind === 'reveal' && c.missionId === first.payload.missionId && c.targetSystemId === first.payload.targetSystemId);
    const idx = cands.findIndex(same);
    stats.samples++; if (idx >= 0) { stats.matched++; if (idx < 3) stats.top3++; }
    out.push({ gameId: gid, turn: t.turn, humanSide: human, quality, state: codec.encode(G), humanAction: { kind: first.kind, ...(first.payload || {}) },
      candidates: cands.slice(0, 12).map((c) => ({ kind: c.kind, leaderId: c.leaderId, targetSystemId: c.targetSystemId, missionId: c.missionId, score: c.score })), matchIndex: idx });
  }
}
writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`games ${stats.games}  rounds ${stats.rounds}  replayed to Command: exact ${stats.exact} approx ${stats.approx} failed ${stats.failed}`);
console.log(`samples (human moves first from an exact/approx state): ${stats.samples}   human action among heuristic candidates: ${stats.matched} (${(100 * stats.matched / Math.max(1, stats.samples)).toFixed(0)}%)   in top-3: ${stats.top3} (${(100 * stats.top3 / Math.max(1, stats.samples)).toFixed(0)}%)`);
console.log('failures:', stats.byFail);
console.log('failure rate by log month:', Object.fromEntries(Object.entries(stats.byMonth).sort().map(([m, v]) => [m, `${v.failed}/${v.rounds}`]))); console.log('AI-fallback choice kinds (approx):', stats.fallbackKinds);
console.log('wrote', OUT, out.length, 'samples');
