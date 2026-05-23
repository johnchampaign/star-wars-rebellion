// Play tab — minimal hot-seat shell wrapping the pure engine directly.
// Includes: state persistence in localStorage, completed-game history,
// and a "Report a problem" dialog that produces a downloadable JSON.

import { useEffect, useRef, useState, useCallback, useMemo, createContext, useContext } from 'react';
import { loadAllForEngine, loadBoardMask, MAP_IMAGE_URL, MARKER_IMAGE_BASE, UNIT_IMAGE_BASE, LEADER_IMAGE_BASE, CARD_IMAGE_BASE, diceImageUrl } from '../data/loadAssets';
import { UNIT_IMAGE, groupByType, groupTypeIds, getUnitStyle, setUnitStyle, nextStyle, unitImageUrl, type UnitImageStyle } from './unitImages';
import { missionTargets } from '../engine/missionTargets';
import { stepOnce as aiStepOnce } from './randomAI';

const LS_HUMAN_SIDE = 'rebellion-human-side';
function randomSide(): Side { return Math.random() < 0.5 ? 'Rebel' : 'Empire'; }
function otherSide(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }

// Context so helper components can read the current style without prop drilling.
const UnitStyleContext = createContext<UnitImageStyle>('vmod');
const useUnitStyle = () => useContext(UnitStyleContext);
import { createGame } from '../engine/setup';
import * as phases from '../engine/phases';
import * as combat from '../engine/combat';
import { CombatBoardLive } from './CombatBoardLive';
import { encode, decode, canEncode } from '../engine/codec';
import type { GameState, Side } from '../engine/types';
import type { System, MaskRect } from '../types';

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1200;
const DISPLAY_H = 600;
const SCALE = DISPLAY_W / NATIVE_W;
const MARKER_R = 16;

const LS_CURRENT = 'rebellion-game-current';
const LS_HISTORY = 'rebellion-games-history';
const HISTORY_CAP = 20;

function sideColor(s: Side): string {
  return s === 'Rebel' ? '#aae0ff' : '#ffaaaa';
}

/** Does the given side own the current pendingChoice? Used by runAILoop
 *  to decide whether to wake the AI when the choice fires during the
 *  HUMAN's turn (e.g. Empire reveals a mission and Rebel auto-resolves
 *  the opposition; AI builds during refresh; etc.). */
function aiOwesChoice(G: GameState, side: Side): boolean {
  const pc = G.pendingChoice;
  if (!pc) return false;
  switch (pc.kind) {
    case 'OpposeMission':            return pc.opposerSide === side;
    case 'BuildPick':                return pc.side === side;
    case 'CombatAttackerTactics':    return pc.side === side;
    case 'CombatDefenderTactics':    return pc.side === side;
    case 'CombatAssignDamage':       return pc.side === side;
    case 'YodaReroll':               return pc.side === side;
    case 'SpecialDieSpend':          return pc.side === side;
    case 'CombatStartActionCards':   return pc.side === side;
    case 'RetreatDecision':          return pc.side === side;
    // Infiltration / Stolen Plans / Plan The Assault are always Rebel choices.
    case 'InfiltrationPick':         return side === 'Rebel';
    case 'StolenPlansReorder':       return side === 'Rebel';
    case 'PlanTheAssaultShips':      return side === 'Rebel';
    case 'CovertOperationPick':      return side === 'Rebel';
    case 'OverseeProjectPick':       return pc.side === side;
    case 'CaptureOperativePick':     return pc.side === side;
    case 'CarbonFreezingPick':       return pc.side === side;
    case 'LureOfTheDarkSidePick':    return pc.side === side;
    case 'HomingBeaconPlace':        return pc.side === side;
    case 'DestroyUpToHealth':        return pc.side === side;
    case 'RogueSquadronRaidPick':    return pc.side === side;
    case 'DoubleOurEffortsPick':     return pc.side === side;
    case 'PlanetaryConquestSourcePick': return pc.side === side;
    case 'FearWillKeepThemInLinePick':  return pc.side === side;
    case 'PublicUprisingPick':       return pc.side === side;
    case 'SupportOfMonCalamariPick': return pc.side === side;
    case 'MisdirectionPick':         return pc.side === side;
    // Other ChoiceRequest kinds (system / leader picks, etc.) are
    // human-initiated and shouldn't auto-fire the AI loop.
    default:                         return false;
  }
}

export default function PlayTab() {
  const gameRef = useRef<GameState | null>(null);
  const dataRef = useRef<Awaited<ReturnType<typeof loadAllForEngine>> | null>(null);
  const systemsRef = useRef<System[]>([]);
  const masksRef = useRef<MaskRect[]>([]);
  const [, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<string>('');
  const [hasSaved, setHasSaved] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportScreenshot, setReportScreenshot] = useState<string | null>(null);
  const [showUploadLogs, setShowUploadLogs] = useState(false);
  const [unitStyle, setUnitStyleState] = useState<UnitImageStyle>(getUnitStyle());
  const [humanSide, setHumanSide] = useState<Side>(() => {
    const stored = localStorage.getItem(LS_HUMAN_SIDE);
    return stored === 'Rebel' || stored === 'Empire' ? stored : 'Rebel';
  });
  const aiSide = otherSide(humanSide);
  // True while the Empire player is hovering the probe-deck UI; Board uses
  // this to highlight systems already ruled out by drawn probe cards.
  const [probeHover, setProbeHover] = useState(false);
  const toggleUnitStyle = () => {
    const next = nextStyle(unitStyle);
    setUnitStyle(next);
    setUnitStyleState(next);
  };

  /** Drive the AI synchronously: keep stepping until either it's the human's
   *  turn AND no AI-owed pending choice remains, the game ends, or the AI
   *  reports it has nothing to do. One setTick at the end produces one
   *  render covering all AI actions in the burst — simpler than per-step
   *  timeouts and immune to Strict Mode timer cancellation races. */
  const runAILoop = useCallback(() => {
    const G0 = gameRef.current;
    if (!G0 || G0.isGameOver) return;
    const human = (localStorage.getItem(LS_HUMAN_SIDE) === 'Empire') ? 'Empire' : 'Rebel';
    const ai: Side = human === 'Rebel' ? 'Empire' : 'Rebel';
    let didAny = false;
    // Safety cap so a buggy AI can't lock the tab.
    for (let safety = 0; safety < 500; safety++) {
      const Gn = gameRef.current;
      if (!Gn || Gn.isGameOver) break;
      const owes = aiOwesChoice(Gn, ai);
      // AI acts when it's its turn, OR when it owes ANY pending choice
      // (opposition, combat tactics, build picks, retreat, etc.). If we
      // don't fire here the game silently locks because nothing else
      // will ever resolve an AI-owned choice posted on the human's turn.
      if (Gn.currentPlayer !== ai && !owes) break;
      let did = false;
      try {
        did = aiStepOnce(Gn, ai);
      } catch (e) {
        console.error('[ai] step threw', e);
        break;
      }
      if (!did) break;
      didAny = true;
    }
    if (didAny) {
      try {
        const Gf = gameRef.current;
        if (Gf && canEncode(Gf)) localStorage.setItem(LS_CURRENT, encode(Gf));
      } catch { /* ignore */ }
      setTick((t) => t + 1);
    }
  }, []);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    runAILoop();
  }, [runAILoop]);

  // Persist current game state after every action.
  const persist = useCallback(() => {
    const G = gameRef.current;
    if (!G) return;
    try {
      if (canEncode(G)) {
        localStorage.setItem(LS_CURRENT, encode(G));
        setHasSaved(true);
      }
      // If game ended, also push to history.
      if (G.isGameOver) {
        archiveCompletedGame(G);
        localStorage.removeItem(LS_CURRENT);
      }
    } catch (e) {
      console.warn('persist failed', e);
    }
    // Dev-only: mirror state to ./game-logs/latest.json via the vite plugin
    // so the agent can read it on demand. Fire-and-forget; failures are
    // silent (the plugin is only present in `vite dev`).
    try {
      if (import.meta.env.DEV) {
        // Strip catalog (huge + static) before sending — agent can re-derive
        // any catalog lookups from assets/. Send the log + dynamic state.
        const { catalog: _catalog, ...slim } = G as Record<string, unknown>;
        void fetch('/__game-dump', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slim, null, 2),
        }).catch(() => { /* ignore */ });
      }
    } catch { /* ignore */ }
  }, []);

  // Load JSON data once.
  useEffect(() => {
    Promise.all([loadAllForEngine(), loadBoardMask()])
      .then(([d, mask]) => {
        dataRef.current = d;
        systemsRef.current = d.systems.systems;
        masksRef.current = mask.masks;
        setHasSaved(localStorage.getItem(LS_CURRENT) !== null);
        refresh();
      })
      .catch((e) => setError(String(e)));
  }, [refresh]);

  const startNew = useCallback(() => {
    if (!dataRef.current) return;
    const trimmed = seed.trim();
    const s = trimmed === '' ? Math.floor(Math.random() * 1e9) : Number(trimmed);
    if (Number.isNaN(s)) return;
    gameRef.current = createGame(dataRef.current, { seed: s, autoSetupUnits: false });
    // Randomly assign human side for this game.
    const newHuman = randomSide();
    localStorage.setItem(LS_HUMAN_SIDE, newHuman);
    setHumanSide(newHuman);
    persist();
    refresh();
  }, [seed, refresh, persist]);

  const resumeSaved = useCallback(() => {
    const raw = localStorage.getItem(LS_CURRENT);
    if (!raw || !dataRef.current) return;
    try {
      // Build a catalog the same way setup does — but we need it without re-running setup.
      // Simplest: create a fresh game to harvest the catalog, then decode into it.
      const fresh = createGame(dataRef.current, { seed: 1 });
      const restored = decode(raw, fresh.catalog);
      gameRef.current = restored;
      refresh();
    } catch (e) {
      setError(`Failed to restore saved game: ${String(e)}. Starting fresh might help.`);
    }
  }, [refresh]);

  const discardSaved = useCallback(() => {
    localStorage.removeItem(LS_CURRENT);
    setHasSaved(false);
    refresh();
  }, [refresh]);

  const G = gameRef.current;

  // (AI driver moved into refresh() / runAILoop() above — a useEffect-based
  // driver was racing with Strict Mode's effect-cleanup cycle.)
  // Re-arm the AI loop on initial render after data loads.
  useEffect(() => { runAILoop(); }, [runAILoop]);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!dataRef.current) return <div className="placeholder">Loading data…</div>;

  if (!G) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>Play</h2>
        <div className="placeholder">
          <p>No game in progress.</p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
            <label style={{ color: '#aaa', fontSize: 13 }}>
              Seed (blank = random):{' '}
              <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="random" style={inputStyle} />
            </label>
            <button className="tab-button active" onClick={startNew}>Start new game</button>
            {hasSaved && (
              <>
                <button className="tab-button" onClick={resumeSaved}>Resume saved game</button>
                <button className="tab-button" onClick={discardSaved}>Discard saved</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------- Action handlers ----------

  const onSkipAssignment = () => {
    if (!G) return;
    phases.skipAssignment(G, G.currentPlayer);
    persist();
    refresh();
  };

  const onPass = () => {
    if (!G) return;
    phases.pass(G, G.currentPlayer);
    persist();
    refresh();
  };

  const onActivateSystem = (
    leaderId: string, targetSystemId: string, moveOrders: phases.MoveOrder[],
  ) => {
    if (!G) return;
    const r = phases.activateSystem(G, G.currentPlayer, leaderId, targetSystemId, moveOrders);
    if (!r.ok) {
      alert(`Cannot activate: ${r.reason}`);
      return false;
    }
    persist();
    refresh();
    return true;
  };

  const onRevealMission = (missionId: string, targetSystemId: string) => {
    if (!G) return false;
    const r = phases.revealMission(G, G.currentPlayer, missionId, targetSystemId);
    if (!r.ok) {
      alert(`Cannot reveal: ${r.reason}`);
      return false;
    }
    persist();
    refresh();
    return true;
  };

  const onPickRebelBase = (systemId: string) => {
    if (!G) return;
    const r = phases.pickRebelBase(G, systemId);
    if (!r.ok) { alert(`Cannot pick: ${r.reason}`); return; }
    persist();
    refresh();
  };

  const onSetupAutoFill = (side: Side) => {
    if (!G) return;
    phases.setupAutoFill(G, side);
    persist();
    refresh();
  };

  const onSetupDeploy = (side: Side, typeId: string, systemId: string) => {
    if (!G) return;
    const r = phases.setupDeployUnit(G, side, typeId, systemId);
    if (!r.ok) alert(`Cannot deploy: ${r.reason}`);
    persist();
    refresh();
  };

  // ---------- Render ----------

  return (
    <UnitStyleContext.Provider value={unitStyle}>
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Play</h2>
        <span style={{ color: '#888', fontSize: 13 }}>
          Round {G.timeMarker} · {G.phase} ·{' '}
          <span style={{ color: sideColor(G.currentPlayer), fontWeight: 600 }}>
            {G.currentPlayer}'s turn
          </span>{' '}
          · Reputation {G.reputationMarker} ·{' '}
          <span style={{ color: sideColor(humanSide), fontWeight: 600 }}>
            you are {humanSide}
          </span>{' '}
          <span style={{ color: '#888' }}>(AI: {aiSide})</span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button className="tab-button" onClick={toggleUnitStyle} title="Toggle between Vassal mini photos and reference-sheet silhouettes">
            units: {unitStyle}
          </button>
          <button
            className="tab-button"
            onClick={async () => {
              // Capture before mounting the modal so the screenshot
              // shows the underlying game state, not the modal itself.
              const { capturePageScreenshot } = await import('./screenshot');
              const png = await capturePageScreenshot();
              setReportScreenshot(png);
              setShowReport(true);
            }}
            title="Report a bug or share feedback"
          >
            Report a problem
          </button>
          <button
            className="tab-button"
            onClick={() => setShowUploadLogs(true)}
            title="Upload your game logs to help train the AI"
          >
            Upload logs
          </button>
          <button className="tab-button" onClick={startNew}>New game</button>
          {G.phase === 'Setup' && (
            <button className="tab-button" onClick={() => onSetupAutoFill(G.currentPlayer)}>
              {G.currentPlayer} auto-fill remaining
            </button>
          )}
          {G.phase === 'Assignment' && G.currentPlayer === humanSide && (
            <button
              className="tab-button active"
              onClick={onSkipAssignment}
              style={{ fontWeight: 700 }}
            >
              {G.currentPlayer} done assigning
            </button>
          )}
          {G.phase === 'Command' && (
            <button className="tab-button" onClick={onPass}>
              {G.currentPlayer} pass
            </button>
          )}
        </span>
      </div>

      {G.isGameOver && (
        <div style={{
          padding: 16, marginBottom: 12, borderRadius: 4,
          background: G.winner === 'Rebel' ? '#1a3a4a' : '#3a1a1a',
          border: `2px solid ${G.winner ? sideColor(G.winner) : '#888'}`,
        }}>
          <strong style={{ color: G.winner ? sideColor(G.winner) : '#fff', fontSize: 18 }}>
            {G.winner} wins!
          </strong>{' '}
          <span style={{ color: '#aaa' }}>reason: {G.winReason}</span>
        </div>
      )}

      <TurnTrack G={G} />
      <DecksPanel
        G={G}
        onProbeHover={humanSide === 'Empire' ? setProbeHover : undefined}
      />

      <Board
        G={G}
        systems={systemsRef.current}
        masks={masksRef.current}
        eliminatedSystemIds={
          probeHover && humanSide === 'Empire'
            ? new Set((G.empire.probeHand ?? [])
                .map((pid) => G.catalog.probes[pid]?.systemId)
                .filter((s): s is string => !!s))
            : null
        }
      />

      {G.phase === 'Setup' && !G.isGameOver && G.pendingRebelBasePick && humanSide === 'Rebel' && (
        <RebelBasePickPanel G={G} onPick={onPickRebelBase} />
      )}

      {G.phase === 'Setup' && !G.isGameOver && G.pendingDeployment && (
        <SetupPanel
          G={G}
          side={G.currentPlayer}
          onDeploy={onSetupDeploy}
          onAutoFill={onSetupAutoFill}
        />
      )}

      {G.phase === 'Assignment' && !G.isGameOver && (
        <AssignmentPanel G={G} side={G.currentPlayer} onChange={() => { persist(); refresh(); }} />
      )}

      {G.phase === 'Command' && !G.isGameOver && G.currentPlayer === humanSide && (
        <CommandPanel
          G={G}
          side={G.currentPlayer}
          onActivate={onActivateSystem}
          onReveal={onRevealMission}
          onPass={onPass}
        />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <FactionPanel G={G} side="Rebel" humanSide={humanSide} />
        <FactionPanel G={G} side="Empire" humanSide={humanSide} />
      </div>

      <LogPanel G={G} />

      {showReport && (
        <ReportProblemModal
          G={G}
          screenshotBase64={reportScreenshot}
          onClose={() => { setShowReport(false); setReportScreenshot(null); }}
        />
      )}
      {showUploadLogs && (
        <UploadLogsDialog
          onClose={() => setShowUploadLogs(false)}
        />
      )}

      {G.pendingNotices && G.pendingNotices.length > 0 && (
        <NotImplementedModal
          notices={G.pendingNotices}
          onDismiss={() => { if (G) G.pendingNotices = []; persist(); refresh(); }}
        />
      )}

      {G.combatReports && G.combatReports.length > 0 && (
        <CombatReportModal
          G={G}
          report={G.combatReports[0]}
          onDismiss={() => { if (G && G.combatReports) G.combatReports.shift(); persist(); refresh(); }}
        />
      )}

      {G.missionReports && G.missionReports.length > 0 && (
        <MissionReportModal
          G={G}
          report={G.missionReports[0]}
          onDismiss={() => { if (G && G.missionReports) G.missionReports.shift(); persist(); refresh(); }}
        />
      )}

      {G.refreshReports && G.refreshReports.length > 0
        && (!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0) && (
        <RefreshReportModal
          G={G}
          report={G.refreshReports[0]}
          humanSide={humanSide}
          onDismiss={() => { if (G && G.refreshReports) G.refreshReports.shift(); persist(); refresh(); }}
        />
      )}

      {/* Sub-choice modals: only render when no report is queued in front,
         so the player sees the mission's report FIRST and then chooses. */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlanTheAssaultShips'
        && humanSide === 'Rebel' && (
        <PlanTheAssaultShipsModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(shipIds) => {
            const r = phases.resolvePlanTheAssaultShips(G, shipIds);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'OverseeProjectPick'
        && humanSide === 'Empire' && (
        <OverseeProjectPickModal
          G={G}
          choice={G.pendingChoice}
          onPick={(qi, slot) => {
            const r = phases.resolveOverseeProjectPick(G, qi, slot);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'CaptureOperativePick'
        && humanSide === 'Empire' && (
        <SimpleLeaderPickModal
          G={G}
          color="#ffaaaa"
          title="Capture Rebel Operative — pick a leader to capture"
          candidates={G.pendingChoice.candidates}
          onPick={(lid) => {
            const r = phases.resolveCaptureOperativePick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'CarbonFreezingPick'
        && humanSide === 'Empire' && (
        <SimpleLeaderPickModal
          G={G}
          color="#ffaaaa"
          title="Carbon Freezing — pick a captured leader to freeze"
          candidates={G.pendingChoice.candidates}
          onPick={(lid) => {
            const r = phases.resolveCarbonFreezingPick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'LureOfTheDarkSidePick'
        && humanSide === 'Empire' && (
        <SimpleLeaderPickModal
          G={G}
          color="#ffaaaa"
          title="Lure Of The Dark Side — pick a captured leader to flip"
          candidates={G.pendingChoice.candidates}
          onPick={(lid) => {
            const r = phases.resolveLureOfTheDarkSidePick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {/* ----- Bulk-added card-choice modals (task #96) ----- */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DestroyUpToHealth'
        && G.pendingChoice.side === humanSide && (
        <DestroyUpToHealthModal G={G} choice={G.pendingChoice}
          onSubmit={(ids) => { const r = phases.resolveDestroyUpToHealth(G, ids); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RogueSquadronRaidPick'
        && G.pendingChoice.side === humanSide && (
        <RogueSquadronRaidModal G={G} choice={G.pendingChoice}
          onSubmit={(picks) => { const r = phases.resolveRogueSquadronRaidPick(G, picks); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DoubleOurEffortsPick'
        && G.pendingChoice.side === humanSide && (
        <DoubleOurEffortsModal G={G} choice={G.pendingChoice}
          onSubmit={(picks) => { const r = phases.resolveDoubleOurEffortsPick(G, picks); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlanetaryConquestSourcePick'
        && G.pendingChoice.side === humanSide && (
        <PlanetaryConquestModal G={G} choice={G.pendingChoice}
          onPick={(sid) => { const r = phases.resolvePlanetaryConquestSourcePick(G, sid); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'FearWillKeepThemInLinePick'
        && G.pendingChoice.side === humanSide && (
        <SystemMultiPickModal G={G} choice={G.pendingChoice}
          title="Fear Will Keep Them In Line — pick 2 systems in this region to gain loyalty"
          color="#ffaaaa"
          onSubmit={(ids) => { const r = phases.resolveFearWillKeepThemInLinePick(G, ids); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PublicUprisingPick'
        && G.pendingChoice.side === humanSide && (
        <PublicUprisingModal G={G} choice={G.pendingChoice}
          onSubmit={(p) => { const r = phases.resolvePublicUprisingPick(G, p); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'SupportOfMonCalamariPick'
        && G.pendingChoice.side === humanSide && (
        <SupportOfMonCalamariModal G={G} choice={G.pendingChoice}
          onPick={(opt) => { const r = phases.resolveSupportOfMonCalamariPick(G, opt); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'MisdirectionPick'
        && G.pendingChoice.side === humanSide && (
        <SimpleLeaderPickModal G={G} color="#aae0ff"
          title="Misdirection — pick a Rebel leader to protect"
          candidates={G.pendingChoice.candidates}
          onPick={(lid) => { const r = phases.resolveMisdirectionPick(G, lid); if (!r.ok) alert(`Cannot resolve: ${r.reason}`); persist(); refresh(); }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'HomingBeaconPlace'
        && humanSide === 'Empire' && (
        <HomingBeaconPlaceModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(lid, sid) => {
            const r = phases.resolveHomingBeaconPlace(G, lid, sid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'CovertOperationPick'
        && humanSide === 'Rebel' && (
        <CovertOperationPickModal
          G={G}
          choice={G.pendingChoice}
          onPick={(keepId) => {
            const r = phases.resolveCovertOperationPick(G, keepId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'InfiltrationPick'
        && (G.pendingMission?.resolverSide === humanSide) && (
        <InfiltrationPickModal
          G={G}
          choice={G.pendingChoice}
          onPick={(keepId) => {
            const r = phases.resolveInfiltrationPick(G, keepId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'StolenPlansReorder'
        && humanSide === 'Rebel' && (
        <StolenPlansReorderModal
          G={G}
          choice={G.pendingChoice}
          onPick={(cardId) => {
            const r = phases.resolveStolenPlansPick(G, cardId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {G.pendingChoice?.kind === 'OpposeMission' && G.pendingChoice.opposerSide === humanSide
        && (!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && (!G.refreshReports || G.refreshReports.length === 0) && (
        <OpposeMissionModal
          G={G}
          choice={G.pendingChoice}
          onResolve={(leaderId) => {
            const r = phases.resolveOpposition(G, leaderId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {/* The live combat board absorbs all in-combat decisions — attacker
          tactics, defender tactics, damage assignment. Renders whenever
          combat is active (G.pendingCombat set) so the player can see
          units / leaders / dice / hands continuously. */}
      {G.pendingCombat && (
        <CombatBoardLive
          G={G}
          humanSide={humanSide}
          onPersist={() => { persist(); refresh(); }}
        />
      )}

      {G.pendingChoice?.kind === 'BuildPick' && G.pendingChoice.side === humanSide
        && (!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && (!G.refreshReports || G.refreshReports.length === 0) && (
        <BuildPickModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(choices) => {
            const r = phases.resolveBuildPicks(G, choices);
            if (!r.ok) alert(`Cannot resolve build: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

    </div>
    </UnitStyleContext.Provider>
  );
}

// ============================================================================
// "Not yet implemented" modal — surfaces engine notImplemented() calls
// ============================================================================

// ============================================================================
// Oppose Mission Modal — opposing player picks whether (and how) to oppose
// ============================================================================

function OpposeMissionModal({ G, choice, onResolve }: {
  G: GameState;
  choice: {
    kind: 'OpposeMission';
    missionId: string;
    targetSystemId: string;
    opposerSide: Side;
    skill: string;
    attackerDice: number;
    poolLeaders: string[];
    existingAtTarget: string[];
  };
  onResolve: (opposerLeaderId: string | null) => void;
}) {
  const card = G.catalog.missions[choice.missionId];
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const color = sideColor(choice.opposerSide);
  const existingDice = choice.existingAtTarget.reduce((acc, lid) => {
    const ld = G.catalog.leaders[lid];
    return acc + (ld ? (ld.skills as Record<string, number>)[choice.skill] ?? 0 : 0);
  }, 0);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 6 }}>
          {choice.opposerSide} — oppose mission?
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>
          <strong style={{ color: '#fff' }}>{card?.name ?? choice.missionId}</strong> at <strong style={{ color: '#ffd54a' }}>{targetName}</strong>
          {' '}— attacker will roll <strong style={{ color: '#fff' }}>{choice.attackerDice}</strong> {choice.skill} dice.
        </div>

        {choice.existingAtTarget.length > 0 && (
          <div style={{ fontSize: 12, color: '#80dc78', marginBottom: 8 }}>
            ✓ Existing leaders at {targetName} will already oppose:
            {' '}{choice.existingAtTarget.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
            {' '}({existingDice} {choice.skill} dice). Sending another leader is optional.
          </div>
        )}
        {choice.existingAtTarget.length === 0 && (
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>
            No opposer leaders at {targetName}. The attacker will roll {choice.attackerDice}
            {' '}dice either way; sending a matching-skill leader gives you dice to roll back.
            Sending a 0-skill leader rolls 0 dice for you, but the attacker still has to
            beat 0 hits (so they fail if they roll all blanks).
          </div>
        )}

        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
          Pool leaders available to send:
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
          {choice.poolLeaders.length === 0 && (
            <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>(pool empty)</div>
          )}
          {choice.poolLeaders.map((lid) => {
            const ld = G.catalog.leaders[lid];
            if (!ld) return null;
            const match = (ld.skills as Record<string, number>)[choice.skill] ?? 0;
            return (
              <button
                key={lid}
                onClick={() => onResolve(lid)}
                style={{
                  padding: '6px 10px',
                  background: '#0c0d10',
                  border: `1px solid ${match > 0 ? color : '#2a2d34'}`,
                  color: '#e8e8ea',
                  borderRadius: 3, cursor: 'pointer', fontSize: 12,
                }}
                title={`Send ${ld.name} to ${targetName} to oppose`}
              >
                <strong>{ld.name}</strong>
                <span style={{ marginLeft: 6, color: match > 0 ? color : '#888', fontSize: 11 }}>
                  {choice.skill} {match} {match > 0 ? `· adds ${match} ${choice.skill} dice` : '· 0 dice (forces roll only)'}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="tab-button active"
            onClick={() => onResolve(null)}
            style={{ fontWeight: 700 }}
          >
            {choice.existingAtTarget.length > 0 ? "Don't send extra (use existing only)" : "Don't oppose (attacker rolls unopposed)"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Stolen Plans Reorder Modal — Rebel sees top 4 objectives, picks order
// ============================================================================

function StolenPlansReorderModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'StolenPlansReorder'; remaining: string[]; orderedTop: string[] };
  onPick: (cardId: string) => void;
}) {
  const totalCount = choice.remaining.length + choice.orderedTop.length;
  const nextSlot = choice.orderedTop.length + 1; // 1-based for display
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 760, width: '94%',
        maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Stolen Plans — pick the order for the top {totalCount} objectives
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Choose which card goes at <strong style={{ color: '#ffd54a' }}>position {nextSlot}</strong> from
          the top. Position 1 is drawn next Refresh; you'll keep picking until all are ordered.
        </div>

        {choice.orderedTop.length > 0 && (
          <div style={{ marginBottom: 12, padding: 8, background: '#0c1a14', borderRadius: 4, border: '1px solid #2a5a3a' }}>
            <div style={{ fontSize: 11, color: '#80dc78', marginBottom: 4, fontWeight: 600 }}>
              Order so far (top → bottom of what gets placed):
            </div>
            <ol style={{ margin: 0, paddingLeft: 18, color: '#e8e8ea' }}>
              {choice.orderedTop.map((cid) => {
                const o = G.catalog.objectives[cid];
                return (
                  <li key={cid} style={{ fontSize: 12 }}>
                    {o?.name ?? cid}{' '}
                    <span style={{ color: '#ffd54a' }}>+{o?.reputation ?? 0}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>Remaining cards:</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
          {choice.remaining.map((cid) => {
            const o = G.catalog.objectives[cid];
            return (
              <button
                key={cid}
                onClick={() => onPick(cid)}
                style={{
                  textAlign: 'left',
                  padding: 10,
                  background: '#0c0d10',
                  border: '1px solid #2a2d34',
                  color: '#e8e8ea', borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
                  <strong style={{ fontSize: 13 }}>{o?.name ?? cid}</strong>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#ffd54a', fontWeight: 700 }}>
                    +{o?.reputation ?? 0} reputation
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#aaa', lineHeight: 1.4 }}>{o?.rulesText ?? ''}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Refresh Phase Report Modal — what happened during the auto-refresh
// ============================================================================

function RefreshReportModal({ G, report, humanSide, onDismiss }: {
  G: GameState;
  report: import('../engine/types').RefreshReport;
  humanSide: Side;
  onDismiss: () => void;
}) {
  const cat = G.catalog;
  const ld = (lid: string) => cat.leaders[lid]?.name ?? lid;
  const sys = (sid: string) => sid === 'rebel-base' ? 'Rebel Base' : (cat.systems[sid]?.name ?? sid);
  const unit = (tid: string) => cat.unitTypes[tid]?.name ?? tid;
  const mission = (mid: string) => cat.missions[mid]?.name ?? mid;
  const obj = (oid: string) => cat.objectives[oid]?.name ?? oid;
  const probe = (pid: string) => cat.probes[pid]?.systemName ?? pid;

  const side = report.side;
  const sideC = sideColor(side);
  const isMine = side === humanSide;

  // Group this side's builds by source system: "Mon Cal: X-Wing, Y-Wing"
  const groupedBuilds = new Map<string, string[]>();
  for (const b of report.builds) {
    const arr = groupedBuilds.get(b.systemId) ?? [];
    arr.push(unit(b.unitTypeId));
    groupedBuilds.set(b.systemId, arr);
  }

  // Group deploys by destination system.
  const groupedDeploys = new Map<string, string[]>();
  for (const d of report.deployed) {
    const arr = groupedDeploys.get(d.systemId) ?? [];
    arr.push(unit(d.unitTypeId));
    groupedDeploys.set(d.systemId, arr);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${sideC}`, borderRadius: 6,
        padding: 22, maxWidth: 640, width: '92%', maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 16, color: sideC, fontWeight: 700, marginBottom: 8 }}>
          Refresh — {side} side, Turn {report.newTurn}
        </div>

        <Section title="Leaders retrieved">
          {report.retrievedLeaders.length === 0
            ? <Quiet>(none — log doesn't yet record retrieved IDs)</Quiet>
            : <div>{report.retrievedLeaders.map(ld).join(', ')}</div>}
        </Section>

        <Section title="Mission cards drawn">
          {report.missionsDrawn.count === 0
            ? <Quiet>(none)</Quiet>
            : (
              <div>
                {report.missionsDrawn.count} drawn
                {isMine && report.missionsDrawn.missionIds.length > 0 && (
                  <span style={{ color: '#aaa', fontSize: 12 }}>
                    {' '}— {report.missionsDrawn.missionIds.map(mission).join(', ')}
                  </span>
                )}
                {!isMine && (
                  <span style={{ color: '#666', fontSize: 12 }}> (hidden from you)</span>
                )}
              </div>
            )}
        </Section>

        {side === 'Empire' && (
          <Section title="Probe cards drawn">
            {report.probesDrawn.count === 0
              ? <Quiet>(none)</Quiet>
              : (
                <div>
                  {report.probesDrawn.count} drawn
                  {isMine && report.probesDrawn.probeIds.length > 0 && (
                    <span style={{ color: '#aaa', fontSize: 12 }}>
                      {' '}— ruled out: {report.probesDrawn.probeIds.map(probe).join(', ')}
                    </span>
                  )}
                  {!isMine && (
                    <span style={{ color: '#666', fontSize: 12 }}> (kept secret by the Empire)</span>
                  )}
                </div>
              )}
          </Section>
        )}

        {side === 'Rebel' && (
          <Section title="Objective drawn">
            {report.objectivesDrawn.count === 0
              ? <Quiet>(none)</Quiet>
              : (
                <div>
                  {isMine
                    ? report.objectivesDrawn.objectiveIds.map((oid) => (
                        <div key={oid} style={{ marginBottom: 2 }}>
                          <strong>{obj(oid)}</strong>
                          <span style={{ color: '#aaa', marginLeft: 6, fontSize: 12 }}>
                            ({cat.objectives[oid]?.reputation ?? '?'} rep, {cat.objectives[oid]?.timing ?? '?'} timing)
                          </span>
                        </div>
                      ))
                    : <span>{report.objectivesDrawn.count} drawn <span style={{ color: '#666', fontSize: 12 }}>(hidden from you)</span></span>}
                </div>
              )}
          </Section>
        )}

        {report.objectivesPlayed.length > 0 && (
          <Section title="Objectives auto-played">
            {report.objectivesPlayed.map((o) => (
              <div key={o.objectiveId}>
                <strong>{obj(o.objectiveId)}</strong> — gained {o.reputation} reputation
              </div>
            ))}
          </Section>
        )}

        <Section title="Recruits">
          {report.recruits.length === 0
            ? <Quiet>(no recruit this turn)</Quiet>
            : report.recruits.map((r, i) => (
                <div key={i}>
                  {r.leaderId ? `Recruited ${ld(r.leaderId)}` : 'Drew an action card only'}
                </div>
              ))}
        </Section>

        <Section title="Build queue additions">
          {groupedBuilds.size === 0
            ? <Quiet>(no builds this turn)</Quiet>
            : Array.from(groupedBuilds.entries()).map(([sid, units]) => (
                <div key={sid}>
                  From <em>{sys(sid)}</em>: {units.join(', ')}
                </div>
              ))}
        </Section>

        <Section title="Units deployed off the queue">
          {groupedDeploys.size === 0
            ? <Quiet>(none — queue didn't reach slot 1)</Quiet>
            : Array.from(groupedDeploys.entries()).map(([sid, units]) => (
                <div key={sid}>
                  At <em>{sys(sid)}</em>: {units.join(', ')}
                </div>
              ))}
        </Section>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onDismiss}
            style={{ padding: '8px 24px', background: sideC, color: '#000',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid #2a2d34' }}>
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 13, color: '#e8e8ea' }}>{children}</div>
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#555', fontStyle: 'italic' }}>{children}</span>;
}

/** Card-count cell that reveals the card images on hover. Only rendered when
 *  the side matches the human player (so we never leak hidden info). Names
 *  and rules text fall back when no image is available, and are surfaced
 *  alongside the image regardless so the small embedded text on the card
 *  art has a legible copy. */
function HandTip({ count, cards }: {
  count: number;
  cards: { name: string; image?: string; rulesText?: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return <>0 cards</>;
  // Width of each card tile in the popup. 130px keeps long hands on
  // one row without running off the screen; the embedded card-art text
  // becomes a thumbnail at this size, so the typeset rulesText below
  // is the primary readable copy.
  const TILE_W = 130;
  return (
    <span
      style={{ borderBottom: '1px dotted #888', cursor: 'help', position: 'relative' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {count} cards
      {open && (
        <div
          // Float a strip of card images to the right of the row so they
          // don't push layout around. Pointer events disabled so leaving
          // the source still closes the popup cleanly.
          style={{
            position: 'absolute', left: '100%', top: '50%',
            transform: 'translateY(-50%)',
            marginLeft: 12, zIndex: 2000,
            display: 'flex', gap: 6, flexWrap: 'wrap',
            background: 'rgba(0,0,0,0.94)', border: '1px solid #555',
            padding: 8, borderRadius: 4, maxWidth: 'min(95vw, 1400px)',
            pointerEvents: 'none',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
          }}
        >
          {cards.map((c, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              width: TILE_W,
            }}>
              {c.image ? (
                <img
                  src={`/dev-assets/cards/${c.image}`}
                  alt={c.name}
                  style={{ width: TILE_W, height: 'auto', borderRadius: 4, border: '1px solid #333' }}
                />
              ) : (
                <div style={{
                  width: TILE_W, height: TILE_W * 1.4, background: '#222',
                  color: '#888', fontSize: 12,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: 8, textAlign: 'center',
                }}>
                  {c.name}
                </div>
              )}
              <div style={{
                color: '#fff', fontSize: 12, fontWeight: 600, marginTop: 4,
                textAlign: 'center', lineHeight: 1.2,
              }}>
                {c.name}
              </div>
              {c.rulesText && (
                <div style={{
                  color: '#cbc4b0', fontSize: 11, marginTop: 3,
                  lineHeight: 1.35, textAlign: 'left',
                  whiteSpace: 'normal',
                }}>
                  {c.rulesText}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

// ============================================================================
// Build Pick Modal — choose unit type for each ambiguous build icon
// ============================================================================

function BuildPickModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'BuildPick';
    side: Side;
    picks: {
      sourceSystemId: string;
      slot: 1 | 2 | 3;
      iconType: 'space' | 'ground';
      iconShape: 'triangle' | 'circle' | 'square';
      legalUnitTypes: string[];
    }[];
    autoApplied: {
      sourceSystemId: string;
      slot: 1 | 2 | 3;
      unitTypeId: string;
    }[];
  };
  onSubmit: (choices: string[]) => void;
}) {
  const cat = G.catalog;
  const sysName = (sid: string) => sid === 'rebel-base' ? 'Rebel Base' : (cat.systems[sid]?.name ?? sid);
  const unitName = (tid: string) => cat.unitTypes[tid]?.name ?? tid;
  const color = sideColor(choice.side);

  const [selections, setSelections] = useState<string[]>(
    () => choice.picks.map((p) => p.legalUnitTypes[0])
  );
  const setPick = (i: number, value: string) => {
    setSelections((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 22, maxWidth: 640, width: '92%', maxHeight: '85vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 16, color, fontWeight: 700, marginBottom: 4 }}>
          {choice.side} — Build phase choices
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Each resource icon below allows more than one unit type. Pick which
          to add to your build queue. Units go to the slot number printed
          beside the resource icon.
        </div>

        {choice.autoApplied.length > 0 && (
          <details open style={{ marginBottom: 12, background: '#1a1f1a', borderRadius: 4, padding: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#80dc78', fontSize: 12, fontWeight: 600 }}>
              Already auto-added this turn ({choice.autoApplied.length} unit{choice.autoApplied.length === 1 ? '' : 's'})
            </summary>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6, lineHeight: 1.4 }}>
              These resource icons only had one legal unit type, so they were
              applied without asking:
              <ul style={{ marginTop: 4, marginBottom: 0, paddingLeft: 18 }}>
                {choice.autoApplied.map((a, i) => (
                  <li key={i} style={{ color: '#cbc4b0' }}>
                    <strong style={{ color: '#fff' }}>{unitName(a.unitTypeId)}</strong>
                    {' '}from <em>{sysName(a.sourceSystemId)}</em>
                    {' '}<span style={{ color: '#666' }}>→ slot {a.slot}</span>
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}

        <div style={{ fontSize: 11, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          Choices needed ({choice.picks.length})
        </div>

        {choice.picks.map((p, i) => (
          <div key={i} style={{ marginBottom: 10, padding: 8, background: '#1f2128', borderRadius: 4 }}>
            <div style={{ fontSize: 13, color: '#e8e8ea', marginBottom: 4 }}>
              <strong>{sysName(p.sourceSystemId)}</strong>
              <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
                {p.iconType} {p.iconShape} → slot {p.slot}
              </span>
            </div>
            {p.legalUnitTypes.map((tid) => (
              <label
                key={tid}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}
              >
                <input
                  type="radio"
                  name={`pick-${i}`}
                  checked={selections[i] === tid}
                  onChange={() => setPick(i, tid)}
                />
                <span style={{ color: '#fff', fontSize: 13 }}>{unitName(tid)}</span>
              </label>
            ))}
          </div>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            onClick={() => onSubmit(selections)}
            style={{ padding: '8px 24px', background: color, color: '#000',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}
          >
            Confirm builds
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Combat Attacker Tactics Modal — pick which tactic cards to play after roll
// ============================================================================

function CombatAttackerTacticsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'CombatAttackerTactics';
    side: Side;
    theater: 'space' | 'ground';
    dice: { color: string; face: string }[];
    hand: string[];
    attackerUnits: number;
    systemId: string;
  };
  onSubmit: (concentrateFireCardId: string | null, damageBoostCardIds: string[]) => void;
}) {
  const color = sideColor(choice.side);
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const hits = choice.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  const blanks = choice.dice.filter((d) => d.face === 'blank').length;

  const concentrateFire = choice.hand.find((cid) => cid.includes('concentrate-fire')) ?? null;
  const damageBoosts = choice.hand.filter((cid) =>
    cid.includes('take-it-down') || cid.includes('critical-hit') || cid.includes('onslaught')
  );

  const [useCF, setUseCF] = useState(false);
  const [pickedBoosts, setPickedBoosts] = useState<Set<string>>(new Set());
  const toggleBoost = (cid: string) => {
    setPickedBoosts((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid); else next.add(cid);
      return next;
    });
  };

  const cardLabel = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  const cardBonus = (cid: string) =>
    cid.includes('take-it-down') ? '+2 damage' :
    cid.includes('onslaught') ? '+2 damage' :
    cid.includes('critical-hit') ? '+1 damage' : '';

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 4 }}>
          {choice.side} — {choice.theater} attack at {sysName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          You rolled {choice.dice.length} dice ({hits} hit{hits === 1 ? '' : 's'}, {blanks} blank{blanks === 1 ? '' : 's'}).
          Play tactic cards to improve this attack, or skip.
        </div>

        {choice.hand.length === 0 && (
          <div style={{ fontSize: 12, color: '#666', fontStyle: 'italic', marginBottom: 10 }}>
            No {choice.theater} tactic cards in hand.
          </div>
        )}

        {concentrateFire && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
            padding: 6, background: '#1f2128', borderRadius: 4, cursor: blanks === 0 ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={useCF}
              disabled={blanks === 0}
              onChange={(e) => setUseCF(e.target.checked)}
            />
            <span style={{ color: '#fff', fontSize: 13 }}>
              <strong>{cardLabel(concentrateFire)}</strong>
              <span style={{ color: '#aaa', marginLeft: 6 }}>
                — reroll up to 2 blanks {blanks === 0 ? '(no blanks to reroll)' : `(you have ${blanks})`}
              </span>
            </span>
          </label>
        )}

        {damageBoosts.map((cid) => (
          <label key={cid} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
            padding: 6, background: '#1f2128', borderRadius: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={pickedBoosts.has(cid)}
              onChange={() => toggleBoost(cid)}
            />
            <span style={{ color: '#fff', fontSize: 13 }}>
              <strong>{cardLabel(cid)}</strong>
              <span style={{ color: '#aaa', marginLeft: 6 }}>— {cardBonus(cid)}</span>
            </span>
          </label>
        ))}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button
            onClick={() => onSubmit(null, [])}
            style={{ padding: '6px 14px', background: '#2a2c33', color: '#fff', border: '1px solid #555', borderRadius: 4, cursor: 'pointer' }}
          >
            Skip
          </button>
          <button
            onClick={() => onSubmit(useCF ? concentrateFire : null, Array.from(pickedBoosts))}
            style={{ padding: '6px 14px', background: color, color: '#000', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}
          >
            Apply &amp; resolve
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Combat Defender Tactics Modal — pick blocks vs. incoming damage
// ============================================================================

function CombatDefenderTacticsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'CombatDefenderTactics';
    side: Side;
    theater: 'space' | 'ground';
    incomingHits: number;
    hand: string[];
    systemId: string;
  };
  onSubmit: (blockCardIds: string[], sacrificeCardIds: string[]) => void;
}) {
  const color = sideColor(choice.side);
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const freeBlock = choice.hand.find((cid) => cid.includes('defensive-formation')) ?? null;
  const paidBlock = choice.hand.find((cid) =>
    (choice.theater === 'ground' && cid.includes('dig-in')) ||
    (choice.theater === 'space' && cid.includes('outmaneuver'))
  ) ?? null;
  const sacrificeCandidates = choice.hand.filter((cid) =>
    cid !== freeBlock && cid !== paidBlock
  );

  const [useFree, setUseFree] = useState(false);
  const [usePaid, setUsePaid] = useState(false);
  const [sacrifice, setSacrifice] = useState<string | null>(sacrificeCandidates[0] ?? null);

  const cardLabel = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (useFree && freeBlock) blockCards.push(freeBlock);
  if (usePaid && paidBlock && sacrifice) {
    blockCards.push(paidBlock); sacrifices.push(sacrifice);
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 4 }}>
          {choice.side} — defend {choice.theater} at {sysName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Incoming damage: <strong style={{ color: '#ff6961' }}>{choice.incomingHits}</strong>.
          Play defensive tactic cards to block (each blocks 1).
        </div>

        {!freeBlock && !paidBlock && (
          <div style={{ fontSize: 12, color: '#666', fontStyle: 'italic', marginBottom: 10 }}>
            No defensive tactic cards in your {choice.theater} hand.
          </div>
        )}

        {freeBlock && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
            padding: 6, background: '#1f2128', borderRadius: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={useFree} onChange={(e) => setUseFree(e.target.checked)} />
            <span style={{ color: '#fff', fontSize: 13 }}>
              <strong>{cardLabel(freeBlock)}</strong>
              <span style={{ color: '#aaa', marginLeft: 6 }}>— block 1 (free)</span>
            </span>
          </label>
        )}

        {paidBlock && (
          <div style={{ marginBottom: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8,
              padding: 6, background: '#1f2128', borderRadius: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={usePaid}
                disabled={sacrificeCandidates.length === 0}
                onChange={(e) => setUsePaid(e.target.checked)}
              />
              <span style={{ color: '#fff', fontSize: 13 }}>
                <strong>{cardLabel(paidBlock)}</strong>
                <span style={{ color: '#aaa', marginLeft: 6 }}>
                  — block 1 (discard a second card){sacrificeCandidates.length === 0 ? ' — no spare card' : ''}
                </span>
              </span>
            </label>
            {usePaid && sacrificeCandidates.length > 0 && (
              <div style={{ marginLeft: 26, marginTop: 4, fontSize: 12, color: '#aaa' }}>
                Discard with:&nbsp;
                <select
                  value={sacrifice ?? ''}
                  onChange={(e) => setSacrifice(e.target.value)}
                  style={{ background: '#2a2c33', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}
                >
                  {sacrificeCandidates.map((cid) => (
                    <option key={cid} value={cid}>{cardLabel(cid)}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
          <button
            onClick={() => onSubmit([], [])}
            style={{ padding: '6px 14px', background: '#2a2c33', color: '#fff', border: '1px solid #555', borderRadius: 4, cursor: 'pointer' }}
          >
            Take it ({choice.incomingHits})
          </button>
          <button
            onClick={() => onSubmit(blockCards, sacrifices)}
            disabled={blockCards.length === 0}
            style={{ padding: '6px 14px', background: blockCards.length === 0 ? '#444' : color, color: '#000',
              border: 'none', borderRadius: 4, cursor: blockCards.length === 0 ? 'not-allowed' : 'pointer', fontWeight: 600 }}
          >
            Block {blockCards.length}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Infiltration Pick Modal — Rebel looks at 2 objectives, picks one to keep on top
// ============================================================================

/** Shared drag-and-drop "top vs bottom of deck" pick modal. The two
 *  drawn cards start one-per-slot (A on top, B on bottom). The player
 *  drags any card to any slot; the other card auto-snaps to the
 *  remaining slot. Click-to-swap is supported as a fallback for users
 *  who don't want to drag.
 *
 *  Slot semantics differ between the two callers (Infiltration: "stays
 *  on top of deck" vs Covert Operation: "kept in hand"). The labels
 *  prop renders the right wording. */
function TopBottomCardPickModal({ G, cardIds, color, title, blurb, topLabel, bottomLabel, topHint, bottomHint, onConfirm }: {
  G: GameState;
  cardIds: [string, string];
  color: string;
  title: string;
  blurb: string;
  topLabel: string;
  bottomLabel: string;
  topHint: string;
  bottomHint: string;
  onConfirm: (topCardId: string, bottomCardId: string) => void;
}) {
  // Slot assignments; both start filled.
  const [topSlot, setTopSlot] = useState<string>(cardIds[0]);
  const [bottomSlot, setBottomSlot] = useState<string>(cardIds[1]);
  const [hoverSlot, setHoverSlot] = useState<'top' | 'bottom' | null>(null);

  // Drop a card on a slot — swap with whatever's there.
  const dropOn = (targetSlot: 'top' | 'bottom', cardId: string) => {
    if (targetSlot === 'top') {
      if (topSlot === cardId) return;             // already there
      setBottomSlot(topSlot);                     // current top → bottom
      setTopSlot(cardId);
    } else {
      if (bottomSlot === cardId) return;
      setTopSlot(bottomSlot);
      setBottomSlot(cardId);
    }
    setHoverSlot(null);
  };

  const onDragStart = (cardId: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', cardId);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (slot: 'top' | 'bottom') => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (hoverSlot !== slot) setHoverSlot(slot);
  };
  const onDragLeave = () => setHoverSlot(null);
  const onDrop = (slot: 'top' | 'bottom') => (e: React.DragEvent) => {
    e.preventDefault();
    const cid = e.dataTransfer.getData('text/plain');
    if (cid) dropOn(slot, cid);
  };

  const renderCard = (cardId: string) => {
    const o = G.catalog.objectives[cardId];
    return (
      <div
        draggable
        onDragStart={onDragStart(cardId)}
        style={{
          background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4,
          padding: 8, cursor: 'grab', userSelect: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        }}
      >
        {o?.image && (
          <img src={`${CARD_IMAGE_BASE}/${o.image}`} alt={o.name ?? cardId}
            draggable={false}
            style={{ width: 180, height: 'auto', borderRadius: 3,
              boxShadow: '0 0 12px rgba(0,0,0,0.6)' }} />
        )}
        <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, textAlign: 'center' }}>
          {o?.name ?? cardId}
        </div>
        <div style={{ fontSize: 10, color: '#ffd54a', fontWeight: 700 }}>
          +{o?.reputation ?? 0} reputation
        </div>
      </div>
    );
  };

  const renderSlot = (slot: 'top' | 'bottom', label: string, hint: string, cardId: string) => {
    const highlighted = hoverSlot === slot;
    return (
      <div
        onDragOver={onDragOver(slot)}
        onDragLeave={onDragLeave}
        onDrop={onDrop(slot)}
        onClick={() => {
          // Click-to-swap fallback: tap a card in one slot to send the
          // OTHER card here. Common when not using a mouse for drag.
          const otherCard = slot === 'top' ? bottomSlot : topSlot;
          dropOn(slot, otherCard);
        }}
        style={{
          flex: 1, padding: 10,
          background: highlighted ? `${color}22` : '#1a1c22',
          border: `2px ${highlighted ? 'solid' : 'dashed'} ${color}`,
          borderRadius: 6,
          minHeight: 280,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        }}
      >
        <div style={{ color, fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {label}
        </div>
        <div style={{ color: '#888', fontSize: 11, textAlign: 'center', minHeight: 14 }}>
          {hint}
        </div>
        {renderCard(cardId)}
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>{blurb}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {renderSlot('top', topLabel, topHint, topSlot)}
          {renderSlot('bottom', bottomLabel, bottomHint, bottomSlot)}
        </div>
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button onClick={() => onConfirm(topSlot, bottomSlot)}
            style={{ padding: '8px 22px', background: color, color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

function InfiltrationPickModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'InfiltrationPick'; topId: string; bottomId: string };
  onPick: (keepOnTopId: string) => void;
}) {
  return (
    <TopBottomCardPickModal
      G={G}
      cardIds={[choice.topId, choice.bottomId]}
      color="#aae0ff"
      title="Infiltration — order the top 2 objective cards"
      blurb="You looked at the top 2 cards of your objective deck. Drag (or click) to place one on top (drawn next refresh) and the other on the bottom."
      topLabel="Top of deck"
      topHint="Drawn next Refresh phase."
      bottomLabel="Bottom of deck"
      bottomHint="Returned to the bottom; you'll see it again later."
      onConfirm={(topCardId, _bottomCardId) => onPick(topCardId)}
    />
  );
}

// ============================================================================
// Covert Operation Pick Modal — Rebel draws 2 objectives, keeps 1 in hand
// ============================================================================

/** Generic single-leader-pick modal — used by Capture Rebel Operative,
 *  Carbon Freezing, and Lure Of The Dark Side. */
function SimpleLeaderPickModal({ G, color, title, candidates, onPick }: {
  G: GameState;
  color: string;
  title: string;
  candidates: string[];
  onPick: (leaderId: string) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button
                key={lid}
                onClick={() => onPick(lid)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: 8, background: '#0c0d10', border: '1px solid #2a2d34',
                  borderRadius: 4, color: '#e8e8ea', cursor: 'pointer',
                }}
              >
                {l?.image && (
                  <img src={`${LEADER_IMAGE_BASE}/${l.image}`} alt={l.name}
                    width={48} height={48}
                    style={{ borderRadius: '50%', border: `2px solid ${color}`, objectFit: 'cover' }} />
                )}
                <span style={{ fontSize: 13 }}>{l?.name ?? lid}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Generic system-multi-pick modal — used by Fear Will Keep Them In Line. */
function SystemMultiPickModal({ G, choice, title, color, onSubmit }: {
  G: GameState;
  choice: { kind: 'FearWillKeepThemInLinePick'; candidates: string[]; count: number };
  title: string;
  color: string;
  onSubmit: (systemIds: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (sid: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(sid)) n.delete(sid);
    else if (n.size < choice.count) n.add(sid);
    return n;
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 6 }}>{title}</div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>Pick {choice.count} of {choice.candidates.length}.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {choice.candidates.map((sid) => (
            <label key={sid} style={{ display: 'flex', gap: 6, padding: 4, background: '#1f2128', borderRadius: 3, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={picked.has(sid)} onChange={() => toggle(sid)} />
              {G.catalog.systems[sid]?.name ?? sid}
            </label>
          ))}
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={() => onSubmit(Array.from(picked))}
            disabled={picked.size !== choice.count}
            style={{ padding: '6px 16px', background: picked.size === choice.count ? color : '#444', color: '#000',
              border: 'none', borderRadius: 3, cursor: picked.size === choice.count ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/** Destroy Up To N Health — generic unit-checklist with budget tracking. */
function DestroyUpToHealthModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'DestroyUpToHealth'; systemId: string; candidates: string[]; budget: number; cardName: string; side: Side };
  onSubmit: (ids: string[]) => void;
}) {
  const ss = G.map.systems[choice.systemId] ?? G.map.rebelBaseSpace;
  const cands = choice.candidates.map((uid) => {
    const u = ss?.units.find((x) => x.instanceId === uid);
    const t = u ? G.catalog.unitTypes[u.typeId] : null;
    return { uid, name: t?.name ?? uid, hp: t?.health.value ?? 0 };
  });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const spent = Array.from(picked).reduce((s, uid) => s + (cands.find((c) => c.uid === uid)?.hp ?? 0), 0);
  const color = sideColor(choice.side);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 6 }}>
          {choice.cardName} — destroy up to {choice.budget} health
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Spent: {spent} / {choice.budget}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {cands.map((c) => {
            const willFit = picked.has(c.uid) || spent + c.hp <= choice.budget;
            return (
              <label key={c.uid} style={{ display: 'flex', gap: 6, padding: 4, background: '#1f2128',
                borderRadius: 3, cursor: willFit ? 'pointer' : 'not-allowed', fontSize: 13, opacity: willFit ? 1 : 0.5 }}>
                <input type="checkbox" checked={picked.has(c.uid)} disabled={!willFit}
                  onChange={() => setPicked((p) => {
                    const n = new Set(p); if (n.has(c.uid)) n.delete(c.uid); else n.add(c.uid); return n;
                  })} />
                {c.name} <span style={{ color: '#888', marginLeft: 4 }}>({c.hp} hp)</span>
              </label>
            );
          })}
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={() => onSubmit(Array.from(picked))}
            style={{ padding: '6px 16px', background: color, color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}>
            Destroy {picked.size} unit{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Rogue Squadron Raid — destroy queue items up to 4 health. */
function RogueSquadronRaidModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'RogueSquadronRaidPick'; candidates: { slot: 1 | 2 | 3; queueIndex: number; unitTypeId: string; health: number }[]; budget: number };
  onSubmit: (picks: { slot: 1 | 2 | 3; queueIndex: number }[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = (c: { slot: number; queueIndex: number }) => `${c.slot}/${c.queueIndex}`;
  const spent = choice.candidates
    .filter((c) => picked.has(key(c)))
    .reduce((s, c) => s + c.health, 0);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Rogue Squadron Raid — destroy up to {choice.budget} health from Empire build queue
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Spent: {spent} / {choice.budget}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {choice.candidates.map((c) => {
            const k = key(c);
            const willFit = picked.has(k) || spent + c.health <= choice.budget;
            return (
              <label key={k} style={{ display: 'flex', gap: 6, padding: 4, background: '#1f2128',
                borderRadius: 3, cursor: willFit ? 'pointer' : 'not-allowed', fontSize: 13, opacity: willFit ? 1 : 0.5 }}>
                <input type="checkbox" checked={picked.has(k)} disabled={!willFit}
                  onChange={() => setPicked((p) => {
                    const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n;
                  })} />
                {G.catalog.unitTypes[c.unitTypeId]?.name ?? c.unitTypeId}
                <span style={{ color: '#888', marginLeft: 4 }}>slot {c.slot} · {c.health} hp</span>
              </label>
            );
          })}
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={() => {
            const arr = choice.candidates.filter((c) => picked.has(key(c)))
              .map((c) => ({ slot: c.slot, queueIndex: c.queueIndex }));
            onSubmit(arr);
          }} style={{ padding: '6px 16px', background: '#aae0ff', color: '#000',
            border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}>
            Destroy {picked.size}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Double Our Efforts — pick 1 or 2 queued units to advance. */
function DoubleOurEffortsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'DoubleOurEffortsPick'; candidates: { slot: 2 | 3; queueIndex: number; unitTypeId: string }[]; picksAllowed: 1 | 2 };
  onSubmit: (picks: { slot: 2 | 3; queueIndex: number }[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = (c: { slot: number; queueIndex: number }) => `${c.slot}/${c.queueIndex}`;
  const toggle = (k: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(k)) n.delete(k);
    else if (n.size < choice.picksAllowed) n.add(k);
    return n;
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Double Our Efforts — advance {choice.picksAllowed === 1 ? '1 unit' : 'up to 2 units'} down the queue
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {choice.candidates.map((c) => {
            const k = key(c);
            return (
              <label key={k} style={{ display: 'flex', gap: 6, padding: 4, background: '#1f2128',
                borderRadius: 3, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
                {G.catalog.unitTypes[c.unitTypeId]?.name ?? c.unitTypeId}
                <span style={{ color: '#888', marginLeft: 4 }}>slot {c.slot} → {c.slot - 1}</span>
              </label>
            );
          })}
        </div>
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <button onClick={() => {
            const arr = choice.candidates.filter((c) => picked.has(key(c)))
              .map((c) => ({ slot: c.slot, queueIndex: c.queueIndex }));
            onSubmit(arr);
          }} style={{ padding: '6px 16px', background: '#ffaaaa', color: '#000',
            border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}>
            Apply {picked.size}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Planetary Conquest — pick a source system to drain. */
function PlanetaryConquestModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'PlanetaryConquestSourcePick'; targetSystemId: string; sources: { sourceSystemId: string; picks: string[] }[] };
  onPick: (sourceSystemId: string) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Planetary Conquest — pick a source system to draw units from
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Target: {targetName}. Units (up to 1 AT-AT, 1 AT-ST, 2 Stormtroopers) move from the source, then combat fires.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {choice.sources.map((s) => (
            <button key={s.sourceSystemId} onClick={() => onPick(s.sourceSystemId)}
              style={{ textAlign: 'left', padding: 8, background: '#0c0d10', border: '1px solid #2a2d34',
                borderRadius: 4, color: '#e8e8ea', cursor: 'pointer', fontSize: 13 }}>
              <strong>{G.catalog.systems[s.sourceSystemId]?.name ?? s.sourceSystemId}</strong>
              <span style={{ color: '#888', marginLeft: 6 }}>(sends {s.picks.length} unit{s.picks.length === 1 ? '' : 's'})</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Public Uprising — pick ship/ground composition for 1 circle + 2 triangles. */
function PublicUprisingModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'PublicUprisingPick'; systemId: string };
  onSubmit: (picks: { circle: 'corellian-corvette' | 'airspeeder'; triangles: ('x-wing' | 'rebel-trooper')[] }) => void;
}) {
  const [circle, setCircle] = useState<'corellian-corvette' | 'airspeeder'>('corellian-corvette');
  const [tri1, setTri1] = useState<'x-wing' | 'rebel-trooper'>('rebel-trooper');
  const [tri2, setTri2] = useState<'x-wing' | 'rebel-trooper'>('rebel-trooper');
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const opt = (val: string, text: string) => <option value={val}>{text}</option>;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Public Uprising — gain 1 circle + 2 triangle units at {sysName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Combat resolves after the units arrive.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#fff' }}>
          <label>Circle unit:
            <select value={circle} onChange={(e) => setCircle(e.target.value as typeof circle)}
              style={{ marginLeft: 8, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}>
              {opt('corellian-corvette', 'Corellian Corvette (ship)')}
              {opt('airspeeder', 'Airspeeder (ground)')}
            </select>
          </label>
          <label>Triangle #1:
            <select value={tri1} onChange={(e) => setTri1(e.target.value as typeof tri1)}
              style={{ marginLeft: 8, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}>
              {opt('x-wing', 'X-Wing (ship)')}
              {opt('rebel-trooper', 'Rebel Trooper (ground)')}
            </select>
          </label>
          <label>Triangle #2:
            <select value={tri2} onChange={(e) => setTri2(e.target.value as typeof tri2)}
              style={{ marginLeft: 8, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}>
              {opt('x-wing', 'X-Wing (ship)')}
              {opt('rebel-trooper', 'Rebel Trooper (ground)')}
            </select>
          </label>
        </div>
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button onClick={() => onSubmit({ circle, triangles: [tri1, tri2] })}
            style={{ padding: '6px 16px', background: '#aae0ff', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}>
            Apply & start combat
          </button>
        </div>
      </div>
    </div>
  );
}

/** Support Of Mon Calamari — binary loyalty vs cruiser. */
function SupportOfMonCalamariModal({ choice, onPick }: {
  G: GameState;
  choice: { kind: 'SupportOfMonCalamariPick'; monCalaLoyalty: string; monCalaSubjugated: boolean };
  onPick: (option: 'loyalty' | 'cruiser') => void;
}) {
  const loyaltyHint = choice.monCalaLoyalty === 'rebel' && !choice.monCalaSubjugated
    ? 'Mon Calamari is already Rebel-loyal — gain has no effect.' : '';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div style={{ background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 10 }}>
          Support Of Mon Calamari — pick one
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => onPick('loyalty')}
            style={{ textAlign: 'left', padding: 10, background: '#0c0d10', border: '1px solid #2a2d34',
              borderRadius: 4, color: '#e8e8ea', cursor: 'pointer', fontSize: 13 }}>
            <strong>Gain 2 loyalty</strong> in Mon Calamari
            {loyaltyHint && <div style={{ color: '#ff8866', fontSize: 11, marginTop: 4 }}>{loyaltyHint}</div>}
          </button>
          <button onClick={() => onPick('cruiser')}
            style={{ textAlign: 'left', padding: 10, background: '#0c0d10', border: '1px solid #2a2d34',
              borderRadius: 4, color: '#e8e8ea', cursor: 'pointer', fontSize: 13 }}>
            <strong>Place 1 Mon Calamari Cruiser</strong> on build slot 3
          </button>
        </div>
      </div>
    </div>
  );
}

/** Oversee Project pick: choose 1 queued Empire unit from slot 1 or 2 to deploy. */
function OverseeProjectPickModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'OverseeProjectPick'; targetSystemId: string;
    candidates: { slot: 1 | 2; queueIndex: number; unitTypeId: string }[] };
  onPick: (queueIndex: number, slot: 1 | 2) => void;
}) {
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 600, width: '92%',
      }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Oversee Project — pick a queued unit to deploy at {sysName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Choose 1 unit on build space 1 or 2 to deploy here immediately.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((c, i) => {
            const t = G.catalog.unitTypes[c.unitTypeId];
            return (
              <button
                key={i}
                onClick={() => onPick(c.queueIndex, c.slot)}
                style={{
                  textAlign: 'left', padding: 8, background: '#0c0d10',
                  border: '1px solid #2a2d34', borderRadius: 4, color: '#e8e8ea',
                  cursor: 'pointer', fontSize: 13,
                }}
              >
                <strong>{t?.name ?? c.unitTypeId}</strong>
                <span style={{ color: '#888', fontSize: 11, marginLeft: 8 }}>
                  build slot {c.slot}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Homing Beacon: Empire picks a captured leader to rescue + system to place them in. */
function HomingBeaconPlaceModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'HomingBeaconPlace'; leaderCandidates: string[]; systemCandidates: string[] };
  onSubmit: (leaderId: string, systemId: string) => void;
}) {
  const [leader, setLeader] = useState(choice.leaderCandidates[0]);
  const [sys, setSys] = useState(choice.systemCandidates[0]);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%',
      }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Homing Beacon — release a leader to expose the Rebel base region
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Rescue 1 captured Rebel leader; place them in any system in the
          Rebel base's region. (Placement reveals the region to the Empire.)
        </div>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Leader to release:</div>
          <select value={leader} onChange={(e) => setLeader(e.target.value)}
            style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '4px 6px', width: '100%' }}>
            {choice.leaderCandidates.map((lid) => (
              <option key={lid} value={lid}>{G.catalog.leaders[lid]?.name ?? lid}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>Place in system:</div>
          <select value={sys} onChange={(e) => setSys(e.target.value)}
            style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '4px 6px', width: '100%' }}>
            {choice.systemCandidates.map((sid) => (
              <option key={sid} value={sid}>{G.catalog.systems[sid]?.name ?? sid}</option>
            ))}
          </select>
        </div>
        <div style={{ textAlign: 'right' }}>
          <button onClick={() => onSubmit(leader, sys)}
            style={{ padding: '6px 18px', background: '#ffaaaa', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
            Release & place
          </button>
        </div>
      </div>
    </div>
  );
}

function CovertOperationPickModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'CovertOperationPick'; drawnIds: [string, string] };
  onPick: (keepInHandId: string) => void;
}) {
  const opt = (id: string) => {
    const o = G.catalog.objectives[id];
    return { id, name: o?.name ?? id, rep: o?.reputation ?? 0, text: o?.rulesText ?? '' };
  };
  void opt; // (helper no longer used; modal delegates to TopBottomCardPickModal)
  return (
    <TopBottomCardPickModal
      G={G}
      cardIds={choice.drawnIds}
      color="#aae0ff"
      title="Covert Operation — keep one objective, bottom the other"
      blurb="You drew the top 2 objective cards. Drag (or click) to place one in your hand (immediately available) and the other on the bottom of the deck."
      topLabel="Keep in hand"
      topHint="Immediately available to play when its trigger fires."
      bottomLabel="Bottom of deck"
      bottomHint="Returned to the bottom; you'll see it again later."
      onConfirm={(topCardId, _bottomCardId) => onPick(topCardId)}
    />
  );
}

// ============================================================================
// Plan The Assault — pick ships to send from Rebel Base to target system
// ============================================================================

function PlanTheAssaultShipsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'PlanTheAssaultShips';
    side: Side;
    targetSystemId: string;
    availableShipIds: string[];
  };
  onSubmit: (shipIds: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const baseUnits = G.map.rebelBaseSpace.units;
  const ships = choice.availableShipIds
    .map((sid) => baseUnits.find((u) => u.instanceId === sid))
    .filter((u): u is NonNullable<typeof u> => !!u);

  const [picked, setPicked] = useState<Set<string>>(() => new Set(choice.availableShipIds));
  const toggle = (sid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid); else next.add(sid);
      return next;
    });
  };
  const allOn = picked.size === choice.availableShipIds.length;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%',
      }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Plan The Assault — pick ships to send to {targetName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Move any number of your ships from the Rebel Base to {targetName} as
          if it were adjacent. Ground units stay behind. Combat will start
          immediately after.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {ships.length === 0 && (
            <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
              (no ships at the Rebel Base — mission resolves without combat)
            </div>
          )}
          {ships.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 4,
                background: '#1f2128', borderRadius: 3, cursor: 'pointer',
              }}>
                <input
                  type="checkbox"
                  checked={picked.has(u.instanceId)}
                  onChange={() => toggle(u.instanceId)}
                />
                <span style={{ color: '#fff', fontSize: 13 }}>
                  {t?.name ?? u.typeId}
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={() => setPicked(allOn ? new Set() : new Set(choice.availableShipIds))}
            style={{ padding: '4px 10px', background: '#2a2c33', color: '#fff',
              border: '1px solid #555', borderRadius: 3, cursor: 'pointer', fontSize: 11 }}
          >
            {allOn ? 'Select none' : 'Select all'}
          </button>
          <button
            onClick={() => onSubmit(Array.from(picked))}
            style={{ padding: '6px 18px', background: '#aae0ff', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Send {picked.size} ship{picked.size === 1 ? '' : 's'} & start combat
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Combat Report Modal — detailed play-by-play after combat resolves
// ============================================================================

function CombatReportModal({ G, report, onDismiss }: {
  G: GameState;
  report: import('../engine/types').CombatReport;
  onDismiss: () => void;
}) {
  const sysName = G.catalog.systems[report.systemId]?.name ?? report.systemId;
  const defenderSide = report.attackerSide === 'Rebel' ? 'Empire' : 'Rebel';
  const winnerLabel =
    report.winner === 'draw' ? 'Draw (both sides eliminated)' :
    report.winner === null   ? 'Inconclusive (both sides have units left)' :
    `${report.winner} controls the system`;
  const winnerColor = report.winner && report.winner !== 'draw' ? sideColor(report.winner) : '#aaa';
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #ffd54a', borderRadius: 6,
          padding: 20, maxWidth: 780, width: '92%',
          maxHeight: '88vh', overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
          <strong style={{ fontSize: 18, color: '#ffd54a' }}>Combat at {sysName}</strong>
          <span style={{ fontSize: 12, color: sideColor(report.attackerSide), fontWeight: 600 }}>
            attacker: {report.attackerSide}
          </span>
          <span style={{ fontSize: 12, color: sideColor(defenderSide), fontWeight: 600 }}>
            defender: {defenderSide}
          </span>
          <span style={{ fontSize: 12, color: '#aaa', marginLeft: 'auto' }}>
            {report.totalRounds} round{report.totalRounds === 1 ? '' : 's'}
          </span>
        </div>

        {report.addedLeaders.length > 0 && (
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>
            Leaders added from pool: {report.addedLeaders.map((l) =>
              `${l.side} ${G.catalog.leaders[l.leaderId]?.name ?? l.leaderId} (tactic ${l.tacticValue})`
            ).join(' · ')}
          </div>
        )}

        {report.rounds.map((round) => (
          <div key={round.round} style={{
            marginBottom: 12, padding: 8, borderRadius: 4,
            background: '#0c0d10', border: '1px solid #2a2d34',
          }}>
            <div style={{ fontSize: 13, color: '#ffd54a', fontWeight: 700, marginBottom: 6 }}>
              Round {round.round}
            </div>
            {round.attacks.length === 0 && (
              <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>(no attacks)</div>
            )}
            {round.attacks.map((a, i) => (
              <div key={i} style={{ marginBottom: 8, paddingBottom: 6, borderBottom: i < round.attacks.length - 1 ? '1px dashed #2a2d34' : 'none' }}>
                <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <span style={{ color: sideColor(a.side), fontWeight: 600 }}>{a.side}</span>
                  <span style={{ color: '#888' }}>{a.theater} attack · {a.attackerUnits} unit{a.attackerUnits === 1 ? '' : 's'}</span>
                </div>
                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
                  {a.dice.length === 0 ? (
                    <span style={{ color: '#666', fontStyle: 'italic', fontSize: 11 }}>(no attack dice)</span>
                  ) : (
                    a.dice.map((d, di) => <DieFaceImg key={di} face={d.face} color={d.color} />)
                  )}
                  <span style={{ marginLeft: 8, color: '#fff', fontSize: 12 }}>
                    {a.hitsRolled} hit{a.hitsRolled === 1 ? '' : 's'}
                    {a.bonusDamage > 0 && <span style={{ color: '#80dc78' }}> +{a.bonusDamage} bonus</span>}
                    {a.blockedDamage > 0 && <span style={{ color: '#aae0ff' }}> −{a.blockedDamage} blocked</span>}
                    <span style={{ color: '#ffd54a', marginLeft: 4 }}>= {a.damageApplied} dmg</span>
                  </span>
                </div>
                {a.tacticsPlayed.length > 0 && (
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 2, fontStyle: 'italic' }}>
                    tactic cards: {a.tacticsPlayed.map((t) => `${t.card} (${t.detail})`).join(', ')}
                  </div>
                )}
                {a.destroyed.length > 0 && (
                  <div style={{ fontSize: 11, color: '#ff8866', marginTop: 2 }}>
                    destroyed: {a.destroyed.map((u) => G.catalog.unitTypes[u.typeId]?.name ?? u.typeId).join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}

        {report.structureDestructions.length > 0 && (
          <div style={{ marginTop: 8, padding: 6, background: '#2a1414', borderRadius: 3 }}>
            <div style={{ fontSize: 12, color: '#ff8866', fontWeight: 600, marginBottom: 2 }}>
              Structure destruction rule (rr p.4 IV)
            </div>
            {report.structureDestructions.map((sd, i) => (
              <div key={i} style={{ fontSize: 11, color: '#fff' }}>
                {sd.side} structures destroyed: {sd.typeIds.map((t) => G.catalog.unitTypes[t]?.name ?? t).join(', ')}
              </div>
            ))}
          </div>
        )}

        <div style={{
          marginTop: 12, padding: '8px 12px', borderRadius: 4,
          background: '#0c0d10', border: `2px solid ${winnerColor}`,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: winnerColor }}>
            Outcome: {winnerLabel}
          </span>
        </div>

        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <button className="tab-button active" onClick={onDismiss} style={{ fontWeight: 700 }}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Mission Report Modal — full-screen showdown of a mission resolution
// ============================================================================

function MissionReportModal({ G, report, onDismiss }: {
  G: GameState;
  report: import('../engine/types').MissionResolutionReport;
  onDismiss: () => void;
}) {
  const card = G.catalog.missions[report.missionId];
  const sysName = G.catalog.systems[report.targetSystemId]?.name ?? report.targetSystemId;
  const cardImg = card?.image ? `${CARD_IMAGE_BASE}/${card.image}` : null;
  const resultColor =
    report.result === 'auto-success' ? '#80dc78' :
    report.result === 'success'      ? '#80dc78' :
                                       '#ff8866';
  const resultLabel =
    report.result === 'auto-success' ? 'AUTOMATIC SUCCESS (unopposed)' :
    report.result === 'success'      ? 'SUCCESS' :
                                       'FAILURE';

  const renderSidePanel = (
    side: Side,
    leaderIds: string[],
    dice: { count: number; faces: string[]; successes: number } | undefined,
    portrait: number | undefined,
    align: 'left' | 'right',
  ) => {
    const color = sideColor(side);
    const showPortrait = !!(portrait && portrait > 0 && side === report.resolverSide);
    const total = (dice?.successes ?? 0) + (showPortrait ? (portrait ?? 0) : 0);
    return (
      <div style={{
        flex: 1, padding: 14, background: '#0c0d10',
        border: `2px solid ${color}`, borderRadius: 4,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
        minWidth: 240,
      }}>
        <div style={{ color, fontSize: 14, fontWeight: 700 }}>
          {side === report.resolverSide ? 'Attacker' : 'Opposer'} — {side}
        </div>
        {/* Leader portraits */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          {leaderIds.length === 0 ? (
            <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>
              (no leaders {align === 'right' ? 'at target' : 'assigned'})
            </div>
          ) : (
            leaderIds.map((lid) => {
              const ldr = G.catalog.leaders[lid];
              const match = ldr ? (ldr.skills as Record<string, number>)[report.skill] ?? 0 : 0;
              return (
                <div key={lid} style={{ textAlign: 'center' }}>
                  {ldr?.image && (
                    <img
                      src={`${LEADER_IMAGE_BASE}/${ldr.image}`}
                      width={64} height={64}
                      style={{ borderRadius: '50%', border: `2px solid ${color}`, objectFit: 'cover' }}
                      alt={ldr.name}
                    />
                  )}
                  <div style={{ fontSize: 11, marginTop: 2, color: '#e8e8ea' }}>{ldr?.name ?? lid}</div>
                  <div style={{ fontSize: 10, color: '#888' }}>{report.skill} {match}</div>
                </div>
              );
            })
          )}
        </div>
        {/* Dice */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center', minHeight: 24 }}>
          {!dice || dice.count === 0 ? (
            <span style={{ color: '#666', fontStyle: 'italic', fontSize: 11 }}>
              {report.result === 'auto-success' ? '(no roll — unopposed)' : '(0 dice)'}
            </span>
          ) : (
            dice.faces.map((f, i) => <DieFaceImg key={i} face={f} color="red" />)
          )}
        </div>
        {/* Successes summary */}
        {dice && (
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>
            {dice.successes} success{dice.successes === 1 ? '' : 'es'}
            {showPortrait && (
              <span style={{ fontSize: 12, color: '#ffd54a', marginLeft: 6, fontWeight: 600 }}>
                +{portrait} portrait
              </span>
            )}
            {showPortrait && (
              <div style={{ fontSize: 14, color: '#ffd54a', marginTop: 4 }}>= {total} total</div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${resultColor}`, borderRadius: 8,
        padding: 20, maxWidth: 1000, width: '94%',
        maxHeight: '92vh', overflowY: 'auto',
        boxShadow: `0 8px 40px ${resultColor}55`,
      }}>
        {/* Header + card image */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 18, color: '#ffd54a', fontWeight: 700, marginBottom: 4 }}>
            {card?.name ?? report.missionId}
          </div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>
            at <strong style={{ color: '#fff' }}>{sysName}</strong>
            {' · '}
            <span style={{ color: sideColor(report.resolverSide) }}>{report.resolverSide}</span> vs{' '}
            <span style={{ color: sideColor(report.opposerSide) }}>{report.opposerSide}</span>
            {' · '}skill {report.skill}{card && ` × ${card.skillCost}`}
          </div>
          {cardImg && (
            <img src={cardImg} alt={card?.name ?? ''} style={{
              maxWidth: 200, maxHeight: 280, borderRadius: 4,
              boxShadow: '0 0 16px rgba(0,0,0,0.6)',
            }} />
          )}
        </div>

        {/* Two-side panel */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 14, alignItems: 'stretch' }}>
          {renderSidePanel(report.resolverSide, report.attackerLeaders, report.attackerDice, report.portraitBonus, 'left')}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', color: '#888', fontSize: 13, padding: '0 4px' }}>
            vs
          </div>
          {renderSidePanel(report.opposerSide, report.opposerLeaders, report.opposerDice, undefined, 'right')}
        </div>

        {/* Outcome banner — large, unambiguous about whether the
            mission's effect fires. */}
        <div style={{
          padding: '14px 16px', borderRadius: 4, marginBottom: 14,
          background: report.result === 'failure' ? '#2a0d0a' : '#0d2a14',
          border: `3px solid ${resultColor}`,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 28, fontWeight: 900, color: resultColor, letterSpacing: 2, lineHeight: 1 }}>
            {resultLabel}
          </div>
          {/* Math summary: attacker total vs opposer total. */}
          {(report.attackerDice || report.opposerDice) && (
            <div style={{ fontSize: 13, color: '#ccc', marginTop: 8, fontFamily: 'monospace' }}>
              Attacker
              {' '}
              <strong style={{ color: '#fff' }}>
                {report.attackerTotal ?? (report.attackerDice?.successes ?? 0)}
              </strong>
              {' '}{report.result === 'failure' ? '<' : '>'}{' '}
              Opposer
              {' '}
              <strong style={{ color: '#fff' }}>
                {report.opposerDice?.successes ?? 0}
              </strong>
              {report.result === 'failure' && ' (ties go to defender)'}
            </div>
          )}
          {/* What this means for the mission's effect. */}
          <div style={{ fontSize: 13, color: '#fff', marginTop: 10, fontWeight: 600 }}>
            {report.result === 'failure'
              ? '✗ Mission effect does NOT fire. No card play, no peek, no objective change.'
              : report.result === 'auto-success'
                ? '✓ Mission effect fires — no opposition possible.'
                : '✓ Mission effect fires.'}
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <button className="tab-button active" onClick={onDismiss} style={{ fontWeight: 700, fontSize: 14, padding: '8px 20px' }}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function NotImplementedModal({ notices, onDismiss }: {
  notices: { id: string; title: string; details?: string }[];
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #ffd54a', borderRadius: 6,
          padding: 20, maxWidth: 540, width: '90%',
          boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: 13, color: '#ffd54a', fontWeight: 700, marginBottom: 8 }}>
          Heads up — not yet implemented
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          The game just hit {notices.length === 1 ? 'a code path' : `${notices.length} code paths`}
          {' '}that isn't fully implemented yet. Skip detailing as a bug — these are known gaps:
        </div>
        <ul style={{ paddingLeft: 18, margin: '0 0 14px 0' }}>
          {notices.map((n) => (
            <li key={n.id} style={{ marginBottom: 8 }}>
              <div style={{ color: '#e8e8ea', fontSize: 13, fontWeight: 600 }}>{n.title}</div>
              {n.details && (
                <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{n.details}</div>
              )}
            </li>
          ))}
        </ul>
        <div style={{ textAlign: 'right' }}>
          <button className="tab-button active" onClick={onDismiss} style={{ fontWeight: 700 }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Board
// ============================================================================

// ============================================================================
// Enlarged sector preview (hover-to-zoom)
// ============================================================================

function EnlargedSector({ G, system }: { G: GameState; system: System }) {
  const unitStyle = useUnitStyle();
  const VIEW_W = 360;
  // Position of the planet inside the viewport (centers a ~360px crop on the planet)
  const cx = system.boardPos.x;
  const cy = system.boardPos.y;
  const imgLeft = -cx + VIEW_W / 2;
  const imgTop = -cy + 140; // center planet vertically within the background area

  const onLeftHalf = system.boardPos.x < NATIVE_W / 2;
  const positionStyle: React.CSSProperties = onLeftHalf ? { right: 6 } : { left: 6 };

  const state = G.map.systems[system.id];
  if (!state) return null;
  const grouped = groupByType(state.units);
  const rebelLeaders = G.rebel.leadersOnBoard[system.id] ?? [];
  const empireLeaders = G.empire.leadersOnBoard[system.id] ?? [];
  const isBaseRevealed = G.rebelBaseRevealed && system.id === G.rebelBaseSystemId;

  // Loyalty status text + marker icon
  let loyaltyLabel = 'Neutral';
  let loyaltyColor = '#888';
  let loyaltyMarkerImg: string | null = null;
  if (state.loyalty === 'rebel') { loyaltyLabel = 'Rebel'; loyaltyColor = '#aae0ff'; loyaltyMarkerImg = 'MarkerLoyaltyRebel.png'; }
  if (state.loyalty === 'imperial') { loyaltyLabel = 'Imperial'; loyaltyColor = '#ffaaaa'; loyaltyMarkerImg = 'MarkerLoyaltyEmpire.png'; }

  return (
    <div
      style={{
        position: 'absolute',
        top: 6, ...positionStyle,
        width: VIEW_W,
        background: '#0c0d10',
        border: '2px solid #ffd54a',
        borderRadius: 4,
        pointerEvents: 'none',
        boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
        overflow: 'hidden',
      }}
    >
      {/* Background art: planet crop with darkening overlay */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0 }}>
        <img
          src={MAP_IMAGE_URL}
          width={NATIVE_W}
          height={NATIVE_H}
          style={{ position: 'absolute', left: imgLeft, top: imgTop, filter: 'blur(0.5px)' }}
          alt="" draggable={false}
        />
        {/* Vertical gradient: lighter at planet position, darker around content */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, rgba(12,13,16,0.55) 0%, rgba(12,13,16,0.65) 30%, rgba(12,13,16,0.92) 70%, rgba(12,13,16,0.96) 100%)',
        }} />
      </div>

      {/* Foreground content */}
      <div style={{ position: 'relative', zIndex: 1, padding: 12 }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <strong style={{ fontSize: 22, color: '#ffd54a', textShadow: '0 0 6px rgba(0,0,0,0.9)' }}>
            {system.name}
          </strong>
          <span style={{ fontSize: 11, color: '#ddd', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
            region {system.region}
            {system.isRemote && ' · remote'}
            {system.isCoruscant && ' · Coruscant'}
            {state.destroyed && ' · destroyed'}
          </span>
        </div>

        {/* Loyalty + status badges */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {loyaltyMarkerImg && (
            <img src={`${MARKER_IMAGE_BASE}/${loyaltyMarkerImg}`} width={28} height={28} alt="" />
          )}
          {state.subjugated && (
            <img src={`${MARKER_IMAGE_BASE}/MarkerLoyaltySubjugated.png`} width={28} height={28} alt="" />
          )}
          <span style={{ fontSize: 14, fontWeight: 600, color: loyaltyColor, textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
            {state.subjugated
              ? `Subjugated${state.loyalty === 'rebel' ? ' (Rebel underneath)' : state.loyalty === 'imperial' ? ' (Imperial underneath)' : ' (Neutral underneath)'}`
              : `${loyaltyLabel} loyalty`}
          </span>
          {state.sabotage && (
            <span style={{ fontSize: 11, color: '#ff7777', background: 'rgba(60,10,10,0.85)', padding: '2px 6px', borderRadius: 2, fontWeight: 600 }}>
              SABOTAGED
            </span>
          )}
          {isBaseRevealed && (
            <span style={{ fontSize: 11, color: '#80dc78', background: 'rgba(10,60,30,0.85)', padding: '2px 6px', borderRadius: 2, fontWeight: 600 }}>
              REBEL BASE
            </span>
          )}
        </div>

        {/* Build slot + resources */}
        {!system.isRemote && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#aaa', textShadow: '0 0 4px rgba(0,0,0,0.9)', marginBottom: 4 }}>
              Build queue slot · Resources
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, borderRadius: 4,
                background: 'rgba(255,213,74,0.9)', color: '#000',
                fontSize: 18, fontWeight: 700,
              }}>
                {system.buildSlot ?? '—'}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                {system.resources.length === 0 ? (
                  <span style={{ color: '#888', fontSize: 13 }}>(none)</span>
                ) : (
                  system.resources.map((r, i) => (
                    <span key={i} style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 30, height: 30, borderRadius: 4,
                      background: r.type === 'space' ? 'rgba(79,195,247,0.85)' : 'rgba(255,183,77,0.85)',
                      color: '#000', fontSize: 20, fontWeight: 700,
                      border: i === 0 && system.resources.length > 1 ? '2px solid #fff' : 'none',
                    }} title={i === 0 ? 'left icon (used when subjugated)' : 'right icon'}>
                      {r.shape === 'triangle' ? '▲' : r.shape === 'circle' ? '●' : '■'}
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Units */}
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: '#aaa', textShadow: '0 0 4px rgba(0,0,0,0.9)', marginBottom: 4 }}>
            Units {grouped.length === 0 ? '· (none)' : ''}
          </div>
          {grouped.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {grouped.map((g) => {
                const file = UNIT_IMAGE[g.typeId];
                if (!file) return null;
                return (
                  <div key={g.typeId} style={{ position: 'relative', width: 72, height: 72 }}>
                    <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={72} height={72} alt={g.typeId} />
                    {g.count > 1 && (
                      <span style={{
                        position: 'absolute', bottom: -3, right: -3,
                        background: '#000', color: '#fff', borderRadius: '50%',
                        fontSize: 11, fontWeight: 700, width: 18, height: 18,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1.5px solid #fff',
                      }}>{g.count}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Leaders */}
        {(rebelLeaders.length > 0 || empireLeaders.length > 0) && (
          <div>
            <div style={{ fontSize: 11, color: '#aaa', textShadow: '0 0 4px rgba(0,0,0,0.9)', marginBottom: 4 }}>
              Leaders
            </div>
            <div style={{ fontSize: 13 }}>
              {rebelLeaders.length > 0 && (
                <div style={{ color: '#aae0ff', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
                  Rebel: {rebelLeaders.join(', ')}
                </div>
              )}
              {empireLeaders.length > 0 && (
                <div style={{ color: '#ffaaaa', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
                  Empire: {empireLeaders.join(', ')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EnlargedRebelBase({ G, rect }: { G: GameState; rect: MaskRect }) {
  const unitStyle = useUnitStyle();
  const VIEW_W = 352;
  // Position: the rebel-base box is on the left side of the board, so show panel on right.
  const onLeftHalf = rect.x < NATIVE_W / 2;
  const positionStyle: React.CSSProperties = onLeftHalf ? { right: 6 } : { left: 6 };

  const units = G.map.rebelBaseSpace.units;
  const leaders = G.rebel.leadersOnBoard['rebel-base-space'] ?? [];
  const grouped = groupByType(units);

  return (
    <div
      style={{
        position: 'absolute', top: 6, ...positionStyle,
        width: VIEW_W,
        background: '#0c0d10',
        border: '2px solid #aae0ff',
        borderRadius: 4, padding: 10,
        pointerEvents: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 14, color: '#aae0ff', flex: 1 }}>Rebel Base space</strong>
        <span style={{ fontSize: 11, color: G.rebelBaseRevealed ? '#888' : '#80dc78', fontWeight: 600 }}>
          {G.rebelBaseRevealed ? 'revealed' : 'hidden'}
        </span>
      </div>

      <div style={{ fontSize: 12, color: '#aaa', lineHeight: 1.5 }}>
        <div style={{ marginBottom: 8 }}>
          {G.rebelBaseRevealed
            ? <>The base has been revealed — units that were here are now in <strong style={{ color: '#fff' }}>{G.catalog.systems[G.rebelBaseSystemId]?.name ?? G.rebelBaseSystemId}</strong>.</>
            : <>Staging area for Rebel units while the secret base location is hidden from Empire.</>}
        </div>

        <div>
          <strong style={{ color: '#fff' }}>{units.length} unit{units.length === 1 ? '' : 's'} staged</strong>
        </div>
        {grouped.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
            {grouped.map((g) => {
              const file = UNIT_IMAGE[g.typeId];
              if (!file) return null;
              return (
                <div key={g.typeId} style={{ position: 'relative', width: 64, height: 64 }}>
                  <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={64} height={64} alt={g.typeId} />
                  {g.count > 1 && (
                    <span style={{
                      position: 'absolute', bottom: -2, right: -2,
                      background: '#000', color: '#fff', borderRadius: '50%',
                      fontSize: 10, fontWeight: 700, width: 16, height: 16,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '1px solid #fff',
                    }}>{g.count}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {leaders.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <strong style={{ color: '#fff' }}>Leaders staged:</strong>{' '}
            <span style={{ color: '#aae0ff' }}>{leaders.join(', ')}</span>
          </div>
        )}

        {G.rebelBaseRevealed && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#888' }}>
            Once revealed, units cannot return to this space; they live in the base's system (above).
          </div>
        )}
      </div>
    </div>
  );
}

// Renders unit miniatures clustered around a point. Groups by type, with a
// count badge if a type appears more than once. Wraps to multiple rows if
// the cluster would exceed maxWidth.
// Small circular leader portraits clustered around a center point on the
// board. Rebel leaders use a blue ring, Empire red. Tooltip shows leader
// names so you can mouse over to identify them.
function LeaderPips({ G, systemId, centerX, centerY }: {
  G: GameState; systemId: string; centerX: number; centerY: number;
}) {
  const rebel = (G.rebel.leadersOnBoard[systemId] ?? []).map((lid) => ({ side: 'Rebel' as Side, leader: G.catalog.leaders[lid] })).filter((x) => x.leader);
  const empire = (G.empire.leadersOnBoard[systemId] ?? []).map((lid) => ({ side: 'Empire' as Side, leader: G.catalog.leaders[lid] })).filter((x) => x.leader);
  const all = [...rebel, ...empire];
  if (all.length === 0) return null;
  const SIZE = 24;        // up from 14 — actually recognisable
  const GAP = 2;
  const totalW = all.length * SIZE + (all.length - 1) * GAP;
  const startX = centerX - totalW / 2;
  return (
    <g pointerEvents="none">
      {/* Dark backing strip for contrast against the map */}
      <rect
        x={startX - 3} y={centerY - SIZE / 2 - 2}
        width={totalW + 6} height={SIZE + 4}
        rx={SIZE / 2 + 2} ry={SIZE / 2 + 2}
        style={{ fill: 'rgba(0,0,0,0.55)' }}
      />
      {all.map((x, i) => {
        const cx = startX + i * (SIZE + GAP) + SIZE / 2;
        const ringColor = x.side === 'Rebel' ? '#aae0ff' : '#ffaaaa';
        const glowColor = x.side === 'Rebel' ? 'rgba(170,224,255,0.85)' : 'rgba(255,170,170,0.85)';
        const clipId = `lpip-${systemId}-${x.leader!.id}`;
        return (
          <g key={x.leader!.id}>
            <defs>
              <clipPath id={clipId}>
                <circle cx={cx} cy={centerY} r={SIZE / 2 - 1} />
              </clipPath>
            </defs>
            {/* Soft outer glow — easier to spot the cluster on a busy map */}
            <circle cx={cx} cy={centerY} r={SIZE / 2 + 1.5}
              style={{ fill: 'none', stroke: glowColor, strokeWidth: 1, opacity: 0.7 }} />
            <image
              href={`${LEADER_IMAGE_BASE}/${x.leader!.image}`}
              x={cx - SIZE / 2} y={centerY - SIZE / 2}
              width={SIZE} height={SIZE}
              clipPath={`url(#${clipId})`}
              preserveAspectRatio="xMidYMid slice"
            />
            <circle cx={cx} cy={centerY} r={SIZE / 2}
              style={{ fill: 'none', stroke: ringColor, strokeWidth: 2 }} />
            <title>{x.side}: {x.leader!.name}</title>
          </g>
        );
      })}
    </g>
  );
}

function UnitCluster({ centerX, centerY, groups, iconSize, maxWidth }: {
  centerX: number; centerY: number;
  groups: { typeId: string; count: number }[];
  iconSize: number;
  maxWidth?: number;
}) {
  const unitStyle = useUnitStyle();
  const gap = 2;
  // Compute how many icons fit per row given maxWidth (default: all on one row, up to 8).
  const perRowMax = maxWidth
    ? Math.max(1, Math.floor((maxWidth + gap) / (iconSize + gap)))
    : 8;
  const perRow = Math.min(groups.length, perRowMax);
  const rows = perRow > 0 ? Math.ceil(groups.length / perRow) : 0;
  const rowWidth = perRow * iconSize + Math.max(0, perRow - 1) * gap;
  const startX = centerX - rowWidth / 2;
  const startY = centerY - (rows * iconSize + Math.max(0, rows - 1) * gap) / 2;
  return (
    <g pointerEvents="none">
      {groups.map((g, i) => {
        const file = UNIT_IMAGE[g.typeId];
        if (!file) return null;
        const row = Math.floor(i / perRow);
        const col = i % perRow;
        const ix = startX + col * (iconSize + gap);
        const iy = startY + row * (iconSize + gap);
        return (
          <g key={g.typeId}>
            <image
              href={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!}
              x={ix} y={iy}
              width={iconSize} height={iconSize}
            />
            {g.count > 1 && (
              <g>
                <circle
                  cx={ix + iconSize - 3} cy={iy + iconSize - 3} r={6}
                  style={{ fill: '#000', stroke: '#fff', strokeWidth: 0.5 }}
                />
                <text
                  x={ix + iconSize - 3} y={iy + iconSize - 1}
                  textAnchor="middle"
                  style={{ fill: '#fff', fontSize: 8, fontWeight: 700 }}
                >
                  {g.count}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
}

function Board({ G, systems, masks, eliminatedSystemIds }: {
  G: GameState; systems: System[]; masks: MaskRect[];
  eliminatedSystemIds?: Set<string> | null;
}) {
  // Compute aggregate of Rebel Base space units (offboard staging area)
  const rbsUnits = G.map.rebelBaseSpace.units.length;
  const BOARD_SCALE = DISPLAY_W / NATIVE_W;
  const [hoverSystemId, setHoverSystemId] = useState<string | null>(null);
  const [hoverRebelBase, setHoverRebelBase] = useState<boolean>(false);
  const hoverSystem = hoverSystemId ? systems.find((s) => s.id === hoverSystemId) : null;
  const rebelBaseRect = masks.find((r) => r.kind === 'rebel-base');

  return (
    <div style={{ position: 'relative', display: 'inline-block', border: '1px solid #2a2d34' }}>
      <img src={MAP_IMAGE_URL} width={DISPLAY_W} height={DISPLAY_H} alt="Board" />
      <svg width={DISPLAY_W} height={DISPLAY_H} style={{ position: 'absolute', top: 0, left: 0 }}>
        {/* Rectangles — kind=hide masks; other kinds render game state on top */}
        {masks.map((r) => {
          const x = r.x * BOARD_SCALE;
          const y = r.y * BOARD_SCALE;
          const w = r.width * BOARD_SCALE;
          const h = r.height * BOARD_SCALE;
          if (r.kind === 'hide') {
            return (
              <rect key={r.id}
                x={x} y={y} width={w} height={h}
                style={{ fill: '#0c0d10', pointerEvents: 'none' }}
              />
            );
          }
          // Play-area rectangles: overlay a darker tint plus state-specific content.
          let title = r.label;
          let content: React.ReactNode = null;
          if (r.kind === 'rebel-base') {
            const units = G.map.rebelBaseSpace.units;
            const leaders = G.rebel.leadersOnBoard['rebel-base-space'] ?? [];
            const grouped = groupByType(units);
            title = G.rebelBaseRevealed ? 'Rebel Base (revealed)' : 'Rebel Base (hidden)';
            content = (
              <>
                <text x={x + 6} y={y + 32} style={{ fill: '#aae0ff', fontSize: 13, fontWeight: 700, pointerEvents: 'none' }}>
                  {units.length} unit{units.length === 1 ? '' : 's'}
                </text>
                {grouped.length > 0 && (
                  <UnitCluster
                    centerX={x + w / 2}
                    centerY={y + h - 36}
                    groups={grouped}
                    iconSize={22}
                    maxWidth={w - 16}
                  />
                )}
                {leaders.length > 0 && (
                  <text x={x + 6} y={y + h - 4} style={{ fill: '#fff', fontSize: 10, pointerEvents: 'none' }}>
                    {leaders.length} leader{leaders.length === 1 ? '' : 's'}
                  </text>
                )}
              </>
            );
          } else if (r.kind.startsWith('build-')) {
            const m = r.kind.match(/^build-([123])-(rebel|empire)$/);
            if (m) {
              const slot = Number(m[1]) as 1 | 2 | 3;
              const side = m[2] === 'rebel' ? 'Rebel' as Side : 'Empire' as Side;
              const queue = (side === 'Rebel' ? G.rebel : G.empire).buildQueue[slot];
              const grouped = groupTypeIds(queue);
              title = `Build queue ${slot} (${side})`;
              content = (
                <>
                  <text x={x + 6} y={y + 30} style={{ fill: sideColor(side), fontSize: 12, fontWeight: 700, pointerEvents: 'none' }}>
                    {queue.length} unit{queue.length === 1 ? '' : 's'}
                  </text>
                  {grouped.length > 0 && (
                    <UnitCluster
                      centerX={x + w / 2}
                      centerY={y + h - 30}
                      groups={grouped}
                      iconSize={20}
                      maxWidth={w - 16}
                    />
                  )}
                </>
              );
            }
          }
          return (
            <g key={r.id} pointerEvents="none">
              <rect
                x={x} y={y} width={w} height={h}
                style={{ fill: 'rgba(20,25,30,0.85)', stroke: 'rgba(120,140,160,0.5)', strokeWidth: 1 }}
              />
              <text x={x + 6} y={y + 14} style={{ fill: '#aaa', fontSize: 10, fontWeight: 600 }}>
                {title}
              </text>
              {content}
            </g>
          );
        })}
        {systems.map((s) => {
          const x = s.boardPos.x * SCALE;
          const y = s.boardPos.y * SCALE;
          const state = G.map.systems[s.id];
          if (!state) return null;
          const rebelUnits = state.units.filter((u) => u.side === 'Rebel').length;
          const empireUnits = state.units.filter((u) => u.side === 'Empire').length;
          const hasUnits = rebelUnits + empireUnits > 0;
          const isBaseRevealed = G.rebelBaseRevealed && s.id === G.rebelBaseSystemId;
          const r = hasUnits ? MARKER_R + 2 : MARKER_R - 4;

          const grouped = groupByType(state.units);
          const isEliminated = eliminatedSystemIds?.has(s.id) ?? false;
          return (
            <g key={s.id}>
              {isBaseRevealed && (
                <circle cx={x} cy={y} r={MARKER_R + 6}
                  style={{ fill: 'none', stroke: '#80dc78', strokeWidth: 2 }} />
              )}
              {isEliminated && (
                <g pointerEvents="none">
                  <circle cx={x} cy={y} r={MARKER_R + 8}
                    style={{ fill: 'rgba(255,80,80,0.18)', stroke: '#ff5050', strokeWidth: 2 }} />
                  <line x1={x - MARKER_R} y1={y - MARKER_R} x2={x + MARKER_R} y2={y + MARKER_R}
                    style={{ stroke: '#ff5050', strokeWidth: 3, strokeLinecap: 'round' }} />
                  <line x1={x + MARKER_R} y1={y - MARKER_R} x2={x - MARKER_R} y2={y + MARKER_R}
                    style={{ stroke: '#ff5050', strokeWidth: 3, strokeLinecap: 'round' }} />
                </g>
              )}
              {hasUnits && (
                <UnitCluster
                  // Render ABOVE the planet image — the area below the planet
                  // is occupied by the printed yellow system-name banner.
                  centerX={x} centerY={y - MARKER_R - 14}
                  groups={grouped}
                  iconSize={18}
                  maxWidth={100}
                />
              )}
              <text x={x} y={y + r + 11} textAnchor="middle"
                style={{ fill: '#fff', fontSize: 9, pointerEvents: 'none', opacity: 0.85 }}
              >
                {s.name}
              </text>
              {/* tiny unit-count label (R/E) on the planet for quick read */}
              {hasUnits && (
                <g pointerEvents="none">
                  {rebelUnits > 0 && (
                    <text x={x - 14} y={y + 4} style={{ fill: '#aae0ff', fontSize: 11, fontWeight: 700, textShadow: '0 0 3px #000' }}>R{rebelUnits}</text>
                  )}
                  {empireUnits > 0 && (
                    <text x={x + 14} y={y + 4} style={{ fill: '#ffaaaa', fontSize: 11, fontWeight: 700, textShadow: '0 0 3px #000' }}>E{empireUnits}</text>
                  )}
                </g>
              )}
              {/* Leader portraits — small circular pip per leader at this system */}
              <LeaderPips G={G} systemId={s.id} centerX={x} centerY={y + MARKER_R + 32} />
            </g>
          );
        })}

        {/* Invisible hover targets per system, sized generously for easy mouseover */}
        {systems.map((s) => {
          const x = s.boardPos.x * SCALE;
          const y = s.boardPos.y * SCALE;
          return (
            <rect
              key={`hover-${s.id}`}
              x={x - 40} y={y - 40} width={80} height={80}
              fill="transparent"
              pointerEvents="all"
              onMouseEnter={() => setHoverSystemId(s.id)}
              onMouseLeave={() => setHoverSystemId(null)}
            />
          );
        })}

        {/* Hover target for the Rebel Base space rectangle */}
        {rebelBaseRect && (
          <rect
            x={rebelBaseRect.x * BOARD_SCALE}
            y={rebelBaseRect.y * BOARD_SCALE}
            width={rebelBaseRect.width * BOARD_SCALE}
            height={rebelBaseRect.height * BOARD_SCALE}
            fill="transparent"
            pointerEvents="all"
            onMouseEnter={() => setHoverRebelBase(true)}
            onMouseLeave={() => setHoverRebelBase(false)}
          />
        )}

        {/* Loyalty / subjugation marker images placed on the printed hex */}
        {systems.map((s) => {
          if (!s.loyaltyMarkerPos) return null; // remote / Coruscant
          const state = G.map.systems[s.id];
          if (!state) return null;
          const mx = s.loyaltyMarkerPos.x * BOARD_SCALE;
          const my = s.loyaltyMarkerPos.y * BOARD_SCALE;
          const markerSize = 36;

          // Pick which marker to render. Per rr p.13: subjugation marker sits
          // ON TOP of any loyalty marker. Render both (loyalty first, subjugation overlapping)
          // so a Rebel-loyalty-underneath-subjugation case is visible.
          const markers: { src: string; offsetX: number; offsetY: number; opacity?: number }[] = [];
          if (state.loyalty === 'rebel') {
            markers.push({ src: 'MarkerLoyaltyRebel.png', offsetX: 0, offsetY: 0 });
          } else if (state.loyalty === 'imperial') {
            markers.push({ src: 'MarkerLoyaltyEmpire.png', offsetX: 0, offsetY: 0 });
          }
          if (state.subjugated) {
            // If a loyalty marker is underneath, offset both noticeably so the
            // hidden loyalty is visible at a glance. The subjugation marker still
            // sits "on top" in game terms — it's the visible one to the right.
            const dx = markers.length > 0 ? 20 : 0;
            const dy = markers.length > 0 ? 14 : 0;
            markers.push({ src: 'MarkerLoyaltySubjugated.png', offsetX: dx, offsetY: dy });
          }
          if (markers.length === 0) return null;
          return (
            <g key={`loyalty-${s.id}`} pointerEvents="none">
              {markers.map((m, i) => (
                <image
                  key={i}
                  href={`${MARKER_IMAGE_BASE}/${m.src}`}
                  x={mx + m.offsetX - markerSize / 2}
                  y={my + m.offsetY - markerSize / 2}
                  width={markerSize}
                  height={markerSize}
                  opacity={m.opacity ?? 1}
                />
              ))}
            </g>
          );
        })}

        {/* If no rebel-base rectangle is defined in masks, fall back to a corner callout */}
        {rbsUnits > 0 && !masks.some((r) => r.kind === 'rebel-base') && (
          <g>
            <rect x={6} y={6} width={170} height={48}
              style={{ fill: 'rgba(0, 60, 90, 0.85)', stroke: G.rebelBaseRevealed ? '#888' : '#aae0ff', strokeWidth: 1.5, rx: 4 }} />
            <text x={12} y={24} style={{ fill: '#aae0ff', fontSize: 11, fontWeight: 600, pointerEvents: 'none' }}>
              {G.rebelBaseRevealed ? 'Rebel Base space (empty)' : 'Rebel Base space (hidden)'}
            </text>
            <text x={12} y={44} style={{ fill: '#fff', fontSize: 14, fontWeight: 700, pointerEvents: 'none' }}>
              {rbsUnits} Rebel unit{rbsUnits === 1 ? '' : 's'} staged
            </text>
          </g>
        )}
      </svg>

      {/* Enlarged sector preview, fixed top-right of the board */}
      {hoverSystem && <EnlargedSector G={G} system={hoverSystem} />}
      {hoverRebelBase && rebelBaseRect && <EnlargedRebelBase G={G} rect={rebelBaseRect} />}

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 6, left: 6,
        background: 'rgba(0,0,0,0.7)', padding: '6px 10px', borderRadius: 3,
        fontSize: 10, color: '#ccc', display: 'flex', gap: 12, flexWrap: 'wrap',
      }}>
        <span><img src={`${MARKER_IMAGE_BASE}/MarkerLoyaltyRebel.png`} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> Rebel</span>
        <span><img src={`${MARKER_IMAGE_BASE}/MarkerLoyaltyEmpire.png`} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> Imperial</span>
        <span><img src={`${MARKER_IMAGE_BASE}/MarkerLoyaltySubjugated.png`} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> subjugated</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'transparent', border: '1px solid #80dc78', borderRadius: '50%', marginRight: 4, verticalAlign: 'middle' }} /> revealed Rebel base</span>
        <span>R<i>N</i> = Rebel units · E<i>N</i> = Empire units</span>
      </div>
    </div>
  );
}

// ============================================================================
// Faction panel
// ============================================================================

function FactionPanel({ G, side, humanSide }: { G: GameState; side: Side; humanSide: Side }) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const color = sideColor(side);
  return (
    <div style={{
      background: '#15171c', borderRadius: 4, padding: 12,
      border: `1px solid ${color}33`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ color, fontSize: 16 }}>{side}</strong>
        {G.currentPlayer === side && G.phase !== 'GameOver' && (
          <span style={{ background: color, color: '#000', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 600 }}>
            ON TURN
          </span>
        )}
        {G.passedThisCommand.includes(side) && (
          <span style={{ color: '#888', fontSize: 11 }}>passed</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: '#aaa' }}>
        <Row label="Leader pool" value={f.leaderPool.length ? f.leaderPool.join(', ') : '(empty)'} />
        <Row label="Leaders on board" value={Object.keys(f.leadersOnBoard).length ? Object.entries(f.leadersOnBoard).map(([s, l]) => `${s}:${l.join(',')}`).join(' · ') : '(none)'} />
        {side === 'Rebel' && (
          <Row
            label="Units at Rebel Base"
            value={G.map.rebelBaseSpace.units.length === 0 ? '(empty)' : (
              Object.entries(G.map.rebelBaseSpace.units.reduce((acc, u) => {
                acc[u.typeId] = (acc[u.typeId] ?? 0) + 1;
                return acc;
              }, {} as Record<string, number>))
                .map(([t, n]) => `${n}× ${t}`).join(', ')
            )}
          />
        )}
        <Row label="Missions face-down" value={
          side === humanSide
            ? <HandTip count={f.leadersOnMissions.length} cards={f.leadersOnMissions.map((m) => {
                const c = G.catalog.missions[m.missionId];
                return { name: c?.name ?? m.missionId, image: c?.image, rulesText: c?.rulesText };
              })} />
            : `${f.leadersOnMissions.length} cards`
        } />
        <Row label="Action hand" value={
          side === humanSide
            ? <HandTip count={f.actionHand.length} cards={f.actionHand.map((cid) => {
                const c = G.catalog.actions[cid];
                return { name: c?.name ?? cid, image: c?.image, rulesText: c?.rulesText };
              })} />
            : `${f.actionHand.length} cards`
        } />
        <Row label="Action deck" value={`${f.actionDeck.length} cards`} />
        <Row label="Mission hand" value={
          side === humanSide
            ? <HandTip count={f.missionHand.length} cards={f.missionHand.map((cid) => {
                const c = G.catalog.missions[cid];
                return { name: c?.name ?? cid, image: c?.image, rulesText: c?.rulesText };
              })} />
            : `${f.missionHand.length} cards`
        } />
        <Row label="Mission deck" value={`${f.missionDeck.length} cards`} />
        {side === 'Rebel' && (
          <Row label="Objective hand" value={
            side === humanSide
              ? <HandTip count={f.objectiveHand?.length ?? 0} cards={(f.objectiveHand ?? []).map((cid) => {
                  const c = G.catalog.objectives[cid];
                  return { name: c?.name ?? cid, image: c?.image, rulesText: c?.rulesText };
                })} />
              : `${f.objectiveHand?.length ?? 0} cards`
          } />
        )}
        {side === 'Empire' && (
          <>
            <Row
              label="Probe hand"
              value={
                <ProbeHandValue
                  probeHand={f.probeHand ?? []}
                  catalog={G.catalog}
                  visible={humanSide === 'Empire'}
                />
              }
            />
            <Row label="Project deck" value={`${f.projectDeck?.length ?? 0} cards`} />
            <Row label="Captured leaders" value={`${f.capturedLeaders?.length ?? 0}`} />
          </>
        )}
        <Row label="Build queue 3 / 2 / 1" value={`${f.buildQueue[3].length} / ${f.buildQueue[2].length} / ${f.buildQueue[1].length}`} />
      </div>
    </div>
  );
}

// ============================================================================
// Rebel Base Pick Panel — choose 1 of 5 candidate hidden-base systems
// ============================================================================

function RebelBasePickPanel({ G, onPick }: { G: GameState; onPick: (sysId: string) => void }) {
  const candidates = G.pendingRebelBasePick ?? [];
  if (candidates.length === 0) return null;
  const color = sideColor('Rebel');
  // Sort alphabetically by display name for easy scanning.
  const sorted = [...candidates].sort((a, b) => {
    const an = G.catalog.systems[a]?.name ?? a;
    const bn = G.catalog.systems[b]?.name ?? b;
    return an.localeCompare(bn);
  });
  return (
    <div style={{
      marginTop: 12, background: '#15171c', borderRadius: 4, padding: 12,
      border: `2px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ color, fontSize: 15 }}>Setup — Rebel: hide your base</strong>
        <span style={{ color: '#888', fontSize: 12 }}>
          Per rr p.15 step 9: secretly pick one system from the probe deck ({candidates.length} valid).
          The probe is removed so the Empire can't draw it during Refresh.
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 4,
      }}>
        {sorted.map((sysId) => {
          const sd = G.catalog.systems[sysId];
          if (!sd) return null;
          return (
            <button
              key={sysId}
              onClick={() => onPick(sysId)}
              style={{
                padding: '6px 10px',
                background: '#0c0d10',
                border: `1px solid ${color}`,
                color: '#e8e8ea',
                borderRadius: 3, cursor: 'pointer', fontSize: 12,
                textAlign: 'left',
              }}
              title={`region ${sd.region}${sd.isRemote ? ' · remote' : ' · populous'}`}
            >
              <div style={{ fontWeight: 600 }}>{sd.name}</div>
              <div style={{ fontSize: 10, color: '#aaa' }}>
                r{sd.region} · {sd.isRemote ? 'remote' : 'populous'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================================
// Setup Panel — choose where to deploy starting units
// ============================================================================

function SetupPanel({ G, side, onDeploy, onAutoFill }: {
  G: GameState;
  side: Side;
  onDeploy: (side: Side, typeId: string, systemId: string) => void;
  onAutoFill: (side: Side) => void;
}) {
  const pending = G.pendingDeployment?.[side] ?? [];
  const color = sideColor(side);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const unitStyle = useUnitStyle();

  // Group pending units by type for display. Not memoed: the underlying
  // array is mutated in place by the engine (splice), so its reference
  // doesn't change — memo deps would never invalidate.
  const grouped = (() => {
    const counts = new Map<string, number>();
    for (const t of pending) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([typeId, count]) => ({ typeId, count }));
  })();

  // Legal targets
  const legalTargets: { id: string; name: string; note?: string }[] = [];
  if (side === 'Empire') {
    for (const [sysId, ss] of Object.entries(G.map.systems)) {
      if (ss.loyalty === 'imperial' || ss.subjugated) {
        const sysDef = G.catalog.systems[sysId];
        const hasGround = ss.units.some((u) => {
          const t = G.catalog.unitTypes[u.typeId];
          return u.side === 'Empire' && t?.theater === 'ground';
        });
        legalTargets.push({
          id: sysId, name: sysDef?.name ?? sysId,
          note: hasGround ? undefined : 'needs ground unit',
        });
      }
    }
  } else {
    legalTargets.push({ id: 'rebel-base-space', name: 'Rebel Base space', note: 'staging area (hidden)' });
    if (G.rebelDeployTarget) {
      const sysDef = G.catalog.systems[G.rebelDeployTarget];
      legalTargets.push({ id: G.rebelDeployTarget, name: sysDef?.name ?? G.rebelDeployTarget, note: 'chosen Rebel system' });
    } else {
      for (const [sysId, ss] of Object.entries(G.map.systems)) {
        const sysDef = G.catalog.systems[sysId];
        if (sysDef?.isCoruscant) continue;
        if (ss.subjugated || ss.loyalty === 'imperial') continue;
        legalTargets.push({ id: sysId, name: sysDef?.name ?? sysId });
      }
    }
  }

  return (
    <div style={{
      marginTop: 12, background: '#15171c', borderRadius: 4, padding: 12,
      border: `2px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <strong style={{ color, fontSize: 15 }}>Setup — {side} unit deployment</strong>
        <span style={{ color: '#888', fontSize: 12 }}>
          {pending.length} unit{pending.length === 1 ? '' : 's'} left to place.{' '}
          {side === 'Empire' && '(Place in Imperial-loyalty or subjugated systems; every Imperial system needs ≥1 ground unit.)'}
          {side === 'Rebel' && '(Rebel Base space and/or one Rebel/neutral system of your choice.)'}
        </span>
        <button
          className="tab-button"
          style={{ marginLeft: 'auto' }}
          onClick={() => onAutoFill(side)}
          disabled={pending.length === 0}
        >
          Auto-fill (computer chooses)
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Pending units */}
        <div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Step 1: pick a unit type
          </div>
          {grouped.length === 0 && (
            <div style={{ color: '#80dc78', fontSize: 13 }}>
              ✓ {side} has placed all starting units.{side === 'Empire' ? ' Waiting for Rebel.' : ''}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {grouped.map((g) => {
              const isSelected = selectedType === g.typeId;
              const file = UNIT_IMAGE[g.typeId];
              return (
                <button
                  key={g.typeId}
                  onClick={() => setSelectedType(g.typeId)}
                  style={{
                    position: 'relative',
                    padding: 4,
                    background: isSelected ? color : '#0c0d10',
                    border: '2px solid ' + (isSelected ? color : '#2a2d34'),
                    borderRadius: 4,
                    cursor: 'pointer',
                    width: 56,
                    height: 56,
                  }}
                  title={g.typeId}
                >
                  {file && <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={44} height={44} alt={g.typeId} />}
                  <span style={{
                    position: 'absolute', bottom: 2, right: 2,
                    background: '#000', color: '#fff', borderRadius: '50%',
                    fontSize: 10, fontWeight: 700, width: 16, height: 16,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px solid #fff',
                  }}>{g.count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Legal targets */}
        <div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Step 2: click a destination
          </div>
          {!selectedType && (
            <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>
              (pick a unit first)
            </div>
          )}
          {selectedType && legalTargets.length === 0 && (
            <div style={{ color: '#ff8866', fontSize: 12 }}>
              No legal targets — Empire needs Imperial-loyalty/subjugated systems.
            </div>
          )}
          {selectedType && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
              {legalTargets.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onDeploy(side, selectedType, t.id)}
                  style={{
                    textAlign: 'left',
                    padding: '4px 8px',
                    background: '#0c0d10',
                    color: '#e8e8ea',
                    border: `1px solid ${t.note?.includes('needs') ? '#ff8866' : '#2a2d34'}`,
                    borderRadius: 3,
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  {t.note && <div style={{ fontSize: 10, color: t.note.includes('needs') ? '#ff8866' : '#888' }}>{t.note}</div>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Command Panel — Activate a system
// ============================================================================
//
// Three-step picker:
//   1. Pick a leader (must be in pool, must have nonzero tactic value).
//   2. Pick a target system (any system on the map — engine validates).
//   3. (Optional) For each adjacent friendly system without your own leader,
//      pick units to move into the target.
// Click Activate → engine handles placement, movement, and auto-combat.

function CommandPanel({ G, side, onActivate, onReveal, onPass }: {
  G: GameState;
  side: Side;
  onActivate: (leaderId: string, targetSystemId: string, moveOrders: phases.MoveOrder[]) => boolean | void;
  onReveal: (missionId: string, targetSystemId: string) => boolean | void;
  onPass: () => void;
}) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const color = sideColor(side);
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [targetSystemId, setTargetSystemId] = useState<string | null>(null);
  // moveCounts: fromSystemId -> typeId -> count to move
  const [moveCounts, setMoveCounts] = useState<Record<string, Record<string, number>>>({});

  // Eligible leaders: in pool, with combat-relevant tactic values.
  const eligibleLeaders = f.leaderPool.filter((lid) => {
    const l = G.catalog.leaders[lid];
    return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
  });

  // Valid sources for moves: systems adjacent to target (or the target itself —
  // pre-existing friendly units), where the human has no leader.
  const sources: string[] = [];
  if (targetSystemId) {
    const adj = G.catalog.adjacency[targetSystemId] ?? [];
    for (const sysId of adj) {
      if ((f.leadersOnBoard[sysId] ?? []).length > 0) continue;
      const ss = G.map.systems[sysId];
      if (!ss) continue;
      const hasOwn = ss.units.some((u) => u.side === side);
      if (hasOwn) sources.push(sysId);
    }
    // Rebel can also pull from rebel-base-space (engine accepts it without adjacency check).
    if (side === 'Rebel' && G.map.rebelBaseSpace.units.length > 0) sources.push('rebel-base-space');
  }

  const reset = () => {
    setLeaderId(null);
    setTargetSystemId(null);
    setMoveCounts({});
  };

  const bump = (sysId: string, typeId: string, delta: number, max: number) => {
    setMoveCounts((m) => {
      const sub = { ...(m[sysId] ?? {}) };
      const cur = sub[typeId] ?? 0;
      const next = Math.max(0, Math.min(max, cur + delta));
      if (next === 0) delete sub[typeId];
      else sub[typeId] = next;
      return { ...m, [sysId]: sub };
    });
  };

  // Mode toggle: 'activate' (default) or 'reveal' a mission.
  const [mode, setMode] = useState<'activate' | 'reveal'>('activate');
  const [revealMissionId, setRevealMissionId] = useState<string | null>(null);
  const [revealTargetSysId, setRevealTargetSysId] = useState<string | null>(null);

  const assignedMissions = f.leadersOnMissions;

  const handleReveal = () => {
    if (!revealMissionId || !revealTargetSysId) return;
    const ok = onReveal(revealMissionId, revealTargetSysId);
    if (ok !== false) {
      setRevealMissionId(null);
      setRevealTargetSysId(null);
    }
  };

  const handleActivate = () => {
    if (!leaderId || !targetSystemId) return;
    // Build moveOrders: convert (sysId × typeId × count) → unit instance IDs.
    const orders: phases.MoveOrder[] = [];
    for (const sysId of Object.keys(moveCounts)) {
      const sub = moveCounts[sysId];
      const src = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
      if (!src) continue;
      const ids: string[] = [];
      for (const typeId of Object.keys(sub)) {
        const want = sub[typeId];
        const matching = src.units.filter((u) => u.side === side && u.typeId === typeId).slice(0, want);
        ids.push(...matching.map((u) => u.instanceId));
      }
      if (ids.length > 0) orders.push({ fromSystemId: sysId, unitInstanceIds: ids });
    }
    const ok = onActivate(leaderId, targetSystemId, orders);
    if (ok !== false) reset();
  };

  return (
    <div style={{
      marginTop: 12, background: '#15171c', borderRadius: 4, padding: 12,
      border: `2px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <strong style={{ color, fontSize: 15 }}>Command — {side}:</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={`tab-button ${mode === 'activate' ? 'active' : ''}`}
            onClick={() => setMode('activate')}
            style={{ fontSize: 14, fontWeight: 600, padding: '6px 14px' }}
          >Activate a system</button>
          <button
            className={`tab-button ${mode === 'reveal' ? 'active' : ''}`}
            onClick={() => setMode('reveal')}
            disabled={assignedMissions.length === 0}
            title={assignedMissions.length === 0 ? 'No missions assigned' : `${assignedMissions.length} assigned mission${assignedMissions.length === 1 ? '' : 's'}`}
            style={{ fontSize: 14, fontWeight: 600, padding: '6px 14px' }}
          >Reveal a mission {assignedMissions.length > 0 ? `(${assignedMissions.length})` : ''}</button>
        </div>
        <button
          className="tab-button"
          style={{ marginLeft: 'auto', fontSize: 14, padding: '6px 14px' }}
          onClick={onPass}
        >Pass</button>
        {mode === 'activate' && (leaderId || targetSystemId) && (
          <button className="tab-button" onClick={reset}>Reset picks</button>
        )}
      </div>

      {mode === 'reveal' && (
        <div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Step 1 — pick an assigned mission
          </div>
          {assignedMissions.length === 0 && (
            <div style={{ color: '#888', fontSize: 12 }}>(none assigned this round)</div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
            {assignedMissions.map((am) => {
              const card = G.catalog.missions[am.missionId];
              if (!card) return null;
              const isSel = revealMissionId === am.missionId;
              const leaderNames = am.leaderIds.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(' + ');
              // Skill total
              const need = card.skill;
              let total = 0;
              for (const lid of am.leaderIds) {
                const ld = G.catalog.leaders[lid];
                if (ld && need) total += ld.skills[need as keyof typeof ld.skills] ?? 0;
              }
              const meets = need ? total >= card.skillCost : true;
              return (
                <button
                  key={am.missionId}
                  onClick={() => setRevealMissionId(am.missionId)}
                  style={{
                    padding: '6px 10px',
                    background: isSel ? color : '#0c0d10',
                    border: `1px solid ${isSel ? color : (meets ? '#2a2d34' : '#5a2020')}`,
                    color: isSel ? '#000' : '#e8e8ea',
                    borderRadius: 3, cursor: 'pointer', fontSize: 12, textAlign: 'left',
                    minWidth: 200,
                  }}
                  title={card.rulesText ? `${card.name}\n\n${card.rulesText}` : card.name}
                >
                  <div style={{ fontWeight: 600 }}>{card.name}</div>
                  <div style={{ fontSize: 10, opacity: 0.85 }}>
                    {leaderNames} · {need ? `${need} ${total}/${card.skillCost}` : '(no skill)'} {!meets && <span style={{ color: '#ff8866' }}>insufficient</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {revealMissionId && (() => {
            const targets = missionTargets(G, side, revealMissionId);
            return (
            <>
              <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
                Step 2 — pick the target system
                {targets.note && (
                  <span style={{ marginLeft: 6, color: targets.permissive ? '#ff8866' : '#80dc78' }}>
                    {targets.note}
                  </span>
                )}
              </div>
              {targets.systemIds.length === 0 && (
                <div style={{ color: '#ff8866', fontSize: 12, marginBottom: 6 }}>
                  No legal targets for this mission right now.
                </div>
              )}
              <select
                value={revealTargetSysId ?? ''}
                onChange={(e) => setRevealTargetSysId(e.target.value || null)}
                disabled={targets.systemIds.length === 0}
                style={{
                  background: '#0c0d10', color: '#e8e8ea',
                  border: '1px solid #3a3d44', borderRadius: 3, padding: '4px 8px', fontSize: 12,
                  minWidth: 220,
                }}
              >
                <option value="">— pick target system —</option>
                {[...targets.systemIds].sort().map((sysId) => (
                  <option key={sysId} value={sysId}>{G.catalog.systems[sysId]?.name ?? sysId}</option>
                ))}
              </select>
              <div style={{ marginTop: 8 }}>
                <button
                  className="tab-button active"
                  onClick={handleReveal}
                  disabled={!revealMissionId || !revealTargetSysId}
                  style={{ fontWeight: 700 }}
                >
                  Reveal mission
                </button>
              </div>
            </>
            );
          })()}
        </div>
      )}

      {mode === 'activate' && (<>
      {/* Step 1: Leader */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>Step 1 — leader (pool, with tactic values)</div>
        {eligibleLeaders.length === 0 && (
          <div style={{ color: '#ff8866', fontSize: 12 }}>
            No eligible leaders in pool. (Already on board / on missions, or pool empty.)
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {eligibleLeaders.map((lid) => {
            const l = G.catalog.leaders[lid]!;
            const isSel = leaderId === lid;
            return (
              <button
                key={lid}
                onClick={() => setLeaderId(lid)}
                style={{
                  padding: '4px 8px',
                  background: isSel ? color : '#0c0d10',
                  border: `1px solid ${isSel ? color : '#2a2d34'}`,
                  color: isSel ? '#000' : '#e8e8ea',
                  borderRadius: 3, cursor: 'pointer', fontSize: 12,
                }}
                title={`space ${l.tacticValues.space}, ground ${l.tacticValues.ground}`}
              >
                {l.name} <span style={{ opacity: 0.7 }}>(S{l.tacticValues.space}/G{l.tacticValues.ground})</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2: Target */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>Step 2 — target system</div>
        {!leaderId && <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>(pick a leader first)</div>}
        {leaderId && (
          <select
            value={targetSystemId ?? ''}
            onChange={(e) => { setTargetSystemId(e.target.value || null); setMoveCounts({}); }}
            style={{
              background: '#0c0d10', color: '#e8e8ea',
              border: '1px solid #3a3d44', borderRadius: 3, padding: '4px 8px', fontSize: 12,
              minWidth: 220,
            }}
          >
            <option value="">— pick target system —</option>
            {Object.keys(G.map.systems).sort().map((sysId) => {
              const sd = G.catalog.systems[sysId];
              return <option key={sysId} value={sysId}>{sd?.name ?? sysId}</option>;
            })}
          </select>
        )}
        {targetSystemId && (
          <span style={{ marginLeft: 8, fontSize: 12, color: '#ffd54a' }}>
            → {G.catalog.systems[targetSystemId]?.name ?? targetSystemId}
          </span>
        )}
      </div>

      {/* Step 3: Move orders */}
      {leaderId && targetSystemId && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Step 3 — optional: move units from adjacent friendly systems
          </div>
          {sources.length === 0 && (
            <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>
              (no adjacent systems with your units, or you have a leader present blocking them)
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
            {sources.map((sysId) => {
              const src = sysId === 'rebel-base-space' ? G.map.rebelBaseSpace : G.map.systems[sysId];
              const name = sysId === 'rebel-base-space' ? 'Rebel Base space' : (G.catalog.systems[sysId]?.name ?? sysId);
              const byType = groupByType(src.units.filter((u) => u.side === side));
              return (
                <div key={sysId} style={{ background: '#0c0d10', padding: 6, borderRadius: 3, border: '1px solid #2a2d34' }}>
                  <div style={{ fontSize: 11, color: '#ccc', marginBottom: 4, fontWeight: 600 }}>{name}</div>
                  {byType.map((g) => {
                    const cur = moveCounts[sysId]?.[g.typeId] ?? 0;
                    return (
                      <div key={g.typeId} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                        <span style={{ flex: 1, fontSize: 11, color: '#aaa' }}>{g.typeId}</span>
                        <button className="tab-button" style={{ padding: '0 6px', fontSize: 14 }} onClick={() => bump(sysId, g.typeId, -1, g.count)} disabled={cur <= 0}>−</button>
                        <span style={{ minWidth: 28, textAlign: 'center', fontSize: 12, color: cur > 0 ? '#ffd54a' : '#666' }}>
                          {cur}/{g.count}
                        </span>
                        <button className="tab-button" style={{ padding: '0 6px', fontSize: 14 }} onClick={() => bump(sysId, g.typeId, +1, g.count)} disabled={cur >= g.count}>+</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          className="tab-button active"
          onClick={handleActivate}
          disabled={!leaderId || !targetSystemId}
          style={{ fontWeight: 700 }}
        >
          Activate
        </button>
        <span style={{ color: '#888', fontSize: 11 }}>
          (no units selected = just place the leader, no movement)
        </span>
      </div>
      </>)}
    </div>
  );
}

// ============================================================================
// Assignment Panel
// ============================================================================

function AssignmentPanel({ G, side, onChange }: { G: GameState; side: Side; onChange: () => void }) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const color = sideColor(side);
  const [pickerMissionId, setPickerMissionId] = useState<string | null>(null);
  const [selectedLeaders, setSelectedLeaders] = useState<string[]>([]);

  const startPicker = (missionId: string) => {
    setPickerMissionId(missionId);
    setSelectedLeaders([]);
  };

  const toggleLeader = (leaderId: string) => {
    setSelectedLeaders((prev) =>
      prev.includes(leaderId) ? prev.filter((l) => l !== leaderId) : (prev.length < 2 ? [...prev, leaderId] : prev)
    );
  };

  const confirmAssign = () => {
    if (!pickerMissionId || selectedLeaders.length === 0) return;
    const result = phases.assignLeader(G, side, pickerMissionId, selectedLeaders);
    if (!result.ok) {
      alert(`Could not assign: ${result.reason}`);
      return;
    }
    setPickerMissionId(null);
    setSelectedLeaders([]);
    onChange();
  };

  return (
    <div style={{
      marginTop: 12, background: '#15171c', borderRadius: 4, padding: 12,
      border: `2px solid ${color}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ color, fontSize: 15 }}>{side} — Assignment Phase</strong>
        <span style={{ color: '#888', fontSize: 12 }}>
          Pick a mission, assign 1–2 leaders. The skill total is shown live; you can
          still assign with insufficient skill, but the reveal will be rejected.
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Missions to assign */}
        <div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Your mission hand ({f.missionHand.length})
          </div>
          <div style={{ maxHeight: 240, overflowY: 'auto' }}>
            {f.missionHand.length === 0 && (
              <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>(no missions to assign)</div>
            )}
            {f.missionHand.map((mid) => {
              const card = G.catalog.missions[mid];
              if (!card) return null;
              return (
                <div
                  key={mid}
                  style={{
                    padding: '6px 8px', marginBottom: 4, borderRadius: 3,
                    background: '#0c0d10', border: '1px solid #2a2d34',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ flex: 1, color: '#e8e8ea' }}>{card.name}</strong>
                    <span style={{ color: '#888', fontSize: 11 }}>
                      {card.skill} × {card.skillCost}
                    </span>
                    <button
                      className="tab-button"
                      onClick={() => startPicker(mid)}
                      style={{ padding: '2px 8px', fontSize: 11 }}
                    >
                      assign
                    </button>
                  </div>
                  {card.rulesText && (
                    <div style={{ color: '#888', fontSize: 11, marginTop: 4, lineHeight: 1.3 }}>
                      {card.rulesText}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: '#aaa' }}>
            Already assigned ({f.leadersOnMissions.length}):
          </div>
          <div style={{ fontSize: 11, color: '#80dc78' }}>
            {f.leadersOnMissions.length === 0 ? (
              <span style={{ color: '#666' }}>(none yet)</span>
            ) : (
              f.leadersOnMissions.map((a, i) => {
                const card = G.catalog.missions[a.missionId];
                return (
                  <div key={i}>
                    <strong>{card?.name ?? a.missionId}</strong> ← {a.leaderIds.map(lid => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Leader pool */}
        <div>
          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
            Your leader pool ({f.leaderPool.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {f.leaderPool.length === 0 && (
              <div style={{ color: '#666', fontSize: 12, fontStyle: 'italic' }}>(no available leaders)</div>
            )}
            {f.leaderPool.map((lid) => {
              const leader = G.catalog.leaders[lid];
              if (!leader) return null;
              const selectable = pickerMissionId !== null;
              const isSelected = selectedLeaders.includes(lid);
              return (
                <button
                  key={lid}
                  disabled={!selectable}
                  onClick={() => toggleLeader(lid)}
                  style={{
                    textAlign: 'left',
                    padding: '4px 8px',
                    background: isSelected ? color : '#0c0d10',
                    color: isSelected ? '#000' : '#e8e8ea',
                    border: `1px solid ${isSelected ? color : '#2a2d34'}`,
                    borderRadius: 3,
                    cursor: selectable ? 'pointer' : 'default',
                    opacity: selectable ? 1 : 0.5,
                    fontSize: 12,
                  }}
                >
                  <strong>{leader.name}</strong>
                  <span style={{ marginLeft: 6, color: isSelected ? '#000a' : '#888', fontSize: 10 }}>
                    {Object.entries(leader.skills)
                      .filter(([, v]) => v > 0)
                      .map(([k, v]) => `${k}:${v}`)
                      .join(' ')}
                    {' '}· tactic s{leader.tacticValues.space}/g{leader.tacticValues.ground}
                  </span>
                </button>
              );
            })}
          </div>

          {pickerMissionId && (() => {
            const card = G.catalog.missions[pickerMissionId];
            const skill = card?.skill;
            const cost = card?.skillCost ?? 0;
            let total = 0;
            if (skill) {
              for (const lid of selectedLeaders) {
                const ld = G.catalog.leaders[lid];
                if (ld) total += ld.skills[skill as keyof typeof ld.skills] ?? 0;
              }
            }
            const meets = !skill ? true : total >= cost;
            const empty = selectedLeaders.length === 0;
            return (
              <div style={{
                marginTop: 12, padding: 8,
                background: empty ? '#1f1a14' : (meets ? '#16271a' : '#2a1414'),
                borderRadius: 3,
                border: `1px solid ${empty ? '#3a2f14' : (meets ? '#3a6b46' : '#7a2828')}`,
              }}>
                <div style={{ fontSize: 12, color: '#ffd54a', marginBottom: 4 }}>
                  Assigning to: <strong>{card?.name}</strong>
                  {skill && (
                    <span style={{ marginLeft: 8, color: '#aaa', fontSize: 11, fontWeight: 'normal' }}>
                      needs <strong style={{ color: '#fff' }}>{skill} × {cost}</strong>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 6 }}>
                  Selected: {selectedLeaders.map(lid => G.catalog.leaders[lid]?.name).join(', ') || '(none)'} · 1–2 leaders
                </div>
                {skill && !empty && (
                  <div style={{
                    fontSize: 12, marginBottom: 6,
                    color: meets ? '#80dc78' : '#ff8866',
                    fontWeight: 600,
                  }}>
                    {meets
                      ? `✓ ${skill} total: ${total} / ${cost} (sufficient — would roll ${total} dice on reveal)`
                      : `✗ ${skill} total: ${total} / ${cost} (insufficient — reveal will be rejected)`
                    }
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="tab-button active"
                    onClick={confirmAssign}
                    disabled={empty}
                    title={!meets && !empty ? 'Insufficient skill — you can still assign, but reveal will fail unless you add more dice via other means.' : ''}
                  >
                    Confirm assign{!meets && !empty ? ' (insufficient)' : ''}
                  </button>
                  <button className="tab-button" onClick={() => { setPickerMissionId(null); setSelectedLeaders([]); }}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Turn Track
// ============================================================================

// Time-track icons per turn, verified against the printed 16-space board:
//   Recruit icon on turns 2-5 (both sides).
//   Build icon on every even turn (both sides).
// Turn 14 carries the Rebel starting-reputation marker — if the time marker
// reaches the reputation marker without the base being destroyed, the Rebels
// win. Reputation gains slide the reputation marker left, shortening the
// Empire's deadline.
const RECRUIT_TURNS = new Set([2, 3, 4, 5]);
const BUILD_TURNS = new Set([2, 4, 6, 8, 10, 12, 14, 16]);
const TRACK_LENGTH = 16;
const TRACK_WINDOW = 8;

function TurnTrack({ G }: { G: GameState }) {
  // The track is 16 turns long but we only show an 8-cell sliding window.
  // The window starts at the current turn and slides right as turns advance,
  // until it would run off the end — then it sticks so the final turn stays
  // visible.
  const firstVisible = Math.min(
    G.timeMarker,
    Math.max(1, TRACK_LENGTH - TRACK_WINDOW + 1)
  );
  const visibleTurns = Array.from(
    { length: Math.min(TRACK_WINDOW, TRACK_LENGTH - firstVisible + 1) },
    (_, i) => firstVisible + i
  );
  return (
    <div style={{
      background: '#15171c', borderRadius: 4, padding: 10, marginBottom: 10,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ fontSize: 12, color: '#aaa', minWidth: 70 }}>Turn track:</span>
      <div style={{ display: 'flex', gap: 4, flex: 1 }}>
        {visibleTurns.map((t) => {
          const isCurrent = t === G.timeMarker;
          const isPast = false; // never past in this view
          const isReputation = t === G.reputationMarker;
          const hasRecruit = RECRUIT_TURNS.has(t);
          const hasBuild = BUILD_TURNS.has(t);
          return (
            <div
              key={t}
              style={{
                flex: 1,
                padding: '6px 4px',
                background: isCurrent ? '#ffd54a' : isPast ? '#2a2d34' : '#0c0d10',
                color: isCurrent ? '#000' : isPast ? '#888' : '#e8e8ea',
                border: `1px solid ${isCurrent ? '#ffd54a' : '#2a2d34'}`,
                borderRadius: 3,
                textAlign: 'center',
                fontSize: 11,
                position: 'relative',
              }}
            >
              <div style={{ fontWeight: 700, fontSize: 14 }}>{t}</div>
              <div style={{ fontSize: 9, marginTop: 2, color: isCurrent ? '#444' : '#888' }}>
                {hasRecruit && hasBuild ? 'R+B' : hasRecruit ? 'R' : hasBuild ? 'B' : '—'}
              </div>
              {isReputation && (
                <div
                  title="Reputation marker"
                  style={{
                    position: 'absolute', top: -6, right: -6,
                    background: '#aae0ff', color: '#000', borderRadius: '50%',
                    width: 18, height: 18, fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    border: '1px solid #0c0d10',
                  }}
                >
                  ★
                </div>
              )}
            </div>
          );
        })}
      </div>
      <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>
        Reputation: <span style={{ color: '#aae0ff', fontWeight: 600 }}>{G.reputationMarker}</span> · <span style={{ color: '#888' }}>R=Recruit, B=Build</span>
      </span>
    </div>
  );
}

// ============================================================================
// Decks Panel
// ============================================================================

function DecksPanel({ G, onProbeHover }: { G: GameState; onProbeHover?: (active: boolean) => void }) {
  const decks: Array<{ label: string; count: number; color: string; subtle?: string; isProbe?: boolean }> = [
    { label: 'Probe deck',           count: G.probeDeck.length,                color: '#7986cb', subtle: G.empire.probeHand?.length ? `+${G.empire.probeHand.length} drawn` : undefined, isProbe: true },
    { label: 'Objective deck',       count: G.rebel.objectiveDeck?.length ?? 0, color: '#aed581', subtle: G.rebel.objectiveHand?.length ? `+${G.rebel.objectiveHand.length} in hand` : undefined },
    { label: 'Rebel mission deck',   count: G.rebel.missionDeck.length,         color: '#4fc3f7' },
    { label: 'Empire mission deck',  count: G.empire.missionDeck.length,        color: '#ff8a80' },
    { label: 'Empire project deck',  count: G.empire.projectDeck?.length ?? 0,  color: '#ff8a80', subtle: 'projects' },
    { label: 'Rebel action deck',    count: G.rebel.actionDeck.length,          color: '#4fc3f7', subtle: 'recruit' },
    { label: 'Empire action deck',   count: G.empire.actionDeck.length,         color: '#ff8a80', subtle: 'recruit' },
    { label: 'Space tactic deck',    count: G.spaceTacticDeck.length,           color: '#80dc78', subtle: G.spaceTacticDiscard.length ? `(${G.spaceTacticDiscard.length} disc.)` : undefined },
    { label: 'Ground tactic deck',   count: G.groundTacticDeck.length,          color: '#80dc78', subtle: G.groundTacticDiscard.length ? `(${G.groundTacticDiscard.length} disc.)` : undefined },
  ];

  return (
    <div style={{
      background: '#15171c', borderRadius: 4, padding: 10, marginBottom: 10,
      display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: 6,
    }}>
      {decks.map((d) => (
        <div
          key={d.label}
          style={{
            background: '#0c0d10', border: `1px solid ${d.color}55`, borderRadius: 3,
            padding: '6px 8px', textAlign: 'center',
            cursor: d.isProbe && onProbeHover ? 'help' : 'default',
          }}
          title={
            d.isProbe && onProbeHover
              ? `${d.label} — hover to highlight systems ruled out by drawn probes`
              : d.label
          }
          onMouseEnter={d.isProbe && onProbeHover ? () => onProbeHover(true) : undefined}
          onMouseLeave={d.isProbe && onProbeHover ? () => onProbeHover(false) : undefined}
        >
          <div style={{ fontSize: 9, color: d.color, lineHeight: 1.2, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {d.label}
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#e8e8ea', lineHeight: 1 }}>
            {d.count}
          </div>
          {d.subtle && (
            <div style={{ fontSize: 9, color: '#888', marginTop: 2 }}>{d.subtle}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
      <span style={{ minWidth: 130, color: '#888' }}>{label}:</span>
      <span style={{ flex: 1, color: '#e8e8ea', fontFamily: 'monospace', fontSize: 11 }}>{value}</span>
    </div>
  );
}

/** Renders the Empire's probe hand. If `visible` (the human is Empire),
 *  shows each card's revealed system name; otherwise just the count.
 *  Probe cards are hidden info from the Rebel (rr p.10). */
function ProbeHandValue({ probeHand, catalog, visible }: {
  probeHand: string[];
  catalog: GameState['catalog'];
  visible: boolean;
}) {
  if (probeHand.length === 0) return <>0 cards</>;
  if (!visible) return <>{probeHand.length} cards (hidden)</>;
  const names = probeHand.map((pid) => {
    const probe = catalog.probes[pid];
    if (!probe) return pid;
    const sys = catalog.systems[probe.systemId];
    return sys?.name ?? probe.systemId;
  });
  return (
    <span style={{ color: '#ffd54a' }}>
      {probeHand.length} cards — {names.join(', ')}
    </span>
  );
}

// ============================================================================
// Log
// ============================================================================

// ----- Mission-roll log entry: render dice faces inline -----
type MissionRollPayload = {
  missionId: string;
  skill: string;
  attacker: { dice: number; successes: number; portrait?: number; total?: number; faces: string[] };
  opposer: { side: Side; leaderIds: string[]; dice: number; successes: number; faces: string[] };
  result: 'success' | 'failure';
};

function DieFaceImg({ face, color = 'black' }: { face: string; color?: 'red' | 'black' | 'green' }) {
  const f = face as 'hit' | 'direct-hit' | 'special' | 'blank';
  const url = diceImageUrl(color, f);
  if (!url) return <span style={{ marginRight: 1 }}>{color[0]}:{face}</span>;
  return (
    <img src={url} width={18} height={18} alt={`${color} ${face}`} title={`${color} ${face}`}
      style={{ verticalAlign: 'middle', marginRight: 1, imageRendering: 'pixelated' }} />
  );
}

function DiceRow({ faces, label, hits, total }: { faces: string[]; label: string; hits: number; total: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 10 }}>
      <span style={{ color: '#aaa', marginRight: 4 }}>{label}</span>
      {faces.length === 0 ? (
        <span style={{ color: '#666', fontStyle: 'italic' }}>(none)</span>
      ) : (
        faces.map((f, i) => <DieFaceImg key={i} face={f} />)
      )}
      <span style={{ marginLeft: 6, color: '#fff' }}>{hits}<span style={{ color: '#888' }}>/{total}d</span> successes</span>
    </span>
  );
}

type CombatAttackPayload = {
  theater: 'space' | 'ground';
  dice: { color: 'red' | 'black' | 'green'; face: string }[];
  attackers: number;
};

function CombatAttackEntry({ payload }: { payload: CombatAttackPayload }) {
  const hits = payload.dice.filter((d) => d.face === 'hit' || d.face === 'direct-hit').length;
  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
      <span style={{ color: '#888' }}>{payload.theater} · {payload.attackers} unit{payload.attackers === 1 ? '' : 's'}</span>
      <span style={{ marginLeft: 4 }}>
        {payload.dice.length === 0 ? (
          <span style={{ color: '#666', fontStyle: 'italic' }}>(no attack)</span>
        ) : (
          payload.dice.map((d, i) => <DieFaceImg key={i} face={d.face} color={d.color} />)
        )}
      </span>
      <span style={{ marginLeft: 6, color: '#fff' }}>{hits} hit{hits === 1 ? '' : 's'}</span>
    </span>
  );
}

function MissionRollEntry({ payload, side }: { payload: MissionRollPayload; side?: Side }) {
  const winColor = payload.result === 'success' ? '#80dc78' : '#ff8866';
  const attTotal = payload.attacker.total ?? payload.attacker.successes;
  const portrait = payload.attacker.portrait ?? 0;
  return (
    <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
      <span style={{ color: '#888' }}>{payload.missionId} ({payload.skill})</span>
      <DiceRow label={side ?? 'attacker'} faces={payload.attacker.faces} hits={attTotal} total={payload.attacker.dice} />
      {portrait > 0 && <span style={{ color: '#ffd54a', fontSize: 11 }}>(+{portrait} portrait)</span>}
      <span style={{ color: '#666' }}>vs</span>
      <DiceRow label={payload.opposer.side} faces={payload.opposer.faces} hits={payload.opposer.successes} total={payload.opposer.dice} />
      <span style={{ color: winColor, fontWeight: 700, marginLeft: 4 }}>
        {payload.result.toUpperCase()}
      </span>
    </span>
  );
}

function LogPanel({ G }: { G: GameState }) {
  return (
    <div style={{
      background: '#15171c', borderRadius: 4, padding: 12, marginTop: 12,
      maxHeight: 240, overflowY: 'auto',
    }}>
      <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
        Log ({G.turnLog.length} entries)
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
        {G.turnLog.slice(-100).map((entry, i) => (
          <div key={i} style={{ color: entry.side ? sideColor(entry.side) : '#aaa', marginBottom: entry.kind === 'mission-roll' ? 6 : 1 }}>
            <span style={{ color: '#666' }}>[t{entry.turn}]</span>{' '}
            {entry.side ? <span style={{ marginRight: 4 }}>{entry.side}</span> : null}
            <span style={{ color: '#fff' }}>{entry.kind}</span>
            {entry.kind === 'mission-roll' && entry.payload ? (
              <MissionRollEntry payload={entry.payload as MissionRollPayload} side={entry.side} />
            ) : entry.kind === 'combat-attack' && entry.payload ? (
              <CombatAttackEntry payload={entry.payload as CombatAttackPayload} />
            ) : entry.payload ? (
              <span style={{ color: '#888', marginLeft: 4 }}>{JSON.stringify(entry.payload)}</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Report Problem Modal
// ============================================================================

function ReportProblemModal({ G, screenshotBase64, onClose }: {
  G: GameState;
  /** Base64 PNG (no data-URL prefix) captured before this modal mounted.
   *  Sent with the report so the issue includes a visual snapshot of what
   *  the player was looking at. May be null if capture failed. */
  screenshotBase64: string | null;
  onClose: () => void;
}) {
  const [description, setDescription] = useState('');
  const [includeScreenshot, setIncludeScreenshot] = useState<boolean>(!!screenshotBase64);
  const stateCodec = canEncode(G) ? encode(G) : '(state is mid-resolution; codec not safe to capture)';

  const buildReport = () => ({
    schema: 'rebellion-report-v1',
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    description,
    canEncodeState: canEncode(G),
    state: canEncode(G) ? JSON.parse(encode(G)) : null,
    turnLog: G.turnLog,
    // Snapshot of pending fields (these don't round-trip but are useful for debugging)
    pending: {
      mission: G.pendingMission ?? null,
      combat: G.pendingCombat ?? null,
      choice: G.pendingChoice ?? null,
    },
    // Base64 PNG of the page at the moment the user opened the modal.
    // Vite endpoint writes this to disk + commits to repo so the GitHub
    // issue can embed it inline.
    screenshotBase64: includeScreenshot ? screenshotBase64 : null,
  });

  const [submitState, setSubmitState] = useState<{
    status: 'idle' | 'submitting' | 'ok' | 'error';
    message?: string;
    issueUrl?: string;
    filePath?: string;
    fallbackUrl?: string;
  }>({ status: 'idle' });

  /** Build a GitHub "new issue" URL with title and body prefilled. Used as
   *  the manual-submission fallback when the relay isn't running (e.g.
   *  user is on a static build, or no SWR_BUGREPORT_* env vars set). */
  const buildGithubNewIssueUrl = (): string => {
    const repo = 'johnchampaign/star-wars-rebellion'; // [VERIFY] repo name
    const title = description.split('\n')[0].slice(0, 80) || 'Problem report';
    const lines: string[] = [`**What happened**`, '', description];
    lines.push('', '**State codec (paste-back snapshot):**', '```', stateCodec.slice(0, 1500), '```');
    if (stateCodec.length > 1500) lines.push('_(state truncated — full state was saved locally if dev server ran)_');
    const body = lines.join('\n').slice(0, 6000);
    const params = new URLSearchParams({ title, body, labels: 'bug,from-game' });
    return `https://github.com/${repo}/issues/new?${params.toString()}`;
  };

  const handleReportProblem = async () => {
    if (!description.trim()) {
      alert('Please describe what happened before submitting.');
      return;
    }
    setSubmitState({ status: 'submitting' });
    // Try the relay (vite dev endpoint, which auto-files a GH issue if env
    // vars are set). On any failure, fall through to a pre-filled GH URL.
    try {
      const res = await fetch('/__report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildReport()),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.url) {
          setSubmitState({ status: 'ok', message: `Filed GitHub issue #${body.number}`, issueUrl: body.url, filePath: body.filePath });
        } else {
          // Saved locally but no GitHub. Offer manual GH URL.
          setSubmitState({
            status: 'ok',
            message: body.note || `Saved to ${body.filePath ?? 'reports/'}`,
            filePath: body.filePath,
            fallbackUrl: buildGithubNewIssueUrl(),
          });
        }
        return;
      }
      // Relay error (502 etc.) — still attempt manual fallback.
      const text = await res.text().catch(() => '');
      setSubmitState({
        status: 'error',
        message: `Relay failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
        fallbackUrl: buildGithubNewIssueUrl(),
      });
    } catch (e) {
      // Network/relay totally unavailable — offer the manual fallback.
      setSubmitState({
        status: 'error',
        message: `Relay unavailable: ${String(e)}`,
        fallbackUrl: buildGithubNewIssueUrl(),
      });
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(buildReport(), null, 2));
      alert('Report copied to clipboard.');
    } catch (e) {
      alert(`Copy failed: ${String(e)}`);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 40, zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', borderRadius: 6, padding: 20,
          maxWidth: 800, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          border: '1px solid #3a3d44',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#ffd54a' }}>Report a problem</h3>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#aaa', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        <p style={{ color: '#aaa', fontSize: 13, marginTop: 0 }}>
          Bug, surprise behavior, confusing UX — anything you want flagged. The report
          includes the current game state, the full turn log, and a snapshot of any
          mid-resolution mission/combat state.
        </p>

        <label style={{ fontSize: 13, color: '#aaa', display: 'block', marginBottom: 4 }}>
          What happened? (be specific — what you expected vs what you saw)
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          style={{
            ...inputStyle,
            width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13,
          }}
          placeholder="Example: I clicked 'Empire pass' during Command phase but it didn't change the current player. Expected the turn to pass back to Rebel."
        />

        {screenshotBase64 && (
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#aaa', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={includeScreenshot}
                onChange={(e) => setIncludeScreenshot(e.target.checked)}
              />
              Include screenshot of the page when you clicked &ldquo;Report a problem&rdquo;
            </label>
            {includeScreenshot && (
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: 'pointer', color: '#aaa', fontSize: 11 }}>Preview</summary>
                <img
                  src={`data:image/png;base64,${screenshotBase64}`}
                  alt="screenshot preview"
                  style={{ maxWidth: '100%', marginTop: 6, border: '1px solid #2a2d34', borderRadius: 3 }}
                />
              </details>
            )}
          </div>
        )}
        {!screenshotBase64 && (
          <div style={{ marginTop: 8, fontSize: 11, color: '#666', fontStyle: 'italic' }}>
            (Screenshot capture wasn&apos;t available — the report will still include the state.)
          </div>
        )}

        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', color: '#aaa', fontSize: 12 }}>
            Preview report payload ({G.turnLog.length} log entries, state codec {canEncode(G) ? 'OK' : 'mid-effect'})
          </summary>
          <pre style={{
            background: '#0c0d10', padding: 10, marginTop: 6, borderRadius: 3,
            fontSize: 10, color: '#cbc4b0', maxHeight: 200, overflow: 'auto',
          }}>
            {JSON.stringify(buildReport(), null, 2).slice(0, 4000)}
            {JSON.stringify(buildReport()).length > 4000 && '\n...(truncated for preview)'}
          </pre>
        </details>

        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', color: '#aaa', fontSize: 12 }}>State codec (paste back to share)</summary>
          <textarea
            value={stateCodec}
            readOnly
            rows={4}
            style={{ ...inputStyle, width: '100%', fontFamily: 'monospace', fontSize: 10, marginTop: 6 }}
          />
        </details>

        {submitState.status !== 'idle' && (
          <div style={{
            marginTop: 12, padding: 8, borderRadius: 4, fontSize: 12,
            background: submitState.status === 'ok' ? '#1a3320' : submitState.status === 'error' ? '#3a1a1a' : '#1f2128',
            color: submitState.status === 'ok' ? '#80dc78' : submitState.status === 'error' ? '#ff8a80' : '#ccc',
            border: `1px solid ${submitState.status === 'ok' ? '#2e6d3f' : submitState.status === 'error' ? '#6d2e2e' : '#3a3d44'}`,
          }}>
            {submitState.status === 'submitting' && 'Submitting…'}
            {submitState.message && <div>{submitState.message}</div>}
            {submitState.issueUrl && (
              <div style={{ marginTop: 4 }}>
                <a href={submitState.issueUrl} target="_blank" rel="noreferrer" style={{ color: '#aae0ff' }}>
                  Open issue ↗
                </a>
              </div>
            )}
            {submitState.filePath && (
              <div style={{ marginTop: 2, color: '#888' }}>Local backup: <code>{submitState.filePath}</code></div>
            )}
            {submitState.fallbackUrl && (
              <div style={{ marginTop: 4 }}>
                <a href={submitState.fallbackUrl} target="_blank" rel="noreferrer" style={{ color: '#aae0ff' }}>
                  Open pre-filled GitHub issue ↗
                </a>
                <span style={{ color: '#888' }}> (click to file manually)</span>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <button className="tab-button" onClick={onClose}>Cancel</button>
          <button className="tab-button" onClick={handleCopy}>Copy to clipboard</button>
          <button
            className="tab-button active"
            onClick={handleReportProblem}
            disabled={submitState.status === 'submitting' || !description.trim()}
          >
            Report a problem
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// History archive
// ============================================================================

// ============================================================================
// Upload Logs Dialog — consent + bulk-publish archived games for AI training
// ============================================================================

function UploadLogsDialog({ onClose }: { onClose: () => void }) {
  // Read archived games out of localStorage so we can show the count up-front.
  const games = (() => {
    try {
      const raw = localStorage.getItem(LS_HISTORY);
      return raw ? (JSON.parse(raw) as Array<{ encodedAt: string; winner?: string; winReason?: string; codec: string }>) : [];
    } catch { return []; }
  })();
  // Also offer to include the in-progress game (the current save) if it
  // exists, so a player who hasn't finished a game can still contribute.
  const inProgressCodec = (() => {
    try { return localStorage.getItem(LS_CURRENT); } catch { return null; }
  })();
  const recordCount = games.length + (inProgressCodec ? 1 : 0);

  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'done'; uploaded: number; deduped: number; failed: number }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const onConfirm = async () => {
    if (!import.meta.env.DEV) {
      setStatus({ kind: 'error', message: 'Upload only works while running `vite dev` (the endpoint is dev-only).' });
      return;
    }
    setConfirmed(true);
    setStatus({ kind: 'uploading' });
    const payload = {
      games: [
        ...games.map((g) => ({
          encodedAt: g.encodedAt,
          winner: g.winner,
          winReason: g.winReason,
          codec: g.codec,
          source: 'browser-game-archive',
        })),
        ...(inProgressCodec ? [{
          encodedAt: new Date().toISOString(),
          inProgress: true,
          codec: inProgressCodec,
          source: 'browser-in-progress',
        }] : []),
      ],
    };
    try {
      const res = await fetch('/__upload-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setStatus({ kind: 'error', message: `Relay returned HTTP ${res.status}` });
        return;
      }
      const body = await res.json() as { uploaded: number; deduped: number; failed: number };
      setStatus({ kind: 'done', uploaded: body.uploaded, deduped: body.deduped, failed: body.failed });
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) });
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        padding: 24,
      }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#15171c', border: '2px solid #ffd54a', borderRadius: 6,
        padding: 24, maxWidth: 600, width: '100%', maxHeight: '90vh', overflowY: 'auto',
        color: '#e8e8ea', fontSize: 13, lineHeight: 1.5,
      }}>
        <h2 style={{ marginTop: 0, marginBottom: 12, color: '#ffd54a' }}>
          Submit logs to public dataset
        </h2>

        {!confirmed && (
          <>
            <p>
              You are about to submit <b>{recordCount}</b> game log{recordCount === 1 ? '' : 's'} to
              a <b>public</b> GitHub repo for use in AI development.
            </p>
            <p style={{ marginBottom: 4 }}><b>What gets sent:</b></p>
            <ul style={{ marginTop: 0, paddingLeft: 22 }}>
              <li>Every move made by you and by the AI — leader placements, mission reveals, mission rolls, combat outcomes, build choices.</li>
              <li>The full turn-by-turn game state, including hand contents, deck order, and dice rolls.</li>
              <li>The final winner and win reason for completed games.</li>
            </ul>
            <p style={{ marginBottom: 4 }}><b>What is NOT sent:</b></p>
            <ul style={{ marginTop: 0, paddingLeft: 22 }}>
              <li>Your name, email, IP address, or any account information.</li>
              <li>Anything outside the game state — no browser data, no other tabs, no cookies, no local files.</li>
            </ul>
            <p>
              Anyone — including researchers — can use the dataset to improve
              the Rebellion AI or study the game. Each log is identified by a
              hash of its content, so re-clicking later only commits NEW games.
            </p>
            <p style={{ opacity: 0.7, fontSize: 12, marginTop: 16 }}>
              If you'd rather not contribute, just cancel — solo play works the
              same way either way.
            </p>
          </>
        )}

        {status.kind === 'uploading' && (
          <p style={{ color: '#aae0ff' }}>Uploading {recordCount} log{recordCount === 1 ? '' : 's'}…</p>
        )}
        {status.kind === 'done' && (
          <p style={{ color: '#80dc78' }}>
            Done. Uploaded <b>{status.uploaded}</b>, deduped <b>{status.deduped}</b>, failed <b>{status.failed}</b>.
          </p>
        )}
        {status.kind === 'error' && (
          <p style={{ color: '#ff8a80' }}>Upload failed: {status.message}</p>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          {!confirmed && (
            <>
              <button className="tab-button" onClick={onClose}>Cancel</button>
              <button
                className="tab-button active"
                onClick={onConfirm}
                disabled={recordCount === 0}
              >
                Submit {recordCount} log{recordCount === 1 ? '' : 's'}
              </button>
            </>
          )}
          {confirmed && status.kind !== 'uploading' && (
            <button className="tab-button" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

function archiveCompletedGame(G: GameState): void {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    const history: Array<{ encodedAt: string; winner?: string; winReason?: string; codec: string }> =
      raw ? JSON.parse(raw) : [];
    const codec = canEncode(G) ? encode(G) : null;
    if (!codec) return;
    history.unshift({
      encodedAt: new Date().toISOString(),
      winner: G.winner,
      winReason: G.winReason,
      codec,
    });
    while (history.length > HISTORY_CAP) history.pop();
    localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  } catch (e) {
    console.warn('archive failed', e);
  }
}

const inputStyle: React.CSSProperties = {
  background: '#0c0d10',
  color: '#e8e8ea',
  border: '1px solid #3a3d44',
  borderRadius: 3,
  padding: '3px 6px',
  fontSize: 12,
  width: 120,
};
