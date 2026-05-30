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
import * as combat from '../engine/combat';
import { stepOnce as aiStepOnce } from './randomAI';
import { vmodAssetUrl, CARD_IMAGE_BASE } from '../data/loadAssets';

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
  const [open, setOpen] = useState(false);
  // Anchor the popover to the LEFT of the trigger when it would otherwise
  // run off the right edge of the viewport. Player report: the Escape Plan
  // tooltip rendered off-screen to the right because the popover was hard-
  // coded to left:'100%' (always to the right of the card name), and the
  // combat tactic cards sit near the right edge (issue #55).
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [flipLeft, setFlipLeft] = useState(false);
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
    if (el && typeof window !== 'undefined') {
      const r = el.getBoundingClientRect();
      // If the right-anchored popover would overflow the viewport, flip it
      // to the left of the trigger instead.
      setFlipLeft(r.right + 8 + POPOVER_W > window.innerWidth);
    }
    setOpen(true);
  };
  const horiz: import('react').CSSProperties = flipLeft
    ? { right: '100%', marginRight: 8 }
    : { left: '100%', marginLeft: 8 };
  return (
    <span
      ref={anchorRef}
      style={{ borderBottom: '1px dotted #888', cursor: 'help', position: 'relative' }}
      onMouseEnter={onEnter}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <div style={{
          position: 'absolute', bottom: '100%', ...horiz,
          marginBottom: 4, zIndex: 3000,
          background: 'rgba(0,0,0,0.95)', border: '1px solid #555',
          padding: 8, borderRadius: 4, width: POPOVER_W,
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

export function CombatBoardLive({ G, humanSide, onPersist, onReportProblem }: {
  G: GameState;
  humanSide: Side;
  onPersist: () => void;
  /** Opens the "Report a problem" dialog from inside the combat overlay.
   *  Needed because the play-tab header (where the normal report button
   *  lives) is hidden behind the full-screen combat board, so players
   *  couldn't file a report while a combat was stuck (#26-ish — surfaced
   *  in conversation, not as a GH issue). */
  onReportProblem?: () => void;
}) {
  const c = G.pendingCombat;
  if (!c) return null;

  const systemName = G.catalog.systems[c.systemId]?.name ?? c.systemId;
  const attacker = c.attackerSide;
  const defender = attacker === 'Rebel' ? 'Empire' : 'Rebel';

  // Current decision (if any) and which side owns it.
  const pc = G.pendingChoice;
  const decisionSide: Side | null =
    pc?.kind === 'CombatAttackerTactics' ? pc.side :
    pc?.kind === 'CombatDefenderTactics' ? pc.side :
    pc?.kind === 'CombatAssignDamage'    ? pc.side :
    pc?.kind === 'YodaReroll'            ? pc.side :
    pc?.kind === 'R2D2Flip'              ? pc.side :
    pc?.kind === 'OneInAMillionOffer'    ? pc.side :
    pc?.kind === 'SpecialDieSpend'       ? pc.side :
    pc?.kind === 'CombatStartActionCards' ? pc.side :
    pc?.kind === 'MoreDangerousTheaterPick' ? pc.side :
    pc?.kind === 'FullyOperationalTargetPick' ? pc.side :
    pc?.kind === 'TargetTheGeneratorPick' ? pc.side :
    pc?.kind === 'ReadyForActionLeaderPick' ? pc.side :
    pc?.kind === 'CombatAddLeaderPick'   ? pc.side :
    pc?.kind === 'RetreatDecision'       ? pc.side : null;
  const isHumanDecision = decisionSide === humanSide;
  const waitingForAI = decisionSide !== null && !isHumanDecision;

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

  /** Per-side per-theater click-target bundle. Only the defender's units in
   *  the active theater are clickable during AssignDamage. */
  const damageAssignBundle = damageChoice ? {
    defenderSide: defender,
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
      />

      <TacticHandsBar
        G={G}
        humanSide={humanSide}
        attacker={attacker}
        defender={defender}
        attackerHand={c.attackerHand}
        defenderHand={c.defenderHand}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, minHeight: 0 }}>
        <TheaterPanel
          G={G} c={c} theater="space"
          attacker={attacker} defender={defender}
          dice={activeTheater === 'space' ? dice : null}
          rolling={activeTheater === 'space' ? c.pendingAttack?.side ?? null : null}
          damageAssign={damageAssignBundle?.theater === 'space' ? damageAssignBundle : null}
        />
        <TheaterPanel
          G={G} c={c} theater="ground"
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
                Waiting for {decisionSide} (AI) to choose…
              </div>
              <button
                className="tab-button"
                onClick={kickAI}
                title="Manually kick the AI driver. Use if the AI seems stuck."
              >
                Step AI
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
        {pc?.kind === 'OneInAMillionOffer' && pc.context === 'combat' && isHumanDecision && (
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
        {pc?.kind === 'FullyOperationalTargetPick' && isHumanDecision && (
          <FullyOperationalPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'TargetTheGeneratorPick' && isHumanDecision && (
          <TargetTheGeneratorPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'ReadyForActionLeaderPick' && isHumanDecision && (
          <ReadyForActionPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatAddLeaderPick' && isHumanDecision && (
          <CombatAddLeaderPanel G={G} choice={pc} onPersist={onPersist} />
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
 *  only the count — opponent's hand is private per RAW. */
function TacticHandsBar({
  G, humanSide, attacker, defender, attackerHand, defenderHand,
}: {
  G: GameState;
  humanSide: Side;
  attacker: Side;
  defender: Side;
  attackerHand: string[];
  defenderHand: string[];
}) {
  const handFor = (side: Side) => (side === attacker ? attackerHand : defenderHand);
  const renderSide = (side: Side) => {
    const hand = handFor(side);
    const isHuman = side === humanSide;
    const color = SIDE_COLOR[side];
    if (isHuman) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color, fontWeight: 700, fontSize: 12 }}>
            {side} tactic cards ({hand.length}):
          </span>
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

function Header({ systemName, attacker, defender, round, humanSide, onReportProblem }: {
  systemName: string; attacker: Side; defender: Side; round: number; humanSide: Side;
  onReportProblem?: () => void;
}) {
  return (
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

function TheaterPanel({ G, c, theater, attacker, defender, dice, rolling, damageAssign }: {
  G: GameState; c: NonNullable<GameState['pendingCombat']>;
  theater: Theater; attacker: Side; defender: Side;
  dice: DieResult[] | null; rolling: Side | null;
  damageAssign?: DamageAssignBundle | null;
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
        />
        <DicePanel dice={dice} side={rolling} />
        <SidePanel
          G={G}
          side={defender}
          units={defUnits}
          leaderIds={defLeaders}
          align="left"
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
function SidePanel({ G, side, units, leaderIds, align, damageAssign }: {
  G: GameState; side: Side; units: UnitInstance[]; leaderIds: string[]; align: 'left' | 'right';
  damageAssign?: DamageAssignBundle | null;
}) {
  const color = SIDE_COLOR[side];
  // Find the highest single-unit HP we need to show (decides how many
  // damage lanes to render). Cap at 5 (the SSD's max HP).
  const maxHp = Math.max(1, ...units.map((u) => G.catalog.unitTypes[u.typeId]?.health.value ?? 1));
  const lanes = Math.min(5, maxHp); // 0..maxHp-1 damage shown; >=maxHp dies
  // Bucket each instance into its damage lane (0 = pristine).
  const buckets: UnitInstance[][] = Array.from({ length: lanes }, () => []);
  for (const u of units) {
    const dmg = Math.min(u.damage ?? 0, lanes - 1);
    buckets[dmg].push(u);
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      gap: 4,
      minWidth: 0,
    }}>
      <div style={{ color, fontSize: 12, fontWeight: 700 }}>{side}</div>
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
          gridTemplateColumns: `repeat(${lanes}, minmax(56px, 1fr))`,
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
  // Two-letter abbreviation derived from the type ID for a quick visual.
  const abbr = (t?.id ?? unit.typeId).split('-').map((s) => s[0]?.toUpperCase()).join('').slice(0, 3);
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
        width: 22, height: 22, background: '#0c0d10', border,
        borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 700, color: '#e8e8ea',
        cursor: onClick ? 'pointer' : 'default',
        boxShadow: legalTarget ? '0 0 6px #ffd54a' : undefined,
      }}
    >
      {abbr}
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

function DicePanel({ dice, side }: { dice: DieResult[] | null; side: Side | null }) {
  if (!dice || dice.length === 0) {
    return <div style={{ alignSelf: 'center', color: '#444', fontSize: 11, fontStyle: 'italic' }}>(no roll yet)</div>;
  }
  const color = side ? SIDE_COLOR[side] : '#888';
  return (
    <div style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{ fontSize: 10, color, fontWeight: 700 }}>{side} rolled</div>
      <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 220 }}>
        {dice.map((d, i) => <Die key={i} d={d} />)}
      </div>
    </div>
  );
}

function Die({ d }: { d: DieResult }) {
  const bg = d.color === 'red' ? '#c4423a' : d.color === 'black' ? '#222' : '#357a3a';
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
  const damageBoosts = choice.hand.filter((cid) =>
    cid.includes('take-it-down') || cid.includes('critical-hit') || cid.includes('onslaught')
  );
  const [useCF, setUseCF] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const label = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  const bonus = (cid: string) =>
    cid.includes('take-it-down') ? '+2 same target' :
    cid.includes('onslaught') ? '+1 × 2 different' :
    cid.includes('critical-hit') ? '+1' : '';

  const submit = () => {
    const r = combat.resolveCombatAttackerTactics(G, {
      concentrateFireCardId: useCF ? cf : null,
      damageBoostCardIds: Array.from(picked),
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
        {damageBoosts.map((cid) => (
          <label key={cid} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
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
            <CardHover G={G} cardId={cid}>{label(cid)}</CardHover> ({bonus(cid)} damage)
          </label>
        ))}
        {!cf && damageBoosts.length === 0 && (
          <span style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
            No playable tactic cards in hand.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={() => { setUseCF(false); setPicked(new Set()); submit(); }}
            style={btn('#2a2c33')}>Skip</button>
          <button onClick={submit} style={btn(SIDE_COLOR[choice.side])}>Apply</button>
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
  const sacrificeCandidates = choice.hand.filter((cid) => cid !== free && cid !== paid);
  const [useFree, setUseFree] = useState(false);
  const [usePaid, setUsePaid] = useState(false);
  const [sacrifice, setSacrifice] = useState<string | null>(sacrificeCandidates[0] ?? null);
  const label = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;

  const blocks: string[] = [];
  const sacs: string[] = [];
  if (useFree && free) blocks.push(free);
  if (usePaid && paid && sacrifice) { blocks.push(paid); sacs.push(sacrifice); }

  const submit = (b: string[], s: string[]) => {
    const r = combat.resolveCombatDefenderTactics(G, { blockCardIds: b, sacrificeCardIds: s });
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
            <input type="checkbox" checked={useFree} onChange={(e) => setUseFree(e.target.checked)} />
            <CardHover G={G} cardId={free}>{label(free)}</CardHover> (free block 1)
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
              <CardHover G={G} cardId={paid}>{label(paid)}</CardHover> (block 1, discard another)
            </label>
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
        {!free && !paid && (
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
            Block {blocks.length}
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
        <button onClick={() => submit(true)} style={btn('#2a2c33')} title="Keep One In A Million in hand">
          Skip
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
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Yoda reroll</b> ({holderName} is here) — pick one blank die to reroll, or skip.
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {choice.blankIndices.map((idx) => (
          <button key={idx} onClick={() => submit(idx)} style={btn(SIDE_COLOR.Rebel)}>
            Reroll die #{idx + 1}
          </button>
        ))}
        <button onClick={() => submit(null)} style={btn('#2a2c33')}>Skip</button>
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
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const spent = draws + picked.size;
  const submit = () => {
    const r = combat.resolveSpecialDieSpend(G, {
      draws,
      playCardIds: Array.from(picked),
    });
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const cardName = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Spend specials:</b> {choice.specialCount} ◈ available
        ({spent} / {max} spent).
        Each special draws 1 tactic card OR plays one special-requiring card.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
          Draws:
          <input
            type="number"
            min={0}
            max={max - picked.size}
            value={draws}
            onChange={(e) => setDraws(Math.max(0, Math.min(max - picked.size, Number(e.target.value) || 0)))}
            style={{ width: 50, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 4px' }}
          />
        </label>
        {choice.specialCards.length > 0 && <span style={{ color: '#aaa', fontSize: 11 }}>·</span>}
        {choice.specialCards.map((cid) => (
          <label key={cid} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
            <input
              type="checkbox"
              checked={picked.has(cid)}
              disabled={!picked.has(cid) && spent >= max}
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
        <div style={{ marginLeft: 'auto' }}>
          <button onClick={submit} disabled={spent > max} style={btn(SIDE_COLOR[choice.side])}>
            Apply ({spent} spent)
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
  const spaceLeft = G.spaceTacticDeck.length;
  const groundLeft = G.groundTacticDeck.length;
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>{card?.name ?? choice.cardId}:</b> draw 3 tactic cards from one deck — your choice.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          onClick={() => pick('space')}
          style={btn('#4fc3f7')}
          disabled={spaceLeft === 0}
          title={spaceLeft === 0 ? 'Space deck is empty' : `Draw 3 from ${spaceLeft} remaining space cards`}
        >
          ◇ Space ({spaceLeft} left)
        </button>
        <button
          onClick={() => pick('ground')}
          style={btn('#ffb74d')}
          disabled={groundLeft === 0}
          title={groundLeft === 0 ? 'Ground deck is empty' : `Draw 3 from ${groundLeft} remaining ground cards`}
        >
          ■ Ground ({groundLeft} left)
        </button>
      </div>
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
  const [dest, setDest] = useState<string | null>(choice.legalDestinations[0] ?? null);
  const submit = (destSystemId: string | null) => {
    const r = combat.resolveRetreatDecision(G, destSystemId, null);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };
  const sysName = (sid: string) => G.catalog.systems[sid]?.name ?? sid;

  // Compute who will survive vs die. Mirror the engine's retreat-transport
  // accounting: capital ships move free, restriction-icon fighters and ground
  // need transport capacity; immobile units always die; any unit not in the
  // selected move group is destroyed (RAW p.5-6).
  const ss = G.map.systems[choice.systemId];
  const ours = (ss?.units ?? []).filter((u) => u.side === choice.side);
  let capacity = 0;
  const willRetreat: typeof ours = [];
  const willDie: typeof ours = [];
  // First pass: capital ships go (they provide capacity).
  for (const u of ours) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.transport.immobile) { willDie.push(u); continue; }
    if (t.transport.capacity > 0) {
      willRetreat.push(u);
      capacity += t.transport.capacity;
    }
  }
  // Second pass: pack restriction/ground into available capacity.
  for (const u of ours) {
    const t = G.catalog.unitTypes[u.typeId];
    if (!t || t.transport.immobile) continue;
    if (t.transport.capacity > 0) continue;
    const needsTransport = t.transport.restriction
      || (t.theater === 'ground' && t.class !== 'structure');
    if (!needsTransport) {
      willRetreat.push(u);
    } else if (capacity > 0) {
      willRetreat.push(u);
      capacity--;
    } else {
      willDie.push(u);
    }
  }
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
        to a friendly adjacent system. (Once per combat.)
      </div>

      {(willRetreat.length > 0 || willDie.length > 0) && (
        <div style={{ marginBottom: 8, padding: 8, background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4, fontSize: 11 }}>
          {willRetreat.length > 0 && (
            <div style={{ color: '#80dc78', marginBottom: willDie.length > 0 ? 4 : 0 }}>
              <b>Will retreat ({willRetreat.length}):</b> {fmt(willRetreat)}
            </div>
          )}
          {willDie.length > 0 && (
            <div style={{ color: '#ff6b6b', fontWeight: 600 }}>
              <b>Will be DESTROYED ({willDie.length})</b> — no transport / immobile: {fmt(willDie)}
            </div>
          )}
          {willDie.length > 0 && (
            <div style={{ color: '#888', marginTop: 4, fontStyle: 'italic' }}>
              Per RAW: declaring retreat doesn't grant free movement — units that can't be transported are destroyed.
              Reconsider \"Stay and fight\" if these losses are unacceptable.
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
                style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 4px', fontSize: 12 }}
              >
                {choice.legalDestinations.map((sid) => (
                  <option key={sid} value={sid}>{sysName(sid)}</option>
                ))}
              </select>
            </label>
            <button onClick={() => submit(dest)} disabled={!dest} style={btn(SIDE_COLOR[choice.side])}>
              Retreat ({willRetreat.length} survive{willDie.length > 0 ? `, ${willDie.length} die` : ''})
            </button>
          </>
        )}
        <button onClick={() => submit(null)} style={btn('#2a2c33')}>Stay and fight</button>
      </div>
    </div>
  );
}

