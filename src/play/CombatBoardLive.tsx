// Full-screen live combat board. Renders whenever G.pendingCombat is set;
// absorbs every in-combat decision (attacker tactics, defender tactics,
// damage assignment) so the player always has the unit / leader / dice
// context visible while making choices.
//
// Decisions still flow through G.pendingChoice — this component reads the
// kind and side, and only enables the decision panel when humanSide owns
// the choice. AI moves continue to auto-resolve via randomAI.ts.

import { useEffect, useRef, useState } from 'react';
import type { GameState, Side, UnitInstance, Theater, DieResult } from '../engine/types';
import * as _combat from '../engine/combat';
import { makeOnlineCombat } from '../online/onlineEngine';
import type { RebellionAction } from '../adapter/rebellionAction';
import { stepOnce as aiStepOnce } from './randomAI';
import { vmodAssetUrl, CARD_IMAGE_BASE, UNIT_IMAGE_BASE } from '../data/loadAssets';
import { unitImageUrl, getUnitStyle } from './unitImages';

// Active combat engine handle. Module-level so the component + any helpers
// resolve to the same one; reassigned per render to the online shim (submits to
// the server) or the real module (single-player). See onlineEngine.ts / PlayTab.
let combat = _combat;

const SIDE_COLOR = { Rebel: '#4fc3f7', Empire: '#ff8a80' } as const;

/** Hover-preview for a single card by id. Looks up the card in either the
 *  tactics or actions catalog (whichever has it) and floats a 220px image
 *  popup with the name + rules text. Used to wrap every card-name reference
 *  on the combat board so the player can read what's actually in their hand. */
function CardHover({ G, cardId, children }: {
  G: GameState;
  cardId: string;
  children: React.ReactNode;
}) {
  // Popover position is computed as fixed coordinates from the trigger's
  // on-screen rect, then clamped to the viewport. Player report: the tactic
  // card tooltip rendered off-screen to the right — the old absolute
  // left:'100%' / flip-left approach could still overflow because the combat
  // tactic cards sit near the right edge. Fixed + clamp can't run off any edge.
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const card =
    G.catalog.tactics[cardId] ??
    G.catalog.actions[cardId] ??
    G.catalog.objectives[cardId] ??
    null;
  if (!card) return <>{children}</>;
  const TILE_W = 220;
  const POPOVER_W = TILE_W + 16;
  const onEnter = () => {
    const el = anchorRef.current;
    if (!el || typeof window === 'undefined') { setPos({ left: 100, top: 100 }); return; }
    const r = el.getBoundingClientRect();
    // Prefer the right of the trigger; fall back to the left if it wouldn't
    // fit; then hard-clamp so the popover is always fully on-screen.
    const spaceRight = window.innerWidth - r.right;
    let left = spaceRight >= POPOVER_W + 16 ? r.right + 8 : r.left - POPOVER_W - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_W - 8));
    // Vertically center on the trigger, clamped so a tall card stays on-screen.
    const top = Math.min(Math.max(8, r.top + r.height / 2), window.innerHeight - 360);
    setPos({ left, top });
  };
  return (
    <span
      ref={anchorRef}
      style={{ borderBottom: '1px dotted #888', cursor: 'help', position: 'relative' }}
      onMouseEnter={onEnter}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div style={{
          position: 'fixed', left: pos.left, top: pos.top, transform: 'translateY(-50%)',
          zIndex: 3000,
          background: 'rgba(0,0,0,0.95)', border: '1px solid #555',
          padding: 8, borderRadius: 4, width: POPOVER_W,
          maxHeight: '92dvh', overflowY: 'auto',
          pointerEvents: 'none',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
        }}>
          {card.image ? (
            <img
              src={vmodAssetUrl(card.image, CARD_IMAGE_BASE)}
              alt={card.name}
              style={{ width: TILE_W, height: 'auto', borderRadius: 4, border: '1px solid #333' }}
            />
          ) : (
            <div style={{
              width: TILE_W, height: TILE_W * 1.4, background: '#222',
              color: '#888', fontSize: 12,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 8, textAlign: 'center',
            }}>
              {card.name}
            </div>
          )}
          <div style={{
            color: '#fff', fontSize: 13, fontWeight: 600, marginTop: 4, textAlign: 'center',
          }}>
            {card.name}
          </div>
          {card.rulesText && (
            <div style={{
              color: '#cbc4b0', fontSize: 11, marginTop: 4,
              lineHeight: 1.35, textAlign: 'left', whiteSpace: 'normal',
            }}>
              {card.rulesText}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

export function CombatBoardLive({ G, humanSide, oiamArmed, onPersist, onReportProblem, onShowDiceKey, onShowTacticKey, online }: {
  G: GameState;
  humanSide: Side;
  /** One In A Million is opt-in (#340): only show its panel when the player has
   *  armed it; otherwise PlayTab auto-skips the offer. */
  oiamArmed?: boolean;
  onPersist: () => void;
  /** Online mode: when set, combat resolvers submit a RebellionAction to the
   *  server instead of mutating local state, and the local AI combat-stepper is
   *  disabled (the opponent is a remote human). */
  online?: { submit: (a: RebellionAction) => Promise<void>; yourTurn: boolean } | null;
  /** Open the dice / tactic reference modals from inside combat — that's
   *  exactly when you need them (player request: MightyFaben). */
  onShowDiceKey?: () => void;
  onShowTacticKey?: () => void;
  /** Opens the "Report a problem" dialog from inside the combat overlay.
   *  Needed because the play-tab header (where the normal report button
   *  lives) is hidden behind the full-screen combat board, so players
   *  couldn't file a report while a combat was stuck (#26-ish — surfaced
   *  in conversation, not as a GH issue). */
  onReportProblem?: () => void;
}) {
  // Point the combat handle at the online shim (submits) or the real module.
  combat = online ? makeOnlineCombat(online.submit, () => online.yourTurn) : _combat;
  const c = G.pendingCombat;
  if (!c) return null;

  const systemName = G.catalog.systems[c.systemId]?.name ?? c.systemId;
  const attacker = c.attackerSide;
  const defender = attacker === 'Rebel' ? 'Empire' : 'Rebel';

  // "What just happened" — reconstruct from the log how this fight started
  // (which leader the attacker activated, and where the units came from), so
  // the combat window isn't a cold open (feature: MightyFaben).
  const triggerSummary = (() => {
    const tl = G.turnLog;
    let beginIdx = -1;
    for (let i = tl.length - 1; i >= 0; i--) {
      const e = tl[i];
      if (e.kind === 'combat-begin' && (e.payload as { systemId?: string })?.systemId === c.systemId) { beginIdx = i; break; }
    }
    if (beginIdx < 0) return null;
    let leaderName: string | null = null;
    const fromCounts = new Map<string, number>();
    let missionName: string | null = null;
    // Which cause we hit FIRST scanning backwards, i.e. the most recent one.
    // Player report #604: the Rebel ran a mission in the system, the Empire
    // then activated it and moved in, and the note still blamed the (earlier,
    // opposing-side) mission. Two guards: only the ATTACKER's own events can
    // be the cause, and the nearest cause to combat-begin wins.
    let firstCause: 'mission' | 'activation' | null = null;
    // Scan the entries leading up to combat-begin (same turn) for the cause.
    for (let i = beginIdx - 1; i >= 0 && i >= beginIdx - 40; i--) {
      const e = tl[i];
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.kind === 'combat-begin' || e.kind === 'combat-end') break; // previous combat
      if (e.kind === 'activate-system' && e.side === attacker
          && p.targetSystemId === c.systemId && !leaderName) {
        leaderName = G.catalog.leaders[p.leaderId as string]?.name ?? (p.leaderId as string);
        firstCause ??= 'activation';
      }
      if (e.kind === 'reveal-mission' && e.side === attacker
          && p.targetSystemId === c.systemId && !missionName) {
        missionName = G.catalog.missions[p.missionId as string]?.name ?? (p.missionId as string);
        firstCause ??= 'mission';
      }
      if (e.kind === 'move-unit' && p.to === c.systemId && p.from) {
        const from = p.from as string;
        fromCounts.set(from, (fromCounts.get(from) ?? 0) + 1);
      }
    }
    const sysName = (sid: string) => sid === 'rebel-base-space' ? 'the Rebel Base' : (G.catalog.systems[sid]?.name ?? sid);
    const froms = [...fromCounts.entries()].map(([s, n]) => `${n} from ${sysName(s)}`).join(', ');
    if (missionName && firstCause === 'mission') return `Triggered by the ${attacker} mission “${missionName}”.`;
    if (leaderName && froms) return `${attacker} activated ${leaderName} into ${systemName}, moving ${froms}.`;
    if (leaderName) return `${attacker} activated ${leaderName} into ${systemName}.`;
    if (froms) return `${attacker} moved in: ${froms}.`;
    return null;
  })();

  // Tactic cards played so far THIS combat, both sides (RAW: revealed once
  // played). Lets you see the enemy actually played one and click to read it
  // (feature: MightyFaben — "you can't tell if the enemy played a tactic").
  const playedTactics: { side: Side; card: string }[] = (() => {
    const tl = G.turnLog;
    let beginIdx = -1;
    for (let i = tl.length - 1; i >= 0; i--) {
      const e = tl[i];
      if (e.kind === 'combat-begin' && (e.payload as { systemId?: string })?.systemId === c.systemId) { beginIdx = i; break; }
    }
    if (beginIdx < 0) return [];
    const out: { side: Side; card: string }[] = [];
    for (let i = beginIdx + 1; i < tl.length; i++) {
      const e = tl[i];
      if (e.kind === 'combat-end') break;
      // combat-tactic fires when a tactic ACTS (reroll/damage). But a cinematic
      // tactic that's revealed and then CANCELLED by the opponent, or that has
      // NO applicable ability, logs a different event and would otherwise never
      // show — so the enemy's defensive/cancel card was invisible unless you dug
      // through the log (playtester: "you aren't told the enemy tactic card").
      // All three are post-reveal, so surfacing them leaks nothing face-down.
      if ((e.kind === 'combat-tactic' || e.kind === 'cinematic-tactic-cancelled'
        || e.kind === 'cinematic-tactic-no-ability') && e.side) {
        const card = (e.payload as { card?: string })?.card;
        if (card) out.push({ side: e.side as Side, card });
      }
    }
    return out;
  })();

  // Current decision (if any) and which side owns it.
  const pc = G.pendingChoice;
  const decisionSide: Side | null =
    pc?.kind === 'CombatAttackerTactics' ? pc.side :
    pc?.kind === 'CombatDefenderTactics' ? pc.side :
    pc?.kind === 'CombatAssignDamage'    ? pc.side :
    pc?.kind === 'CinematicTargetPick'   ? pc.side :
    pc?.kind === 'CinematicDestroyPick'  ? pc.side :
    pc?.kind === 'YodaReroll'            ? pc.side :
    pc?.kind === 'R2D2Flip'              ? pc.side :
    pc?.kind === 'OneInAMillionOffer'    ? pc.side :
    pc?.kind === 'SpecialDieSpend'       ? pc.side :
    pc?.kind === 'CombatStartActionCards' ? pc.side :
    pc?.kind === 'MoreDangerousTheaterPick' ? pc.side :
    pc?.kind === 'MoreDangerousRetrievePick' ? pc.side :
    pc?.kind === 'FullyOperationalTargetPick' ? pc.side :
    pc?.kind === 'BazesLoyaltyTarget'    ? pc.side :
    pc?.kind === 'TargetTheGeneratorPick' ? pc.side :
    pc?.kind === 'ReadyForActionLeaderPick' ? pc.side :
    pc?.kind === 'CombatAddLeaderPick'   ? pc.side :
    pc?.kind === 'CinematicTacticSelect' ? pc.side :
    pc?.kind === 'RogueOneChoice'        ? pc.side :
    pc?.kind === 'ConfrontationLeaderPick' ? pc.side :
    pc?.kind === 'TractorBeamCapturePick' ? pc.side :
    pc?.kind === 'CinematicReroll'       ? pc.side :
    pc?.kind === 'CinematicHeal'         ? pc.side :
    pc?.kind === 'CinematicDeferredHeal' ? pc.side :
    pc?.kind === 'RetreatDecision'       ? pc.side : null;
  const isHumanDecision = decisionSide === humanSide;
  // Online, the opponent is a remote human (or a SERVER-driven AI seat) — either
  // way the client doesn't run the AI, so the "resume AI" affordance is
  // single-player-only. Online we just show a neutral "waiting for opponent".
  const waitingForOpponent = decisionSide !== null && !isHumanDecision;
  // Belt-and-suspenders to the render guard in PlayTab: once the game is over the
  // AI owes nothing, so never show/drive a "Waiting for AI…" state (#533 — a card
  // that removes the base's last defender ends the game mid-combat with the
  // pending choice still set).
  const waitingForAI = !online && !G.isGameOver && waitingForOpponent;

  // Self-healing AI driver: any time this component renders and the AI owes
  // a combat decision, step the AI synchronously and notify the parent to
  // re-render. The parent's runAILoop already does this on every refresh()
  // call, but in some edge cases (specifically: when a human's submit
  // posts a follow-up AI-owed choice, then setTick batches the re-render
  // before runAILoop's read of gameRef.current sees the latest state)
  // it can be missed. Adding a render-driven retry guarantees we never
  // freeze on an AI-owed choice as long as CombatBoardLive is mounted.
  const aiSide: Side = humanSide === 'Rebel' ? 'Empire' : 'Rebel';
  // Fingerprint includes pc.side so transitions Empire→Rebel within the
  // same kind (e.g. start-of-combat handoff) retrigger. Resets on any
  // pendingCombat change too.
  const fp = `${pc?.kind ?? '-'}:${(pc as { side?: string } | undefined)?.side ?? '-'}:${c.round}:${(pc as { theater?: string } | undefined)?.theater ?? ''}`;
  const lastStepRef = useRef<string>('');
  const [aiFailure, setAiFailure] = useState<string | null>(null);
  useEffect(() => {
    if (online) return; // online: the opponent is a remote human, not local AI.
    if (!waitingForAI || decisionSide !== aiSide) return;
    if (G.missionReports && G.missionReports.length > 0) return;
    if (lastStepRef.current === fp) return;
    lastStepRef.current = fp;
    try {
      const did = aiStepOnce(G, aiSide);
      if (did) {
        setAiFailure(null);
        onPersist();
      } else {
        const msg = `aiStepOnce returned false for ${pc?.kind} side=${(pc as { side?: string } | undefined)?.side} round=${c.round}`;
        console.warn('[CombatBoardLive]', msg, { pc });
        setAiFailure(msg);
      }
    } catch (e) {
      console.error('[CombatBoardLive] aiStepOnce threw', e);
      setAiFailure(`aiStepOnce threw: ${(e as Error)?.message ?? String(e)}`);
    }
  }, [fp]);

  /** Step AI manual kick — resets the dedup fingerprint so it actually retries,
   *  then calls onPersist to trigger the parent's runAILoop. */
  const kickAI = () => {
    lastStepRef.current = '';
    setAiFailure(null);
    onPersist();
  };

  // Belt-and-suspenders auto-recovery (issue #75): if the AI still owes a
  // combat decision a beat after render — e.g. the fp-keyed effect above
  // missed a transient, or the AI choice arrived before the parent's runAILoop
  // read the latest state — auto-kick once so the player never lands on a
  // silent "Waiting for AI…" with no progress. Cleared the moment the choice
  // resolves (fp changes → component re-renders → timeout cancelled).
  useEffect(() => {
    if (!waitingForAI || decisionSide !== aiSide) return;
    const t = setTimeout(() => { lastStepRef.current = ''; onPersist(); }, 700);
    return () => clearTimeout(t);
  }, [fp]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Emergency: assign damage on the AI's behalf by picking weakest-first. Used
   *  when the AI returns false and we'd otherwise be soft-locked. */
  const forceAssignDamage = () => {
    if (!pc || pc.kind !== 'CombatAssignDamage') return;
    const ss = G.map.systems[pc.systemId] ?? G.map.rebelBaseSpace;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const assigned = new Map<string, number>();
    const sourceFirstTarget = new Map<string, string>();
    const sourceTargets = new Map<string, Set<string>>();
    const out: (string | null)[] = [];
    for (let i = 0; i < pc.hits.length; i++) {
      const src = pc.hits[i].source;
      const isTakeItDown = src && src.includes('take-it-down');
      const isOnslaught = src && src.includes('onslaught');
      let best: { id: string; remaining: number; tier: number } | null = null;
      for (const tid of pc.targetsByHit[i]) {
        if (isTakeItDown && sourceFirstTarget.has(src) && tid !== sourceFirstTarget.get(src)) continue;
        if (isOnslaught && sourceTargets.get(src)?.has(tid)) continue;
        const u = ss?.units.find((x: UnitInstance) => x.instanceId === tid);
        if (!u) continue;
        const t = G.catalog.unitTypes[u.typeId];
        if (!t) continue;
        const queued = assigned.get(tid) ?? 0;
        const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - queued;
        if (remaining <= 0) continue;
        const tier = tierRank[t.tier ?? 'square'] ?? 9;
        if (!best || remaining < best.remaining || (remaining === best.remaining && tier < best.tier)) {
          best = { id: tid, remaining, tier };
        }
      }
      if (best) {
        out.push(best.id);
        assigned.set(best.id, (assigned.get(best.id) ?? 0) + 1);
        if (src) {
          if (!sourceFirstTarget.has(src)) sourceFirstTarget.set(src, best.id);
          if (!sourceTargets.has(src)) sourceTargets.set(src, new Set());
          sourceTargets.get(src)!.add(best.id);
        }
      } else out.push(null);
    }
    const r = combat.resolveCombatAssignDamage(G, out);
    if (!r.ok) alert(`Force-assign failed: ${r.reason}\nassignments=${JSON.stringify(out)}`);
    setAiFailure(null);
    lastStepRef.current = '';
    onPersist();
  };

  // Dice rolled by the in-flight attack (if any) — shown in the active theater.
  const dice: DieResult[] | null = c.pendingAttack?.dice ?? null;
  const activeTheater: Theater | null = c.pendingAttack?.theater ?? c.activeTheater ?? null;

  // ============================================================
  // Damage-assignment state (lifted out of AssignDamagePanel so it
  // can be shared with the per-unit click targets on the board).
  // ============================================================
  const damageChoice = (pc?.kind === 'CombatAssignDamage' && isHumanDecision) ? pc : null;
  const damageChoiceKey = damageChoice
    ? `${damageChoice.systemId}:${damageChoice.theater}:${damageChoice.hits.length}:${damageChoice.hits.map((h) => `${h.face}-${h.color ?? 'x'}-${h.source ?? ''}`).join(',')}`
    : null;
  const [assignments, setAssignments] = useState<(string | null)[]>([]);
  const [selectedHitIdx, setSelectedHitIdx] = useState<number | null>(null);
  const lastChoiceKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (damageChoice && damageChoiceKey !== lastChoiceKeyRef.current) {
      lastChoiceKeyRef.current = damageChoiceKey;
      // Pre-fill with the weakest-target-first heuristic so the human can
      // either accept defaults via Submit or click to override.
      const ss = G.map.systems[damageChoice.systemId] ?? G.map.rebelBaseSpace;
      const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
      const queued = new Map<string, number>();
      const sourceFirstTarget = new Map<string, string>();
      const sourceTargets = new Map<string, Set<string>>();
      const init: (string | null)[] = damageChoice.hits.map((h, i) => {
        const src = h.source;
        const isTakeItDown = src && src.includes('take-it-down');
        const isOnslaught = src && src.includes('onslaught');
        const targets = damageChoice.targetsByHit[i];
        let best: { id: string; remaining: number; tier: number } | null = null;
        for (const tid of targets) {
          if (isTakeItDown && sourceFirstTarget.has(src!) && tid !== sourceFirstTarget.get(src!)) continue;
          if (isOnslaught && sourceTargets.get(src!)?.has(tid)) continue;
          const u = ss?.units.find((x: UnitInstance) => x.instanceId === tid);
          if (!u) continue;
          const t = G.catalog.unitTypes[u.typeId];
          if (!t) continue;
          const qd = queued.get(tid) ?? 0;
          const remaining = (t.health.value ?? 1) - (u.damage ?? 0) - qd;
          if (remaining <= 0) continue;
          const tier = tierRank[t.tier ?? 'square'] ?? 9;
          if (!best || remaining < best.remaining || (remaining === best.remaining && tier < best.tier)) {
            best = { id: tid, remaining, tier };
          }
        }
        if (best) {
          queued.set(best.id, (queued.get(best.id) ?? 0) + 1);
          if (src) {
            if (!sourceFirstTarget.has(src)) sourceFirstTarget.set(src, best.id);
            if (!sourceTargets.has(src)) sourceTargets.set(src, new Set());
            sourceTargets.get(src)!.add(best.id);
          }
          return best.id;
        }
        return null;
      });
      setAssignments(init);
      // Select the first die with no auto-assignment so the user can fix
      // the gaps; if everything auto-filled, leave nothing selected.
      const firstNull = init.findIndex((a) => a === null);
      setSelectedHitIdx(firstNull >= 0 ? firstNull : null);
    }
    if (!damageChoice && lastChoiceKeyRef.current !== null) {
      lastChoiceKeyRef.current = null;
      setAssignments([]);
      setSelectedHitIdx(null);
    }
  }, [damageChoiceKey]);

  /** Click handler for a unit on the board during damage assignment. Assigns
   *  the currently selected die's hit to that unit, then auto-advances the
   *  selection to the next unassigned die (if any). */
  const onAssignUnitClick = (unitInstanceId: string) => {
    if (!damageChoice || selectedHitIdx === null) return;
    if (!damageChoice.targetsByHit[selectedHitIdx]?.includes(unitInstanceId)) return;
    setAssignments((prev) => {
      const next = [...prev];
      next[selectedHitIdx] = unitInstanceId;
      return next;
    });
    // Auto-advance: find next die with no assignment, wrapping around.
    const n = damageChoice.hits.length;
    let nextIdx: number | null = null;
    for (let off = 1; off <= n; off++) {
      const j = (selectedHitIdx + off) % n;
      if (j === selectedHitIdx) break;
      // Skip dice with no legal targets.
      if (damageChoice.targetsByHit[j].length === 0) continue;
      // Skip already-assigned dice — but only if the wrap hasn't completed.
      if (j !== selectedHitIdx && assignments[j] !== null && off < n) continue;
      nextIdx = j;
      break;
    }
    setSelectedHitIdx(nextIdx);
  };

  const submitDamage = () => {
    if (!damageChoice) return;
    const r = combat.resolveCombatAssignDamage(G, assignments);
    if (!r.ok) {
      alert(`Cannot resolve: ${r.reason}`);
      return;
    }
    onPersist();
  };

  /** Per-side per-theater click-target bundle. The clickable units belong to
   *  the side BEING HIT — i.e. the opponent of the side currently assigning
   *  damage (the roller), NOT always the combat's defender. On a counter-
   *  attack the combat-defender is the one rolling, so the units to click
   *  belong to the combat-attacker; keying this to the static `defender`
   *  left those units unclickable and damage unassignable. (Issue #54.) */
  const damageAssignBundle = damageChoice ? {
    defenderSide: (damageChoice.side === 'Rebel' ? 'Empire' : 'Rebel') as Side,
    theater: damageChoice.theater,
    selectedHitIdx,
    legalUnitIds: (selectedHitIdx === null
      ? new Set<string>()
      : new Set(damageChoice.targetsByHit[selectedHitIdx] ?? [])),
    assignedCountByUnit: ((): Map<string, number> => {
      const m = new Map<string, number>();
      for (const uid of assignments) if (uid) m.set(uid, (m.get(uid) ?? 0) + 1);
      return m;
    })(),
    onUnitClick: onAssignUnitClick,
  } : null;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)',
      display: 'flex', flexDirection: 'column', zIndex: 2000,
      padding: 16, color: '#e8e8ea',
    }}>
      <Header
        systemName={systemName}
        attacker={attacker}
        defender={defender}
        round={c.round}
        humanSide={humanSide}
        onReportProblem={onReportProblem}
        onShowDiceKey={onShowDiceKey}
        onShowTacticKey={onShowTacticKey}
        trigger={triggerSummary}
      />

      <TacticHandsBar
        G={G}
        humanSide={humanSide}
        attacker={attacker}
        defender={defender}
        attackerHand={c.attackerHand}
        defenderHand={c.defenderHand}
        faceupSide={c.flags?.goodIntelActive ? 'Rebel' : null}
      />

      {playedTactics.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 12 }}>
          <span style={{ color: '#888' }}>Tactics played:</span>
          {playedTactics.map((p, i) => (
            <span key={i} style={{
              background: '#0c0d10', border: `1px solid ${SIDE_COLOR[p.side]}88`,
              borderRadius: 3, padding: '2px 6px',
            }}>
              <span style={{ color: SIDE_COLOR[p.side], fontWeight: 700, marginRight: 4 }}>{p.side}</span>
              <CardHover G={G} cardId={p.card}>
                {G.catalog.tactics[p.card]?.name ?? p.card}
              </CardHover>
            </span>
          ))}
        </div>
      )}

      {/* Running tally of units destroyed in this battle (Foggy Leggy request). */}
      {(c.removed?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 6, fontSize: 12 }}>
          <span style={{ color: '#888' }}>Units removed:</span>
          {(['Rebel', 'Empire'] as const).map((s) => {
            const lost = (c.removed ?? []).filter((r) => r.side === s);
            if (lost.length === 0) return null;
            const counts = new Map<string, number>();
            for (const r of lost) counts.set(r.typeId, (counts.get(r.typeId) ?? 0) + 1);
            return (
              <span key={s} style={{
                background: '#0c0d10', border: `1px solid ${SIDE_COLOR[s]}88`,
                borderRadius: 3, padding: '2px 6px',
              }}>
                <span style={{ color: SIDE_COLOR[s], fontWeight: 700, marginRight: 4 }}>{s}</span>
                {[...counts].map(([tid, n], i) => (
                  <span key={tid} style={{ marginLeft: i ? 8 : 0, color: '#cbb' }}>
                    {n}× {G.catalog.unitTypes[tid]?.name ?? tid}
                  </span>
                ))}
              </span>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, minHeight: 0 }}>
        <TheaterPanel
          G={G} c={c} theater="space" humanSide={humanSide}
          attacker={attacker} defender={defender}
          dice={activeTheater === 'space' ? dice : null}
          rolling={activeTheater === 'space' ? c.pendingAttack?.side ?? null : null}
          damageAssign={damageAssignBundle?.theater === 'space' ? damageAssignBundle : null}
        />
        <TheaterPanel
          G={G} c={c} theater="ground" humanSide={humanSide}
          attacker={attacker} defender={defender}
          dice={activeTheater === 'ground' ? dice : null}
          rolling={activeTheater === 'ground' ? c.pendingAttack?.side ?? null : null}
          damageAssign={damageAssignBundle?.theater === 'ground' ? damageAssignBundle : null}
        />
      </div>

      {/* Decision strip — bottom row, fixed height. */}
      <div style={{
        marginTop: 12, padding: 14, background: '#15171c', borderRadius: 6,
        border: `2px solid ${decisionSide ? SIDE_COLOR[decisionSide] : '#3a3d44'}`,
        minHeight: 110,
      }}>
        {waitingForAI && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ color: '#888', fontStyle: 'italic' }}>
                Waiting for {decisionSide} (AI) to choose… (continues automatically)
              </div>
              <button
                className="tab-button active"
                onClick={kickAI}
                title="If the combat doesn't continue on its own, click to resume the AI."
                style={{ fontWeight: 700 }}
              >
                ▶ Continue (resume AI)
              </button>
              {pc?.kind === 'CombatAssignDamage' && (
                <button
                  className="tab-button"
                  onClick={forceAssignDamage}
                  title="Bypass the AI: pick weakest-target damage assignment directly."
                  style={{ borderColor: '#c4423a' }}
                >
                  Force-resolve damage
                </button>
              )}
            </div>
            {aiFailure && (
              <div style={{ color: '#ff8a80', fontSize: 11, fontFamily: 'monospace' }}>
                ⚠ {aiFailure}
              </div>
            )}
          </div>
        )}
        {online && waitingForOpponent && (
          <div style={{ color: '#e0b84f', fontStyle: 'italic' }}>
            Waiting for {decisionSide} to resolve their combat decision…
          </div>
        )}
        {pc?.kind === 'CombatAttackerTactics' && isHumanDecision && (
          <AttackerTacticsPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatDefenderTactics' && isHumanDecision && (
          <DefenderTacticsPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatAssignDamage' && isHumanDecision && (
          <AssignDamagePanel
            G={G} choice={pc} c={c}
            assignments={assignments}
            selectedHitIdx={selectedHitIdx}
            setSelectedHitIdx={setSelectedHitIdx}
            setAssignments={setAssignments}
            onSubmit={submitDamage}
          />
        )}
        {pc?.kind === 'YodaReroll' && pc.context === 'combat' && isHumanDecision && (
          <YodaRerollPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'R2D2Flip' && pc.context === 'combat' && isHumanDecision && (
          <R2D2FlipPanel G={G} choice={pc} c={c} onPersist={onPersist} />
        )}
        {pc?.kind === 'OneInAMillionOffer' && pc.context === 'combat' && isHumanDecision && oiamArmed && (
          <OneInAMillionPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'SpecialDieSpend' && isHumanDecision && (
          <SpecialDieSpendPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatStartActionCards' && isHumanDecision && (
          <StartOfCombatPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'MoreDangerousTheaterPick' && isHumanDecision && (
          <MoreDangerousTheaterPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'MoreDangerousRetrievePick' && isHumanDecision && (
          <MoreDangerousRetrievePanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'FullyOperationalTargetPick' && isHumanDecision && (
          <FullyOperationalPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'TargetTheGeneratorPick' && isHumanDecision && (
          <TargetTheGeneratorPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'BazesLoyaltyTarget' && isHumanDecision && (
          <BazesLoyaltyPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicTargetPick' && isHumanDecision && (
          <CinematicTargetPickPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicDestroyPick' && isHumanDecision && (
          <CinematicDestroyPickPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'ReadyForActionLeaderPick' && isHumanDecision && (
          <ReadyForActionPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatAddLeaderPick' && isHumanDecision && (
          <CombatAddLeaderPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicTacticSelect' && isHumanDecision && (
          <CinematicTacticSelectPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'RogueOneChoice' && isHumanDecision && (
          <RogueOneChoicePanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'ConfrontationLeaderPick' && isHumanDecision && (
          <ConfrontationLeaderPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'TractorBeamCapturePick' && isHumanDecision && (
          <TractorBeamCapturePanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicReroll' && isHumanDecision && (
          <CinematicRerollPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicHeal' && isHumanDecision && (
          <CinematicHealPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CinematicDeferredHeal' && isHumanDecision && (
          <CinematicDeferredHealPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'RetreatDecision' && isHumanDecision && (
          <RetreatPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {/* Always-visible diagnostic line so the player can see what state
            the combat is in even if no panel renders for it. */}
        <div style={{ fontSize: 10, color: '#555', marginTop: 6, fontFamily: 'monospace' }}>
          state: pc={pc?.kind ?? 'none'} side={(pc as { side?: string } | undefined)?.side ?? '-'} round={c.round} you={humanSide} ai-owns={waitingForAI ? 'yes' : 'no'}
        </div>
        {!pc && (
          <div style={{ color: '#666', fontStyle: 'italic' }}>
            Resolving — combat will pause here on the next decision.
          </div>
        )}
      </div>
    </div>
  );
}

/** Strip showing each side's combat tactic-card hand. The human side sees
 *  their cards (with hover-preview of art + rules text). The AI side sees
 *  only the count — opponent's hand is private per RAW.
 *
 *  `faceupSide` overrides that privacy for one side: Good Intel's base-game
 *  clause is "Rebel player must keep tactic cards faceup", which used to be
 *  logged as a no-op, so the Empire paid for the card and saw nothing (#621). */
function TacticHandsBar({
  G, humanSide, attacker, defender, attackerHand, defenderHand, faceupSide,
}: {
  G: GameState;
  humanSide: Side;
  attacker: Side;
  defender: Side;
  attackerHand: string[];
  defenderHand: string[];
  faceupSide?: Side | null;
}) {
  const handFor = (side: Side) => (side === attacker ? attackerHand : defenderHand);
  const renderSide = (side: Side) => {
    const hand = handFor(side);
    const faceup = side === faceupSide;
    const isHuman = side === humanSide || faceup;
    const color = SIDE_COLOR[side];
    if (isHuman) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color, fontWeight: 700, fontSize: 12 }}>
            {side} tactic cards ({hand.length}):
          </span>
          {faceup && side !== humanSide && (
            <span style={{ color: '#8fd0ff', fontSize: 11, fontStyle: 'italic' }}>
              (faceup — Good Intel)
            </span>
          )}
          {hand.length === 0 && (
            <span style={{ color: '#666', fontStyle: 'italic', fontSize: 11 }}>(none)</span>
          )}
          {hand.map((cid, i) => {
            const card = G.catalog.tactics[cid];
            const label = card?.name ?? cid;
            const theater = card?.theater;
            const dot = theater === 'space' ? '◇' : theater === 'ground' ? '■' : '·';
            return (
              <span key={`${cid}-${i}`} style={{
                background: '#0c0d10', border: `1px solid ${color}88`,
                borderRadius: 3, padding: '2px 6px', fontSize: 11,
              }}>
                <CardHover G={G} cardId={cid}>
                  <span style={{ color: '#aaa', marginRight: 4 }}>{dot}</span>
                  {label}
                </CardHover>
              </span>
            );
          })}
        </div>
      );
    }
    // Opponent: count only, no hover preview.
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color, fontWeight: 700, fontSize: 12 }}>
          {side} tactic cards:
        </span>
        <span style={{
          background: '#0c0d10', border: `1px solid ${color}88`,
          borderRadius: 3, padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#fff',
        }}>
          {hand.length}
        </span>
        <span style={{ color: '#666', fontStyle: 'italic', fontSize: 11 }}>
          (hidden — opponent's hand)
        </span>
      </div>
    );
  };
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      gap: 24, padding: '8px 12px', marginTop: 8,
      background: '#15171c', borderRadius: 4, border: '1px solid #2a2d34',
    }}>
      {renderSide(attacker)}
      {renderSide(defender)}
    </div>
  );
}

function Header({ systemName, attacker, defender, round, humanSide, onReportProblem, onShowDiceKey, onShowTacticKey, trigger }: {
  systemName: string; attacker: Side; defender: Side; round: number; humanSide: Side;
  onReportProblem?: () => void; onShowDiceKey?: () => void; onShowTacticKey?: () => void; trigger?: string | null;
}) {
  return (
    <>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 20, color: '#ffd54a' }}>Combat at {systemName}</h2>
      <div style={{ fontSize: 13, color: '#aaa' }}>
        <span style={{ color: SIDE_COLOR[attacker], fontWeight: 700 }}>{attacker}</span>
        {' '}attacks{' '}
        <span style={{ color: SIDE_COLOR[defender], fontWeight: 700 }}>{defender}</span>
      </div>
      <div style={{ marginLeft: 'auto', fontSize: 13, color: '#aaa', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span>
          You are <span style={{ color: SIDE_COLOR[humanSide], fontWeight: 700 }}>{humanSide}</span>
          {' · '}Round {round}
        </span>
        {onShowDiceKey && (
          <button onClick={onShowDiceKey} title="What each die face means + odds"
            style={{ background: '#1a2230', color: '#9fb3d9', border: '1px solid #3a4a6a',
              padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>
            dice key
          </button>
        )}
        {onShowTacticKey && (
          <button onClick={onShowTacticKey} title="Every tactic card + how the decks work"
            style={{ background: '#241f17', color: '#d9c79f', border: '1px solid #5a4a2a',
              padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12 }}>
            tactic key
          </button>
        )}
        {onReportProblem && (
          <button
            onClick={onReportProblem}
            title="Report a stuck combat or other problem. The current game state (incl. mid-combat) gets attached to the GitHub issue."
            style={{
              background: '#2a1414', color: '#ff8866',
              border: '1px solid #5a2a2a', padding: '4px 10px', borderRadius: 3,
              cursor: 'pointer', fontSize: 12,
            }}
          >
            Report a problem
          </button>
        )}
      </div>
    </div>
    {trigger && (
      <div style={{ fontSize: 12, color: '#cbc4b0', marginTop: 4, fontStyle: 'italic' }}>
        ⚔ {trigger}
      </div>
    )}
    </>
  );
}

type DamageAssignBundle = {
  defenderSide: Side;
  theater: Theater;
  selectedHitIdx: number | null;
  legalUnitIds: Set<string>;
  assignedCountByUnit: Map<string, number>;
  onUnitClick: (unitInstanceId: string) => void;
};

function TheaterPanel({ G, c, theater, attacker, defender, dice, rolling, damageAssign, humanSide }: {
  G: GameState; c: NonNullable<GameState['pendingCombat']>;
  theater: Theater; attacker: Side; defender: Side;
  dice: DieResult[] | null; rolling: Side | null;
  damageAssign?: DamageAssignBundle | null;
  humanSide: Side;
}) {
  const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
  const inTheater = (u: UnitInstance) => {
    const t = G.catalog.unitTypes[u.typeId];
    return t?.theater === theater;
  };
  const attUnits = (ss?.units ?? []).filter((u) => u.side === attacker && inTheater(u));
  const defUnits = (ss?.units ?? []).filter((u) => u.side === defender && inTheater(u));
  const attLeaders = (G[attacker.toLowerCase() as 'rebel' | 'empire'].leadersOnBoard[c.systemId] ?? []);
  const defLeaders = (G[defender.toLowerCase() as 'rebel' | 'empire'].leadersOnBoard[c.systemId] ?? []);
  const empty = attUnits.length === 0 && defUnits.length === 0;

  return (
    <div style={{
      flex: 1, background: '#15171c', borderRadius: 6, border: '1px solid #2a2d34',
      padding: 10, display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 }}>
        {theater} theater{empty ? ' — (no units)' : ''}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12, minHeight: 0 }}>
        <SidePanel
          G={G}
          side={attacker}
          units={attUnits}
          leaderIds={attLeaders}
          align="right"
          isYou={attacker === humanSide}
          damageAssign={damageAssign && damageAssign.defenderSide === attacker ? damageAssign : null}
        />
        <DicePanel dice={dice} side={rolling} humanSide={humanSide} />
        <SidePanel
          G={G}
          side={defender}
          units={defUnits}
          leaderIds={defLeaders}
          align="left"
          isYou={defender === humanSide}
          damageAssign={damageAssign && damageAssign.defenderSide === defender ? damageAssign : null}
        />
      </div>
    </div>
  );
}

/** Per-instance, damage-lane unit panel. Inspired by the OSD BMV Battle Mat
 *  layout (independent implementation): the panel is a row of columns, one
 *  per damage level (0 / 1 / 2 / 3+). Each unit instance sits in the column
 *  matching its current damage. Wounded units visibly slide right as combat
 *  progresses. Squares are color-tinted by the unit's health colour
 *  (red-health vs black-health) so unit-class is legible at a glance. */
function SidePanel({ G, side, units, leaderIds, align, damageAssign, isYou }: {
  G: GameState; side: Side; units: UnitInstance[]; leaderIds: string[]; align: 'left' | 'right';
  damageAssign?: DamageAssignBundle | null;
  isYou?: boolean;
}) {
  const color = SIDE_COLOR[side];
  // Attack-dice pool this side's units contribute, capped at 5 red / 5 black
  // (rr p.4). Shown as a caption so the player can see WHERE the dice come
  // from — RAW rolls one shared pool per side, not per-unit dice, so this is
  // the faithful way to surface "which units made these dice".
  let poolRed = 0, poolBlack = 0;
  for (const u of units) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    poolRed += t.attack.red;
    poolBlack += t.attack.black;
  }
  const cappedRed = Math.min(5, poolRed);
  const cappedBlack = Math.min(5, poolBlack);
  const capped = poolRed > 5 || poolBlack > 5;
  // Find the highest single-unit HP we need to show (decides how many
  // damage lanes to render). Cap at 5 (the SSD's max HP).
  const maxHp = Math.max(1, ...units.map((u) => G.catalog.unitTypes[u.typeId]?.health.value ?? 1));
  const lanes = Math.min(5, maxHp); // 0..maxHp-1 damage shown; >=maxHp dies
  // Bucket each instance into its damage lane (0 = pristine). A unit at or past
  // its OWN health is lethally damaged — in cinematic combat it's "staged",
  // destroyed at end of round but still on the board. It goes in a separate
  // "doomed" lane rather than being clamped into the last damage lane, which
  // previously showed e.g. a 2-HP AT-ST with 2 damage as merely "1 dmg" and
  // hid that it was already dead (players #264/#265).
  const buckets: UnitInstance[][] = Array.from({ length: lanes }, () => []);
  const doomed: UnitInstance[] = [];
  for (const u of units) {
    const t = G.catalog.unitTypes[u.typeId];
    const ownHp = t?.health.value ?? 1;
    // The Death Star (health.color === null) is invulnerable — it can never be
    // "doomed." Its health.value is 0, which would otherwise trip `damage >=
    // ownHp` (0 >= 0) and wrongly show an untouched Death Star as destroyed (#306).
    if (t?.health.color !== null && (u.damage ?? 0) >= ownHp) { doomed.push(u); continue; }
    buckets[Math.min(u.damage ?? 0, lanes - 1)].push(u);
  }
  const cols = lanes + (doomed.length ? 1 : 0);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      gap: 4,
      minWidth: 0,
    }}>
      <div style={{ color, fontSize: 12, fontWeight: 700 }}>
        {side}{isYou ? ' (you)' : ''}
      </div>
      {(cappedRed > 0 || cappedBlack > 0) && (
        <div
          title={`All of ${side}'s units roll into ONE shared pool (the rules don't tie individual dice to individual ships). This side's units add ${poolRed} red + ${poolBlack} black${capped ? ', capped at 5 of each per attack' : ''}.`}
          style={{ fontSize: 10, color: '#bbb', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          rolls
          {cappedRed > 0 && <span style={{ color: '#e0625a', fontWeight: 700 }}>{cappedRed}🔴</span>}
          {cappedBlack > 0 && <span style={{ color: '#cfcfcf', fontWeight: 700 }}>{cappedBlack}⚫</span>}
          {capped && <span style={{ color: '#888' }}>(cap)</span>}
        </div>
      )}
      {leaderIds.length > 0 && (
        <div style={{ fontSize: 11, color: '#ccc' }}>
          ★ {leaderIds.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
        </div>
      )}
      {units.length === 0 ? (
        <div style={{ color: '#555', fontSize: 11, fontStyle: 'italic' }}>(no units)</div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, minmax(56px, 1fr))`,
          gap: 4, marginTop: 2,
        }}>
          {/* Lane headers */}
          {buckets.map((_, lane) => (
            <div key={`h-${lane}`} style={{
              fontSize: 9, color: '#666', textAlign: 'center',
              textTransform: 'uppercase', letterSpacing: 0.4,
            }}>
              {lane === 0 ? 'undmg' : `${lane} dmg`}
            </div>
          ))}
          {doomed.length > 0 && (
            <div key="h-doomed" style={{
              fontSize: 9, color: '#e0625a', textAlign: 'center',
              textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700,
            }}>
              destroyed
            </div>
          )}
          {/* Lane contents — per-instance icons */}
          {buckets.map((bucket, lane) => (
            <div key={`b-${lane}`} style={{
              display: 'flex', flexWrap: 'wrap', gap: 2,
              justifyContent: 'center', alignItems: 'flex-start',
              minHeight: 30,
              background: lane === 0 ? 'transparent' : `rgba(255,80,80,${0.05 * lane})`,
              border: lane === 0 ? '1px dashed #2a2d34' : '1px dashed #4a3333',
              borderRadius: 3, padding: 3,
            }}>
              {bucket.map((u) => {
                const legal = damageAssign?.legalUnitIds.has(u.instanceId) ?? false;
                const assignedCount = damageAssign?.assignedCountByUnit.get(u.instanceId) ?? 0;
                return (
                  <UnitIcon key={u.instanceId} G={G} unit={u}
                    legalTarget={legal}
                    assignedCount={assignedCount}
                    onClick={legal && damageAssign ? () => damageAssign.onUnitClick(u.instanceId) : undefined}
                  />
                );
              })}
            </div>
          ))}
          {doomed.length > 0 && (
            <div key="b-doomed" style={{
              display: 'flex', flexWrap: 'wrap', gap: 2,
              justifyContent: 'center', alignItems: 'flex-start',
              minHeight: 30,
              background: 'rgba(224,98,90,0.18)',
              border: '1px solid #7a2f2a', borderRadius: 3, padding: 3,
              // Lethally damaged — destroyed at end of the combat round.
              opacity: 0.7,
            }} title="Lethally damaged — destroyed at the end of this combat round unless a heal removes the damage first. You can still pile extra damage on it (overdamage) to insure the kill against a heal.">
              {doomed.map((u) => {
                const legal = damageAssign?.legalUnitIds.has(u.instanceId) ?? false;
                const assignedCount = damageAssign?.assignedCountByUnit.get(u.instanceId) ?? 0;
                return (
                  <UnitIcon key={u.instanceId} G={G} unit={u}
                    legalTarget={legal}
                    assignedCount={assignedCount}
                    onClick={legal && damageAssign ? () => damageAssign.onUnitClick(u.instanceId) : undefined}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UnitIcon({ G, unit, legalTarget, assignedCount, onClick }: {
  G: GameState; unit: UnitInstance;
  legalTarget?: boolean;
  assignedCount?: number;
  onClick?: () => void;
}) {
  const t = G.catalog.unitTypes[unit.typeId];
  const name = t?.name ?? unit.typeId;
  const hc = t?.health.color;
  // Health-color tint: red-health units get a red border, black-health
  // units get a gray border. Death Star (color=null) is unbordered.
  // During damage assignment, legal-target units get a glowing yellow border.
  const border = legalTarget ? '2px solid #ffd54a'
              : hc === 'red' ? '2px solid #c4423a'
              : hc === 'black' ? '2px solid #888'
              : '1px dotted #555';
  // Two-letter abbreviation derived from the type ID (fallback when the unit
  // image isn't available).
  const abbr = (t?.id ?? unit.typeId).split('-').map((s) => s[0]?.toUpperCase()).join('').slice(0, 3);
  // Actual ship/troop picture (player request: pictures, not letters). Falls
  // back to the abbreviation when no art is mapped for this type.
  const imgUrl = unitImageUrl(unit.typeId, UNIT_IMAGE_BASE, getUnitStyle());
  // Rich combat tooltip: attack dice, hp, theater, tier, transport.
  const tooltip = (() => {
    if (!t) return name;
    const hpMax = t.health.value ?? 1;
    const hpNow = hpMax - (unit.damage ?? 0);
    const hpColor = t.health.color ?? '—';
    const attack = `Atk: ${t.attack.red}R + ${t.attack.black}B`;
    const tierLabel = t.tier ?? '?';
    const transport = t.transport.capacity > 0
      ? `Transport ${t.transport.capacity}${t.transport.restriction ? ' (restricted)' : ''}`
      : (t.transport.immobile ? 'Immobile' : '');
    return [
      name,
      `${t.theater} · ${tierLabel}`,
      `HP ${hpNow}/${hpMax} (${hpColor})`,
      attack,
      transport,
    ].filter(Boolean).join('\n');
  })();
  return (
    <div
      title={tooltip}
      onClick={onClick}
      style={{
        position: 'relative',
        width: 30, height: 30, background: '#0c0d10', border,
        borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 700, color: '#e8e8ea',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: legalTarget ? '0 0 6px #ffd54a' : undefined,
        overflow: 'hidden',
      }}
    >
      {imgUrl ? (
        <img
          src={imgUrl}
          alt={name}
          draggable={false}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
        />
      ) : (
        abbr
      )}
      {assignedCount && assignedCount > 0 ? (
        <div style={{
          position: 'absolute', top: -6, right: -6,
          minWidth: 14, height: 14, padding: '0 3px',
          background: '#c4423a', color: '#fff',
          fontSize: 9, fontWeight: 700, borderRadius: 7,
          border: '1px solid #000',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          lineHeight: 1,
        }}>
          {assignedCount}
        </div>
      ) : null}
    </div>
  );
}

function DicePanel({ dice, side, humanSide }: { dice: DieResult[] | null; side: Side | null; humanSide: Side }) {
  if (!dice || dice.length === 0) {
    return <div style={{ alignSelf: 'center', color: '#444', fontSize: 11, fontStyle: 'italic' }}>(no roll yet)</div>;
  }
  const color = side ? SIDE_COLOR[side] : '#888';
  const isYou = side === humanSide;
  // Plain-English tally so the player doesn't have to decode the glyphs.
  const hits = dice.filter((d) => d.face === 'hit').length;
  const direct = dice.filter((d) => d.face === 'direct-hit').length;
  const special = dice.filter((d) => d.face === 'special').length;
  const blanks = dice.filter((d) => d.face === 'blank').length;
  const parts: string[] = [];
  if (hits) parts.push(`${hits} hit${hits === 1 ? '' : 's'}`);
  if (direct) parts.push(`${direct} direct`);
  if (special) parts.push(`${special} special`);
  if (blanks) parts.push(`${blanks} miss${blanks === 1 ? '' : 'es'}`);
  return (
    <div style={{
      alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      padding: '6px 8px', borderRadius: 6,
      border: `1px solid ${color}`, background: `${color}14`,
    }}>
      <div style={{ fontSize: 10, color, fontWeight: 700 }}>
        {isYou ? `YOUR roll (${side})` : `${side}'s roll`}
      </div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 220 }}>
        {dice.map((d, i) => <Die key={i} d={d} />)}
      </div>
      <div style={{ fontSize: 10, color: '#cbd2da' }}>
        {parts.length ? parts.join(' · ') : 'no results'}
      </div>
    </div>
  );
}

// Combat dice come in three REAL colours: red, black, and green (the RoE die).
// Green is a first-class colour, not a catch-all — match it explicitly so a
// genuinely-unknown colour renders as an obvious magenta rather than silently
// masquerading as a valid green die.
function dieColor(color: DieResult['color']): string {
  switch (color) {
    case 'red': return '#c4423a';
    case 'black': return '#222';
    case 'green': return '#357a3a';
    default: return '#d000d0';
  }
}

function Die({ d }: { d: DieResult }) {
  const bg = dieColor(d.color);
  const face =
    d.face === 'hit' ? '✓' :
    d.face === 'direct-hit' ? '✶' :
    d.face === 'special' ? '◈' : '·';
  const faceColor = d.face === 'blank' ? '#555' : '#fff';
  return (
    <div title={`${d.color} ${d.face}`} style={{
      width: 22, height: 22, background: bg, border: '1px solid #000', borderRadius: 3,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, color: faceColor,
    }}>
      {face}
    </div>
  );
}

// ---------- Decision panels ----------

function AttackerTacticsPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAttackerTactics' }>;
  onPersist: () => void;
}) {
  const hits = choice.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = choice.dice.filter((d) => d.face === 'blank').length;
  const cf = choice.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  // Only the FREE damage boost (Critical Hit) belongs in this regular-tactics
  // step. Onslaught / Take It Down have a ★ requirement (requiresSpecial) and
  // are played from the Special Die Spend step, which charges a rolled special
  // — offering them here let a player play them with no special (report #204).
  const damageBoosts = choice.hand.filter((cid) =>
    (cid.includes('take-it-down') || cid.includes('critical-hit') || cid.includes('onslaught'))
    && G.catalog.tactics[cid]?.requiresSpecial !== true
  );
  // No Escape (free space tactic): trap the defending fleet — they can't
  // retreat this round. Only space combat surfaces it (hand is theater-filtered).
  const noEscape = choice.hand.find((cid) => cid.includes('no-escape')) ?? null;
  const [useCF, setUseCF] = useState(false);
  const [useNE, setUseNE] = useState(false);
  // Selection is by POSITION in `damageBoosts`, not by card id: a hand can hold
  // two copies of the same card (Critical Hit is copies:2), and keying the set
  // by id made one checkbox toggle both — and only ever played one (#618).
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const label = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  const bonus = (cid: string) =>
    cid.includes('take-it-down') ? '+2 same target' :
    cid.includes('onslaught') ? '+1 × 2 different' :
    cid.includes('critical-hit') ? '+1' : '';

  // `skip` forces an empty play — the Skip button can't rely on setState-then-
  // submit, because submit would still close over the pre-reset selection.
  const submit = (skip = false) => {
    const r = combat.resolveCombatAttackerTactics(G, {
      concentrateFireCardId: !skip && useCF ? cf : null,
      damageBoostCardIds: skip ? []
        : Array.from(picked).sort((a, b) => a - b).map((i) => damageBoosts[i]),
      noEscapeCardId: !skip && useNE ? noEscape : null,
    });
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };

  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Attacker tactics:</b> {hits} hit{hits === 1 ? '' : 's'} of {choice.dice.length} dice
        ({blanks} blank{blanks === 1 ? '' : 's'})
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {cf && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={useCF} disabled={blanks === 0} onChange={(e) => setUseCF(e.target.checked)} />
            <CardHover G={G} cardId={cf}>{label(cf)}</CardHover> (reroll ≤2 blanks)
          </label>
        )}
        {damageBoosts.map((cid, i) => (
          <label key={`${cid}#${i}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={picked.has(i)}
              onChange={(e) => {
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(i); else next.delete(i);
                  return next;
                });
              }}
            />
            <CardHover G={G} cardId={cid}>{label(cid)}</CardHover> ({bonus(cid)} damage)
            {/* Disambiguate duplicate copies so the two rows aren't identical. */}
            {damageBoosts.filter((o) => o === cid).length > 1 && (
              <span style={{ fontSize: 10, opacity: 0.65 }}>
                copy {damageBoosts.slice(0, i + 1).filter((o) => o === cid).length}
              </span>
            )}
          </label>
        ))}
        {noEscape && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={useNE} onChange={(e) => setUseNE(e.target.checked)} />
            <CardHover G={G} cardId={noEscape}>{label(noEscape)}</CardHover> (opponent can't retreat this round)
          </label>
        )}
        {!cf && !noEscape && damageBoosts.length === 0 && (
          <span style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
            No playable tactic cards in hand.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => { setUseCF(false); setUseNE(false); setPicked(new Set<number>()); submit(true); }}
            style={btn('#2a2c33')}>Skip</button>
          <button onClick={() => submit()} style={btn(SIDE_COLOR[choice.side])}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function DefenderTacticsPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatDefenderTactics' }>;
  onPersist: () => void;
}) {
  const free = choice.hand.find((cid) => cid.includes('defensive-formation')) ?? null;
  const paid = choice.hand.find((cid) =>
    (choice.theater === 'ground' && cid.includes('dig-in')) ||
    (choice.theater === 'space' && cid.includes('outmaneuver'))
  ) ?? null;
  // The Dig In / Outmaneuver sacrifice may be ANY other tactic card in hand —
  // including a Defensive Formation you'd otherwise play for the free block
  // (#122), OR a SECOND COPY of the same card (two Dig In → play one, sacrifice
  // the other). Remove only ONE copy of the played card (not every same-id copy,
  // which blocked using a duplicate as the sacrifice, #565).
  const sacrificeCandidates = (() => {
    const rest = [...choice.hand];
    if (paid) { const i = rest.indexOf(paid); if (i >= 0) rest.splice(i, 1); }
    return rest;
  })();
  // No Escape (free space tactic): the defender can trap the attacking fleet so
  // it can't retreat this round. Independent of blocks (it prevents no damage).
  const defNoEscape = choice.hand.find((cid) => cid.includes('no-escape')) ?? null;
  const [useFree, setUseFree] = useState(false);
  const [usePaid, setUsePaid] = useState(false);
  const [useNE, setUseNE] = useState(false);
  const [sacrifice, setSacrifice] = useState<string | null>(sacrificeCandidates[0] ?? null);
  const label = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;

  const digInSacrifice = (usePaid && paid && sacrifice) ? sacrifice : null;
  const playFree = !!(useFree && free && free !== digInSacrifice);
  const blocks: string[] = [];
  const sacs: string[] = [];
  if (playFree && free) blocks.push(free);
  if (usePaid && paid && sacrifice) { blocks.push(paid); sacs.push(sacrifice); }

  const submit = (b: string[], s: string[]) => {
    const r = combat.resolveCombatDefenderTactics(G, {
      blockCardIds: b, sacrificeCardIds: s,
      noEscapeCardId: useNE ? defNoEscape : null,
    });
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };

  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Defender tactics:</b> {choice.incomingHits} incoming hit{choice.incomingHits === 1 ? '' : 's'} —
        play blocks?
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {free && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={playFree}
              disabled={usePaid && sacrifice === free}
              onChange={(e) => setUseFree(e.target.checked)}
            />
            <CardHover G={G} cardId={free}>{label(free)}</CardHover>{' '}
            {usePaid && sacrifice === free ? `(discarded for ${paid ? label(paid) : 'block'})` : '(free block 1)'}
          </label>
        )}
        {paid && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={usePaid}
                disabled={sacrificeCandidates.length === 0}
                onChange={(e) => setUsePaid(e.target.checked)}
              />
              <CardHover G={G} cardId={paid}>{label(paid)}</CardHover> (discard another card → block up to 2)
            </label>
            {sacrificeCandidates.length === 0 && (
              // Explain WHY it's greyed out — this card blocks a hit only by
              // discarding a second card, and there's no other card to spend.
              // (Issue #51 read as "can't play it" when it was just unusable.)
              <span style={{ fontSize: 11, color: '#888' }}>
                — needs another card in hand to discard
              </span>
            )}
            {usePaid && sacrificeCandidates.length > 0 && (
              <select
                value={sacrifice ?? ''}
                onChange={(e) => setSacrifice(e.target.value)}
                style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 4px', fontSize: 11 }}
              >
                {sacrificeCandidates.map((cid) => (
                  <option key={cid} value={cid}>{label(cid)}</option>
                ))}
              </select>
            )}
          </span>
        )}
        {defNoEscape && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={useNE} onChange={(e) => setUseNE(e.target.checked)} />
            <CardHover G={G} cardId={defNoEscape}>{label(defNoEscape)}</CardHover> (attacker can't retreat this round)
          </label>
        )}
        {!free && !paid && !defNoEscape && (
          <span style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
            No defensive cards in hand.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => submit([], [])} style={btn(SIDE_COLOR[choice.side])}>
            Take all {choice.incomingHits}
          </button>
          <button
            onClick={() => submit(blocks, sacs)}
            disabled={blocks.length === 0}
            style={{
              ...btn(blocks.length === 0 ? '#2a2c33' : SIDE_COLOR[choice.side]),
              opacity: blocks.length === 0 ? 0.45 : 1,
              cursor: blocks.length === 0 ? 'not-allowed' : 'pointer',
            }}
          >
            {/* Damage blocked, not card count: defensive-formation blocks 1,
                dig-in/outmaneuver block up to 2. */}
            Block {(playFree ? 1 : 0) + (usePaid && paid && sacrifice ? 2 : 0)}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignDamagePanel({ G, choice, c, assignments, selectedHitIdx, setSelectedHitIdx, setAssignments, onSubmit }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  c: NonNullable<GameState['pendingCombat']>;
  assignments: (string | null)[];
  selectedHitIdx: number | null;
  setSelectedHitIdx: (i: number | null) => void;
  setAssignments: React.Dispatch<React.SetStateAction<(string | null)[]>>;
  onSubmit: () => void;
}) {
  void c;
  const unitLabel = (instanceId: string): string => {
    const ss = G.map.systems[choice.systemId] ?? G.map.rebelBaseSpace;
    const u = ss?.units.find((x: UnitInstance) => x.instanceId === instanceId);
    if (!u) return instanceId.slice(0, 6);
    const t = G.catalog.unitTypes[u.typeId];
    return t?.name ?? u.typeId;
  };
  const clearHit = (i: number) => {
    setAssignments((prev) => { const next = [...prev]; next[i] = null; return next; });
    setSelectedHitIdx(i);
  };
  const allAssigned = assignments.every((a, i) => a !== null || choice.targetsByHit[i].length === 0);

  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Assign damage:</b> click a die to select it, then click the highlighted defender unit on the board.
        {selectedHitIdx !== null && (
          <span style={{ marginLeft: 8, color: '#ffd54a' }}>
            ← die #{selectedHitIdx + 1} selected
          </span>
        )}
      </div>
      {/* RR p.5: blocks are spent AFTER assignment, so every hit is still
          assignable — the defender then pulls this many damages back off his
          units. Say so, or the extra dice look like a bug (#622). */}
      {!!choice.blocksApplied && choice.blocksApplied > 0 && (
        <div style={{ fontSize: 11, color: '#8fd0ff', marginBottom: 6 }}>
          🛡 The defender blocked <b>{choice.blocksApplied}</b> damage. Assign all your
          hits anyway — blocks come off <i>after</i> you assign, and the defender chooses
          which assigned damage they cancel.
        </div>
      )}
      {/* Per-source constraint hints. RAW: Take It Down forces both hits to
          one target; Onslaught forces hits to different targets. */}
      {(() => {
        const sources = new Set(choice.hits.map((h) => h.source).filter((s): s is string => !!s));
        if (sources.size === 0) return null;
        return (
          <div style={{ fontSize: 11, color: '#cbc4b0', marginBottom: 6 }}>
            {Array.from(sources).map((s) => {
              const card = G.catalog.tactics[s];
              const name = card?.name ?? s;
              const rule = s.includes('take-it-down')
                ? `both hits must target the SAME unit`
                : s.includes('onslaught')
                ? `the 2 hits must target DIFFERENT units`
                : null;
              if (!rule) return null;
              return <div key={s}>⚠ <b>{name}</b>: {rule}.</div>;
            })}
          </div>
        );
      })()}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {choice.hits.map((h, i) => {
          const noTargets = choice.targetsByHit[i].length === 0;
          const isSelected = selectedHitIdx === i;
          const assignedTo = assignments[i];
          const srcLabel = h.source
            ? (h.source.includes('take-it-down') ? 'TID' : h.source.includes('onslaught') ? 'ONS' : h.source.includes('critical-hit') ? 'CRIT' : h.source.includes('bombardment') ? 'BOMB' : '+')
            : null;
          return (
            <button key={i}
              onClick={() => noTargets ? null : setSelectedHitIdx(i)}
              disabled={noTargets}
              title={assignedTo ? `→ ${unitLabel(assignedTo)}` : (noTargets ? '(no legal target)' : 'Click to select; then click a unit on the board')}
              style={{
                background: '#0c0d10',
                border: isSelected ? '2px solid #ffd54a' : (assignedTo ? '2px solid #80dc78' : '1px solid #2a2d34'),
                borderRadius: 3,
                padding: '4px 6px', fontSize: 11,
                display: 'flex', alignItems: 'center', gap: 4,
                cursor: noTargets ? 'not-allowed' : 'pointer',
                opacity: noTargets ? 0.4 : 1,
                boxShadow: isSelected ? '0 0 6px #ffd54a' : undefined,
              }}
            >
              <Die d={{ color: (h.color ?? 'black') as DieResult['color'], face: h.face }} />
              {srcLabel && (
                <span style={{ fontSize: 9, color: '#cbc4b0', fontWeight: 700 }}>{srcLabel}</span>
              )}
              {assignedTo && (
                <span style={{ color: '#80dc78', fontSize: 10 }}>
                  → {unitLabel(assignedTo).slice(0, 10)}
                  <span
                    onClick={(e) => { e.stopPropagation(); clearHit(i); }}
                    style={{ marginLeft: 4, color: '#ff8866', cursor: 'pointer' }}
                  >✕</span>
                </span>
              )}
              {noTargets && <span style={{ color: '#555', fontSize: 9 }}>—</span>}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onSubmit} style={btn(SIDE_COLOR[choice.side])}>
          {allAssigned ? 'Apply damage' : 'Apply (skip unassigned)'}
        </button>
        <button
          className="tab-button"
          onClick={() => { setAssignments(choice.hits.map(() => null)); setSelectedHitIdx(0); }}
          title="Clear all picks and start over"
        >Reset</button>
        <span style={{ fontSize: 11, color: '#888' }}>
          {assignments.filter((a) => a !== null).length} / {assignments.length} assigned
        </span>
      </div>
    </div>
  );
}

function btn(bg: string): React.CSSProperties {
  return {
    padding: '6px 14px', background: bg, color: '#000',
    border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 12,
  };
}

// ---------- Yoda reroll ----------

// ---------- One In A Million (Luke/Wedge) ----------

function OneInAMillionPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'OneInAMillionOffer' }>;
  onPersist: () => void;
}) {
  const [picks, setPicks] = useState<Map<number, string>>(new Map());
  const setFace = (i: number, face: string | null) => {
    const next = new Map(picks);
    if (face === null) next.delete(i);
    else {
      if (!next.has(i) && next.size >= 2) return;
      next.set(i, face);
    }
    setPicks(next);
  };
  const submit = (skip: boolean) => {
    const arr = skip ? [] : Array.from(picks.entries()).map(([index, face]) => ({ index, face }));
    const r = combat.resolveOneInAMillionCombat(G, arr);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b style={{ color: '#aae0ff' }}>One In A Million:</b>{' '}
        Discard the card to set up to 2 dice faces to results of your choice.
        <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>⚠ One-time use.</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {choice.faces.map((face, i) => {
          const overridden = picks.get(i);
          return (
            <div key={i} style={{
              background: '#0c0d10', border: `2px solid ${overridden ? '#80dc78' : '#2a2d34'}`, borderRadius: 4,
              padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
            }}>
              <Die d={{ color: choice.colors[i], face }} />
              <span style={{ color: '#888' }}>→</span>
              <select value={overridden ?? ''} onChange={(e) => setFace(i, e.target.value || null)}
                style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #555', fontSize: 11 }}
              >
                <option value="">(keep)</option>
                <option value="blank">blank</option>
                <option value="hit">hit ✓</option>
                <option value="direct-hit">direct-hit ✶</option>
                <option value="special">special ◈</option>
              </select>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
        Set: {picks.size} / 2
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => submit(false)} disabled={picks.size === 0} style={btn(SIDE_COLOR.Rebel)}>
          Apply ({picks.size})
        </button>
        {/* Light fill + border so "Skip" reads as an obviously-clickable choice,
            not a disabled button (dark-grey-on-black looked dead — player #635,
            same issue as the Yoda-reroll skip in #282 and retreat "Stay" in #66). */}
        <button
          onClick={() => submit(true)}
          title="Keep One In A Million in hand"
          style={{ padding: '6px 14px', background: '#d7dae0', color: '#000',
            border: '2px solid #9aa0ad', borderRadius: 3, cursor: 'pointer',
            fontWeight: 700, fontSize: 12 }}
        >
          Skip (keep card)
        </button>
      </div>
    </div>
  );
}

// ---------- R2-D2 (Resourceful Astromech) flip ----------

function R2D2FlipPanel({ G, choice, c, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'R2D2Flip' }>;
  c: NonNullable<GameState['pendingCombat']>;
  onPersist: () => void;
}) {
  const dice = c.pendingAttack?.dice ?? [];
  const submit = (flipIndex: number | null) => {
    const r = combat.resolveR2D2Flip(G, flipIndex);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b style={{ color: '#aae0ff' }}>R2-D2 (Resourceful Astromech):</b>{' '}
        Discard the ring to turn 1 Empire die to blank?
        <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
          ⚠ One-time use — once discarded, the card is gone for the rest of the game.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
        {choice.flippableDieIndices.map((i) => {
          const d = dice[i];
          if (!d) return null;
          return (
            <button
              key={i}
              onClick={() => submit(i)}
              style={{
                background: '#0c0d10', border: '2px solid #aae0ff', borderRadius: 4,
                padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              }}
              title={`Flip this ${d.color} ${d.face} die to blank`}
            >
              <Die d={d} />
              <span style={{ fontSize: 11, color: '#aae0ff' }}>→ ▢ blank</span>
            </button>
          );
        })}
        <button
          onClick={() => submit(null)}
          style={btn('#2a2c33')}
          title="Save R2-D2 for a later combat"
        >
          Skip (keep R2-D2 in hand)
        </button>
      </div>
    </div>
  );
}

function YodaRerollPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'YodaReroll' }>;
  onPersist: () => void;
}) {
  const submit = (idx: number | null) => {
    const r = combat.resolveYodaReroll(G, idx);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const holderName = G.catalog.leaders[choice.holderLeaderId]?.name ?? choice.holderLeaderId;
  // Candidates include every non-direct-hit die (#540), so show each die's
  // color+face — the player needs to see WHICH die a button rerolls.
  const dice = G.pendingCombat?.pendingAttack?.dice ?? [];
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Yoda reroll</b> ({holderName} is here) — pick one of your dice to reroll
        (a blank is the usual choice), or skip. Skipping keeps the ring available
        for later this round.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {choice.blankIndices.map((idx) => {
          const d = dice[idx];
          return (
            <button key={idx} onClick={() => submit(idx)} style={btn(SIDE_COLOR.Rebel)}>
              Reroll #{idx + 1}{d ? ` — ${d.color} ${d.face}` : ''}
            </button>
          );
        })}
        {/* Light fill + border so "Skip" reads as an obviously-clickable choice,
            not a disabled button (dark-grey-on-black looked dead — player #282,
            same issue as the retreat "Stay and fight" button in #66). */}
        <button
          onClick={() => submit(null)}
          style={{ padding: '6px 14px', background: '#d7dae0', color: '#000',
            border: '2px solid #9aa0ad', borderRadius: 3, cursor: 'pointer',
            fontWeight: 700, fontSize: 12 }}
        >
          Skip (no reroll)
        </button>
      </div>
    </div>
  );
}

// ---------- Special-die spend ----------

function SpecialDieSpendPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'SpecialDieSpend' }>;
  onPersist: () => void;
}) {
  const max = choice.specialCount;
  const [draws, setDraws] = useState(0);
  // Keyed by POSITION, not card id — two copies of the same ★ card (Take It
  // Down / Outmaneuver are copies:2) are separately playable for 1 ◈ each,
  // and an id-keyed set toggled both rows at once (#618).
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const spent = draws + picked.size;
  const submit = () => {
    const r = combat.resolveSpecialDieSpend(G, {
      draws,
      playCardIds: Array.from(picked).sort((a, b) => a - b).map((i) => choice.specialCards[i]),
    });
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const cardName = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>You rolled {choice.specialCount} special {choice.specialCount === 1 ? 'result' : 'results'} (◈).</b>
        {' '}Each ◈ can do <i>one</i> of: <b>draw a tactic card</b>, or <b>play a tactic card that needs a ◈</b>.
        {' '}({spent} of {max} ◈ used — you don't have to use them all.)
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
          Draw this many tactic cards:
          <input
            type="number"
            min={0}
            max={max - picked.size}
            value={draws}
            onChange={(e) => setDraws(Math.max(0, Math.min(max - picked.size, Number(e.target.value) || 0)))}
            style={{ width: 50, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 4px' }}
          />
        </label>
        <div style={{ minWidth: 200 }}>
          {choice.specialCards.length > 0 ? (
            <>
              <div style={{ fontSize: 12, color: '#cbd2da', marginBottom: 2 }}>
                …or spend a ◈ to play a card from your hand that needs one:
              </div>
              {choice.specialCards.map((cid, i) => (
                <label key={`${cid}#${i}`} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={picked.has(i)}
                    disabled={!picked.has(i) && spent >= max}
                    onChange={(e) => {
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(i); else next.delete(i);
                        return next;
                      });
                    }}
                  />
                  <CardHover G={G} cardId={cid}>{cardName(cid)}</CardHover>
                  {choice.specialCards.filter((o) => o === cid).length > 1 && (
                    <span style={{ fontSize: 10, opacity: 0.65 }}>
                      copy {choice.specialCards.slice(0, i + 1).filter((o) => o === cid).length}
                    </span>
                  )}
                </label>
              ))}
            </>
          ) : (
            <div style={{ fontSize: 11, color: '#888', fontStyle: 'italic' }}>
              You have no ◈-requiring tactic cards in hand right now, so your only
              use for these ◈ is drawing tactic cards (or just continue).
            </div>
          )}
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={submit} disabled={spent > max} style={btn(SIDE_COLOR[choice.side])}>
            {spent === 0 ? 'Continue (use no ◈)' : `Apply (${spent} ◈)`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Start-of-combat action cards ----------

function StartOfCombatPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatStartActionCards' }>;
  onPersist: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const submit = () => {
    const r = combat.resolveCombatStartActionCards(G, Array.from(picked));
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const cardName = (cid: string) => G.catalog.actions[cid]?.name ?? cid;
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Start-of-combat action cards</b> — play 0 or more from your hand.
      </div>
      {choice.playable.length === 0 ? (
        <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>(no playable cards)</div>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {choice.playable.map((cid) => (
            <label key={cid} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={picked.has(cid)}
                onChange={(e) => {
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(cid); else next.delete(cid);
                    return next;
                  });
                }}
              />
              <CardHover G={G} cardId={cid}>{cardName(cid)}</CardHover>
            </label>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, textAlign: 'right' }}>
        <button onClick={submit} style={btn(SIDE_COLOR[choice.side])}>
          {picked.size === 0 ? 'Skip' : `Play ${picked.size} card${picked.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}

// ---------- "More Dangerous Than You Realize" theater pick ----------

function MoreDangerousTheaterPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'MoreDangerousTheaterPick' }>;
  onPersist: () => void;
}) {
  const card = G.catalog.actions[choice.cardId];
  const pick = (theater: 'space' | 'ground') => {
    const r = combat.resolveMoreDangerousTheaterPick(G, theater);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  // Cinematic combat (#449): "draw" = retrieve your own discarded advanced
  // tactic cards back into your deck, so show DISCARD counts, not base decks.
  const cinematic = !!G.pendingCombat?.cinematic;
  const f = choice.side === 'Rebel' ? G.rebel : G.empire;
  const eliminated = new Set(f.cinematicTacticEliminated ?? []);
  const discOf = (th: 'space' | 'ground') => (f.cinematicTacticDiscard ?? [])
    .filter((cid) => G.catalog.tactics[cid]?.theater === th && !eliminated.has(cid)).length;
  const spaceLeft = cinematic ? discOf('space') : G.spaceTacticDeck.length;
  const groundLeft = cinematic ? discOf('ground') : G.groundTacticDeck.length;
  const verb = cinematic ? 'retrieve up to 3 of your discarded tactic cards back into one deck' : 'draw 3 tactic cards from one deck';
  const src = cinematic ? 'discarded' : 'remaining';
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{card?.name ?? choice.cardId}:</b> {verb} — your choice.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => pick('space')}
          style={btn('#4fc3f7')}
          disabled={spaceLeft === 0 && groundLeft > 0}
          title={`3 from ${spaceLeft} ${src} space cards`}
        >
          ◇ Space ({spaceLeft} {src})
        </button>
        <button
          onClick={() => pick('ground')}
          style={btn('#ffb74d')}
          disabled={groundLeft === 0 && spaceLeft > 0}
          title={`3 from ${groundLeft} ${src} ground cards`}
        >
          ■ Ground ({groundLeft} {src})
        </button>
      </div>
    </div>
  );
}

// ---------- "More Dangerous" cinematic retrieval pick (#449) ----------

function MoreDangerousRetrievePanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'MoreDangerousRetrievePick' }>;
  onPersist: () => void;
}) {
  const [sel, setSel] = useState<number[]>([]);
  const toggle = (i: number) => setSel((s) => (s.includes(i) ? s.filter((x) => x !== i) : s.length < choice.count ? [...s, i] : s));
  const submit = () => {
    const r = combat.resolveMoreDangerousRetrievePick(G, sel.map((i) => choice.candidates[i]));
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{G.catalog.actions[choice.cardId]?.name ?? choice.cardId}:</b> pick {choice.count} of your
        discarded {choice.theater} tactic cards to return to your deck.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {choice.candidates.map((cid, i) => (
          <button key={i} onClick={() => toggle(i)}
            style={{ ...btn(sel.includes(i) ? '#80dc78' : '#888'),
              background: sel.includes(i) ? 'rgba(60,110,60,0.4)' : undefined }}>
            {G.catalog.tactics[cid]?.name ?? cid}
          </button>
        ))}
      </div>
      <button onClick={submit} disabled={sel.length !== choice.count} className="tab-button active">
        Retrieve {sel.length}/{choice.count}
      </button>
    </div>
  );
}

// ---------- "Fully Operational" target pick (Moff Jerjerrod) ----------

function FullyOperationalPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'FullyOperationalTargetPick' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const submit = (instanceId: string) => {
    const r = combat.resolveFullyOperationalTargetPick(G, instanceId);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Fully Operational:</b> destroy 1 Rebel ship of your choice.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((iid) => {
          const u = ss?.units.find((x) => x.instanceId === iid);
          const t = u ? G.catalog.unitTypes[u.typeId] : null;
          return (
            <button key={iid} onClick={() => submit(iid)} style={btn('#ff8866')}>
              {t?.name ?? u?.typeId ?? iid}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- "Target the Generator" structure pick (General Veers) ----------

function TargetTheGeneratorPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'TargetTheGeneratorPick' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const submit = (instanceId: string) => {
    const r = combat.resolveTargetTheGeneratorPick(G, instanceId);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Target the Generator:</b> destroy 1 structure in this system.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((iid) => {
          const u = ss?.units.find((x) => x.instanceId === iid);
          const t = u ? G.catalog.unitTypes[u.typeId] : null;
          return (
            <button key={iid} onClick={() => submit(iid)} style={btn('#ff8866')}>
              {t?.name ?? u?.typeId ?? iid}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- "Baze's Loyalty" destroy-2-health pick (Chirrut, #316) ----------

function BazesLoyaltyPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'BazesLoyaltyTarget' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const submit = (instanceId: string) => {
    const r = combat.resolveBazesLoyaltyTarget(G, instanceId);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Baze's Loyalty:</b> destroy units worth up to {choice.budget} health — pick one.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((iid) => {
          const u = ss?.units.find((x) => x.instanceId === iid);
          const t = u ? G.catalog.unitTypes[u.typeId] : null;
          return (
            <button key={iid} onClick={() => submit(iid)} style={btn('#ff8866')}>
              {t?.name ?? u?.typeId ?? iid}{t ? ` (${t.health.value}♥)` : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Cinematic targeted-deal pick (Tow Cables / Ion Blast, #290) ----------

function CinematicDestroyPickPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicDestroyPick' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const submit = (instanceId: string) => {
    const r = combat.resolveCinematicDestroyPick(G, instanceId);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{choice.side} — choose a target:</b> destroy 1 enemy unit (no dice rolled).
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((iid) => {
          const u = ss?.units.find((x) => x.instanceId === iid);
          const t = u ? G.catalog.unitTypes[u.typeId] : null;
          return (
            <button key={iid} onClick={() => submit(iid)} style={btn('#ff8866')}>
              {t?.name ?? u?.typeId ?? iid}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CinematicTargetPickPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicTargetPick' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const submit = (instanceId: string) => {
    const r = combat.resolveCinematicTargetPick(G, instanceId);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{choice.side} — choose a target:</b> deal {choice.amount} damage to 1 enemy unit.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((iid) => {
          const u = ss?.units.find((x) => x.instanceId === iid);
          const t = u ? G.catalog.unitTypes[u.typeId] : null;
          const hp = t?.health.value ?? 0;
          const remaining = hp - (u?.damage ?? 0);
          return (
            <button key={iid} onClick={() => submit(iid)} style={btn('#ffcc55')}>
              {t?.name ?? u?.typeId ?? iid}
              {hp > 0 && (
                <span style={{ fontSize: 10, opacity: 0.75 }}> ({remaining}/{hp} hp)</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- "Ready For Action" leader pick (Piett / Veers) ----------

function ReadyForActionPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'ReadyForActionLeaderPick' }>;
  onPersist: () => void;
}) {
  const submit = (leaderId: string) => {
    const r = combat.resolveReadyForActionLeaderPick(G, leaderId as never);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Ready For Action:</b> place a leader from the pool into this combat (returns at end).
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((lid) => {
          const ldr = G.catalog.leaders[lid];
          const tv = (ldr?.tacticValues.space ?? 0) + (ldr?.tacticValues.ground ?? 0);
          return (
            <button key={lid} onClick={() => submit(lid)} style={btn('#80dc78')}>
              {ldr?.name ?? lid} <span style={{ fontSize: 10, opacity: 0.7 }}>(tactic {tv})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Combat step 1: optional "add a leader from pool" ----------

function CinematicTacticSelectPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicTacticSelect' }>;
  onPersist: () => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const submit = (cardId: string | null, useTop: boolean) => {
    const r = combat.resolveCinematicTacticSelect(G, cardId, useTop);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    setPicked(null);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{choice.side} — play an advanced tactic card ({choice.theater}, round {choice.round})</b>{' '}
        You must play one card each round; pick its top or bottom ability, or decline
        the ability (the card is still discarded). Played cards are discarded (the deck
        recycles once it empties).
      </div>
      {/* Good Intel: the Empire chooses after the Rebel reveals, so show the Rebel's card. */}
      {choice.revealedOpponentTactic !== undefined && (
        <div style={{
          fontSize: 12, marginBottom: 8, padding: '6px 8px', borderRadius: 6,
          background: '#241c10', border: '1px solid #806020',
        }}>
          <b style={{ color: '#ffd54a' }}>Good Intel:</b>{' '}
          {choice.revealedOpponentTactic
            ? <>the Rebel revealed <b>{choice.revealedOpponentTactic.name}</b> — pick your response.</>
            : <>the Rebel played no tactic card this round.</>}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {choice.options.map((opt) => {
          const sel = picked === opt.cardId;
          // The top ability of every advanced tactic requires a specific unit in
          // this combat (RoE p.9); surface it so players know why a top ability
          // is/isn't available (#315).
          const reqUnitId = G.catalog.tactics[opt.cardId]?.primaryUnit;
          const reqUnitName = reqUnitId ? (G.catalog.unitTypes[reqUnitId]?.name ?? reqUnitId) : null;
          return (
            <div
              key={opt.cardId}
              style={{
                border: `1px solid ${sel ? '#80dc78' : '#444'}`,
                borderRadius: 6, padding: 8, minWidth: 180, maxWidth: 240,
                background: sel ? '#1b2a1b' : '#181818', cursor: 'pointer',
              }}
              onClick={() => setPicked(sel ? null : opt.cardId)}
            >
              <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 4 }}>{opt.name}</div>
              <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 6 }}>
                <div><b>Top:</b> {opt.primaryText}{!opt.primaryUsable && <span style={{ color: '#e07b7b' }}> (prereq not met)</span>}</div>
                {reqUnitName && (
                  <div style={{ fontSize: 10, color: opt.primaryUsable ? '#9bd' : '#e07b7b', marginTop: 2 }}>
                    Top requires a {reqUnitName} in this combat{opt.primaryUsable ? ' ✓' : ' — not present'}
                  </div>
                )}
                <div style={{ marginTop: 4 }}><b>Bottom:</b> {opt.secondaryText} <span style={{ opacity: 0.6 }}>(no requirement)</span></div>
              </div>
              {sel && (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    disabled={!opt.primaryUsable}
                    onClick={(e) => { e.stopPropagation(); submit(opt.cardId, true); }}
                    style={{ ...btn(opt.primaryUsable ? '#80dc78' : '#555'), opacity: opt.primaryUsable ? 1 : 0.5 }}
                  >
                    Play top
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); submit(opt.cardId, false); }} style={btn('#80b0dc')}>
                    Play bottom
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <button onClick={() => submit(null, false)} style={btn('#ffd54a')}>
        Resolve no ability (discard a card)
      </button>
    </div>
  );
}

function RogueOneChoicePanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'RogueOneChoice' }>;
  onPersist: () => void;
}) {
  const submit = (action: string) => {
    const r = combat.resolveRogueOneChoice(G, action);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Rogue One</b> — a unit retreated this round. Rescue 1 captured leader{' '}
        <i>or</i> remove 1 target marker from this system.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.rescuable.map((lid) => (
          <button key={`r-${lid}`} onClick={() => submit(`rescue:${lid}`)} style={btn('#80dc78')}>
            Rescue {G.catalog.leaders[lid]?.name ?? lid}
          </button>
        ))}
        {choice.markerSources.map((src) => (
          <button key={`m-${src}`} onClick={() => submit(`marker:${src}`)} style={btn('#80b0dc')}>
            Remove “{src}” marker
          </button>
        ))}
      </div>
    </div>
  );
}

function TractorBeamCapturePanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'TractorBeamCapturePick' }>;
  onPersist: () => void;
}) {
  const submit = (leaderId: string) => {
    const r = combat.resolveTractorBeamCapturePick(G, leaderId as never);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Tractor Beam</b> — capture <i>1 Rebel leader</i> stranded in this system.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((lid) => (
          <button key={lid} onClick={() => submit(lid)} style={btn('#dc8078')}>
            Capture {G.catalog.leaders[lid]?.name ?? lid}
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfrontationLeaderPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'ConfrontationLeaderPick' }>;
  onPersist: () => void;
}) {
  const submit = (leaderId: string) => {
    const r = combat.resolveConfrontationLeaderPick(G, leaderId as never);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Confrontation</b> — the last Imperial ground unit here was destroyed.
        Mark <i>1 Imperial leader</i> in this system for elimination at the end of
        the Command phase. <span style={{ opacity: 0.7 }}>(Strongest first — your call.)</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((lid) => {
          const ldr = G.catalog.leaders[lid];
          const sp = ldr?.tacticValues.space ?? 0;
          const gr = ldr?.tacticValues.ground ?? 0;
          return (
            <button key={lid} onClick={() => submit(lid)} style={btn('#dc8078')}>
              Mark {ldr?.name ?? lid}{' '}
              <span style={{ fontSize: 10, opacity: 0.7 }}>(space {sp} / ground {gr})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CinematicRerollPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicReroll' }>;
  onPersist: () => void;
}) {
  const [sel, setSel] = useState<number[]>([...choice.suggested]);
  const toggle = (i: number) =>
    setSel((s) => s.includes(i) ? s.filter((x) => x !== i) : (s.length < choice.allowance ? [...s, i] : s));
  const submit = (indices: number[]) => {
    const r = combat.resolveCinematicReroll(G, indices);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const faceGlyph = (f: string) =>
    f === 'blank' ? '–' : f === 'hit' ? '◆' : f === 'direct-hit' ? '◆◆' : f === 'special' ? '★' : f;
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Cinematic reroll</b> — you may reroll up to <b>{choice.allowance}</b>{' '}
        of your dice (your leader's tactic value). Click dice to toggle; the
        blanks are pre-selected. <span style={{ opacity: 0.7 }}>Selected {sel.length}/{choice.allowance}.</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {choice.faces.map((f, i) => {
          const on = sel.includes(i);
          // Green is an explicit RoE die colour, not the catch-all; an unknown
          // colour falls through to magenta so it's visibly wrong, not fake-green.
          const col = choice.colors[i] === 'red' ? '#c0392b'
            : choice.colors[i] === 'black' ? '#444'
            : choice.colors[i] === 'green' ? '#3a7d3a' : '#d000d0';
          return (
            <button key={i} onClick={() => toggle(i)}
              style={{ ...btn(on ? '#ffd54a' : '#777'), minWidth: 40, borderColor: col,
                outline: on ? '2px solid #ffd54a' : 'none' }}>
              {faceGlyph(f)}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => submit(sel)} style={btn('#80dc78')}>
          Reroll {sel.length} selected
        </button>
        <button onClick={() => submit([])} style={btn('#ffd54a')}>Keep roll</button>
      </div>
    </div>
  );
}

function CinematicHealPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicHeal' }>;
  onPersist: () => void;
}) {
  const initial: Record<string, number> = {};
  choice.suggested.forEach((s) => { initial[s.instanceId] = s.amount; });
  const [alloc, setAlloc] = useState<Record<string, number>>(initial);
  const usedBy = (color: 'red' | 'black') =>
    choice.candidates.filter((c) => c.color === color).reduce((n, c) => n + (alloc[c.instanceId] ?? 0), 0);
  const inc = (cand: typeof choice.candidates[number]) => {
    if ((alloc[cand.instanceId] ?? 0) < cand.damage && usedBy(cand.color) < choice.budget[cand.color]) {
      setAlloc((a) => ({ ...a, [cand.instanceId]: (a[cand.instanceId] ?? 0) + 1 }));
    }
  };
  const dec = (cand: typeof choice.candidates[number]) =>
    setAlloc((a) => ({ ...a, [cand.instanceId]: Math.max(0, (a[cand.instanceId] ?? 0) - 1) }));
  const submit = (map: Record<string, number>) => {
    const allocation = Object.entries(map).map(([instanceId, amount]) => ({ instanceId, amount })).filter((x) => x.amount > 0);
    const r = combat.resolveCinematicHeal(G, allocation);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Removing damage</b> — spend your ★ dice to heal your own units (each ★
        removes 1 damage from a unit of the matching colour).{' '}
        <span style={{ opacity: 0.7 }}>
          Red ★ {usedBy('red')}/{choice.budget.red} · Black ★ {usedBy('black')}/{choice.budget.black}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {choice.candidates.map((cand) => {
          const cur = alloc[cand.instanceId] ?? 0;
          const col = cand.color === 'red' ? '#c0392b' : '#444';
          return (
            <div key={cand.instanceId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: col, display: 'inline-block' }} />
              <span style={{ minWidth: 150 }}>{G.catalog.unitTypes[cand.typeId]?.name ?? cand.typeId}</span>
              <span style={{ fontSize: 11, opacity: 0.7, minWidth: 70 }}>dmg {cand.damage}</span>
              <button onClick={() => dec(cand)} style={btn('#777')}>−</button>
              <span style={{ minWidth: 20, textAlign: 'center' }}>{cur}</span>
              <button onClick={() => inc(cand)} style={btn('#80dc78')}>+</button>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => submit(alloc)} style={btn('#80dc78')}>Apply heal</button>
        <button onClick={() => { const m: Record<string, number> = {}; choice.suggested.forEach((s) => { m[s.instanceId] = s.amount; }); setAlloc(m); }} style={btn('#80b0dc')}>Use suggested</button>
        <button onClick={() => submit({})} style={btn('#ffd54a')}>Spend none</button>
      </div>
    </div>
  );
}

// ---------- Draw Their Fire / Energy Shield deferred heal (#322) ----------

function CinematicDeferredHealPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CinematicDeferredHeal' }>;
  onPersist: () => void;
}) {
  const initial: Record<string, number> = {};
  choice.suggested.forEach((s) => { initial[s.instanceId] = s.amount; });
  const [alloc, setAlloc] = useState<Record<string, number>>(initial);
  const used = choice.candidates.reduce((n, c) => n + (alloc[c.instanceId] ?? 0), 0);
  const inc = (cand: typeof choice.candidates[number]) => {
    if ((alloc[cand.instanceId] ?? 0) < cand.damage && used < choice.amount) {
      setAlloc((a) => ({ ...a, [cand.instanceId]: (a[cand.instanceId] ?? 0) + 1 }));
    }
  };
  const dec = (cand: typeof choice.candidates[number]) =>
    setAlloc((a) => ({ ...a, [cand.instanceId]: Math.max(0, (a[cand.instanceId] ?? 0) - 1) }));
  const submit = (map: Record<string, number>) => {
    const allocation = Object.entries(map).map(([instanceId, amount]) => ({ instanceId, amount })).filter((x) => x.amount > 0);
    const r = combat.resolveCinematicDeferredHeal(G, allocation);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Remove damage</b> — pull up to {choice.amount} damage off your own
        {' '}{choice.theater} units (Draw Their Fire / Energy Shield).{' '}
        <span style={{ opacity: 0.7 }}>{used}/{choice.amount} used</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
        {choice.candidates.map((cand) => {
          const cur = alloc[cand.instanceId] ?? 0;
          return (
            <div key={cand.instanceId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ minWidth: 150 }}>{G.catalog.unitTypes[cand.typeId]?.name ?? cand.typeId}</span>
              <span style={{ fontSize: 11, opacity: 0.7, minWidth: 90 }}>
                dmg {cand.damage}{cand.staged ? ' ⚠ dying' : ''}
              </span>
              <button onClick={() => dec(cand)} style={btn('#777')}>−</button>
              <span style={{ minWidth: 20, textAlign: 'center' }}>{cur}</span>
              <button onClick={() => inc(cand)} style={btn('#80dc78')}>+</button>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => submit(alloc)} style={btn('#80dc78')}>Apply heal</button>
        <button onClick={() => { const m: Record<string, number> = {}; choice.suggested.forEach((s) => { m[s.instanceId] = s.amount; }); setAlloc(m); }} style={btn('#80b0dc')}>Use suggested</button>
        <button onClick={() => submit({})} style={btn('#ffd54a')}>Remove none</button>
      </div>
    </div>
  );
}

function CombatAddLeaderPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAddLeaderPick' }>;
  onPersist: () => void;
}) {
  const submit = (leaderId: string | null) => {
    const r = combat.resolveCombatAddLeaderPick(G, leaderId as never);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{choice.side} — add a leader to this combat?</b>{' '}
        You have no leader with tactic values here. You <i>may</i> place one leader
        from your pool — they roll tactic dice but are at risk of capture / elimination.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {choice.candidates.map((lid) => {
          const ldr = G.catalog.leaders[lid];
          const sp = ldr?.tacticValues.space ?? 0;
          const gr = ldr?.tacticValues.ground ?? 0;
          return (
            <button key={lid} onClick={() => submit(lid)} style={btn('#80dc78')}>
              {ldr?.name ?? lid}{' '}
              <span style={{ fontSize: 10, opacity: 0.7 }}>(space {sp} / ground {gr})</span>
            </button>
          );
        })}
        <button onClick={() => submit(null)} style={btn('#ffd54a')}>
          Don't add (no tactic dice this combat)
        </button>
      </div>
    </div>
  );
}

// ---------- Retreat decision ----------

function RetreatPanel({ G, choice, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'RetreatDecision' }>;
  onPersist: () => void;
}) {
  const ss = G.map.systems[choice.systemId];
  const ours = (ss?.units ?? []).filter((u) => u.side === choice.side);
  // RAW p.5: self-mobile ships — space units with no transport-restriction icon
  // (capital ships, transports, and Rebel X-/Y-Wings) — MUST move out;
  // restriction-icon units (TIE Fighters) and ground units MAY be left behind
  // alive; immobile units can never move (stay alive). Nothing is destroyed.
  const unitClass = (u: { typeId: string }): 'carrier' | 'leaveable' | 'immobile' => {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.transport.immobile) return 'immobile';
    if (t.theater === 'space' && !t.transport.restriction) return 'carrier';
    return 'leaveable';
  };
  const carriers = ours.filter((u) => unitClass(u) === 'carrier');
  const leaveable = ours.filter((u) => unitClass(u) === 'leaveable');
  const immobile = ours.filter((u) => unitClass(u) === 'immobile');
  const capacity = carriers.reduce((s, u) => s + (G.catalog.unitTypes[u.typeId]?.transport.capacity ?? 0), 0);
  const ignoresTransport = !!G.pendingCombat?.flags?.retreatIgnoresTransport?.[choice.side];

  // With more than one legal destination, start UNSELECTED so the player has to
  // consciously pick where to retreat — otherwise the dropdown silently defaulted
  // to the first system and a quick "Retreat" click sent them somewhere they
  // didn't choose (player #283). A single destination auto-selects (no real choice).
  const [dest, setDest] = useState<string | null>(
    choice.legalDestinations.length === 1 ? choice.legalDestinations[0] : null);
  // RAW: one leader leads the retreat (the units follow it). Default to the
  // first present; let the player choose if they have more than one here.
  const [leader, setLeader] = useState<string | null>(choice.leadersInSystem[0] ?? null);
  // Which fighters/ground to bring (default: all). Anything not brought — or
  // over transport capacity — stays behind alive.
  const [bring, setBring] = useState<Set<string>>(() => new Set(leaveable.map((u) => u.instanceId)));
  const toggleBring = (uid: string) => setBring((prev) => {
    const next = new Set(prev);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });

  const broughtList = leaveable.filter((u) => bring.has(u.instanceId));
  const fitting = ignoresTransport ? broughtList : broughtList.slice(0, capacity);
  const overflow = ignoresTransport ? [] : broughtList.slice(capacity);
  const willRetreat = [...carriers, ...fitting];
  const willStay = [
    ...immobile,
    ...leaveable.filter((u) => !bring.has(u.instanceId)),
    ...overflow,
  ];

  const submit = (destSystemId: string | null) => {
    // "Stay and fight" (null dest) doesn't move a leader; a real retreat does.
    const moveIds = destSystemId
      ? [...carriers.map((u) => u.instanceId), ...fitting.map((u) => u.instanceId)]
      : null;
    const r = combat.resolveRetreatDecision(G, destSystemId, moveIds, destSystemId ? leader : null);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const leaderName = (lid: string) => G.catalog.leaders[lid]?.name ?? lid;
  const sysName = (sid: string) => G.catalog.systems[sid]?.name ?? sid;

  const fmt = (units: typeof ours) => {
    const counts = new Map<string, number>();
    for (const u of units) counts.set(u.typeId, (counts.get(u.typeId) ?? 0) + 1);
    return [...counts.entries()].map(([t, n]) => {
      const name = G.catalog.unitTypes[t]?.name ?? t;
      return n > 1 ? `${name}×${n}` : name;
    }).join(', ');
  };

  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Retreat?</b> {choice.availableUnits.length} unit{choice.availableUnits.length === 1 ? '' : 's'} can withdraw
        to a friendly adjacent system, led by one of your leaders. (Once per combat.)
        {choice.leadersInSystem.length > 1 && (
          <span style={{ color: '#888' }}> Any leader you don't pick stays behind in the system.</span>
        )}
      </div>

      {leaveable.length > 0 && (
        <div style={{ marginBottom: 8, fontSize: 11 }}>
          <div style={{ color: '#aaa', marginBottom: 3 }}>
            Bring along (fighters &amp; ground — transport capacity {ignoresTransport ? '∞ (Escape Plan)' : capacity}).
            Unchecked units stay behind in the system, alive.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {leaveable.map((u) => (
              <label key={u.instanceId} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <input type="checkbox" checked={bring.has(u.instanceId)} onChange={() => toggleBring(u.instanceId)} />
                {G.catalog.unitTypes[u.typeId]?.name ?? u.typeId}
              </label>
            ))}
          </div>
        </div>
      )}

      {(willRetreat.length > 0 || willStay.length > 0) && (
        <div style={{ marginBottom: 8, padding: 8, background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4, fontSize: 11 }}>
          {willRetreat.length > 0 && (
            <div style={{ color: '#80dc78', marginBottom: willStay.length > 0 ? 4 : 0 }}>
              <b>Will retreat ({willRetreat.length}):</b> {fmt(willRetreat)}
            </div>
          )}
          {willStay.length > 0 && (
            <div style={{ color: '#e0c060' }}>
              <b>Will stay behind ({willStay.length}):</b> {fmt(willStay)}
              <div style={{ color: '#888', marginTop: 2, fontStyle: 'italic' }}>
                These remain in the system (alive, not destroyed). If the enemy still has units in
                their theater, another combat round is fought.
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {choice.legalDestinations.length === 0 ? (
          <span style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>(no legal destinations)</span>
        ) : (
          <>
            <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
              Retreat to:
              <select
                value={dest ?? ''}
                onChange={(e) => setDest(e.target.value || null)}
                style={{ background: '#0c0d10', color: dest ? '#fff' : '#ffcf66',
                  border: `1px solid ${dest ? '#555' : '#ffcf66'}`, padding: '2px 4px', fontSize: 12 }}
              >
                {choice.legalDestinations.length > 1 && (
                  <option value="" disabled>— choose a system —</option>
                )}
                {choice.legalDestinations.map((sid) => (
                  <option key={sid} value={sid}>{sysName(sid)}</option>
                ))}
              </select>
            </label>
            {choice.leadersInSystem.length > 1 ? (
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
                Led by:
                <select
                  value={leader ?? ''}
                  onChange={(e) => setLeader(e.target.value || null)}
                  style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 4px', fontSize: 12 }}
                >
                  {choice.leadersInSystem.map((lid) => (
                    <option key={lid} value={lid}>{leaderName(lid)}</option>
                  ))}
                </select>
              </label>
            ) : (
              <span style={{ fontSize: 12, color: '#aaa' }}>
                Led by <b style={{ color: '#fff' }}>{leaderName(choice.leadersInSystem[0] ?? '')}</b>
              </span>
            )}
            <button onClick={() => submit(dest)} disabled={!dest || willRetreat.length === 0} style={btn(SIDE_COLOR[choice.side])}>
              Retreat ({willRetreat.length} move{willStay.length > 0 ? `, ${willStay.length} stay` : ''})
            </button>
          </>
        )}
        {/* Clearly-enabled style: dark-grey-on-black read as disabled, making
            it look like you couldn't stay (player report #66). Light fill +
            border + bold = an obviously clickable, equal-weight choice. */}
        <button
          onClick={() => submit(null)}
          style={{ padding: '6px 14px', background: '#d7dae0', color: '#000',
            border: '2px solid #9aa0ad', borderRadius: 3, cursor: 'pointer',
            fontWeight: 700, fontSize: 12 }}
        >
          Stay and fight
        </button>
      </div>
    </div>
  );
}

