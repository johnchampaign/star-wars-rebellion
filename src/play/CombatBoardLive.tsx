// Full-screen live combat board. Renders whenever G.pendingCombat is set;
// absorbs every in-combat decision (attacker tactics, defender tactics,
// damage assignment) so the player always has the unit / leader / dice
// context visible while making choices.
//
// Decisions still flow through G.pendingChoice — this component reads the
// kind and side, and only enables the decision panel when humanSide owns
// the choice. AI moves continue to auto-resolve via randomAI.ts.

import { useState } from 'react';
import type { GameState, Side, UnitInstance, Theater, DieResult } from '../engine/types';
import * as combat from '../engine/combat';

const SIDE_COLOR = { Rebel: '#4fc3f7', Empire: '#ff8a80' } as const;

export function CombatBoardLive({ G, humanSide, onPersist }: {
  G: GameState;
  humanSide: Side;
  onPersist: () => void;
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
    pc?.kind === 'SpecialDieSpend'       ? pc.side :
    pc?.kind === 'CombatStartActionCards' ? pc.side :
    pc?.kind === 'RetreatDecision'       ? pc.side : null;
  const isHumanDecision = decisionSide === humanSide;
  const waitingForAI = decisionSide !== null && !isHumanDecision;

  // Dice rolled by the in-flight attack (if any) — shown in the active theater.
  const dice: DieResult[] | null = c.pendingAttack?.dice ?? null;
  const activeTheater: Theater | null = c.pendingAttack?.theater ?? c.activeTheater ?? null;

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
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12, minHeight: 0 }}>
        <TheaterPanel
          G={G} c={c} theater="space"
          attacker={attacker} defender={defender}
          dice={activeTheater === 'space' ? dice : null}
          rolling={activeTheater === 'space' ? c.pendingAttack?.side ?? null : null}
        />
        <TheaterPanel
          G={G} c={c} theater="ground"
          attacker={attacker} defender={defender}
          dice={activeTheater === 'ground' ? dice : null}
          rolling={activeTheater === 'ground' ? c.pendingAttack?.side ?? null : null}
        />
      </div>

      {/* Decision strip — bottom row, fixed height. */}
      <div style={{
        marginTop: 12, padding: 14, background: '#15171c', borderRadius: 6,
        border: `2px solid ${decisionSide ? SIDE_COLOR[decisionSide] : '#3a3d44'}`,
        minHeight: 110,
      }}>
        {waitingForAI && (
          <div style={{ color: '#888', fontStyle: 'italic' }}>
            Waiting for {decisionSide} (AI) to choose…
          </div>
        )}
        {pc?.kind === 'CombatAttackerTactics' && isHumanDecision && (
          <AttackerTacticsPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatDefenderTactics' && isHumanDecision && (
          <DefenderTacticsPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatAssignDamage' && isHumanDecision && (
          <AssignDamagePanel G={G} choice={pc} c={c} onPersist={onPersist} />
        )}
        {pc?.kind === 'YodaReroll' && isHumanDecision && (
          <YodaRerollPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'SpecialDieSpend' && isHumanDecision && (
          <SpecialDieSpendPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'CombatStartActionCards' && isHumanDecision && (
          <StartOfCombatPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {pc?.kind === 'RetreatDecision' && isHumanDecision && (
          <RetreatPanel G={G} choice={pc} onPersist={onPersist} />
        )}
        {!pc && (
          <div style={{ color: '#666', fontStyle: 'italic' }}>
            Resolving — combat will pause here on the next decision.
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ systemName, attacker, defender, round, humanSide }: {
  systemName: string; attacker: Side; defender: Side; round: number; humanSide: Side;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 20, color: '#ffd54a' }}>Combat at {systemName}</h2>
      <div style={{ fontSize: 13, color: '#aaa' }}>
        <span style={{ color: SIDE_COLOR[attacker], fontWeight: 700 }}>{attacker}</span>
        {' '}attacks{' '}
        <span style={{ color: SIDE_COLOR[defender], fontWeight: 700 }}>{defender}</span>
      </div>
      <div style={{ marginLeft: 'auto', fontSize: 13, color: '#aaa' }}>
        You are <span style={{ color: SIDE_COLOR[humanSide], fontWeight: 700 }}>{humanSide}</span>
        {' · '}Round {round}
      </div>
    </div>
  );
}

function TheaterPanel({ G, c, theater, attacker, defender, dice, rolling }: {
  G: GameState; c: NonNullable<GameState['pendingCombat']>;
  theater: Theater; attacker: Side; defender: Side;
  dice: DieResult[] | null; rolling: Side | null;
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
        />
      </div>
    </div>
  );
}

function SidePanel({ G, side, units, leaderIds, align }: {
  G: GameState; side: Side; units: UnitInstance[]; leaderIds: string[]; align: 'left' | 'right';
}) {
  const color = SIDE_COLOR[side];
  // Group identical unit types and render damage on each instance individually.
  const grouped = new Map<string, UnitInstance[]>();
  for (const u of units) {
    const arr = grouped.get(u.typeId) ?? [];
    arr.push(u);
    grouped.set(u.typeId, arr);
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      gap: 4,
    }}>
      <div style={{ color, fontSize: 12, fontWeight: 700, marginBottom: 4 }}>{side}</div>
      {leaderIds.length > 0 && (
        <div style={{ fontSize: 11, color: '#ccc' }}>
          ★ {leaderIds.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
        </div>
      )}
      {grouped.size === 0 && (
        <div style={{ color: '#555', fontSize: 11, fontStyle: 'italic' }}>(no units)</div>
      )}
      {Array.from(grouped.entries()).map(([typeId, instances]) => {
        const t = G.catalog.unitTypes[typeId];
        const maxHp = t?.health.value ?? 1;
        return (
          <div key={typeId} style={{ fontSize: 12, color: '#e8e8ea', textAlign: align }}>
            <strong>{t?.name ?? typeId}</strong> ×{instances.length}
            {instances.some((u) => (u.damage ?? 0) > 0) && (
              <span style={{ marginLeft: 6, fontSize: 10, color: '#ff8a80' }}>
                {instances.map((u, i) => (
                  (u.damage ?? 0) > 0
                    ? <span key={i} style={{ marginRight: 4 }}>[{maxHp - (u.damage ?? 0)}/{maxHp}]</span>
                    : null
                ))}
              </span>
            )}
          </div>
        );
      })}
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
    cid.includes('take-it-down') ? '+2' :
    cid.includes('onslaught') ? '+2' :
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
            {label(cf)} (reroll ≤2 blanks)
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
            {label(cid)} ({bonus(cid)} damage)
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
            {label(free)} (free block 1)
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
              {label(paid)} (block 1, discard another)
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
          <button onClick={() => submit([], [])} style={btn('#2a2c33')}>Take all {choice.incomingHits}</button>
          <button onClick={() => submit(blocks, sacs)} disabled={blocks.length === 0}
            style={btn(blocks.length === 0 ? '#444' : SIDE_COLOR[choice.side])}>Block {blocks.length}</button>
        </div>
      </div>
    </div>
  );
}

function AssignDamagePanel({ G, choice, c, onPersist }: {
  G: GameState;
  choice: Extract<NonNullable<GameState['pendingChoice']>, { kind: 'CombatAssignDamage' }>;
  c: NonNullable<GameState['pendingCombat']>;
  onPersist: () => void;
}) {
  // Pre-fill assignments with the AI heuristic (weakest unit first) so the
  // human can just click Submit to accept defaults — keeps fast play fast.
  const [assignments, setAssignments] = useState<(string | null)[]>(() => {
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
    const queued = new Map<string, number>();
    return choice.hits.map((_, i) => {
      const targets = choice.targetsByHit[i];
      let best: { id: string; remaining: number; tier: number } | null = null;
      for (const tid of targets) {
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
        return best.id;
      }
      return null;
    });
  });

  const unitLabel = (instanceId: string): string => {
    const ss = G.map.systems[c.systemId] ?? G.map.rebelBaseSpace;
    const u = ss?.units.find((x: UnitInstance) => x.instanceId === instanceId);
    if (!u) return instanceId.slice(0, 6);
    const t = G.catalog.unitTypes[u.typeId];
    return `${t?.name ?? u.typeId}${(u.damage ?? 0) > 0 ? ` (${(t?.health.value ?? 1) - (u.damage ?? 0)} hp)` : ''}`;
  };

  const submit = () => {
    const r = combat.resolveCombatAssignDamage(G, assignments);
    if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
    onPersist();
  };

  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 8 }}>
        <b>Assign damage:</b> pick which defender unit takes each hit.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 60, overflowY: 'auto' }}>
        {choice.hits.map((h, i) => {
          const opts = choice.targetsByHit[i];
          return (
            <div key={i} style={{
              background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 3,
              padding: '4px 6px', fontSize: 11,
              display: 'flex', flexDirection: 'column', gap: 2,
            }}>
              <span style={{ color: '#aaa' }}>
                <Die d={{ color: (h.color ?? 'black') as DieResult['color'], face: h.face }} />
              </span>
              {opts.length === 0 ? (
                <span style={{ color: '#555' }}>(no legal target)</span>
              ) : (
                <select
                  value={assignments[i] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setAssignments((prev) => {
                      const next = [...prev];
                      next[i] = v;
                      return next;
                    });
                  }}
                  style={{ background: '#15171c', color: '#fff', border: '1px solid #555', fontSize: 11, padding: '2px 4px' }}
                >
                  <option value="">(skip)</option>
                  {opts.map((tid) => (
                    <option key={tid} value={tid}>{unitLabel(tid)}</option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 8, textAlign: 'right' }}>
        <button onClick={submit} style={btn(SIDE_COLOR[choice.side])}>Apply damage</button>
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
            {cardName(cid)}
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
              {cardName(cid)}
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
  return (
    <div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        <b>Retreat?</b> {choice.availableUnits.length} unit{choice.availableUnits.length === 1 ? '' : 's'} can withdraw
        to a friendly adjacent system. (Once per combat.)
      </div>
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
              Retreat all
            </button>
          </>
        )}
        <button onClick={() => submit(null)} style={btn('#2a2c33')}>Stay and fight</button>
      </div>
    </div>
  );
}

