// Play tab — minimal hot-seat shell wrapping the pure engine directly.
// Includes: state persistence in localStorage, completed-game history,
// and a "Report a problem" dialog that produces a downloadable JSON.

import { useEffect, useRef, useState, useCallback, useMemo, createContext, useContext } from 'react';
import { loadAllForEngine, loadBoardMask, MAP_IMAGE_URL, MARKER_IMAGE_BASE, UNIT_IMAGE_BASE, LEADER_IMAGE_BASE, CARD_IMAGE_BASE, IMG_BUST, diceImageUrl, vmodAssetUrl, mapImageUrl } from '../data/loadAssets';
import { UNIT_IMAGE, groupByType, groupTypeIds, getUnitStyle, setUnitStyle, nextStyle, unitImageUrl, type UnitImageStyle } from './unitImages';
import { capturePageScreenshot } from './screenshot';
import { missionTargets, missionLeaderTargets } from '../engine/missionTargets';
import { stepOnce as aiStepOnce } from './randomAI';
import { TERRITORIES, territoryFill } from '../data/territories';
import {
  loadVmodFromFile, getVmodMeta, clearVmodCache, preloadAllBlobUrls,
  notifyArtChanged, useArtLoaded, getCachedFilenames, getCachedArtUrlSync,
  LoadFailure,
  type LoadProgress, type LoadReport,
} from './vmodArtCache';

const LS_HUMAN_SIDE = 'rebellion-human-side';
const LS_SIDE_PREF = 'rebellion-side-pref'; // 'Rebel' | 'Empire' | 'Random'
const LS_EXPANSION = 'rebellion-expansion-config';
type SidePref = 'Rebel' | 'Empire' | 'Random';
function randomSide(): Side { return Math.random() < 0.5 ? 'Rebel' : 'Empire'; }
function otherSide(s: Side): Side { return s === 'Rebel' ? 'Empire' : 'Rebel'; }

// Context so helper components can read the current style without prop drilling.
const UnitStyleContext = createContext<UnitImageStyle>('vmod');
const useUnitStyle = () => useContext(UnitStyleContext);
import { createGame, resolveExpansion } from '../engine/setup';
import * as _phases from '../engine/phases';
import type { MoveOrder } from '../engine/phases';
import { PROJECT_ONLY_UNIT_IDS } from '../engine/units';
import * as _combat from '../engine/combat';
import { CombatBoardLive } from './CombatBoardLive';
import { encode, decode, canEncode } from '../engine/codec';
import type { GameState, Side, LeaderId } from '../engine/types';
import type { RebellionAction } from '../adapter/rebellionAction';
import { makeOnlinePhases, makeOnlineCombat } from '../online/onlineEngine';
import type { System, MaskRect, ExpansionConfig } from '../types';

// Active engine handles. Module-level so PlayTab AND its module-scope
// sub-components/helpers all call the same `phases.*`/`combat.*`. The PlayTab
// component reassigns these each render: the real engine in single-player, or
// the online shim (submits actions to the server) in online mode. Safe because
// only one PlayTab instance is mounted at a time, and the reassignment runs
// before any child renders within the same render pass.
let phases = _phases;
let combat = _combat;

const NATIVE_W = 3180;
const NATIVE_H = 1590;
const DISPLAY_W = 1200;
const DISPLAY_H = 600;
const SCALE = DISPLAY_W / NATIVE_W;
const MARKER_R = 16;
// Distinct, muted fills per board region — used to draw a usable VECTOR galaxy
// when the real Map.png art isn't available (no module / copyright-stripped
// placeholder). Indexed by system.region.
const REGION_FILL = [
  '#3a4a63', '#5a4a63', '#3a5a52', '#63523a', '#4a3a63', '#3a6352', '#634a4a', '#52633a', '#3a4a4a',
];

// Territory polygons for the no-art vector fallback. The play board uses the
// CANONICAL committed data (territories.json) — NOT the dev tab's localStorage
// working copy, which would otherwise shadow shipped updates (e.g. someone who
// edited cells locally wouldn't see newly-committed barriers). Edit + Export in
// the dev 'territories' tab to change this; the dev tab shows local edits.
const FALLBACK_TERRITORIES = TERRITORIES.regions;

/** Ray-cast point-in-polygon test (image-native coords). Used to assign each
 *  system to the territory cell that contains its boardPos. */
function pointInPoly(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > p[1]) !== (yj > p[1])) &&
      (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const LS_CURRENT = 'rebellion-game-current';
const LS_HISTORY = 'rebellion-games-history';
// encodedAt ids of completed games already uploaded, so we don't re-send them
// (player report #125 — uploads kept re-submitting old, already-stored logs).
const LS_UPLOADED = 'rebellion-uploaded-logs';
// Stable per-device reporter ID. Generated once on first problem-report
// submission, persisted forever. Lets us tie GitHub issues back to the
// reporter so we can surface our resolution comment to them on next visit
// (the "your problem report has been responded to" modal).
const LS_REPORTER_ID = 'rebellion-reporter-id';
// Set of issue numbers whose resolution comment the user has acknowledged
// (clicked OK on the response modal). Stored as JSON array of numbers.
const LS_SEEN_RESPONSES = 'rebellion-seen-responses';

/** Get or generate the stable reporter ID for this device. */
function getReporterId(): string {
  try {
    let id = localStorage.getItem(LS_REPORTER_ID);
    if (!id) {
      // Random 16-char base36 string. Not cryptographically secure, just
      // needs to be unique enough that two reporters don't collide.
      id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(LS_REPORTER_ID, id);
    }
    return id;
  } catch {
    return 'anon-' + Math.random().toString(36).slice(2, 10);
  }
}
const HISTORY_CAP = 20;

function sideColor(s: Side): string {
  return s === 'Rebel' ? '#aae0ff' : '#ffaaaa';
}

/** Log the exact board image the app is rendering (resolved filename + bytes
 *  + SHA-256 prefix), so we can confirm which VASSAL board is live without
 *  guessing. Reference: v1.2e Map-Redux.png = 5.54 MB / sha256 4d3d404754d6a548;
 *  v1.02d Map.png = 10.81 MB / sha256 1a1ef9aff451258d. */
async function logBoardIdentity(): Promise<void> {
  try {
    const files = getCachedFilenames();
    const resolved =
      files.find((f) => /map-redux\.png/i.test(f)) ||
      files.find((f) => /(^|\/)map\.png$/i.test(f)) ||
      '(no board in cache — stripped placeholder)';
    const url = mapImageUrl();
    const blob = await (await fetch(url)).blob();
    const buf = await blob.arrayBuffer();
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
      .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    const sizeMB = (blob.size / 1048576).toFixed(2);
    const known = hash === '4d3d404754d6a548' ? ' [v1.2e Map-Redux ✓]'
      : hash === '1a1ef9aff451258d' ? ' [v1.02d Map.png — OLD]'
      : ' [unrecognized]';
    // eslint-disable-next-line no-console
    console.info(`[board-image] resolved=${resolved} size=${sizeMB}MB sha256=${hash}${known}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.info('[board-image] could not read board image', e);
  }
}

/** Does the given side own the current pendingChoice? Used by runAILoop
 *  to decide whether to wake the AI when the choice fires during the
 *  HUMAN's turn (e.g. Empire reveals a mission and Rebel auto-resolves
 *  the opposition; AI builds during refresh; etc.). */
/** Summarize the AI side's notable Command actions from turnLog[fromIdx..] into
 *  short human-readable lines for the "what the AI just did" banner. Only
 *  side-tagged actions for `aiSide` (so the human's own actions are excluded);
 *  combats surface via their own report modal so they're omitted here. */
/** One AI-activity line. `missionId` is set for mission runs so the banner can
 *  show the card's rules text on hover (player request: MightyFaben wanted a
 *  reminder of what e.g. "Research and Development" does). */
type AiActivityLine = { text: string; missionId?: string };

function summarizeAiActions(G: GameState, fromIdx: number, aiSide: Side): AiActivityLine[] {
  const sysName = (id: string) => id === 'rebel-base-space' ? 'the Rebel Base' : (G.catalog.systems[id]?.name ?? id);
  const ldrName = (id: string) => G.catalog.leaders[id]?.name ?? id;
  const misName = (id: string) => G.catalog.missions[id]?.name ?? id;
  const out: AiActivityLine[] = [];
  for (let i = fromIdx; i < G.turnLog.length; i++) {
    const e = G.turnLog[i];
    if (e.side !== aiSide) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === 'activate-system') {
      const orders = (p.orders as number) ?? 0;
      out.push({ text: `Activated ${ldrName(p.leaderId as string)} at ${sysName(p.targetSystemId as string)}`
        + (orders > 0 ? ` (moved ${orders} unit group${orders === 1 ? '' : 's'})` : ' (no units moved)') });
    } else if (e.kind === 'reveal-mission') {
      out.push({
        text: `Ran mission “${misName(p.missionId as string)}” at ${sysName(p.targetSystemId as string)}`,
        missionId: p.missionId as string,
      });
    } else if (e.kind === 'pass') {
      out.push({ text: 'Passed (done for the round)' });
    }
  }
  return out.slice(-8); // keep the banner short
}

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
    case 'R2D2Flip':                 return pc.side === side;
    case 'SpecialDieSpend':          return pc.side === side;
    case 'CombatStartActionCards':   return pc.side === side;
    case 'MoreDangerousTheaterPick': return pc.side === side;
    case 'FullyOperationalTargetPick': return pc.side === side;
    case 'TargetTheGeneratorPick':   return pc.side === side;
    case 'ReadyForActionLeaderPick': return pc.side === side;
    case 'DeathStarPlansAttempt':    return pc.side === side;
    case 'PlayObjective':            return pc.side === side;
    case 'RaidOutpostsPlace':        return pc.side === side;
    case 'RebelCellPlace':           return pc.side === side;
    case 'RebelCellDiscard':         return pc.side === side;
    case 'RetreatDecision':          return pc.side === side;
    // Infiltration / Plan The Assault are always Rebel choices.
    case 'InfiltrationPick':         return side === 'Rebel';
    case 'SafeHavenPick':            return side === 'Rebel';
    case 'PlanTheAssaultShips':      return side === 'Rebel';
    case 'LeadStrikeTeamUnits':      return side === 'Rebel';
    case 'BuildFromIconsPick':       return pc.side === side;
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
    case 'ResearchAndDevelopmentOption':     return pc.side === side;
    case 'ResearchAndDevelopmentProjectPick': return pc.side === side;
    case 'RecruitActionCardPick':    return pc.side === side;
    case 'PlayAssignmentActionCard': return pc.side === side;
    case 'PlayImmediateActionCard':  return pc.side === side;
    case 'ArmCardProbePick':         return pc.side === side;
    case 'ActionCardSystemPick':     return pc.side === side;
    case 'AttachRingPick':           return pc.side === side;
    case 'DeployUnitPick':           return pc.side === side;
    case 'DetainedTargetPick':       return pc.side === side;
    case 'RetrieveThePlansPick':     return pc.side === side;
    case 'InterrogationDroidDecoyPick': return pc.side === side;
    // Response-card offers fired mid-mission-reveal. These post a choice to
    // the OPPOSING side during the active side's turn — without listing them
    // here, runAILoop's gate sees "not my currentPlayer + don't owe a choice"
    // and exits, leaving the offer orphaned. The originating mission's
    // continuation chain then never runs and the mission silently vanishes.
    case 'UndercoverOffer':          return pc.side === side;
    case 'BlindsideOffer':           return pc.side === side;
    case 'WookieGuardianOffer':      return pc.side === side;
    case 'NobleSacrificeOffer':      return pc.side === side;
    case 'ItIsYourDestinyOffer':     return pc.side === side;
    case 'OneInAMillionOffer':       return pc.side === side;
    case 'C3POOffer':                return pc.side === side;
    case 'FalconOffer':              return pc.side === side;
    case 'SonOfSkywalkerOffer':      return pc.side === side;
    case 'TrackThemOffer':           return pc.side === side;
    case 'SomethingToFightForOffer': return pc.side === side;
    case 'PostBountyOffer':          return pc.side === side;
    case 'AmbitionsOfPowerOffer':    return pc.side === side;
    case 'LeaderPoolEliminate':      return pc.side === side;
    case 'DiscreditRebellionChoice': return pc.side === side;
    case 'SecretMissionPick':        return pc.side === side;
    case 'MissionRecruitLeaderPick': return pc.side === side;
    case 'ReconnaissancePick':       return pc.side === side;
    case 'DrawThemOutPick':          return pc.side === side;
    case 'RegionalAidPick':          return pc.side === side;
    case 'BehindEnemyLinesUnits':    return pc.side === side;
    case 'WereTheBaitUnits':         return pc.side === side;
    case 'ImperialMightUnits':       return pc.side === side;
    case 'BreakTheirWillPick':       return pc.side === side;
    case 'HeistChoice':              return pc.side === side;
    case 'EstablishTradeChoice':     return pc.side === side;
    case 'UnderTheRadarKeep':        return pc.side === side;
    case 'UnderTheRadarReturn':      return pc.side === side;
    case 'StartingCardBranch':       return pc.side === side;
    // Robust default: ANY side-tagged choice belongs to the side it names, so
    // if that side is the AI, the AI owes it. This catches choice kinds the AI
    // can resolve but that aren't explicitly listed above — without it, such a
    // choice freezes the game when the human is the opponent (the AI loop bails
    // and no modal shows). Issue #74: the AI Rebel had to pick a leader from a
    // two-leader recruit card (RecruitLeaderPick) and the game locked up,
    // because that kind was missing from the list. A choice the AI can't
    // actually resolve just stops the loop once (no worse than before); a
    // choice it CAN resolve now fires correctly.
    default: {
      const sided = pc as { side?: Side };
      return typeof sided.side === 'string' && sided.side === side;
    }
  }
}

/** Returns true if `side` has any legal Command-phase action available right
 *  now. Used to relabel the Pass button when the player is effectively
 *  forced to end their participation in this Command phase.
 *
 *  Definition of "has an action":
 *    - At least one leader in their pool has combined tactic values > 0
 *      (i.e. could activate a system), OR
 *    - At least one assigned mission has enough leader skill to be revealed
 *      (skill total >= skill cost).
 *
 *  We don't bother validating per-system legality of activation — that's
 *  expensive and the player can see system options in the Command panel
 *  anyway. The check is a fast superset that's accurate for "no leaders
 *  left in pool with tactic dice AND no revealable missions". */
function hasAnyCommandAction(G: GameState, side: Side): boolean {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  // Any leader WITH tactic values still in pool? Only those can activate a
  // system (RR: a leader without tactic values cannot activate).
  for (const lid of f.leaderPool) {
    const ld = G.catalog.leaders[lid];
    if (!ld) continue;
    if ((ld.tacticValues.space + ld.tacticValues.ground) > 0) return true;
  }
  // Any revealable assigned mission?
  for (const am of f.leadersOnMissions) {
    const card = G.catalog.missions[am.missionId];
    if (!card || !card.skill) continue;
    // Ring/minor-aware total (matches the engine reveal check) so a mission
    // made revealable by minor or ring-granted icons (e.g. K-2SO) counts (#173).
    const sc = phases.totalSkill(G, am.leaderIds, card.skill);
    if (sc.major + sc.minor >= card.skillCost) return true;
  }
  return false;
}

/** Online mode (Phase 4b): when provided, PlayTab renders the redacted server
 *  view instead of owning a local engine. Read-only for now (the OnlinePlay
 *  wrapper disables pointer events and supplies the action panel); per-control
 *  submit wiring is the next step. When `online` is undefined, PlayTab behaves
 *  exactly as the single-player app — every online code path below is gated. */
export type PlayTabOnlineMode = {
  view: GameState;
  you: Side | null;
  yourTurn: boolean;
  submit: (action: RebellionAction) => Promise<void>;
};

export default function PlayTab({ online }: { online?: PlayTabOnlineMode } = {}) {
  const gameRef = useRef<GameState | null>(null);
  // Point the module-level engine handles at the online shim (mutators submit
  // RebellionActions to the server) or the real modules (single-player). See
  // the `let phases/combat` declaration above and onlineEngine.ts.
  phases = online ? makeOnlinePhases(online.submit, () => online.yourTurn) : _phases;
  combat = online ? makeOnlineCombat(online.submit, () => online.yourTurn) : _combat;
  // Undo stack for the interactive Setup phase. Each entry is an encoded
  // snapshot (codec string) of G taken just BEFORE a human placement /
  // auto-fill. Undo pops the latest; Reset restores entry[0] (the state
  // before the human's first placement). Codec round-trip is used instead
  // of structuredClone so instance-id counters get reseeded on restore
  // (same path as save/load — avoids the dup-instanceId bug, issue #29).
  // Player request: Eskil Swahn (BGG) misclicked during Rebel setup with
  // no way to take it back.
  const setupUndoStackRef = useRef<string[]>([]);
  const dataRef = useRef<Awaited<ReturnType<typeof loadAllForEngine>> | null>(null);
  const systemsRef = useRef<System[]>([]);
  const masksRef = useRef<MaskRect[]>([]);
  const [tick, setTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<string>('');
  const [hasSaved, setHasSaved] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [reportScreenshot, setReportScreenshot] = useState<string | null>(null);
  const [showUploadLogs, setShowUploadLogs] = useState(false);
  // Queue of unseen "objective scored" notices for the human side. Populated
  // by an effect that watches turnLog for new play-objective entries; each
  // one becomes a modal that the user acknowledges before the next shows.
  const [objectiveNoticeQueue, setObjectiveNoticeQueue] = useState<
    { objectiveId: string; reputation: number; turn: number }[]
  >([]);
  const seenObjectiveLogIdxRef = useRef<number>(0);
  // "What the AI just did" banner. The AI takes its turns without player
  // input (moves, leader placements, combats), and players reported losing
  // track of what happened (MightyFaben). We scan the turnLog for the AI's
  // notable Command-phase actions since the human last had control and show
  // a brief dismissible summary.
  const [aiActivity, setAiActivity] = useState<AiActivityLine[]>([]);
  const aiActivitySeenIdxRef = useRef<number>(0);
  // Game-over modal: shown once when the game ends, dismissible (the inline
  // banner stays as a persistent reminder). Player report #195 asked for a
  // proper "you won / you lost" dialogue rather than only the easy-to-miss
  // banner. Keyed by a flag the effect resets when a NEW game starts.
  const [gameOverAck, setGameOverAck] = useState(false);
  const aiActivityInitRef = useRef<boolean>(false);
  // Queue of objective cards just drawn (one modal per draw, with the
  // objective's name, art, and rules text). User #39 needed to know which
  // objectives entered their hand at which Refresh — and there was no
  // surface for that info other than reading the log. Now drawn objectives
  // pop a small modal so the player can read the card before it gets
  // buried in the hand. Detected from the same turnLog scan as scored
  // objectives.
  const [drawnObjectiveQueue, setDrawnObjectiveQueue] = useState<
    { objectiveId: string; turn: number }[]
  >([]);
  // Queue of "your leader was rescued" notices for the human Rebel player.
  // Triggered by rescue-leader events (both mission-rescue and auto-rescue
  // — the latter happens when a captured leader's system loses all Imperial
  // units). Michael Knauss (BGG report) didn't realize Han Solo had been
  // auto-rescued after his Plan The Assault attack on Bothawui, then tried
  // to reveal Daring Rescue and saw "no targets" — leading to a confusing
  // problem report. Modal makes the rescue visible.
  const [leaderRescuedQueue, setLeaderRescuedQueue] = useState<
    { leaderId: string; reason: string; turn: number }[]
  >([]);
  // Generic "private event" notices for the human EMPIRE player — things that
  // happen on the Empire's side but had no surfacing other than reading the log:
  //   - Homing Beacon placed a captured leader to reveal the base's region (#192)
  //   - a project card was drawn into the Empire's hand (#194)
  // Each becomes a small dismissible modal. Detected from the same turnLog scan.
  const [infoNoticeQueue, setInfoNoticeQueue] = useState<
    { title: string; body: string; turn: number }[]
  >([]);
  // Queue of resolved-problem-report responses the user hasn't seen yet.
  // Fetched once at app load from /api/my-responses; each unseen response
  // becomes a modal that thanks the user + explains the fix in plain
  // language. Dismissing adds the issue number to the LS_SEEN_RESPONSES set
  // so it doesn't pop again.
  const [responseNoticeQueue, setResponseNoticeQueue] = useState<
    { number: number; title: string; htmlUrl: string; response: string }[]
  >([]);
  const [unitStyle, setUnitStyleState] = useState<UnitImageStyle>(getUnitStyle());
  const [showUnitKey, setShowUnitKey] = useState<boolean>(false);
  const [showDiceKey, setShowDiceKey] = useState<boolean>(false);
  const [showTacticKey, setShowTacticKey] = useState<boolean>(false);
  // "Peek the board": temporarily hide the open modal/overlay so you can see
  // the full map behind it, then toggle back to make your choice (idea:
  // MightyFaben — softens every "greyed-out map behind a prompt" case at once).
  const [peekBoard, setPeekBoard] = useState<boolean>(false);
  // Player-toggleable "images on / images off" switch. When OFF, every
  // <img> and SVG <image> in the play tree is hidden via CSS, letting
  // the text fallbacks (unit abbreviations, dice glyphs, etc.) carry the
  // UI on their own. Useful when (a) the strict-image deploy is serving
  // 1x1 placeholders that have white edges or stray pixels showing, or
  // (b) a player just prefers a text-first view. Persisted across reloads.
  const [imagesOff, setImagesOff] = useState<boolean>(
    () => localStorage.getItem('rebellion-images-off') === '1',
  );
  const artLoaded = useArtLoaded();
  const [showLoadArt, setShowLoadArt] = useState(false);
  // True when the loaded .vmod is the OLDER board (ships Map.png, not the
  // v1.2e "Redux" board). The app's coordinates are calibrated to the Redux
  // board now, so an old module misaligns every marker — nudge the user to
  // upgrade so everyone is on the same art.
  const [staleModule, setStaleModule] = useState(false);
  const checkStaleModule = useCallback(() => {
    const files = getCachedFilenames();
    if (files.length === 0) { setStaleModule(false); return; }
    const hasRedux = files.some((f) => /map-redux\.png/i.test(f));
    const hasOldBoard = files.some((f) => /(^|\/)map\.png$/i.test(f));
    setStaleModule(hasOldBoard && !hasRedux);
  }, []);
  // One-time boot: if a .vmod has been previously loaded, preload all
  // blob URLs into the in-memory cache so the synchronous URL helpers
  // (unitImageUrl, vmodAssetUrl, diceImageUrl) return blob:URLs starting
  // from the very first render.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const meta = await getVmodMeta();
      if (cancelled) return;
      if (!meta) {
        // No .vmod ever loaded on this device → auto-open the loader modal
        // so first-time visitors are directed to the VASSAL download
        // instead of silently playing without art.
        setShowLoadArt(true);
        return;
      }
      await preloadAllBlobUrls();
      if (!cancelled) { setTick((t) => t + 1); checkStaleModule(); }
      logBoardIdentity();
    })();
    return () => { cancelled = true; };
  }, [checkStaleModule]);
  // Fetch unseen responses to this user's previously-filed problem reports.
  // Fires once at app load. Silently no-ops if the user has never filed a
  // report (no reporter ID in localStorage). The /api/my-responses endpoint
  // ties issues to this device via the reporter HTML comment embedded in
  // each issue body by /api/report.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const reporterId = localStorage.getItem(LS_REPORTER_ID);
        if (!reporterId) return;
        const seen = new Set<number>(
          JSON.parse(localStorage.getItem(LS_SEEN_RESPONSES) || '[]'),
        );
        const res = await fetch(`/api/my-responses?reporterId=${encodeURIComponent(reporterId)}`);
        if (!res.ok || cancelled) return;
        const body: {
          ok?: boolean;
          responses?: { number: number; title: string; htmlUrl: string; response: string | null }[];
        } = await res.json();
        if (!body.ok || !Array.isArray(body.responses)) return;
        const unseen = body.responses
          .filter((r) => r.response && !seen.has(r.number))
          .map((r) => ({
            number: r.number, title: r.title, htmlUrl: r.htmlUrl, response: r.response!,
          }));
        if (unseen.length > 0 && !cancelled) {
          setResponseNoticeQueue(unseen);
        }
      } catch (e) {
        console.warn('[my-responses] fetch failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const toggleImages = () => {
    setImagesOff((v) => {
      const next = !v;
      if (next) localStorage.setItem('rebellion-images-off', '1');
      else localStorage.removeItem('rebellion-images-off');
      return next;
    });
  };
  const [humanSide, setHumanSide] = useState<Side>(() => {
    // Online: the server seat is authoritative and already known at mount
    // (OnlinePlay only renders us once `view`/`you` have loaded). Never let a
    // stale localStorage side (e.g. from a prior game where you were the Empire)
    // make the Rebel client render the Empire's perspective — that hides the
    // Rebel's own base and suppresses the Rebel setup panels.
    if (online?.you === 'Rebel' || online?.you === 'Empire') return online.you;
    const stored = localStorage.getItem(LS_HUMAN_SIDE);
    return stored === 'Rebel' || stored === 'Empire' ? stored : 'Rebel';
  });
  // Player's preference for next new game: Rebel / Empire / Random. Persisted
  // so the choice survives reload. "Random" rolls 50/50 on startNew.
  const [sidePref, setSidePref] = useState<SidePref>(() => {
    const v = localStorage.getItem(LS_SIDE_PREF);
    return v === 'Rebel' || v === 'Empire' || v === 'Random' ? v : 'Random';
  });
  const updateSidePref = (p: SidePref) => {
    setSidePref(p);
    localStorage.setItem(LS_SIDE_PREF, p);
  };
  // Rise of the Empire opt-in for the NEXT new game. Persisted as a partial
  // config; resolveExpansion fills defaults at start. Default: base game.
  const [expansionPref, setExpansionPref] = useState<ExpansionConfig>(() => {
    try {
      const raw = localStorage.getItem(LS_EXPANSION);
      if (raw) return resolveExpansion(JSON.parse(raw));
    } catch { /* ignore */ }
    return resolveExpansion({});
  });
  const updateExpansionPref = (patch: Partial<ExpansionConfig>) => {
    // Disabled→enabled is a special case: the disabled state forces every
    // sub-flag false, so merging it with `{enabled: true}` would defeat the
    // resolveExpansion defaults (false ?? true === false). Seed from a fresh
    // resolve in that case so the on-defaults (RoE units / new starters /
    // RoE missions / expanded board ON; cinematic combat OFF) are applied.
    const base: Partial<ExpansionConfig> = (!expansionPref.enabled && patch.enabled)
      ? { enabled: true }
      : { ...expansionPref, ...patch };
    const next = resolveExpansion({ ...base, ...patch });
    setExpansionPref(next);
    try { localStorage.setItem(LS_EXPANSION, JSON.stringify(next)); } catch { /* ignore */ }
  };
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
    if (online) return; // online games are server-authoritative — no local AI.
    const G0 = gameRef.current;
    if (!G0 || G0.isGameOver) return;
    const human = (localStorage.getItem(LS_HUMAN_SIDE) === 'Empire') ? 'Empire' : 'Rebel';
    const ai: Side = human === 'Rebel' ? 'Empire' : 'Rebel';
    // Batched, time-bounded driver. Runs steps for up to ~40ms, then yields
    // to the browser to repaint. Continues via setTimeout until the AI has
    // nothing left to do. Keeps the UI responsive even when the AI has many
    // sequential decisions to make (full Assignment phase + Command turns +
    // combat resolution).
    let totalSteps = 0;
    const runBatch = () => {
      const batchStart = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      let didAny = false;
      let stepsThisBatch = 0;
      for (;;) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (now - batchStart > 40) break; // yield to browser
        if (totalSteps >= 2000) break;     // hard safety cap
        if (stepsThisBatch >= 200) break;  // per-batch safety
        const Gn = gameRef.current;
        if (!Gn || Gn.isGameOver) break;
        // Pause the AI while a mission/combat report is waiting to be shown,
        // so the human sees the result before the AI takes its next action
        // (and before the combat board can preempt it). Reporter saw Plant
        // False Lead resolve and the Empire immediately start a combat
        // elsewhere without the mission result ever appearing. (#63)
        if ((Gn.missionReports?.length ?? 0) > 0 || (Gn.combatReports?.length ?? 0) > 0
          || (Gn.objectiveReports?.length ?? 0) > 0) break;
        const owes = aiOwesChoice(Gn, ai);
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
        stepsThisBatch++;
        totalSteps++;
      }
      if (didAny) {
        try {
          const Gf = gameRef.current;
          if (Gf && canEncode(Gf)) localStorage.setItem(LS_CURRENT, encode(Gf));
        } catch { /* ignore */ }
        setTick((t) => t + 1);
      }
      // Schedule another batch if there's still AI work to do.
      const Gn2 = gameRef.current;
      if (!Gn2 || Gn2.isGameOver) return;
      if (totalSteps >= 2000) {
        console.warn('[ai] runAILoop hit hard safety cap (2000 steps)');
        return;
      }
      const owes2 = aiOwesChoice(Gn2, ai);
      if (Gn2.currentPlayer === ai || owes2) {
        setTimeout(runBatch, 0);
      }
    };
    runBatch();
  }, []);

  const refresh = useCallback(() => {
    // Any state advance ends a "peek" — so a leftover peek can never hide the
    // next prompt; each new decision shows its modal normally.
    setPeekBoard(false);
    setTick((t) => t + 1);
    runAILoop();
    // Detect newly-scored objectives since the last refresh. We scan the
    // turnLog from the last-seen index forward; play-objective events get
    // queued as user-visible notices. Only enqueue for the human's side —
    // the AI's objectives are private to the AI player conceptually.
    const G = gameRef.current;
    if (G && G.turnLog) {
      const humanSidePref = (() => {
        try { return localStorage.getItem(LS_HUMAN_SIDE) || 'Rebel'; } catch { return 'Rebel'; }
      })();
      // NB: "objective scored" notices come from the engine's G.objectiveReports
      // (→ ObjectiveReportModal), which fires for every scoring path (combat,
      // death-star, refresh). We deliberately DON'T also scan play-objective here
      // — doing both produced a double popup ("Objective scored" then "+1
      // reputation") for the same score (player report #120).
      const draws: { objectiveId: string; turn: number }[] = [];
      const rescues: { leaderId: string; reason: string; turn: number }[] = [];
      const infos: { title: string; body: string; turn: number }[] = [];
      for (let i = seenObjectiveLogIdxRef.current; i < G.turnLog.length; i++) {
        const e = G.turnLog[i];
        // draw-objective is only logged for the Rebel side (objectives are
        // a Rebel-only mechanic). Show the modal for whichever side the
        // human is playing — if Empire, they probably don't want spoilers
        // about what the AI just drew, so gate on humanSidePref === 'Rebel'.
        if (e.kind === 'draw-objective' && e.side === humanSidePref && humanSidePref === 'Rebel') {
          const p = e.payload as { objectiveIds?: string[] } | undefined;
          for (const oid of (p?.objectiveIds ?? [])) {
            draws.push({ objectiveId: oid, turn: e.turn ?? 0 });
          }
        }
        // rescue-leader fires for both mission-rescue (the player ran a
        // rescue mission successfully) and auto-rescue (engine path: a
        // captured leader's system lost its Imperial units). Both are
        // surfaced — the mission-rescue case is celebratory, the auto-
        // rescue case can be a real surprise (issue #45).
        if (e.kind === 'rescue-leader' && humanSidePref === 'Rebel') {
          const p = e.payload as { leaderId?: string; reason?: string } | undefined;
          if (p?.leaderId) {
            rescues.push({
              leaderId: p.leaderId,
              reason: p.reason ?? 'auto',
              turn: e.turn ?? 0,
            });
          }
        }
        // Homing Beacon placed a captured leader in a system in the Rebel base's
        // region, exposing which region the base is in — a big deal for the
        // Empire's search, but previously only visible in the log (#192).
        if (e.kind === 'homing-beacon-place' && humanSidePref === 'Empire') {
          const p = e.payload as { leaderId?: string; systemId?: string } | undefined;
          const leaderName = p?.leaderId ? (G.catalog.leaders[p.leaderId]?.name ?? p.leaderId) : 'A leader';
          const sysName = p?.systemId ? (G.catalog.systems[p.systemId]?.name ?? p.systemId) : 'a system';
          infos.push({
            title: 'Homing Beacon — region revealed',
            body: `${leaderName} was placed in ${sysName}. The Rebel base is in this system's region — focus your search there.`,
            turn: e.turn ?? 0,
          });
        }
        // A project card was drawn into the Empire's hand (Research & Development /
        // Construct missions). The Empire player couldn't tell WHICH one without
        // hunting through their mission hand (#194).
        if (e.kind === 'project-draw' && humanSidePref === 'Empire') {
          const p = e.payload as { drawn?: string[] } | undefined;
          for (const pid of (p?.drawn ?? [])) {
            const name = G.catalog.missions[pid]?.name ?? pid;
            infos.push({
              title: 'Project card drawn',
              body: `You drew the project: ${name}. It's in your mission hand, ready to assign.`,
              turn: e.turn ?? 0,
            });
          }
        }
      }
      seenObjectiveLogIdxRef.current = G.turnLog.length;
      if (draws.length > 0) {
        setDrawnObjectiveQueue((q) => [...q, ...draws]);
      }
      if (rescues.length > 0) {
        setLeaderRescuedQueue((q) => [...q, ...rescues]);
      }
      if (infos.length > 0) {
        setInfoNoticeQueue((q) => [...q, ...infos]);
      }
    }
  }, [runAILoop]);

  // Persist current game state after every action.
  const persist = useCallback(() => {
    if (online) return; // online games live on the server; never write the
    // redacted view to single-player localStorage (it would corrupt resume).
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
    gameRef.current = createGame(dataRef.current, { seed: s, autoSetupUnits: false, expansion: expansionPref });
    // New game: nothing scored yet, but reset the seen-cursor to be safe.
    seenObjectiveLogIdxRef.current = 0;
    aiActivitySeenIdxRef.current = 0;
    aiActivityInitRef.current = false;
    setAiActivity([]);
    setObjectiveNoticeQueue([]);
    setDrawnObjectiveQueue([]);
    setLeaderRescuedQueue([]);
    setInfoNoticeQueue([]);
    // Honor the player's side preference. "Random" rolls 50/50.
    const newHuman: Side =
      sidePref === 'Rebel' ? 'Rebel' :
      sidePref === 'Empire' ? 'Empire' :
      randomSide();
    localStorage.setItem(LS_HUMAN_SIDE, newHuman);
    setHumanSide(newHuman);
    persist();
    refresh();
  }, [seed, refresh, persist, sidePref, expansionPref]);

  const resumeSaved = useCallback(() => {
    const raw = localStorage.getItem(LS_CURRENT);
    if (!raw || !dataRef.current) return;
    try {
      // Build a catalog the same way setup does — but we need it without re-running setup.
      // Simplest: create a fresh game to harvest the catalog, then decode into it.
      const fresh = createGame(dataRef.current, { seed: 1 });
      const restored = decode(raw, fresh.catalog);
      gameRef.current = restored;
      // Resumed game: don't re-announce historical objective scores — fast-
      // forward the seen-cursor to the current end of log. Anything that
      // happens AFTER this point will pop the notice modal as expected.
      seenObjectiveLogIdxRef.current = restored.turnLog?.length ?? 0;
      aiActivitySeenIdxRef.current = restored.turnLog?.length ?? 0;
      aiActivityInitRef.current = true;
      setAiActivity([]);
      setObjectiveNoticeQueue([]);
      setDrawnObjectiveQueue([]);
      setLeaderRescuedQueue([]);
      setInfoNoticeQueue([]);
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

  // Export / import a game as a portable code (base64 of the engine codec +
  // which side you control), so you can hand a game from one browser/device to
  // another — there's no server-side save (player question: MightyFaben).
  const exportGameCode = useCallback(() => {
    const Gx = gameRef.current;
    if (!Gx || !canEncode(Gx)) {
      alert('Can\'t export mid-action — finish the current step (or wait for the AI) and try again.');
      return;
    }
    const code = btoa(JSON.stringify({ v: 1, codec: encode(Gx), humanSide }));
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(
        () => alert('Game code copied to your clipboard.\n\nOn the other device, open the game and use "import game", then paste this code.'),
        () => window.prompt('Copy this game code and paste it via "import game" on the other device:', code),
      );
    } else {
      window.prompt('Copy this game code and paste it via "import game" on the other device:', code);
    }
  }, [humanSide]);

  const importGameCode = useCallback(() => {
    const raw = window.prompt('Paste a game code (from "export game" on another device):');
    if (!raw) return;
    try {
      const obj = JSON.parse(atob(raw.trim())) as { codec?: string; humanSide?: string };
      if (!obj?.codec) throw new Error('not a game code');
      const human: Side = obj.humanSide === 'Empire' ? 'Empire' : 'Rebel';
      localStorage.setItem(LS_HUMAN_SIDE, human);
      setHumanSide(human);
      localStorage.setItem(LS_CURRENT, obj.codec);
      resumeSaved(); // decodes LS_CURRENT into the live game
    } catch (e) {
      alert(`That doesn't look like a valid game code: ${String(e)}`);
    }
  }, [resumeSaved]);

  // Online mode: render the redacted server view directly (no local engine).
  // Done at render so there's no first-paint flash; OnlinePlay always mounts us
  // with a view in hand. Keep the seat (humanSide) in sync with our server seat.
  if (online) gameRef.current = online.view;
  useEffect(() => { if (online?.you) setHumanSide(online.you); }, [online?.you]);

  const G = gameRef.current;

  // (AI driver moved into refresh() / runAILoop() above — a useEffect-based
  // driver was racing with Strict Mode's effect-cleanup cycle.)
  // Re-arm the AI loop on initial render after data loads.
  useEffect(() => { runAILoop(); }, [runAILoop]);

  // Re-arm the game-over modal whenever a game is in progress, so the NEXT
  // game's end shows the dialogue again (#195). Unconditional hook — must run
  // before any early return.
  useEffect(() => {
    if (G && !G.isGameOver && gameOverAck) setGameOverAck(false);
  }, [G, G?.isGameOver, gameOverAck]);

  // #193 instrumentation: report-ordering diagnostics. When the player reports
  // that a combat summary shows out of order (e.g. after the opponent's
  // mission/activation), the cause is which queued report the UI picks to show
  // next. Whenever the set of queued reports changes, log a snapshot of all five
  // queues with their seq stamps (seq = turnLog length when the report was
  // queued, i.e. its chronological position) and the current turnLog length, so
  // the next out-of-order occurrence is captured in the console verbatim. Cheap,
  // read-only, and easy to strip once #193 is understood.
  const reportSig = G ? [
    ...(G.combatReports ?? []).map((r) => `c${r.seq ?? '?'}`),
    ...(G.missionReports ?? []).map((r) => `m${r.seq ?? '?'}`),
    ...(G.objectiveReports ?? []).map((r) => `o${(r as { seq?: number }).seq ?? '?'}`),
    ...(G.refreshReports ?? []).map((r) => `r${(r as { seq?: number }).seq ?? '?'}`),
    ...(G.activationReports ?? []).map((r) => `a${(r as { seq?: number }).seq ?? '?'}`),
  ].join(',') : '';
  useEffect(() => {
    if (!G || reportSig === '') return;
    const snap = (arr: { seq?: number; kind?: string }[] | undefined, tag: string) =>
      (arr ?? []).map((r, i) => ({ tag, i, seq: r.seq, kind: (r as { kind?: string }).kind }));
    // eslint-disable-next-line no-console
    console.log('[report-order #193]', {
      turnLogLen: G.turnLog?.length,
      currentPlayer: G.currentPlayer,
      phase: G.phase,
      queues: [
        ...snap(G.combatReports as { seq?: number }[], 'combat'),
        ...snap(G.missionReports as { seq?: number }[], 'mission'),
        ...snap(G.objectiveReports as { seq?: number }[], 'objective'),
        ...snap(G.refreshReports as { seq?: number }[], 'refresh'),
        ...snap(G.activationReports as { seq?: number }[], 'activation'),
      ].sort((a, b) => (a.seq ?? 1e15) - (b.seq ?? 1e15)),
    });
  }, [reportSig]);

  // "What the AI just did" — when control returns to the human, summarize the
  // AI's notable Command actions since the human last had control. Runs on
  // every tick; only acts when the human is genuinely in control (no pending
  // choice/combat/mission/report and it's their turn).
  useEffect(() => {
    const Gn = gameRef.current;
    if (!Gn || Gn.isGameOver) return;
    const ai: Side = humanSide === 'Rebel' ? 'Empire' : 'Rebel';
    const reportsPending = (Gn.missionReports?.length ?? 0) > 0
      || (Gn.combatReports?.length ?? 0) > 0 || (Gn.objectiveReports?.length ?? 0) > 0;
    const humanInControl = Gn.currentPlayer === humanSide && !aiOwesChoice(Gn, ai)
      && !reportsPending && !Gn.pendingChoice && !Gn.pendingCombat && !Gn.pendingMission;
    if (!humanInControl) return;
    if (!aiActivityInitRef.current) {
      // First control-checkpoint after load/new game — just set the cursor.
      aiActivityInitRef.current = true;
      aiActivitySeenIdxRef.current = Gn.turnLog.length;
      return;
    }
    if (aiActivitySeenIdxRef.current >= Gn.turnLog.length) return;
    const summary = summarizeAiActions(Gn, aiActivitySeenIdxRef.current, ai);
    aiActivitySeenIdxRef.current = Gn.turnLog.length;
    if (summary.length) setAiActivity(summary);
  }, [tick, humanSide]);

  // #179 (online): let a player declare "pass" during the OPPONENT's Command
  // turn. RAW still applies — the pass is submitted only when it becomes their
  // turn — but they don't have to come back just to click Pass. Cleared when
  // the phase changes or after it fires. Never fires over a pending choice
  // (e.g. an oppose-mission prompt), mission, or combat.
  // MUST be declared before the early returns below — hooks run unconditionally
  // on every render or React unmounts the tree (online loads with G null first,
  // then populates, so a hook after the `if (!G)` return changes the hook count
  // and blanks the page).
  const [autoPassQueued, setAutoPassQueued] = useState(false);
  useEffect(() => {
    if (!autoPassQueued || !G || !online) return;
    if (G.phase !== 'Command' || G.isGameOver) { setAutoPassQueued(false); return; }
    if (!online.yourTurn || G.currentPlayer !== humanSide) return;
    if (G.pendingChoice || G.pendingMission || G.pendingCombat) return;
    setAutoPassQueued(false);
    phases.pass(G, G.currentPlayer);
    persist();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPassQueued, tick, online?.yourTurn]);

  if (error) return <div className="placeholder"><h2>Load error</h2><p>{error}</p></div>;
  if (!dataRef.current) return <div className="placeholder">Loading data…</div>;

  if (!G) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>Play</h2>
        <div className="placeholder">
          <p>No game in progress.</p>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
              <div style={{ color: '#aaa', fontSize: 13 }}>Play as:</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['Rebel', 'Empire', 'Random'] as const).map((p) => {
                  const active = sidePref === p;
                  const c = p === 'Rebel' ? '#aae0ff' : p === 'Empire' ? '#ffaaaa' : '#cbc4b0';
                  return (
                    <button
                      key={p}
                      onClick={() => updateSidePref(p)}
                      style={{
                        padding: '6px 14px',
                        background: active ? c : '#15171c',
                        color: active ? '#000' : c,
                        border: `2px solid ${c}`,
                        borderRadius: 4,
                        fontWeight: active ? 700 : 500,
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
            <ExpansionPanel cfg={expansionPref} onChange={updateExpansionPref} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
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
    // Guard: passing ENDS your Command phase for the round — any missions you
    // assigned but haven't revealed won't happen. A common mistake (esp. online)
    // is to pass over your own mission reveals, which looks like "the opponent
    // did everything". Warn if the passing side still has assigned missions.
    const f = G.currentPlayer === 'Rebel' ? G.rebel : G.empire;
    const pending = f.leadersOnMissions.length;
    if (pending > 0) {
      const ok = window.confirm(
        `You still have ${pending} assigned mission${pending === 1 ? '' : 's'} you haven't revealed.\n\n` +
        `Passing ends your Command phase for this round — those missions will NOT be carried out ` +
        `(their leaders just return at the end of the round). Pass anyway?`,
      );
      if (!ok) return;
    }
    phases.pass(G, G.currentPlayer);
    persist();
    refresh();
  };

  const onActivateSystem = (
    leaderId: string, targetSystemId: string, moveOrders: MoveOrder[],
  ) => {
    if (!G) return;
    const r = phases.activateSystem(G, G.currentPlayer, leaderId, targetSystemId, moveOrders);
    if (!r.ok) {
      // Diagnostic dump: build a human-readable per-unit dump inline in the
      // alert so the user doesn't have to dig into DevTools. Console.group
      // gets printed too for those who want to grep it.
      const lines = [`Cannot activate: ${r.reason}`, '', `leader=${leaderId} target=${targetSystemId}`];
      for (const o of moveOrders) {
        const src = o.fromSystemId === 'rebel-base-space'
          ? G.map.rebelBaseSpace
          : G.map.systems[o.fromSystemId];
        lines.push('', `from ${o.fromSystemId} (${o.unitInstanceIds.length} units):`);
        for (const uid of o.unitInstanceIds) {
          const u = src?.units.find((x) => x.instanceId === uid);
          const t = u && G.catalog.unitTypes[u.typeId];
          lines.push(
            `  ${uid}: typeId=${u?.typeId ?? '(NOT AT SOURCE!)'} ` +
            `cap=${t?.transport.capacity ?? 0} ` +
            `theater=${t?.theater ?? '?'} ` +
            `restriction=${t?.transport.restriction ?? false}`
          );
        }
      }
      if (moveOrders.length === 0) lines.push('', '(no move orders sent — leader-only activation)');
      const msg = lines.join('\n');
      console.error('[activate-reject]', msg);
      alert(msg);
      return false;
    }
    persist();
    refresh();
    return true;
  };

  const onRevealMission = (missionId: string, targetSystemId: string, targetLeaderId?: string) => {
    if (!G) return false;
    const r = phases.revealMission(G, G.currentPlayer, missionId, targetSystemId, targetLeaderId);
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

  // Dismiss the front-most report modal. Goes through the engine mutator so that
  // online it submits an action (server-persisted) instead of shifting the local
  // redacted view — a local shift is undone by the next poll, which locked the
  // dialog.
  const onAckReport = (reportType: 'mission' | 'combat' | 'objective' | 'refresh' | 'activation') => {
    if (!G) return;
    phases.acknowledgeReport(G, reportType);
    persist();
    refresh();
  };

  const onSetupAutoFill = (side: Side) => {
    if (!G) return;
    if (canEncode(G)) setupUndoStackRef.current.push(encode(G));
    phases.setupAutoFill(G, side);
    persist();
    refresh();
  };

  const onSetupDeploy = (side: Side, typeId: string, systemId: string) => {
    if (!G) return;
    // Snapshot BEFORE the placement so it can be undone. If the placement
    // turns out to be illegal (no state change), drop the redundant snapshot.
    const snapshot = canEncode(G) ? encode(G) : null;
    if (snapshot) setupUndoStackRef.current.push(snapshot);
    const r = phases.setupDeployUnit(G, side, typeId, systemId);
    if (!r.ok) {
      if (snapshot) setupUndoStackRef.current.pop();
      alert(`Cannot deploy: ${r.reason}`);
    }
    persist();
    refresh();
  };

  // Pull a SPECIFIC placed unit back off the board during setup (player request:
  // change a placement without undoing everything after it). Snapshotted like a
  // deploy so it's itself undoable.
  const onSetupUndoUnit = (side: Side, typeId: string, systemId: string) => {
    if (!G) return;
    const snapshot = canEncode(G) ? encode(G) : null;
    if (snapshot) setupUndoStackRef.current.push(snapshot);
    const r = phases.setupUndoDeployUnit(G, side, typeId, systemId);
    if (!r.ok) {
      if (snapshot) setupUndoStackRef.current.pop();
      alert(`Cannot pull back: ${r.reason}`);
    }
    persist();
    refresh();
  };

  // Undo the most recent human setup placement (or auto-fill).
  const onSetupUndo = () => {
    const Gc = gameRef.current;
    if (!Gc) return;
    const snap = setupUndoStackRef.current.pop();
    if (!snap) return;
    gameRef.current = decode(snap, Gc.catalog);
    persist();
    refresh();
  };

  // Reset all of the human's setup placements back to before the first one.
  const onSetupReset = () => {
    const Gc = gameRef.current;
    if (!Gc) return;
    const stack = setupUndoStackRef.current;
    if (stack.length === 0) return;
    if (!confirm('Reset your setup? This clears all the units you\'ve placed so far and starts your deployment over.')) return;
    const baseline = stack[0];
    setupUndoStackRef.current = [];
    gameRef.current = decode(baseline, Gc.catalog);
    persist();
    refresh();
  };

  // ---------- Render ----------

  return (
    <UnitStyleContext.Provider value={unitStyle}>
    <div className={imagesOff ? 'images-off' : undefined}>
      {/* Global rule that hides every <img> and SVG <image> tag when the
       *  user has toggled images off. Scoped to descendants of the play
       *  root so other tabs are unaffected. */}
      <style>{`
        .images-off img, .images-off image { visibility: hidden; }
      `}</style>
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
          <button className="tab-button" onClick={() => setShowUnitKey(true)} title="Show a key of every unit type — picture, name, tier shape and theater">
            unit key
          </button>
          <button className="tab-button" onClick={() => setShowDiceKey(true)} title="Show what each die face means in combat and on missions, with odds">
            dice key
          </button>
          <button className="tab-button" onClick={() => setShowTacticKey(true)} title="Show every tactic card and how the tactic decks work">
            tactic key
          </button>
          <button className="tab-button" onClick={exportGameCode} title="Copy a code for this game so you can continue it on another device/browser">
            export game
          </button>
          <button className="tab-button" onClick={importGameCode} title="Load a game from a code exported on another device/browser">
            import game
          </button>
          <button className="tab-button" onClick={toggleUnitStyle} title="Toggle between Vassal mini photos and reference-sheet silhouettes">
            units: {unitStyle}
          </button>
          <button className="tab-button" onClick={toggleImages} title="Toggle images on/off — when off, only text labels show (useful with the strict-image deploy)">
            images: {imagesOff ? 'off' : 'on'}
          </button>
          <button
            className="tab-button"
            onClick={() => setShowLoadArt(true)}
            title={artLoaded.loaded
              ? `Art loaded from ${artLoaded.meta?.vmodFilename ?? 'cached .vmod'} (${artLoaded.meta?.fileCount ?? 0} files). Click to re-load or clear.`
              : 'Load VASSAL .vmod to populate game art (one-time, cached in browser).'}
          >
            art: {artLoaded.loaded ? 'loaded' : 'none'}
          </button>
          <button
            className="tab-button"
            onClick={() => {
              // Open the modal IMMEDIATELY so the user sees a response to
              // their click. Capture the screenshot in the background and
              // attach when it's ready. If html2canvas hangs or throws,
              // the modal still works — user can submit without screenshot.
              setReportScreenshot(null);
              setShowReport(true);
              (async () => {
                try {
                  const png = await Promise.race([
                    capturePageScreenshot(),
                    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
                  ]);
                  setReportScreenshot(png);
                } catch (e) {
                  console.warn('[report] background screenshot failed:', e);
                }
              })();
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
            <>
              {(() => {
                const playable = phases.playableAssignmentActionCards(G, humanSide);
                if (playable.length === 0 || G.pendingChoice) return null;
                return (
                  <button
                    className="tab-button"
                    onClick={() => {
                      const r = phases.requestAssignmentActionCardPlay(G, humanSide);
                      if (!r.ok) alert(`Cannot play: ${r.reason}`);
                      persist(); refresh();
                    }}
                    title={`${playable.length} playable action card${playable.length === 1 ? '' : 's'}`}
                  >
                    Play action card ({playable.length})
                  </button>
                );
              })()}
              <button
                className="tab-button active"
                onClick={onSkipAssignment}
                style={{ fontWeight: 700 }}
              >
                {G.currentPlayer} done assigning
              </button>
            </>
          )}
          {G.phase === 'Command' && (() => {
            const canDo = hasAnyCommandAction(G, G.currentPlayer);
            return (
              <button
                className={canDo ? 'tab-button' : 'tab-button active'}
                onClick={onPass}
                style={canDo ? undefined : { fontWeight: 700 }}
                title={canDo
                  ? 'Voluntarily pass for the rest of the Command phase. You can still oppose missions and join combats.'
                  : 'No leaders in your pool can activate, and no assigned mission has enough skill to reveal. Click to end your Command phase.'}
              >
                {G.currentPlayer} {canDo ? 'pass' : 'end Command phase'}
              </button>
            );
          })()}
          {/* Immediate-action-card play button (RoE: Under the Radar etc.).
              Shown during Assignment OR Command on the player's own turn
              whenever a playable Immediate card is in hand. */}
          {(G.phase === 'Assignment' || G.phase === 'Command')
            && G.currentPlayer === humanSide
            && !G.pendingChoice
            && (() => {
              const playable = phases.playableImmediateActionCards(G, humanSide);
              if (playable.length === 0) return null;
              return (
                <button
                  className="tab-button"
                  onClick={() => {
                    const r = phases.requestImmediateActionCardPlay(G, humanSide);
                    if (!r.ok) alert(`Cannot play: ${r.reason}`);
                    persist(); refresh();
                  }}
                  title={`${playable.length} playable Immediate card${playable.length === 1 ? '' : 's'}`}
                  style={{ marginLeft: 6 }}
                >
                  Play immediate card ({playable.length})
                </button>
              );
            })()}
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

      {G.isGameOver && !gameOverAck && (
        <GameOverModal
          winner={G.winner ?? null}
          winReason={G.winReason ?? null}
          humanSide={humanSide}
          onDismiss={() => setGameOverAck(true)}
        />
      )}

      {aiActivity.length > 0 && (
        // Sticky so it stays in view as you scroll down to your leaders/command
        // controls — no more scrolling back up to see what the AI did
        // (player request: MightyFaben).
        <div style={{
          position: 'sticky', top: 0, zIndex: 1500,
          margin: '8px 0', padding: '8px 12px', borderRadius: 6,
          background: 'rgba(20,30,45,0.97)', border: `1px solid ${sideColor(aiSide)}`,
          display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12,
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: sideColor(aiSide), fontWeight: 700, marginBottom: 2 }}>
              {/* "since your last turn" rather than "just" — these are the AI's
                  actions accumulated since the human last had control, which
                  can span a round boundary if the human passed early (#181). */}
              {aiSide} — since your last turn:
            </div>
            <div style={{ color: '#cfe2f5', display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
              {aiActivity.map((line, i) => {
                const card = line.missionId ? G.catalog.missions[line.missionId] : null;
                // Hover a mission run to read what the card does (e.g. what
                // "Research and Development" actually resolves).
                return (
                  <span key={i}
                    title={card?.rulesText ? `${card.name}: ${card.rulesText}` : undefined}
                    style={card?.rulesText ? { textDecoration: 'underline dotted', textUnderlineOffset: 2, cursor: 'help' } : undefined}>
                    • {line.text}
                  </span>
                );
              })}
            </div>
          </div>
          <button className="tab-button" style={{ padding: '2px 8px', fontSize: 11 }}
            onClick={() => setAiActivity([])}>dismiss</button>
        </div>
      )}

      <TurnTrack G={G} />
      <DecksPanel
        G={G}
        onProbeHover={humanSide === 'Empire' ? setProbeHover : undefined}
      />

      {/* Leader rosters sit right above the map so you can check them without
          scrolling to the bottom of the page (request: MightyFaben). */}
      {/* All four rosters in one horizontal line on wide screens (units sit
          right beside their faction's leaders), wrapping gracefully when the
          viewport can't fit four columns. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 12, margin: '8px 0', alignItems: 'start',
      }}>
        <LeaderRoster G={G} side="Rebel" humanSide={humanSide} />
        <UnitRoster G={G} side="Rebel" />
        <LeaderRoster G={G} side="Empire" humanSide={humanSide} />
        <UnitRoster G={G} side="Empire" />
      </div>

      <Board
        G={G}
        systems={systemsRef.current}
        masks={masksRef.current}
        humanSide={humanSide}
        eliminatedSystemIds={
          probeHover && humanSide === 'Empire' ? empireRuledOutSystems(G) : null
        }
      />

      {/* Setup panels. Setup is concurrent: each player sets up their OWN side.
          - Hotseat: one human runs both sides, so show whichever side the engine
            has active (G.currentPlayer).
          - Online: show the human their OWN setup — the Rebel's base pick + the
            Rebel's deployment, or the Empire's deployment — independent of
            G.currentPlayer, so neither player waits on the other to finish. */}
      {G.phase === 'Setup' && !G.isGameOver && G.pendingRebelBasePick && humanSide === 'Rebel' && (
        <RebelBasePickPanel G={G} onPick={onPickRebelBase} />
      )}

      {G.phase === 'Setup' && !G.isGameOver && G.pendingDeployment
        && (online ? (G.pendingDeployment[humanSide]?.length ?? 0) > 0 : true) && (
        <SetupPanel
          G={G}
          side={online ? humanSide : G.currentPlayer}
          onDeploy={onSetupDeploy}
          onAutoFill={onSetupAutoFill}
          onUndo={onSetupUndo}
          onUndoUnit={onSetupUndoUnit}
          onReset={onSetupReset}
          undoCount={setupUndoStackRef.current.length}
        />
      )}

      {/* Online: only show the human their OWN assignment, on their OWN turn —
          otherwise the opponent sees this side's panel (with an undo button on
          their assigned leaders, and the mission redacted to __hidden__). Hotseat
          shows the engine's active side. */}
      {G.phase === 'Assignment' && !G.isGameOver && (!online || G.currentPlayer === humanSide) && (
        <AssignmentPanel G={G} side={online ? humanSide : G.currentPlayer} humanSide={humanSide} onChange={() => { persist(); refresh(); }} />
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

      {/* #179 (online): while it's the opponent's Command turn, let the player
          pre-declare a pass. The actual pass submits when their turn arrives
          (RAW — you pass ON your turn); this just saves a round trip. */}
      {online && G.phase === 'Command' && !G.isGameOver && G.currentPlayer !== humanSide && (
        <div style={{
          marginTop: 12, background: '#15171c', borderRadius: 4, padding: 12,
          border: '1px solid #2a2d34', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <span style={{ color: '#aaa', fontSize: 13 }}>
            Command — opponent&apos;s turn.
          </span>
          <button
            className="tab-button"
            style={autoPassQueued ? { borderColor: '#80dc78', color: '#80dc78' } : undefined}
            onClick={() => {
              if (autoPassQueued) { setAutoPassQueued(false); return; }
              const f = humanSide === 'Rebel' ? G.rebel : G.empire;
              const pending = f.leadersOnMissions.length;
              if (pending > 0) {
                const ok = window.confirm(
                  `You still have ${pending} assigned mission${pending === 1 ? '' : 's'} you haven't revealed.\n\n` +
                  `Passing ends your Command phase for this round — those missions will NOT be carried out. ` +
                  `Queue the pass anyway?`,
                );
                if (!ok) return;
              }
              setAutoPassQueued(true);
            }}
          >
            {autoPassQueued ? '✓ Will pass when your turn comes — click to cancel' : 'Pass my next turn (end my Command phase)'}
          </button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <FactionPanel G={G} side="Rebel" humanSide={humanSide} />
        <FactionPanel G={G} side="Empire" humanSide={humanSide} />
      </div>

      <LogPanel G={G} humanSide={humanSide} />

      {/* All modal/overlay layers live in this wrapper. "Peek board" sets
          display:none on it so the map behind shows through; display:contents
          keeps the fixed-position children laying out normally otherwise. */}
      {/* Reference-key overlays render OUTSIDE the peek wrapper, so they stay
          usable while peeking at the board during a choice (player report #126:
          couldn't open the unit key while peeking). */}
      {showUnitKey && (
        <UnitKeyModal G={G} unitStyle={unitStyle} onClose={() => setShowUnitKey(false)} />
      )}
      {showDiceKey && (
        <DiceKeyModal onClose={() => setShowDiceKey(false)} />
      )}
      {showTacticKey && (
        <TacticKeyModal G={G} onClose={() => setShowTacticKey(false)} />
      )}

      <div style={{ display: peekBoard ? 'none' : 'contents' }}>
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
      {showLoadArt && (
        <LoadArtModal
          G={G}
          currentMeta={artLoaded.meta}
          onClose={() => { setShowLoadArt(false); checkStaleModule(); }}
          onLoaded={() => { refresh(); checkStaleModule(); }}
        />
      )}
      {staleModule && !showLoadArt && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5100,
        }} onClick={() => setStaleModule(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: '#15171c', border: '2px solid #ffd54a', borderRadius: 6,
            padding: 20, maxWidth: 520, width: '90%', boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          }}>
            <div style={{ fontSize: 14, color: '#ffd54a', fontWeight: 700, marginBottom: 8 }}>
              Please update your board art
            </div>
            <div style={{ fontSize: 13, color: '#cbc4b0', marginBottom: 14, lineHeight: 1.5 }}>
              You're using an <b>older VASSAL module</b>. The game's board positions
              are now calibrated to the updated <b>v1.2e</b> map (the "Redux" board),
              so on the older art the loyalty markers and other tokens will sit
              slightly out of place. Grab the current module so everyone's on the
              same board:
              <div style={{ marginTop: 10 }}>
                <a href={VASSAL_DRIVE_URL} target="_blank" rel="noopener noreferrer"
                  style={{ color: '#4fc3f7', fontWeight: 700 }}>
                  Download the current module (v1.2e)
                </a>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="tab-button" onClick={() => setStaleModule(false)}
                style={{ fontSize: 12 }}>
                Keep older art for now
              </button>
              <button className="tab-button active" onClick={() => { setStaleModule(false); setShowLoadArt(true); }}
                style={{ fontWeight: 700 }}>
                Load the new module
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notices live in shared engine state. Online, a seat sees only the
          notices addressed to it (its own side or untagged/global) — a Rebel-only
          notice (e.g. "Rapid Mobilization queued") must never pop for the Empire.
          Dismissal goes through the engine mutator so it persists server-side (a
          local G.pendingNotices=[] on the redacted view is undone by the next
          poll, re-showing the notice forever). */}
      {(() => {
        const all = G.pendingNotices ?? [];
        const visible = online ? all.filter((n) => !n.side || n.side === humanSide) : all;
        if (visible.length === 0) return null;
        return (
          <NotImplementedModal
            notices={visible}
            onDismiss={() => { phases.acknowledgeNotices(G); persist(); refresh(); }}
          />
        );
      })()}

      {objectiveNoticeQueue.length > 0 && (
        <ObjectiveScoredModal
          G={G}
          notice={objectiveNoticeQueue[0]}
          onDismiss={() => setObjectiveNoticeQueue((q) => q.slice(1))}
        />
      )}

      {/* Show scored objectives first; drawn objectives queue behind so
       *  the celebratory "you got rep" modal isn't buried under the
       *  informational "here's what's in your hand now" modal. */}
      {objectiveNoticeQueue.length === 0 && drawnObjectiveQueue.length > 0 && (
        <ObjectiveDrawnModal
          G={G}
          notice={drawnObjectiveQueue[0]}
          onDismiss={() => setDrawnObjectiveQueue((q) => q.slice(1))}
        />
      )}

      {/* Leader-rescued notices stack behind objective modals because
       *  rescue often happens at combat-end, just before refresh/objective
       *  scoring — surfacing rep gains first feels more responsive. */}
      {objectiveNoticeQueue.length === 0
        && drawnObjectiveQueue.length === 0
        && leaderRescuedQueue.length > 0 && (
        <LeaderRescuedModal
          G={G}
          notice={leaderRescuedQueue[0]}
          onDismiss={() => setLeaderRescuedQueue((q) => q.slice(1))}
        />
      )}

      {/* Empire private-event notices (Homing Beacon region reveal #192,
       *  project draw #194) — stack behind the objective/rescue notices. */}
      {objectiveNoticeQueue.length === 0
        && drawnObjectiveQueue.length === 0
        && leaderRescuedQueue.length === 0
        && infoNoticeQueue.length > 0 && (
        <InfoNoticeModal
          notice={infoNoticeQueue[0]}
          onDismiss={() => setInfoNoticeQueue((q) => q.slice(1))}
        />
      )}

      {responseNoticeQueue.length > 0 && (
        <ReportResponseModal
          notice={responseNoticeQueue[0]}
          onDismiss={() => {
            const dismissed = responseNoticeQueue[0];
            // Persist as seen so it doesn't pop again on next load.
            try {
              const seen = new Set<number>(
                JSON.parse(localStorage.getItem(LS_SEEN_RESPONSES) || '[]'),
              );
              seen.add(dismissed.number);
              localStorage.setItem(LS_SEEN_RESPONSES, JSON.stringify([...seen]));
            } catch { /* localStorage full or disabled — modal just won't dismiss persistently */ }
            setResponseNoticeQueue((q) => q.slice(1));
          }}
        />
      )}

      {/* Report modals. Online, show a blocking report only when it's the
          viewer's turn (online.yourTurn) — the SAME signal that enables clicks.
          Gating on yourTurn (rather than currentPlayer) guarantees a visible
          report modal is always interactive: if clicks are suppressed because
          it's not your turn, the modal isn't shown, so it can never lock. The
          report is cleared by whoever currently holds the turn, via onAckReport
          (server-persisted acknowledge online). */}
      {/* Event-report modals (combat / mission / objective / refresh /
          activation). Only ONE shows at a time, and it's the chronologically
          EARLIEST queued report by its seq stamp (turnLog length at queue
          time) — so an AI turn that, say, moved units THEN ran a mission shows
          the move first, and combat shows before a mission that followed it
          (#178/#193/#220). Ties break by a stable kind priority. Activation
          reports are only eligible once nothing is mid-resolution, since a
          combat-triggering activation must surface its combat report first. */}
      {(() => {
        if (online && !online.yourTurn) return null;
        const cr = G.combatReports?.[0];
        const mr = G.missionReports?.[0];
        const or = G.objectiveReports?.[0];
        const rr = G.refreshReports?.[0];
        const ar = G.activationReports?.[0];
        const activationEligible = !!ar && !G.pendingMission && !G.pendingCombat && !G.pendingChoice;
        const candidates: { kind: string; seq: number; prio: number }[] = [];
        if (cr) candidates.push({ kind: 'combat', seq: cr.seq ?? 0, prio: 0 });
        if (mr) candidates.push({ kind: 'mission', seq: mr.seq ?? 0, prio: 1 });
        if (or) candidates.push({ kind: 'objective', seq: or.seq ?? 0, prio: 2 });
        if (rr) candidates.push({ kind: 'refresh', seq: rr.seq ?? 0, prio: 3 });
        if (activationEligible) candidates.push({ kind: 'activation', seq: ar!.seq ?? 0, prio: 4 });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => (a.seq - b.seq) || (a.prio - b.prio));
        switch (candidates[0].kind) {
          case 'combat':
            return <CombatReportModal G={G} report={cr!} onDismiss={() => onAckReport('combat')} />;
          case 'mission':
            return <MissionReportModal G={G} report={mr!} onDismiss={() => onAckReport('mission')} />;
          case 'objective':
            return <ObjectiveReportModal G={G} report={or!} onDismiss={() => onAckReport('objective')} />;
          case 'refresh':
            return <RefreshReportModal G={G} report={rr!} humanSide={humanSide} onDismiss={() => onAckReport('refresh')} />;
          case 'activation':
            return <ActivationReportModal G={G} report={ar!} onDismiss={() => onAckReport('activation')} />;
          default:
            return null;
        }
      })()}

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
        && G.pendingChoice?.kind === 'LeadStrikeTeamUnits'
        && humanSide === 'Rebel' && (
        <LeadStrikeTeamUnitsModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(unitIds) => {
            const r = phases.resolveLeadStrikeTeamUnits(G, unitIds);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'BehindEnemyLinesUnits'
        && humanSide === 'Rebel' && (
        <BehindEnemyLinesUnitsModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(unitIds) => {
            const r = phases.resolveBehindEnemyLinesUnits(G, unitIds);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'WereTheBaitUnits'
        && humanSide === 'Empire' && (
        <WereTheBaitUnitsModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(unitIds) => {
            const r = phases.resolveWereTheBaitUnits(G, unitIds);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ImperialMightUnits'
        && humanSide === 'Empire' && (
        <ImperialMightUnitsModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(indices) => {
            const r = phases.resolveImperialMightUnits(G, indices);
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
        && G.pendingChoice?.kind === 'RecruitLeaderPick'
        && G.pendingChoice.side === humanSide && (
        <SimpleLeaderPickModal
          G={G}
          color={sideColor(humanSide)}
          title={`Recruit — choose which leader to bring in${
            G.catalog.actions[G.pendingChoice.cardId]?.name
              ? ` (${G.catalog.actions[G.pendingChoice.cardId]?.name})` : ''}`}
          candidates={G.pendingChoice.candidates}
          onPick={(lid) => {
            const r = phases.resolveRecruitLeaderPick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlantFalseLeadPlacement'
        && humanSide === 'Rebel' && (
        <PlantFalseLeadModal
          G={G}
          cards={G.pendingChoice.cards}
          onConfirm={(placements) => {
            const r = phases.resolvePlantFalseLeadPlacement(G, placements);
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
      {/* Refresh recruit step — keep one drawn action card */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RecruitActionCardPick'
        && G.pendingChoice.side === humanSide && (
        <RecruitCardPickModal
          G={G}
          side={G.pendingChoice.side}
          drawnIds={G.pendingChoice.drawnIds}
          canDrawMore={G.pendingChoice.canDrawMore}
          color={sideColor(G.pendingChoice.side)}
          onDrawAnother={() => {
            const r = phases.recruitDrawAnother(G);
            if (!r.ok) alert(`Cannot draw another: ${r.reason}`);
            persist(); refresh();
          }}
          onConfirm={(keepCardId) => {
            const r = phases.resolveRecruitActionCardPick(G, keepCardId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {/* Research & Development — stage 1: option pick */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ResearchAndDevelopmentOption'
        && humanSide === 'Empire' && (
        <ResearchAndDevelopmentOptionModal
          G={G}
          choice={G.pendingChoice}
          onPick={(opt) => {
            const r = phases.resolveResearchAndDevelopmentOption(G, opt);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      {/* Research & Development — stage 2: project keep-vs-bottom (Option A only) */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ResearchAndDevelopmentProjectPick'
        && humanSide === 'Empire' && (
        <TopBottomCardPickModal
          G={G}
          cardIds={G.pendingChoice.drawnIds}
          color="#ffaaaa"
          title="Research & Development — keep one project, bottom the other"
          blurb="You drew the top 2 project cards. Drag (or click) to place one in your mission hand (available to assign later) and the other on the bottom of the project deck."
          topLabel="Keep in hand"
          topHint="Goes into your mission hand to assign later."
          bottomLabel="Bottom of deck"
          bottomHint="Returned to the bottom of the project deck."
          lookupCard={(cid) => {
            const m = G.catalog.missions[cid];
            return { name: m?.name ?? cid, image: m?.image };
          }}
          onConfirm={(topCardId) => {
            const r = phases.resolveResearchAndDevelopmentProjectPick(G, topCardId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {/* ----- Assignment-timed action card play (#99) ----- */}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlayAssignmentActionCard'
        && G.pendingChoice.side === humanSide && (
        <PlayAssignmentActionCardModal G={G} choice={G.pendingChoice}
          onPick={(cid) => {
            const r = phases.playAssignmentActionCard(G, cid);
            if (!r.ok) alert(`Cannot play: ${r.reason}`);
            persist(); refresh();
          }}
          onCancel={() => {
            phases.cancelAssignmentActionCardPlay(G);
            persist(); refresh();
          }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlayImmediateActionCard'
        && G.pendingChoice.side === humanSide && (
        <PlayImmediateActionCardModal G={G} choice={G.pendingChoice}
          onPick={(cid) => {
            const r = phases.playImmediateActionCard(G, cid);
            if (!r.ok) alert(`Cannot play: ${r.reason}`);
            persist(); refresh();
          }}
          onCancel={() => {
            phases.cancelImmediateActionCardPlay(G);
            persist(); refresh();
          }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ArmCardProbePick'
        && G.pendingChoice.side === humanSide && (
        <ArmCardProbePickModal G={G} choice={G.pendingChoice}
          onPick={(probeId) => {
            const r = phases.resolveArmCardProbePick(G, probeId);
            if (!r.ok) alert(`Cannot arm: ${r.reason}`);
            persist(); refresh();
          }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ActionCardSystemPick'
        && G.pendingChoice.side === humanSide && (
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title={`${G.catalog.actions[G.pendingChoice.cardId]?.name ?? G.pendingChoice.cardId} — pick a system`}
          instructions={G.catalog.actions[G.pendingChoice.cardId]?.rulesText}
          candidates={G.pendingChoice.candidates}
          onPick={(sid) => {
            const r = phases.resolveActionCardSystemPick(G, sid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'AttachRingPick'
        && G.pendingChoice.side === humanSide && (
        <AttachRingPickModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveAttachRing(G, lid);
            if (!r.ok) alert(`Cannot attach: ${r.reason}`);
            persist(); refresh();
          }} />
      )}
      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DeployUnitPick'
        && G.pendingChoice.side === humanSide && (
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title={`Deploy ${G.catalog.unitTypes[G.pendingChoice.typeId]?.name ?? G.pendingChoice.typeId}`}
          instructions={`Pick where this unit deploys — or use "Leave on build queue (slot 1)" below to NOT deploy it and keep it on space 1 of your build queue.`}
          candidates={G.pendingChoice.candidates}
          unitTokens={(() => {
            // pendingDeployPicks already INCLUDES the unit being placed now as
            // its first entry (it's only shifted off after you deploy it), so
            // map it directly — don't prepend typeId or the count doubles.
            const side = (G.pendingChoice as { side: Side }).side;
            const q = (G.refreshPaused?.pendingDeployPicks ?? [])
              .filter((p) => p.side === side).map((p) => p.typeId);
            return q.length > 0 ? q : [G.pendingChoice.typeId];
          })()}
          handReference={humanSide}
          onPick={(sid) => {
            const r = phases.resolveDeployUnitPick(G, sid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
          cancelLabel="Leave on build queue (slot 1)"
          onCancel={() => {
            const r = phases.declineDeployUnit(G);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {/* Mission-context Yoda reroll (combat-context lives in CombatBoardLive). */}
      {G.pendingChoice?.kind === 'YodaReroll'
        && (G.pendingChoice.context === 'mission' || G.pendingChoice.context === 'dsplans')
        && G.pendingChoice.side === humanSide && (
        <YodaMissionRerollModal G={G} choice={G.pendingChoice}
          onPick={(idx) => {
            // idx is the chosen blank to reroll, or -1 to skip. DSP context
            // routes to the Death Star Plans resolver (#186).
            const r = G.pendingChoice && G.pendingChoice.kind === 'YodaReroll'
              && G.pendingChoice.context === 'dsplans'
              ? combat.resolveDsPlansYoda(G, idx)
              : phases.resolveYodaMissionReroll(G, idx);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {/* Mission-context R2-D2 (combat-context lives in CombatBoardLive). */}
      {G.pendingChoice?.kind === 'R2D2Flip'
        && G.pendingChoice.context === 'mission'
        && G.pendingChoice.side === humanSide && (
        <R2D2MissionFlipModal G={G} choice={G.pendingChoice}
          onPick={(idx) => {
            const r = phases.resolveR2D2MissionFlip(G, idx);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DeathStarPlansAttempt'
        && G.pendingChoice.side === humanSide && (
        <DeathStarPlansAttemptModal G={G} choice={G.pendingChoice}
          onAttempt={(attempt, dsId) => {
            const r = combat.resolveDeathStarPlansAttempt(G, attempt, dsId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PlayObjective'
        && G.pendingChoice.side === humanSide && (
        <PlayObjectiveModal G={G} choice={G.pendingChoice}
          onPick={(oid) => {
            const r = G.pendingChoice && G.pendingChoice.kind === 'PlayObjective'
              && G.pendingChoice.window === 'combat'
              ? combat.resolveCombatObjectivePick(G, oid)
              : phases.resolvePlayObjectivePick(G, oid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RaidOutpostsPlace'
        && G.pendingChoice.side === humanSide && (
        <RaidOutpostsPlaceModal G={G} choice={G.pendingChoice}
          onPick={(systemIds) => {
            const r = phases.resolveRaidOutpostsPlace(G, systemIds);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RebelCellPlace'
        && G.pendingChoice.side === humanSide && (
        <RebelCellPlaceModal G={G} choice={G.pendingChoice}
          onPick={(systemId) => {
            const r = phases.resolveRebelCellPlace(G, systemId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RebelCellDiscard'
        && G.pendingChoice.side === humanSide && (
        <RebelCellDiscardModal G={G} choice={G.pendingChoice}
          onPick={(objectiveId) => {
            const r = phases.resolveRebelCellDiscard(G, objectiveId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DetainedTargetPick'
        && G.pendingChoice.side === humanSide && (
        <DetainedTargetPickModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveDetainedTargetPick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RetrieveThePlansPick'
        && G.pendingChoice.side === humanSide && (
        <RetrieveThePlansPickModal G={G} choice={G.pendingChoice}
          onPick={(oid) => {
            const r = phases.resolveRetrieveThePlansPick(G, oid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'InterrogationDroidDecoyPick'
        && G.pendingChoice.side === humanSide && (
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title="Interrogation Droid — name decoy systems"
          instructions="Name systems as decoys for the Rebel base. Pick them on the map."
          candidates={G.pendingChoice.candidates}
          onPick={() => {}}
          multi={{
            count: G.pendingChoice.count,
            onSubmit: (sids) => {
              const r = phases.resolveInterrogationDroidDecoyPick(G, sids);
              if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
              persist(); refresh();
            },
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'OneInAMillionOffer'
        && (G.pendingChoice.context === 'mission' || G.pendingChoice.context === 'dsplans')
        && G.pendingChoice.side === humanSide && (
        <OneInAMillionMissionModal choice={G.pendingChoice}
          onSubmit={(picks) => {
            // DSP context routes to the Death Star Plans resolver (#186).
            const r = G.pendingChoice && G.pendingChoice.kind === 'OneInAMillionOffer'
              && G.pendingChoice.context === 'dsplans'
              ? combat.resolveDsPlansOneInAMillion(G, picks)
              : phases.resolveOneInAMillionMission(G, picks);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'NobleSacrificeOffer'
        && G.pendingChoice.side === humanSide && (
        <NobleSacrificeOfferModal onAccept={(accept) => {
          const r = phases.resolveNobleSacrificeOffer(G, accept);
          if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
          persist(); refresh();
        }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ItIsYourDestinyOffer'
        && G.pendingChoice.side === humanSide && (
        <ItIsYourDestinyOfferModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveItIsYourDestinyOffer(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'UndercoverOffer'
        && G.pendingChoice.side === humanSide && (
        <UndercoverOfferModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveUndercoverOffer(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'SonOfSkywalkerOffer'
        && G.pendingChoice.side === humanSide && (
        <SonOfSkywalkerOfferModal G={G} choice={G.pendingChoice}
          onPick={(mid) => {
            const r = phases.resolveSonOfSkywalkerOffer(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'TrackThemOffer'
        && G.pendingChoice.side === humanSide && (
        <TrackThemOfferModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = combat.resolveTrackThemOffer(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'SomethingToFightForOffer'
        && G.pendingChoice.side === humanSide && (
        <SomethingToFightForOfferModal G={G} choice={G.pendingChoice}
          onPick={(oid) => {
            const r = combat.resolveSomethingToFightForOffer(G, oid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'PostBountyOffer'
        && G.pendingChoice.side === humanSide && (
        <PostBountyOfferModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolvePostBountyOffer(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'AmbitionsOfPowerOffer'
        && G.pendingChoice.side === humanSide && (
        <AmbitionsOfPowerOfferModal choice={G.pendingChoice}
          onAccept={(accept) => {
            const r = phases.resolveAmbitionsOfPowerOffer(G, accept);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'LeaderPoolEliminate'
        && G.pendingChoice.side === humanSide && (
        <LeaderPoolEliminateModal G={G} choice={G.pendingChoice}
          onPick={(leaderId) => {
            const r = phases.resolveLeaderPoolEliminate(G, leaderId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DiscreditRebellionChoice'
        && G.pendingChoice.side === humanSide && (
        <DiscreditRebellionModal G={G} choice={G.pendingChoice}
          onAction={(action) => {
            const r = phases.resolveDiscreditRebellion(G, action);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'HeistChoice'
        && G.pendingChoice.side === humanSide && (
        <HeistChoiceModal G={G} choice={G.pendingChoice}
          onAction={(action) => {
            const r = phases.resolveHeistChoice(G, action);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'EstablishTradeChoice'
        && G.pendingChoice.side === humanSide && (
        <EstablishTradeChoiceModal G={G} choice={G.pendingChoice}
          onAction={(action) => {
            const r = phases.resolveEstablishTradeChoice(G, action);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'UnderTheRadarKeep'
        && G.pendingChoice.side === humanSide && (
        <UnderTheRadarKeepModal G={G} choice={G.pendingChoice}
          onPick={(probeId) => {
            const r = phases.resolveUnderTheRadarKeep(G, probeId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'UnderTheRadarReturn'
        && G.pendingChoice.side === humanSide && (
        <UnderTheRadarReturnModal G={G} choice={G.pendingChoice}
          onAccept={(accept) => {
            const r = phases.resolveUnderTheRadarReturn(G, accept);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'StartingCardBranch'
        && G.pendingChoice.side === humanSide && (
        <StartingCardBranchModal G={G} choice={G.pendingChoice}
          onAction={(action) => {
            const r = phases.resolveStartingCardBranch(G, action);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {/* Secret Mission's keep-cards pick is part of RESOLVING the mission, so
          it must show even though the mission's own resolve report is already
          queued — otherwise the player sees only the report and never the pick
          (BGG report). The modal's z-index sits above the report so it shows
          first; the report follows once the pick is made. */}
      {G.pendingChoice?.kind === 'SecretMissionPick'
        && G.pendingChoice.side === humanSide && (
        <SecretMissionPickModal G={G} choice={G.pendingChoice}
          onPick={(mid) => {
            const r = phases.resolveSecretMissionPick(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'MissionRecruitLeaderPick'
        && G.pendingChoice.side === humanSide && (
        <MissionRecruitLeaderPickModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveMissionRecruitLeaderPick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ReconnaissancePick'
        && G.pendingChoice.side === humanSide && (
        <ReconnaissancePickModal G={G} choice={G.pendingChoice}
          onPick={(mid) => {
            const r = phases.resolveReconnaissancePick(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'DrawThemOutPick'
        && G.pendingChoice.side === humanSide && (
        <DrawThemOutPickModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveDrawThemOutPick(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RegionalAidPick'
        && G.pendingChoice.side === humanSide && (
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title="Regional Aid — gain loyalty elsewhere in the region"
          instructions="Pick a populous system in the same region as the target to gain a second loyalty marker."
          candidates={G.pendingChoice.candidates}
          onPick={(sid) => {
            const r = phases.resolveRegionalAidPick(G, sid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'BreakTheirWillPick'
        && G.pendingChoice.side === humanSide && (
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title="Break Their Will — name a system"
          instructions="Name any system. The Rebel must reveal whether their hidden base is in that system's region."
          candidates={G.pendingChoice.candidates}
          onPick={(sid) => {
            const r = phases.resolveBreakTheirWillPick(G, sid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'BlindsideOffer'
        && G.pendingChoice.side === humanSide && (
        <BlindsideOfferModal G={G} choice={G.pendingChoice}
          onAccept={(accept) => {
            const r = phases.resolveBlindsideOffer(G, accept);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'WookieGuardianOffer'
        && G.pendingChoice.side === humanSide && (
        <WookieGuardianOfferModal G={G} choice={G.pendingChoice}
          onAccept={(accept) => {
            const r = phases.resolveWookieGuardianOffer(G, accept);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'C3POOffer'
        && G.pendingChoice.side === humanSide && (
        <C3POOfferModal G={G} choice={G.pendingChoice}
          onAccept={(accept) => {
            const r = phases.resolveC3POOffer(G, accept);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'FalconOffer'
        && G.pendingChoice.side === humanSide && (
        <FalconOfferModal G={G} choice={G.pendingChoice}
          onPick={(lid) => {
            const r = phases.resolveFalconOffer(G, lid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'BrilliantAdministratorBuildPick'
        && G.pendingChoice.side === humanSide && (
        <BrilliantAdministratorBuildPickModal G={G} choice={G.pendingChoice}
          onPick={(picks) => {
            const r = phases.resolveBrilliantAdministratorBuildPick(G, picks);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'CatchThemBySurpriseMovePick'
        && G.pendingChoice.side === humanSide && (
        <CatchThemBySurpriseMovePickModal G={G} choice={G.pendingChoice}
          onPick={(srcId, ids) => {
            const r = phases.resolveCatchThemBySurpriseMovePick(G, srcId, ids);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ScoutingMissionTIEPick'
        && G.pendingChoice.side === humanSide && (
        <ScoutingMissionTIEPickModal G={G} choice={G.pendingChoice}
          onPick={(ids) => {
            const r = phases.resolveScoutingMissionTIEPick(G, ids);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'OurMostDesperateHourPick'
        && G.pendingChoice.side === humanSide && (
        <MissionListPickModal G={G} choice={G.pendingChoice}
          title="Our Most Desperate Hour — pick a mission"
          subtitle="Search your full mission deck. Leia is placed directly on the chosen mission (assigned and ready to reveal this turn)."
          color="#aae0ff"
          assignedLeaderId="princess-leia"
          onPick={(mid) => {
            const r = phases.resolveOurMostDesperateHourPick(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ProceedingAsPlannedPick'
        && G.pendingChoice.side === humanSide && (
        <MissionListPickModal G={G} choice={G.pendingChoice}
          title="Proceeding As Planned — pick a project"
          subtitle="Search the project deck. The resolver leader will be assigned to it."
          color="#ffaaaa"
          assignedLeaderId={G.pendingChoice.leaderId}
          onPick={(mid) => {
            const r = phases.resolveProceedingAsPlannedPick(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'StartEvacuationPick'
        && G.pendingChoice.side === humanSide && (
        <StartEvacuationPickModal G={G} choice={G.pendingChoice}
          onPick={(sysId, ids) => {
            const r = phases.resolveStartEvacuationPick(G, sysId, ids);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'IndependentOperationEvacPick'
        && G.pendingChoice.side === humanSide && (
        <IndependentOperationEvacPickModal G={G} choice={G.pendingChoice}
          onPick={(sysId) => {
            const r = phases.resolveIndependentOperationEvacPick(G, sysId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'HiddenFleetUnitPick'
        && G.pendingChoice.side === humanSide && (
        <HiddenFleetUnitPickModal G={G} choice={G.pendingChoice}
          onPick={(ids) => {
            const r = phases.resolveHiddenFleetUnitPick(G, ids);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'TemporaryAllianceBuildPick'
        && G.pendingChoice.side === humanSide && (
        <TemporaryAllianceBuildPickModal G={G} choice={G.pendingChoice}
          onPick={(picks) => {
            const r = phases.resolveTemporaryAllianceBuildPick(G, picks);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'BuildFromIconsPick'
        && G.pendingChoice.side === humanSide && (
        <BuildFromIconsPickModal G={G} choice={G.pendingChoice}
          onPick={(picks) => {
            const r = phases.resolveBuildFromIconsPick(G, picks);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'ContingencyPlanPick'
        && G.pendingChoice.side === humanSide && (
        <ContingencyPlanPickModal G={G} choice={G.pendingChoice}
          onPick={(mid) => {
            const r = phases.resolveContingencyPlanPick(G, mid);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RapidMobilizationBranch'
        && G.pendingChoice.side === humanSide && (
        <RapidMobilizationBranchModal G={G} choice={G.pendingChoice}
          onPick={(branch) => {
            const r = phases.resolveRapidMobilizationBranch(G, branch);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RapidMobilizationMovePick'
        && G.pendingChoice.side === humanSide && (
        <RapidMobilizationMovePickModal G={G}
          onPick={(sysId, ids) => {
            const r = phases.resolveRapidMobilizationMove(G, sysId, ids);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'RapidMobilizationBasePick'
        && G.pendingChoice.side === humanSide && (
        <RapidMobilizationBasePickModal G={G} choice={G.pendingChoice}
          onPick={(sysId) => {
            const r = phases.resolveRapidMobilizationBasePick(G, sysId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }} />
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
        <MapPickerOverlay
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          color={sideColor(G.pendingChoice.side)}
          title="Fear Will Keep Them In Line"
          instructions="Pick systems in this region to gain Imperial loyalty. Click them on the map."
          candidates={G.pendingChoice.candidates}
          onPick={() => {}}
          multi={{
            count: G.pendingChoice.count,
            onSubmit: (ids) => {
              const r = phases.resolveFearWillKeepThemInLinePick(G, ids);
              if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
              persist(); refresh();
            },
          }} />
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
        && humanSide === 'Rebel' && (
        <HomingBeaconMapModal
          G={G} systems={systemsRef.current} masks={masksRef.current} humanSide={humanSide}
          leaderCandidates={G.pendingChoice.leaderCandidates}
          systemCandidates={G.pendingChoice.systemCandidates}
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
        && G.pendingChoice?.kind === 'SafeHavenPick'
        && (!online || online.yourTurn) && (
        <SafeHavenPickModal
          G={G}
          choice={G.pendingChoice}
          onConfirm={(picks) => {
            const r = phases.resolveSafeHavenPick(G, picks);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}

      {(!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0)
        && G.pendingChoice?.kind === 'StolenPlansReorder'
        // Side-aware gate: the reorder modal belongs to whichever side the
        // choice is tagged for — Rebel for Stolen Plans, Empire for Lord
        // Vader's Orders (#203). Was hardcoded to Rebel, so a human Empire
        // playing Lord Vader's Orders never got the dialog (and, after the
        // ownership fix, the game would soft-lock with no one to resolve it).
        && humanSide === G.pendingChoice.side && (
        <StolenPlansReorderModal
          G={G}
          choice={G.pendingChoice}
          onPick={(cardId) => {
            const r = phases.resolveStolenPlansPick(G, cardId);
            if (!r.ok) alert(`Cannot resolve: ${r.reason}`);
            persist(); refresh();
          }}
          onUndo={() => {
            const r = phases.undoStolenPlansPick(G);
            if (!r.ok) alert(`Cannot undo: ${r.reason}`);
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
      {G.pendingCombat && (!G.missionReports || G.missionReports.length === 0) && (
        <CombatBoardLive
          G={G}
          humanSide={humanSide}
          online={online ? { submit: online.submit, yourTurn: online.yourTurn } : undefined}
          onPersist={() => { persist(); refresh(); }}
          onShowDiceKey={() => setShowDiceKey(true)}
          onShowTacticKey={() => setShowTacticKey(true)}
          onReportProblem={() => {
            // Open the modal first; capture screenshot in background with
            // a 5s timeout so html2canvas can't strand the user behind a
            // dead click.
            setReportScreenshot(null);
            setShowReport(true);
            (async () => {
              try {
                const png = await Promise.race([
                  capturePageScreenshot(),
                  new Promise<null>((r) => setTimeout(() => r(null), 5000)),
                ]);
                setReportScreenshot(png);
              } catch (e) {
                console.warn('[report] background screenshot failed:', e);
              }
            })();
          }}
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

      {G.pendingChoice?.kind === 'HandLimitDiscard' && G.pendingChoice.side === humanSide
        && (!G.missionReports || G.missionReports.length === 0)
        && (!G.combatReports || G.combatReports.length === 0) && (
        <HandLimitDiscardModal
          G={G}
          choice={G.pendingChoice}
          onSubmit={(ids) => {
            const r = phases.resolveHandLimitDiscard(G, ids);
            if (!r.ok) alert(`Cannot discard: ${r.reason}`);
            persist(); refresh();
          }}
        />
      )}
      </div>

      {/* Floating "peek the board" toggle — shown whenever a prompt/overlay is
          up that greys out the map. Lives OUTSIDE the wrapper above so it stays
          clickable while peeking. (idea: MightyFaben) */}
      {(!!G.pendingChoice || !!G.pendingCombat
        || !!(G.missionReports?.length) || !!(G.combatReports?.length)
        || !!(G.refreshReports?.length) || !!(G.objectiveReports?.length)) && (
        <button
          onClick={() => setPeekBoard((p) => !p)}
          title="Temporarily hide this prompt to see the whole map, then click again to go back and choose"
          style={{
            position: 'fixed', top: 10, left: 10, zIndex: 10000,
            background: peekBoard ? '#ffd54a' : '#1a2230',
            color: peekBoard ? '#000' : '#9fb3d9',
            border: `2px solid ${peekBoard ? '#ffd54a' : '#3a4a6a'}`,
            padding: '6px 12px', borderRadius: 4, cursor: 'pointer',
            fontWeight: 700, fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          }}
        >
          {peekBoard ? '↩ Back to choice' : '👁 Peek board'}
        </button>
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
    attackerPortrait: number;
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
      zIndex: 5000,
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
          <CardNameHover
            name={card?.name ?? choice.missionId}
            image={card?.image}
            rulesText={card?.rulesText}
          >
            <strong style={{ color: '#fff', borderBottom: '1px dotted #888' }}>
              {card?.name ?? choice.missionId}
            </strong>
          </CardNameHover>
          {' '}at <strong style={{ color: '#ffd54a' }}>{targetName}</strong>
          {' '}— attacker will roll <strong style={{ color: '#fff' }}>{choice.attackerDice}</strong> {choice.skill} dice.
        </div>

        {choice.attackerPortrait > 0 && (
          <div style={{
            fontSize: 12, color: '#ffb84d', marginBottom: 8, fontWeight: 600,
            background: 'rgba(80,50,10,0.6)', border: '1px solid #6a4a1a',
            borderRadius: 3, padding: '4px 8px',
          }}>
            ⚠ Portrait bonus: this mission pictures a leader the attacker assigned —
            they get <strong>+{choice.attackerPortrait} automatic successes</strong> on
            top of their dice. Factor this in before opposing.
          </div>
        )}

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

function StolenPlansReorderModal({ G, choice, onPick, onUndo }: {
  G: GameState;
  choice: { kind: 'StolenPlansReorder'; remaining: string[]; orderedTop: string[] };
  onPick: (cardId: string) => void;
  onUndo: () => void;
}) {
  const totalCount = choice.remaining.length + choice.orderedTop.length;
  const nextSlot = choice.orderedTop.length + 1; // 1-based for display
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 5000,
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
                    <CardNameHover name={o?.name ?? cid} image={o?.image} rulesText={o?.rulesText}>
                      <span style={{ borderBottom: '1px dotted #888' }}>{o?.name ?? cid}</span>
                    </CardNameHover>
                    {' '}
                    <span style={{ color: '#ffd54a' }}>+{o?.reputation ?? 0}</span>
                  </li>
                );
              })}
            </ol>
            <button className="tab-button" onClick={onUndo}
              style={{ marginTop: 6, fontSize: 11, padding: '2px 8px' }}>
              ↩ Undo last pick
            </button>
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
                  <CardNameHover name={o?.name ?? cid} image={o?.image} rulesText={o?.rulesText}>
                    <strong style={{ fontSize: 13, borderBottom: '1px dotted #888' }}>{o?.name ?? cid}</strong>
                  </CardNameHover>
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
// Objective Scored notice — pops up the moment the human's side completes
// an objective, showing the card art + rules text + rep gained.
// ============================================================================

function ObjectiveScoredModal({ G, notice, onDismiss }: {
  G: GameState;
  notice: { objectiveId: string; reputation: number; turn: number };
  onDismiss: () => void;
}) {
  const o = G.catalog.objectives[notice.objectiveId];
  const cardUrl = o?.image ? getCachedArtUrlSync(o.image) : null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5500,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #80dc78', borderRadius: 6,
          padding: 20, maxWidth: 460, width: '92%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)', textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 14, color: '#80dc78', fontWeight: 700, marginBottom: 6 }}>
          Rebel objective scored — turn {notice.turn}
        </div>
        <div style={{ fontSize: 18, color: '#fff', fontWeight: 700, marginBottom: 4 }}>
          {o?.name ?? notice.objectiveId}
        </div>
        <div style={{ fontSize: 14, color: '#ffd54a', fontWeight: 700, marginBottom: 10 }}>
          +{notice.reputation} reputation
        </div>
        {cardUrl ? (
          <img
            src={cardUrl}
            alt={o?.name ?? notice.objectiveId}
            style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 4, border: '1px solid #333', display: 'block', margin: '0 auto 10px' }}
          />
        ) : (
          <div style={{
            width: '100%', height: 180, background: '#222', color: '#888',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4, marginBottom: 10, fontSize: 12,
          }}>
            (objective art not in cached .vmod)
          </div>
        )}
        {o?.rulesText && (
          <div style={{ fontSize: 12, color: '#cbc4b0', marginBottom: 12, lineHeight: 1.4, textAlign: 'left' }}>
            {o.rulesText}
          </div>
        )}
        <button
          onClick={onDismiss}
          style={{
            padding: '8px 18px', fontSize: 14, fontWeight: 700,
            background: '#80dc78', color: '#000', border: 'none',
            borderRadius: 4, cursor: 'pointer',
          }}
        >OK</button>
      </div>
    </div>
  );
}

// ============================================================================
// Objective Drawn notice — shown each time a new objective card enters the
// Rebel's hand (typically during the draw step of Refresh). Lets the player
// see the card art / name / rules text before it disappears into the hand,
// and surfaces what was drawn so they can plan around it. User-suggested
// after issue #39 ("when did regional-support-1 enter my hand?") couldn't be
// answered from the log alone.
// ============================================================================

function ObjectiveDrawnModal({ G, notice, onDismiss }: {
  G: GameState;
  notice: { objectiveId: string; turn: number };
  onDismiss: () => void;
}) {
  const o = G.catalog.objectives[notice.objectiveId];
  const cardUrl = o?.image ? getCachedArtUrlSync(o.image) : null;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5400,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
          padding: 20, maxWidth: 460, width: '92%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)', textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Objective drawn — turn {notice.turn}
        </div>
        <div style={{ fontSize: 18, color: '#fff', fontWeight: 700, marginBottom: 4 }}>
          {o?.name ?? notice.objectiveId}
        </div>
        {o && (
          <div style={{ fontSize: 12, color: '#ffd54a', marginBottom: 10 }}>
            Stage {o.stage} · {o.timing} · +{o.reputation} reputation when scored
          </div>
        )}
        {cardUrl ? (
          <img
            src={cardUrl}
            alt={o?.name ?? notice.objectiveId}
            style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 4, border: '1px solid #333', display: 'block', margin: '0 auto 10px' }}
          />
        ) : (
          <div style={{
            width: '100%', height: 180, background: '#222', color: '#888',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4, marginBottom: 10, fontSize: 12,
          }}>
            (objective art not in cached .vmod)
          </div>
        )}
        {o?.rulesText && (
          <div style={{ fontSize: 12, color: '#cbc4b0', marginBottom: 12, lineHeight: 1.4, textAlign: 'left' }}>
            {o.rulesText}
          </div>
        )}
        <button
          onClick={onDismiss}
          style={{
            padding: '8px 18px', fontSize: 14, fontWeight: 700,
            background: '#aae0ff', color: '#000', border: 'none',
            borderRadius: 4, cursor: 'pointer',
          }}
        >OK</button>
      </div>
    </div>
  );
}

// ============================================================================
// Leader Rescued notice — pops when a captured Rebel leader is freed,
// whether via a successful rescue mission or via auto-rescue (engine
// path: a captured leader at a system with no opposing units is freed).
// User report #45 surfaced the need: Han Solo auto-rescued at the end
// of combat after the Empire retreated; the player didn't realize, then
// tried to reveal Daring Rescue and got a confusing "no targets" error.
// ============================================================================

/** Generic dismissible info notice for Empire private events (Homing Beacon
 *  region reveal #192, project draw #194). Title + body, one button. */
function InfoNoticeModal({ notice, onDismiss }: {
  notice: { title: string; body: string; turn: number };
  onDismiss: () => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5200 }}
      onClick={onDismiss}>
      <div style={{ background: '#15171c', border: '2px solid #ffb84d', borderRadius: 6,
        padding: 20, maxWidth: 460, width: '90%' }}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 15, color: '#ffb84d', fontWeight: 700, marginBottom: 8 }}>
          {notice.title}
        </div>
        <div style={{ fontSize: 13, color: '#d8dade', lineHeight: 1.5, marginBottom: 16 }}>
          {notice.body}
        </div>
        <div style={{ textAlign: 'right' }}>
          <button className="tab-button active" onClick={onDismiss} style={{ padding: '6px 18px' }}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

function LeaderRescuedModal({ G, notice, onDismiss }: {
  G: GameState;
  notice: { leaderId: string; reason: string; turn: number };
  onDismiss: () => void;
}) {
  const ldr = G.catalog.leaders[notice.leaderId];
  const portraitUrl = ldr?.image ? getCachedArtUrlSync(ldr.image) : null;
  const wasMissionRescue = notice.reason !== 'no-imperial-units'
    && notice.reason !== 'auto'
    && notice.reason !== 'replaced-by-new-capture';
  const headline = wasMissionRescue ? 'Leader rescued!' : 'Leader freed';
  const explainReason = (() => {
    if (notice.reason === 'no-imperial-units') {
      return 'No Imperial units remained at the system where they were held — per the rules, captured leaders are freed when their captors leave.';
    }
    if (notice.reason === 'replaced-by-new-capture') {
      return 'The Empire captured another leader, releasing this one (the Empire only has one "captured" ring at a time).';
    }
    if (wasMissionRescue) {
      return 'A successful rescue mission freed them.';
    }
    return `Reason: ${notice.reason}`;
  })();
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5400,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #80dc78', borderRadius: 6,
          padding: 22, maxWidth: 440, width: '92%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)', textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 13, color: '#80dc78', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {headline} — turn {notice.turn}
        </div>
        <div style={{ fontSize: 18, color: '#fff', fontWeight: 700, marginBottom: 10 }}>
          {ldr?.name ?? notice.leaderId}
        </div>
        {portraitUrl && (
          <img
            src={portraitUrl}
            alt={ldr?.name ?? notice.leaderId}
            style={{ width: 180, height: 'auto', borderRadius: 4, border: '1px solid #333', margin: '0 auto 12px', display: 'block' }}
          />
        )}
        <div style={{ fontSize: 12, color: '#cbc4b0', lineHeight: 1.4, textAlign: 'left', marginBottom: 14 }}>
          {explainReason}
        </div>
        <button
          onClick={onDismiss}
          style={{
            padding: '8px 18px', fontSize: 14, fontWeight: 700,
            background: '#80dc78', color: '#000', border: 'none',
            borderRadius: 4, cursor: 'pointer',
          }}
        >OK</button>
      </div>
    </div>
  );
}

// ============================================================================
// Report-Response notice — surfaces the resolution comment from a previously-
// filed problem report. The comment is written in user-facing language by
// the maintainer when closing the GitHub issue (see CLAUDE.md "Report-
// response writing style" for the convention). Modal renders the response
// as markdown-ish plain text + a link to the underlying GitHub issue.
// ============================================================================

function ReportResponseModal({ notice, onDismiss }: {
  notice: { number: number; title: string; htmlUrl: string; response: string };
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6500,
      }}
      onClick={onDismiss}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
          padding: 22, maxWidth: 560, width: '94%',
          maxHeight: '88vh', overflowY: 'auto',
          boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
        }}
      >
        <div style={{ fontSize: 12, color: '#aae0ff', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Reply to your problem report
        </div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 14, fontStyle: 'italic' }}>
          "{notice.title}"
        </div>
        <div style={{
          fontSize: 14, color: '#e8e8ea', lineHeight: 1.55,
          whiteSpace: 'pre-wrap', marginBottom: 16,
        }}>
          {notice.response}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <a
            href={notice.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#888' }}
          >
            (issue #{notice.number} on GitHub)
          </a>
          <button
            onClick={onDismiss}
            style={{
              padding: '8px 18px', fontSize: 14, fontWeight: 700,
              background: '#aae0ff', color: '#000', border: 'none',
              borderRadius: 4, cursor: 'pointer',
            }}
          >Thanks</button>
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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

        {/* "Objectives auto-played" intentionally omitted: each completed
            objective already gets its own prominent "Objective completed"
            modal (with card art) before this report shows, so listing it here
            too read as the same card appearing twice (player report). */}

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
          {groupedBuilds.size > 0
            ? Array.from(groupedBuilds.entries()).map(([sid, units]) => (
                <div key={sid}>
                  From <em>{sys(sid)}</em>: {units.join(', ')}
                </div>
              ))
            : (() => {
                // Explain WHY there's no build, so a non-build turn isn't
                // mistaken for a broken build step. Build happens as the time
                // marker advances ONTO a build space (2,4,6,…,14) — it's a
                // every-other-round step, not every round.
                const t = report.newTurn;
                const isBuildSpace = phases.BUILD_TIME_MARKERS.has(t);
                const next = [...phases.BUILD_TIME_MARKERS].sort((a, b) => a - b).find((s) => s > t);
                return (
                  <Quiet>
                    {isBuildSpace
                      ? '(build space, but nothing could be queued — your systems were blocked by enemy units, sabotaged, or had no resource icons)'
                      : `(no build this turn — builds happen as the time marker advances onto a build space: 2, 4, 6, …, 14. It's now on space ${t}${next ? `, so the next build is at space ${next}` : ''}.)`}
                  </Quiet>
                );
              })()}
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
/** A short "when/how do I play this?" line for an action-hand card (issue #67
 *  — players couldn't tell how to play An Old Friend / Ambush / C-3PO). */
function actionCardPlayHint(G: GameState, side: Side, cardId: string): string | undefined {
  const card = G.catalog.actions[cardId];
  if (!card) return undefined;
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const reqs = card.leaderRequirement ?? [];
  const reqNames = reqs.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(' or ');
  const leaderReady = reqs.length === 0 || reqs.some((lid) => f.leaderPool.includes(lid as never));
  // Droid ring cards: attach to a leader during your Assignment phase; the ring
  // then triggers in that leader's system.
  if (cardId === 'resourceful-astromech') {
    return '💍 Attach the R2-D2 ring to a leader (Assignment phase, "Play action card" button). '
      + 'It blanks one enemy die during a mission/combat in that leader\'s system.';
  }
  if (cardId === 'human-cyborg-relations') {
    return '💍 Attach the C-3PO ring to a leader (Assignment phase, "Play action card" button). '
      + 'It auto-succeeds a failed diplomacy mission in that leader\'s system.';
  }
  switch (card.timing) {
    case 'Assignment':
      return '▶ Play during your Assignment phase'
        + (reqs.length
            ? ` — needs ${reqNames} in your leader pool`
              + (leaderReady
                  ? '. Available now: use the "Play action card" button.'
                  : ' (not in your pool right now).')
            : '. Use the "Play action card" button.');
    case 'Immediate':
      return '⚡ Triggers automatically at the right moment — you\'ll be prompted (you don\'t play it from hand).';
    case 'StartOfCombat':
      return '⚔ Offered at the start of a combat you\'re in — you\'ll be prompted then.';
    case 'Special':
      return '✦ Triggers at its specific moment (e.g. during a mission or combat) — you\'ll be prompted.';
    default:
      return card.timing ? `Timing: ${card.timing}` : undefined;
  }
}

function HandTip({ count, cards }: {
  count: number;
  cards: { name: string; image?: string; rulesText?: string; hint?: string }[];
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
          // Float a strip of card images to the right of the row. Force
          // single-row layout (no wrap, no column collapse) so 6+ cards
          // tile horizontally rather than stacking. Width sized to fit
          // exactly N tiles + gaps so a parent's overflow:hidden / narrow
          // containing block can't crush the popup into a column.
          // Pointer events disabled so leaving the source still closes
          // the popup cleanly.
          style={{
            // Anchor the popup's BOTTOM to the row and grow UPWARD — the
            // hand links live in the faction panel low on the page, so a
            // centered/downward popup ran off the bottom and clipped the
            // rules text under tall card images (player report: objective
            // hover showed the image but not the text). maxHeight + scroll
            // guarantees the text is always reachable.
            position: 'absolute', left: '100%', bottom: 0,
            marginLeft: 12, zIndex: 2000,
            display: 'flex', flexDirection: 'row', gap: 6, flexWrap: 'nowrap',
            background: 'rgba(0,0,0,0.94)', border: '1px solid #555',
            padding: 8, borderRadius: 4,
            maxHeight: '92vh', overflowY: 'auto',
            // Explicit width = N * tile + (N-1) * gap + 16 padding. Stops
            // a narrow ancestor's containing block from forcing column.
            width: cards.length > 0
              ? `${cards.length * TILE_W + (cards.length - 1) * 6 + 16}px`
              : 'auto',
            maxWidth: 'min(95vw, 1400px)',
            overflowX: 'auto',
            pointerEvents: 'none',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
          }}
        >
          {cards.map((c, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              width: TILE_W, flexShrink: 0,
            }}>
              {(() => {
                // Resolve through the .vmod art cache (blob URL from
                // IndexedDB). The old hardcoded /dev-assets/cards/ path
                // only worked in dev — production strips that directory.
                const resolved = c.image ? getCachedArtUrlSync(c.image) : null;
                return resolved ? (
                  <img
                    src={resolved}
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
                );
              })()}
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
              {c.hint && (
                <div style={{
                  color: '#ffd54a', fontSize: 10, marginTop: 4,
                  lineHeight: 1.3, textAlign: 'left', fontStyle: 'italic',
                  whiteSpace: 'normal',
                }}>
                  {c.hint}
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
// CardNameHover — wrap a card name (mission / action / objective / tactic)
// so hovering shows the card art + rules text. Use anywhere a card is
// referenced by name in dialogs, modals, log lines, etc.
// ============================================================================

function CardNameHover({ name, image, rulesText, children, color }: {
  name: string;
  image?: string;
  rulesText?: string;
  children?: React.ReactNode;
  color?: string;
}) {
  // Anchor rect captured at hover time. The preview is rendered position:fixed
  // (relative to the viewport, NOT the hovered element) so it escapes any
  // scrolling/overflow:auto container — otherwise it gets clipped by the modal
  // it lives in (player report #94: Stolen Plans card previews cut off).
  const [rect, setRect] = useState<DOMRect | null>(null);
  const TILE_W = 200;
  const PW = TILE_W + 16;
  const resolved = image ? getCachedArtUrlSync(image) : null;
  // Clamp horizontally to the viewport; flip above/below based on room.
  let posStyle: React.CSSProperties = {};
  if (rect) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - PW / 2, vw - PW - 8));
    posStyle = rect.top > vh / 2
      ? { left, bottom: vh - rect.top + 6 } // place above the name
      : { left, top: rect.bottom + 6 };     // place below
  }
  return (
    <span
      style={{ cursor: 'help', color: color ?? 'inherit' }}
      onMouseEnter={(e) => setRect(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setRect(null)}
    >
      {children ?? name}
      {rect && (
        <span
          style={{
            position: 'fixed', ...posStyle,
            zIndex: 6000,
            display: 'block',
            background: 'rgba(0,0,0,0.96)', border: '1px solid #555',
            padding: 8, borderRadius: 4,
            width: TILE_W + 16,
            maxHeight: '80vh', overflowY: 'auto',
            boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
            pointerEvents: 'none',
            textAlign: 'center',
          }}
        >
          {resolved ? (
            <img src={resolved} alt={name}
              style={{ width: TILE_W, height: 'auto', borderRadius: 4, border: '1px solid #333' }}
            />
          ) : (
            <span style={{
              display: 'inline-block', width: TILE_W, height: TILE_W * 1.4,
              background: '#222', color: '#888', fontSize: 12,
              padding: 8, boxSizing: 'border-box',
            }}>{name}</span>
          )}
          <span style={{
            display: 'block', color: '#fff', fontSize: 12, fontWeight: 600,
            marginTop: 4, lineHeight: 1.2,
          }}>{name}</span>
          {rulesText && (
            <span style={{
              display: 'block', color: '#cbc4b0', fontSize: 11, marginTop: 3,
              lineHeight: 1.35, textAlign: 'left', whiteSpace: 'normal',
            }}>{rulesText}</span>
          )}
        </span>
      )}
    </span>
  );
}

// ============================================================================
// Build Pick Modal — choose unit type for each ambiguous build icon
// ============================================================================

/** Compact one-line unit stat readout: theater, red/black attack dice, health,
 *  and transport (capacity provided or needs-a-lift). Shown in the build picker
 *  so you can compare ships before queueing them (feature: MightyFaben). */
function UnitStatLine({ G, typeId }: { G: GameState; typeId: string }) {
  const t = G.catalog.unitTypes[typeId];
  if (!t) return null;
  return (
    <span style={{ color: '#9a937f', fontSize: 11, whiteSpace: 'nowrap' }}>
      {t.theater === 'space' ? '🚀 space' : '🛡 ground'}
      {' · atk '}
      <span style={{ color: '#ff8866' }}>{t.attack.red}R</span>
      <span style={{ color: '#888' }}>/</span>
      <span style={{ color: '#ccc' }}>{t.attack.black}B</span>
      {t.attack.green > 0 && (<>
        <span style={{ color: '#888' }}>/</span>
        <span style={{ color: '#7be08a' }}>{t.attack.green}G</span>
      </>)}
      {' · HP '}{t.health.value}
      {t.transport.capacity > 0 && ` · carries ${t.transport.capacity}`}
      {t.transport.restriction && ' · needs a transport'}
    </span>
  );
}

/** Mission hand-limit discard (RR p.12): the player picks exactly `count`
 *  non-starting, non-project missions to discard down to the 10-card limit. */
function HandLimitDiscardModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'HandLimitDiscard'; side: Side; count: number; discardable: string[] };
  onSubmit: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < choice.count) next.add(id);
      return next;
    });
  };
  const accent = '#ffb84d';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5100 }}>
      <div style={{ background: '#15171c', border: `2px solid ${accent}`, borderRadius: 6,
        padding: 20, maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <h3 style={{ color: accent, marginTop: 0 }}>
          Over the mission hand limit — discard {choice.count}
        </h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          You're over the 10-card limit. Choose {choice.count} mission{choice.count === 1 ? '' : 's'} to
          discard ({picked.size}/{choice.count} selected). Starting and project cards don't count and can't be discarded.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
          {choice.discardable.map((id) => {
            const m = G.catalog.missions[id];
            const on = picked.has(id);
            return (
              <button key={id} className="tab-button" onClick={() => toggle(id)}
                style={{ textAlign: 'left', padding: '8px 10px',
                  border: `1px solid ${on ? accent : '#2a2d34'}`,
                  background: on ? 'rgba(120,80,20,0.35)' : '#0c0d10' }}>
                <div style={{ fontWeight: 700, color: '#fff' }}>{m?.name ?? id}</div>
                {m?.rulesText && (
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 3 }}>{m.rulesText}</div>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ textAlign: 'right' }}>
          <button className="tab-button active"
            disabled={picked.size !== choice.count}
            onClick={() => onSubmit([...picked])}
            style={{ padding: '6px 16px', opacity: picked.size === choice.count ? 1 : 0.5 }}>
            Discard {picked.size}
          </button>
        </div>
      </div>
    </div>
  );
}

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
      available?: Record<string, number>;
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

  // Holding-pool supply remaining per type at enumeration time. The engine
  // already pruned fully-exhausted types from legalUnitTypes; this lets us
  // also prevent the player spending the SAME last token on two icons in this
  // one batch (the engine hard-rejects that, but warn before they submit).
  const supplyOf = (tid: string): number =>
    choice.picks.find((p) => p.available && tid in p.available)?.available?.[tid] ?? Infinity;
  // How many of `tid` the current selections (excluding pick index `exclude`)
  // already claim.
  const claimedByOthers = (tid: string, exclude: number): number =>
    selections.reduce((n, s, j) => n + (j !== exclude && s === tid ? 1 : 0), 0);
  const remainingFor = (tid: string, exclude: number): number =>
    supplyOf(tid) - claimedByOthers(tid, exclude);
  // An icon's chosen unit is "exhausted" when no token remains for it. The
  // overdraw is FIXABLE if some OTHER legal unit for that icon still has a
  // token (the player should switch) — and only then do we block Confirm.
  // When every legal unit for an icon is used up (unfixable), the build is
  // unavoidably wasted per RAW, so we allow Confirm and let the engine waste
  // it in order — otherwise the modal hard-froze with no way forward (#217).
  const pickExhausted = (i: number): boolean =>
    supplyOf(selections[i]) !== Infinity && remainingFor(selections[i], i) <= 0;
  const pickFixable = (i: number): boolean =>
    pickExhausted(i) && choice.picks[i].legalUnitTypes.some(
      (tid) => tid !== selections[i] && remainingFor(tid, i) > 0);
  const blockConfirm = choice.picks.some((p, i) => pickFixable(i));
  const willWaste = choice.picks.some((p, i) => pickExhausted(i) && !pickFixable(i));

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
            {p.legalUnitTypes.map((tid) => {
              const rem = remainingFor(tid, i);
              const finite = supplyOf(tid) !== Infinity;
              const exhausted = finite && rem <= 0 && selections[i] !== tid;
              return (
                <label
                  key={tid}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0',
                    cursor: exhausted ? 'not-allowed' : 'pointer', opacity: exhausted ? 0.45 : 1 }}
                >
                  <input
                    type="radio"
                    name={`pick-${i}`}
                    checked={selections[i] === tid}
                    disabled={exhausted}
                    onChange={() => setPick(i, tid)}
                  />
                  <span style={{ color: '#fff', fontSize: 13, minWidth: 120 }}>{unitName(tid)}</span>
                  <UnitStatLine G={G} typeId={tid} />
                  {finite && (
                    <span style={{ fontSize: 11, color: rem <= 0 ? '#e57373' : '#888', marginLeft: 'auto' }}>
                      {rem <= 0 ? 'none left in supply' : `${rem} in supply`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        ))}

        {blockConfirm && (
          <div style={{ fontSize: 12, color: '#e57373', margin: '8px 0', lineHeight: 1.4 }}>
            One of your picks would build a unit you have no token left for in
            the holding pool, but another unit is still available for that icon.
            Choose a different unit — the build can't exceed your physical supply.
          </div>
        )}
        {!blockConfirm && willWaste && (
          <div style={{ fontSize: 12, color: '#d2a24c', margin: '8px 0', lineHeight: 1.4 }}>
            You've run out of tokens for some of these icons, and no other unit
            fits them. Those resource icons will simply be skipped (the build is
            wasted) — you can still confirm to build everything you have tokens for.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            onClick={() => onSubmit(selections)}
            disabled={blockConfirm}
            style={{ padding: '8px 24px', background: blockConfirm ? '#444' : color, color: blockConfirm ? '#999' : '#000',
              border: 'none', borderRadius: 4, cursor: blockConfirm ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 14 }}
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
  // Dig In / Outmaneuver discard ONE OTHER ground/space tactic card from hand
  // to block 2 (RAW). The sacrifice may be ANY other tactic card in hand —
  // including a Defensive Formation you'd otherwise have played for a free
  // block. (#122: the sacrifice list wrongly excluded the free-block card, so
  // a hand of [Dig In, Defensive Formation] couldn't play Dig In at all.)
  const sacrificeCandidates = choice.hand.filter((cid) => cid !== paidBlock);

  const [useFree, setUseFree] = useState(false);
  const [usePaid, setUsePaid] = useState(false);
  const [sacrifice, setSacrifice] = useState<string | null>(sacrificeCandidates[0] ?? null);

  const cardLabel = (cid: string) => G.catalog.tactics[cid]?.name ?? cid;
  // A card spent as the Dig In sacrifice can't ALSO be played as a free block.
  const digInSacrifice = (usePaid && paidBlock && sacrifice) ? sacrifice : null;
  const playFree = !!(useFree && freeBlock && freeBlock !== digInSacrifice);
  const blockCards: string[] = [];
  const sacrifices: string[] = [];
  if (playFree && freeBlock) blockCards.push(freeBlock);
  if (usePaid && paidBlock && sacrifice) {
    blockCards.push(paidBlock); sacrifices.push(sacrifice);
  }
  // Defensive Formation blocks 1; Dig In / Outmaneuver block 2.
  const blockTotal = (playFree ? 1 : 0) + ((usePaid && paidBlock && sacrifice) ? 2 : 0);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
          Defensive Formation blocks 1; Dig In / Outmaneuver block 2 by discarding a second tactic card.
        </div>

        {!freeBlock && !paidBlock && (
          <div style={{ fontSize: 12, color: '#666', fontStyle: 'italic', marginBottom: 10 }}>
            No defensive tactic cards in your {choice.theater} hand.
          </div>
        )}

        {freeBlock && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
            padding: 6, background: '#1f2128', borderRadius: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={useFree}
              disabled={usePaid && sacrifice === freeBlock}
              onChange={(e) => setUseFree(e.target.checked)} />
            <span style={{ color: '#fff', fontSize: 13 }}>
              <strong>{cardLabel(freeBlock)}</strong>
              <span style={{ color: '#aaa', marginLeft: 6 }}>
                — block 1 (free){usePaid && sacrifice === freeBlock ? ' — spent on Dig In' : ''}
              </span>
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
              <span style={{ color: sacrificeCandidates.length === 0 ? '#888' : '#fff', fontSize: 13 }}>
                <strong>{cardLabel(paidBlock)}</strong>
                <span style={{ color: '#aaa', marginLeft: 6 }}>
                  — block up to 2 (discard a second tactic card)
                </span>
              </span>
            </label>
            {sacrificeCandidates.length === 0 && (
              <div style={{ marginLeft: 26, marginTop: 4, fontSize: 12, color: '#e0b94f' }}>
                Can't play {cardLabel(paidBlock)} right now — it has to discard a second
                tactic card to block, and this is the only card in your hand.
              </div>
            )}
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
            Block {blockTotal}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Infiltration Pick Modal — Rebel looks at 2 objectives, picks one to keep on top
// ============================================================================

/** Research & Development — Option A vs B picker. Two big buttons; B
 *  is greyed (but still legal) when there's no sabotage marker. */
function ResearchAndDevelopmentOptionModal({ G, choice, onPick }: {
  G: GameState;
  choice: { kind: 'ResearchAndDevelopmentOption'; targetSystemId: string; hasSabotage: boolean; projectDeckSize: number };
  onPick: (option: 'A' | 'B') => void;
}) {
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
      <div style={{ background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Research & Development at {sysName} — pick one
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 14 }}>
          Project deck has {choice.projectDeckSize} card{choice.projectDeckSize === 1 ? '' : 's'} remaining.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={() => onPick('A')}
            style={{ textAlign: 'left', padding: 12, background: '#0c0d10', border: '1px solid #2a2d34',
              borderRadius: 4, color: '#e8e8ea', cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>A: Draw 2 project cards</div>
            <div style={{ fontSize: 11, color: '#aaa' }}>
              Keep 1, place the other on the bottom of the project deck.
            </div>
          </button>
          <button onClick={() => onPick('B')}
            style={{ textAlign: 'left', padding: 12, background: '#0c0d10',
              border: choice.hasSabotage ? '1px solid #80dc78' : '1px solid #2a2d34',
              borderRadius: 4, color: '#e8e8ea', cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
              B: Remove sabotage + draw 1 project card
              {choice.hasSabotage && <span style={{ color: '#80dc78', marginLeft: 6, fontSize: 11 }}>(sabotage present)</span>}
            </div>
            <div style={{ fontSize: 11, color: '#aaa' }}>
              {choice.hasSabotage
                ? `Removes the sabotage marker from ${sysName} and draws 1 project card.`
                : 'No sabotage marker at this system — Option A is strictly better, but B is still legal (just draws 1).'}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shared drag-and-drop "top vs bottom of deck" pick modal. The two
 *  drawn cards start one-per-slot (A on top, B on bottom). The player
 *  drags any card to any slot; the other card auto-snaps to the
 *  remaining slot. Click-to-swap is supported as a fallback for users
 *  who don't want to drag.
 *
 *  Slot semantics differ between the two callers (Infiltration: "stays
 *  on top of deck" vs Covert Operation: "kept in hand"). The labels
 *  prop renders the right wording. */
function TopBottomCardPickModal({ G, cardIds, color, title, blurb, topLabel, bottomLabel, topHint, bottomHint, lookupCard, onConfirm }: {
  G: GameState;
  cardIds: [string, string];
  color: string;
  title: string;
  blurb: string;
  topLabel: string;
  bottomLabel: string;
  topHint: string;
  bottomHint: string;
  /** Map a cardId to display fields. Defaults to objective lookup so
   *  existing Infiltration / Covert callers keep working without
   *  passing this prop. Pass a different lookup for project cards. */
  lookupCard?: (cardId: string) => { name: string; image?: string; reputation?: number; text?: string };
  onConfirm: (topCardId: string, bottomCardId: string) => void;
}) {
  const defaultLookup = (cardId: string) => {
    const o = G.catalog.objectives[cardId];
    return { name: o?.name ?? cardId, image: o?.image, reputation: o?.reputation, text: o?.rulesText };
  };
  const lookup = lookupCard ?? defaultLookup;
  void G; // satisfy unused-locals when lookupCard is provided
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
    const info = lookup(cardId);
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
        {info.image && (
          <img src={vmodAssetUrl(info.image, CARD_IMAGE_BASE)} alt={info.name}
            draggable={false}
            style={{ width: 180, height: 'auto', borderRadius: 3,
              boxShadow: '0 0 12px rgba(0,0,0,0.6)' }} />
        )}
        <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, textAlign: 'center' }}>
          {info.name}
        </div>
        {typeof info.reputation === 'number' && (
          <div style={{ fontSize: 10, color: '#ffd54a', fontWeight: 700 }}>
            +{info.reputation} reputation
          </div>
        )}
        {/* Always show the card's text — in production the card art is
         *  stripped to a placeholder, so the image alone tells the player
         *  nothing about what the card does (player report #105). */}
        {info.text && (
          <div style={{ fontSize: 11, color: '#bdb8a8', textAlign: 'center', lineHeight: 1.35, maxWidth: 200 }}>
            {info.text}
          </div>
        )}
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
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

/** Recruit step (RAW-faithful). The player has drawn 2+ action cards and keeps
 *  ONE — recruiting a leader shown on it if able; the rest go to the bottom.
 *  Per RAW, if NONE of the drawn cards shows a still-recruitable leader, the
 *  player may keep drawing one card at a time (canDrawMore) until one does, or
 *  forgo recruiting and keep a card just for its action effect. */
function RecruitCardPickModal({ G, side, drawnIds, canDrawMore, color, onConfirm, onDrawAnother }: {
  G: GameState;
  side: Side;
  drawnIds: string[];
  canDrawMore: boolean;
  color: string;
  onConfirm: (keepCardId: string) => void;
  onDrawAnother: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(drawnIds[0] ?? null);
  // Keep the selection valid as the drawn set grows (after Draw another).
  useEffect(() => {
    if (selected && !drawnIds.includes(selected)) setSelected(drawnIds[0] ?? null);
  }, [drawnIds, selected]);

  const cardLeaderInfo = (cid: string) => {
    const card = G.catalog.actions[cid];
    const lids = card?.leaderRequirement ?? [];
    const leaders = lids.map((lid) => ({
      lid,
      name: G.catalog.leaders[lid]?.name ?? lid,
      recruitable: phases.leaderRecruitable(G, side, lid),
    }));
    return { card, leaders };
  };

  const renderCard = (cid: string) => {
    const { card, leaders } = cardLeaderInfo(cid);
    const isSel = selected === cid;
    const anyRecruitable = leaders.some((l) => l.recruitable);
    return (
      <div
        key={cid}
        onClick={() => setSelected(cid)}
        style={{
          background: '#0c0d10',
          border: `2px solid ${isSel ? color : '#2a2d34'}`,
          borderRadius: 5, padding: 8, cursor: 'pointer', userSelect: 'none',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5,
          width: 168, boxShadow: isSel ? `0 0 10px ${color}88` : 'none',
        }}
      >
        {card?.image && (
          <img src={vmodAssetUrl(card.image, CARD_IMAGE_BASE)} alt={card?.name ?? cid}
            draggable={false}
            style={{ width: 150, height: 'auto', borderRadius: 3 }} />
        )}
        <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, textAlign: 'center' }}>
          {card?.name ?? cid}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
          {leaders.length === 0 && (
            <div style={{ fontSize: 10, color: '#888' }}>No leader</div>
          )}
          {leaders.map((l) => {
            // Show the leader's skills + tactic values so the player can weigh
            // who to recruit (reporter MightyFaben).
            const ld = G.catalog.leaders[l.lid];
            const skills = ld ? Object.entries(ld.skills)
              .filter(([, v]) => (v as number) > 0)
              .map(([k, v]) => `${k}:${v}`)
              .join(' ') : '';
            return (
              <div key={l.lid} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, fontWeight: 700,
                  color: l.recruitable ? '#7fd17f' : '#c06060' }}>
                  {l.recruitable ? '✓ ' : '✗ '}{l.name}
                  {!l.recruitable && <span style={{ color: '#888', fontWeight: 400 }}> (already in play)</span>}
                </div>
                {ld && (
                  <div style={{ fontSize: 9, color: '#9aa3ad', lineHeight: 1.3 }}>
                    {skills || 'no skills'}
                    <br />tactic s{ld.tacticValues.space}/g{ld.tacticValues.ground}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {leaders.length > 0 && !anyRecruitable && (
          <div style={{ fontSize: 9, color: '#888', textAlign: 'center' }}>recruits no one</div>
        )}
      </div>
    );
  };

  const selInfo = selected ? cardLeaderInfo(selected) : null;
  const selRecruitsSomeone = !!selInfo && selInfo.leaders.some((l) => l.recruitable);
  // Would keeping the selected card throw away a recruit you could still make?
  // (Another drawn card recruits someone, or you're allowed to draw deeper.)
  const otherCardRecruits = !!selected && drawnIds.some(
    (id) => id !== selected && cardLeaderInfo(id).leaders.some((l) => l.recruitable));
  const forgoingAvailableRecruit = !selRecruitsSomeone && (otherCardRecruits || canDrawMore);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 720, width: '94%', maxHeight: '92vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ fontSize: 14, color, fontWeight: 700, marginBottom: 6 }}>
          Recruit — keep one card
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          You drew action cards. Keep ONE — if it shows a leader you haven't recruited yet (✓),
          that leader joins your pool. The cards you don't keep go to the bottom of your deck.
          {canDrawMore && ' None of these cards shows a recruitable leader — you may draw another card, or keep one anyway just for its action effect.'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
          {drawnIds.map(renderCard)}
        </div>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            onClick={onDrawAnother}
            disabled={!canDrawMore}
            title={canDrawMore
              ? 'Draw one more card from the top of your deck.'
              : 'You can only draw deeper when none of the drawn cards shows a recruitable leader.'}
            style={{ padding: '8px 16px',
              background: canDrawMore ? '#2a2d34' : '#1a1c22',
              color: canDrawMore ? '#fff' : '#555',
              border: `1px solid ${canDrawMore ? color : '#2a2d34'}`, borderRadius: 3,
              cursor: canDrawMore ? 'pointer' : 'not-allowed', fontWeight: 600, fontSize: 13 }}>
            Draw another card
          </button>
          <button
            onClick={() => {
              if (!selected) return;
              // Warn before THROWING AWAY a recruit you could still make this
              // turn — either another drawn card recruits someone, or you're
              // allowed to keep drawing for one. Forgoing is legal (you keep
              // the card for its action effect) but should never be accidental.
              if (forgoingAvailableRecruit) {
                const reason = otherCardRecruits
                  ? 'Another card you drew would let you recruit a leader.'
                  : 'You could keep drawing until you find a recruitable leader.';
                const ok = window.confirm(
                  reason + ' Keep this card instead and recruit NO leader this turn? '
                  + '(You\'ll still get the action card.)');
                if (!ok) return;
              }
              onConfirm(selected);
            }}
            disabled={!selected}
            style={{ padding: '8px 22px', background: color, color: '#000',
              border: 'none', borderRadius: 3, cursor: selected ? 'pointer' : 'not-allowed',
              fontWeight: 700, fontSize: 14, opacity: selected ? 1 : 0.5 }}>
            {selRecruitsSomeone ? 'Keep & recruit' : 'Keep card'}
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

/** RoE Safe Haven — pick up to 2 units from the build queue to deploy here. */
function SafeHavenPickModal({ G, choice, onConfirm }: {
  G: GameState;
  choice: { kind: 'SafeHavenPick'; systemId: string; units: { slot: 1 | 2 | 3; index: number; typeId: string }[] };
  onConfirm: (pickedIndices: number[]) => void;
}) {
  const color = sideColor('Rebel');
  const [selected, setSelected] = useState<number[]>([]);
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const toggle = (i: number) => {
    setSelected((cur) => {
      if (cur.includes(i)) return cur.filter((x) => x !== i);
      if (cur.length >= 2) return cur; // cap at 2
      return [...cur, i];
    });
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2600,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 8,
        padding: 24, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
      }}>
        <h3 style={{ color, marginTop: 0 }}>Safe Haven — deploy up to 2 units</h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          Choose up to <b>2 units</b> from your build queue to deploy directly to <b>{sysName}</b>.
          You may take fewer (or none). Selected: {selected.length}/2.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {choice.units.map((u, i) => {
            const isSel = selected.includes(i);
            const name = G.catalog.unitTypes[u.typeId]?.name ?? u.typeId;
            return (
              <button
                key={`${u.slot}-${u.index}`}
                className="tab-button"
                onClick={() => toggle(i)}
                style={{
                  textAlign: 'left', padding: '8px 12px',
                  borderColor: isSel ? color : '#2a2d34',
                  background: isSel ? 'rgba(170,224,255,0.12)' : '#0c0d10',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <span style={{ width: 18 }}>{isSel ? '☑' : '☐'}</span>
                <span style={{ fontWeight: 700, color: '#fff' }}>{name}</span>
                <span style={{ marginLeft: 'auto', color: '#888', fontSize: 11 }}>build slot {u.slot}</span>
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="tab-button" style={{ borderColor: color, color }}
            onClick={() => onConfirm(selected)}>
            Deploy {selected.length} unit{selected.length === 1 ? '' : 's'}
          </button>
          <button className="tab-button" onClick={() => onConfirm([])}>
            Take none
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Covert Operation Pick Modal — Rebel draws 2 objectives, keeps 1 in hand
// ============================================================================

/** Plant False Lead placement modal: the Rebel chose to take these probe
 *  cards from the Empire and decides where each returns — top or bottom of
 *  the deck. (#64 follow-up) */
function PlantFalseLeadModal({ G, cards, onConfirm }: {
  G: GameState;
  cards: string[];
  onConfirm: (placements: { cardId: string; position: 'top' | 'bottom' }[]) => void;
}) {
  const color = sideColor('Rebel');
  const [pos, setPos] = useState<Record<string, 'top' | 'bottom'>>(() => {
    const m: Record<string, 'top' | 'bottom'> = {};
    for (const c of cards) m[c] = 'bottom'; // default: bury (deny longest)
    return m;
  });
  const sysName = (probeId: string) => {
    const sid = G.catalog.probes[probeId]?.systemId;
    return sid ? (G.catalog.systems[sid]?.name ?? sid) : probeId;
  };
  const btn = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 12, fontWeight: 600,
    border: `1px solid ${active ? color : '#3a3d44'}`,
    background: active ? color : '#0c0d10', color: active ? '#000' : '#e8e8ea',
  });
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
      <div style={{ background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 460, width: '92%', boxShadow: '0 8px 32px rgba(0,0,0,0.7)' }}>
        <div style={{ fontSize: 15, color, fontWeight: 700, marginBottom: 6 }}>
          Plant False Lead — return the Empire's probe cards
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12, lineHeight: 1.5 }}>
          You took these {cards.length} probe card{cards.length === 1 ? '' : 's'} from the Empire
          (systems they'd ruled out). Choose where each goes — <b>Bottom</b> hides it the longest;
          <b> Top</b> makes the Empire redraw it next, wasting their probe.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {cards.map((c) => (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8,
              background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4, padding: '6px 10px' }}>
              <span style={{ flex: 1, fontSize: 13, color: '#e8e8ea' }}>{sysName(c)}</span>
              <button style={btn(pos[c] === 'top')} onClick={() => setPos((p) => ({ ...p, [c]: 'top' }))}>Top</button>
              <button style={btn(pos[c] === 'bottom')} onClick={() => setPos((p) => ({ ...p, [c]: 'bottom' }))}>Bottom</button>
            </div>
          ))}
        </div>
        <div style={{ textAlign: 'right' }}>
          <button
            onClick={() => onConfirm(cards.map((c) => ({ cardId: c, position: pos[c] })))}
            style={{ padding: '8px 22px', background: color, color: '#000', border: 'none',
              borderRadius: 3, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
            Confirm placement
          </button>
        </div>
      </div>
    </div>
  );
}

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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
                  <img src={vmodAssetUrl(l.image, LEADER_IMAGE_BASE)} alt={l.name}
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
      <div style={{ background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Planetary Conquest — pick a source system to draw units from
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Target: {targetName}. Units (up to 1 AT-AT, 1 AT-ST, 2 Stormtroopers) move from the source, then combat fires.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 320, overflowY: 'auto' }}>
          {[...choice.sources]
            // Sort by units-sent descending so the strongest source is on top.
            .sort((a, b) => b.picks.length - a.picks.length)
            .map((s) => {
              // Break the picks down by unit type so the player can see
              // exactly what's coming (e.g. "1 AT-AT, 1 AT-ST, 2 Stormtroopers").
              const ss = G.map.systems[s.sourceSystemId];
              const byType: Record<string, number> = {};
              for (const uid of s.picks) {
                const u = ss?.units.find((x) => x.instanceId === uid);
                if (!u) continue;
                byType[u.typeId] = (byType[u.typeId] ?? 0) + 1;
              }
              const labelFor = (typeId: string) => G.catalog.unitTypes[typeId]?.name ?? typeId;
              const breakdown = Object.entries(byType)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([typeId, n]) => `${n}× ${labelFor(typeId)}`)
                .join(', ');
              return (
                <button key={s.sourceSystemId} onClick={() => onPick(s.sourceSystemId)}
                  style={{ textAlign: 'left', padding: 8, background: '#0c0d10', border: '1px solid #2a2d34',
                    borderRadius: 4, color: '#e8e8ea', cursor: 'pointer', fontSize: 13 }}>
                  <div>
                    <strong>{G.catalog.systems[s.sourceSystemId]?.name ?? s.sourceSystemId}</strong>
                    <span style={{ color: '#80dc78', marginLeft: 8, fontWeight: 600 }}>
                      sends {s.picks.length} unit{s.picks.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ color: '#cbc4b0', fontSize: 12, marginTop: 2 }}>
                    {breakdown || '(empty)'}
                  </div>
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** Public Uprising — pick ship/ground composition for 1 circle + 2 triangles. */
function PublicUprisingModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: { kind: 'PublicUprisingPick'; systemId: string };
  onSubmit: (picks: { circle: string; triangles: string[] }) => void;
}) {
  // RAW: "gain 1 circle and 2 triangle units (ships and/or ground units)."
  // Offer EVERY Rebel unit of the matching tier from the catalog — not a
  // hardcoded pair — so e.g. the Rebel Transport (a triangle ship) is
  // selectable (player report #205). Structures aren't "gained" this way.
  const rebelUnitsOfTier = (tier: 'circle' | 'triangle') =>
    Object.values(G.catalog.unitTypes)
      .filter((u) => (u.side === 'Rebel' || (u as { faction?: string }).faction === 'Rebel')
        && u.tier === tier && u.class !== 'structure'
        // RoE units only when the expansion's unit toggle is on — don't offer
        // Nebulon-B / Rebel Vanguard / U-Wing in a base game (regression #215).
        && (u.set !== 'rote' || G.expansion?.roeUnits === true))
      .map((u) => u.id);
  const circleOptions = rebelUnitsOfTier('circle');
  const triangleOptions = rebelUnitsOfTier('triangle');
  const label = (id: string) => {
    const u = G.catalog.unitTypes[id];
    const kind = u?.theater === 'ground' ? 'ground' : 'ship';
    return `${u?.name ?? id} (${kind})`;
  };
  const [circle, setCircle] = useState<string>(circleOptions[0] ?? '');
  const [tri1, setTri1] = useState<string>(triangleOptions[0] ?? '');
  const [tri2, setTri2] = useState<string>(triangleOptions[0] ?? '');
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const sel = (val: string, set: (v: string) => void, options: string[]) => (
    <select value={val} onChange={(e) => set(e.target.value)}
      style={{ marginLeft: 8, background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '2px 6px' }}>
      {options.map((id) => <option key={id} value={id}>{label(id)}</option>)}
    </select>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
      <div style={{ background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Public Uprising — gain 1 circle + 2 triangle units at {sysName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 10 }}>
          Ships and/or ground units. Combat resolves after the units arrive.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: '#fff' }}>
          <label>Circle unit: {sel(circle, setCircle, circleOptions)}</label>
          <label>Triangle #1: {sel(tri1, setTri1, triangleOptions)}</label>
          <label>Triangle #2: {sel(tri2, setTri2, triangleOptions)}</label>
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
  choice: { kind: 'SupportOfMonCalamariPick'; monCalaLoyalty: string; monCalaSubjugated: boolean; cruiserAvailable?: boolean };
  onPick: (option: 'loyalty' | 'cruiser') => void;
}) {
  const loyaltyHint = choice.monCalaLoyalty === 'rebel' && !choice.monCalaSubjugated
    ? 'Mon Calamari is already Rebel-loyal — gain has no effect.' : '';
  const cruiserAvailable = choice.cruiserAvailable !== false;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}>
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
          <button onClick={() => cruiserAvailable && onPick('cruiser')}
            disabled={!cruiserAvailable}
            style={{ textAlign: 'left', padding: 10, background: '#0c0d10', border: '1px solid #2a2d34',
              borderRadius: 4, color: cruiserAvailable ? '#e8e8ea' : '#666',
              cursor: cruiserAvailable ? 'pointer' : 'not-allowed', fontSize: 13 }}>
            <strong>Place 1 Mon Calamari Cruiser</strong> on build slot 3
            {!cruiserAvailable && <div style={{ color: '#ff8866', fontSize: 11, marginTop: 4 }}>
              All 3 Mon Calamari Cruisers are already in play — none left to place.</div>}
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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

function LeadStrikeTeamUnitsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'LeadStrikeTeamUnits';
    side: Side;
    targetSystemId: string;
    availableUnitIds: string[];
    max: number;
  };
  onSubmit: (unitIds: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const baseUnits = G.map.rebelBaseSpace.units;
  const units = choice.availableUnitIds
    .map((uid) => baseUnits.find((u) => u.instanceId === uid))
    .filter((u): u is NonNullable<typeof u> => !!u);

  // Default to the first `max` units (player can adjust).
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(choice.availableUnitIds.slice(0, choice.max)));
  const atCap = picked.size >= choice.max;
  const toggle = (uid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < choice.max) next.add(uid); // enforce up-to-max
      return next;
    });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%',
      }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Lead The Strike Team — send up to {choice.max} ground units to {targetName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Choose up to {choice.max} ground units from the Rebel Base to move to {targetName}
          {' '}(ignoring transport and adjacency). If Imperial ground units are there,
          combat starts immediately after.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {units.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            const isOn = picked.has(u.instanceId);
            const disabled = !isOn && atCap;
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 4,
                background: '#1f2128', borderRadius: 3,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={disabled}
                  onChange={() => toggle(u.instanceId)}
                />
                <span style={{ color: '#fff', fontSize: 13 }}>{t?.name ?? u.typeId}</span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 11, marginRight: 'auto' }}>
            {picked.size}/{choice.max} selected
          </span>
          <button
            onClick={() => onSubmit(Array.from(picked))}
            style={{ padding: '6px 18px', background: '#aae0ff', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Send {picked.size} unit{picked.size === 1 ? '' : 's'} & start combat
          </button>
        </div>
      </div>
    </div>
  );
}

function BehindEnemyLinesUnitsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'BehindEnemyLinesUnits';
    side: Side;
    targetSystemId: string;
    sourceSystemId: string;
    availableUnitIds: string[];
    max: number;
  };
  onSubmit: (unitIds: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  // Read units from the recorded source container (Rebel Base space, or the
  // base's system after reveal) — not hardcoded to rebelBaseSpace.
  const sourceContainer = choice.sourceSystemId === 'rebel-base-space'
    ? G.map.rebelBaseSpace
    : G.map.systems[choice.sourceSystemId];
  const sourceUnits = sourceContainer?.units ?? [];
  const units = choice.availableUnitIds
    .map((uid) => sourceUnits.find((u) => u.instanceId === uid))
    .filter((u): u is NonNullable<typeof u> => !!u);

  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(choice.availableUnitIds.slice(0, choice.max)));
  const atCap = picked.size >= choice.max;
  const toggle = (uid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (next.size < choice.max) next.add(uid);
      return next;
    });
  };

  // Transport check (#281): the card waives leaders + adjacency, NOT transport.
  // Ground units and restriction-icon fighters in the selection each need 1
  // carrier capacity from a ship that's ALSO moving. Mirror the engine's
  // validateMoveOrderTransport so the UI blocks an untransportable selection.
  let capacity = 0, capacityShips = 0, required = 0;
  for (const u of units) {
    if (!picked.has(u.instanceId)) continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.transport.capacity > 0) { capacity += t.transport.capacity; capacityShips++; }
    if (t.transport.restriction) required++;
    if (t.theater === 'ground' && t.class !== 'structure') required++;
  }
  const transportOk = required === 0 || (capacityShips >= 1 && capacity >= required);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 14, color: '#aae0ff', fontWeight: 700, marginBottom: 6 }}>
          Behind Enemy Lines — send up to {choice.max} units to {targetName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Choose up to {choice.max} units (any theatre) from the Rebel Base to move to {targetName}
          {' '}(ignoring leaders and adjacency). Ground units and fighters still need a
          {' '}transport ship moving with them. Combat resolves immediately after.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {units.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            const isOn = picked.has(u.instanceId);
            const disabled = !isOn && atCap;
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 4,
                background: '#1f2128', borderRadius: 3,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={disabled}
                  onChange={() => toggle(u.instanceId)}
                />
                <span style={{ color: '#fff', fontSize: 13 }}>
                  {t?.name ?? u.typeId}
                  <span style={{ color: '#888', fontSize: 11 }}> · {t?.theater}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ color: transportOk ? '#888' : '#e0625a', fontSize: 11, marginRight: 'auto' }}>
            {picked.size}/{choice.max} selected
            {!transportOk && ` · need a transport ship (capacity ${capacity}/${required})`}
          </span>
          <button
            onClick={() => transportOk && onSubmit(Array.from(picked))}
            disabled={!transportOk}
            style={{ padding: '6px 18px', background: transportOk ? '#aae0ff' : '#2a2c33',
              color: transportOk ? '#000' : '#777',
              border: 'none', borderRadius: 3, cursor: transportOk ? 'pointer' : 'not-allowed',
              fontWeight: 600, fontSize: 13 }}
          >
            Send {picked.size} unit{picked.size === 1 ? '' : 's'} & start combat
          </button>
        </div>
      </div>
    </div>
  );
}

function WereTheBaitUnitsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'WereTheBaitUnits';
    side: Side;
    targetSystemId: string;
    sourceSystemId: string;
    availableUnitIds: string[];
    healthBudget: number;
  };
  onSubmit: (unitIds: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const sourceContainer = choice.sourceSystemId === 'rebel-base-space'
    ? G.map.rebelBaseSpace
    : G.map.systems[choice.sourceSystemId];
  const sourceUnits = sourceContainer?.units ?? [];
  const units = choice.availableUnitIds
    .map((uid) => sourceUnits.find((u) => u.instanceId === uid))
    .filter((u): u is NonNullable<typeof u> => !!u);
  const healthOf = (uid: string) => {
    const u = sourceUnits.find((x) => x.instanceId === uid);
    return u ? (G.catalog.unitTypes[u.typeId]?.health.value ?? 0) : 0;
  };

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const usedHealth = Array.from(picked).reduce((s, uid) => s + healthOf(uid), 0);
  const remaining = choice.healthBudget - usedHealth;
  const toggle = (uid: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else if (healthOf(uid) <= remaining) next.add(uid); // enforce budget
      return next;
    });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          We're the Bait — drag up to {choice.healthBudget} health of Rebel ground units to {targetName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Pick Rebel ground units from their base whose combined health is at most {choice.healthBudget}.
          They're dragged to {targetName} and combat resolves immediately.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {units.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            const h = t?.health.value ?? 0;
            const isOn = picked.has(u.instanceId);
            const disabled = !isOn && h > remaining;
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 4,
                background: '#1f2128', borderRadius: 3,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
              }}>
                <input type="checkbox" checked={isOn} disabled={disabled} onChange={() => toggle(u.instanceId)} />
                <span style={{ color: '#fff', fontSize: 13 }}>
                  {t?.name ?? u.typeId}
                  <span style={{ color: '#888', fontSize: 11 }}> · {h} health</span>
                </span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 11, marginRight: 'auto' }}>
            {usedHealth}/{choice.healthBudget} health used
          </span>
          <button
            onClick={() => onSubmit(Array.from(picked))}
            style={{ padding: '6px 18px', background: '#ffaaaa', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Drag {picked.size} unit{picked.size === 1 ? '' : 's'} & start combat
          </button>
        </div>
      </div>
    </div>
  );
}

function ImperialMightUnitsModal({ G, choice, onSubmit }: {
  G: GameState;
  choice: {
    kind: 'ImperialMightUnits';
    side: Side;
    targetSystemId: string;
    queueTypeIds: string[];
    max: number;
  };
  onSubmit: (indices: number[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  // Default to the first `max` queue entries.
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(choice.queueTypeIds.map((_t, i) => i).slice(0, choice.max)));
  const atCap = picked.size >= choice.max;
  const toggle = (i: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else if (next.size < choice.max) next.add(i);
      return next;
    });
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 22, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
      }}>
        <div style={{ fontSize: 14, color: '#ffaaaa', fontWeight: 700, marginBottom: 6 }}>
          Imperial Might — deploy up to {choice.max} units from build queue space 1 to {targetName}
        </div>
        <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
          Pick up to {choice.max} units waiting on build-queue space 1 to deploy immediately at {targetName}.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.queueTypeIds.map((typeId, i) => {
            const t = G.catalog.unitTypes[typeId];
            const isOn = picked.has(i);
            const disabled = !isOn && atCap;
            return (
              <label key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: 4,
                background: '#1f2128', borderRadius: 3,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
              }}>
                <input type="checkbox" checked={isOn} disabled={disabled} onChange={() => toggle(i)} />
                <span style={{ color: '#fff', fontSize: 13 }}>{t?.name ?? typeId}</span>
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 11, marginRight: 'auto' }}>
            {picked.size}/{choice.max} selected
          </span>
          <button
            onClick={() => onSubmit(Array.from(picked))}
            style={{ padding: '6px 18px', background: '#ffaaaa', color: '#000',
              border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
          >
            Deploy {picked.size} unit{picked.size === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Objective-completion notice (issue #71). Pops when a Rebel objective scores
 *  — most notably combat-timed ones like Major Victory, which previously
 *  granted reputation silently with no on-screen acknowledgement. */
function ObjectiveReportModal({ G, report, onDismiss }: {
  G: GameState;
  report: { objectiveId: string; reputation: number; via: string };
  onDismiss: () => void;
}) {
  const card = G.catalog.objectives[report.objectiveId];
  const art = card?.image ? getCachedArtUrlSync(card.image) : null;
  const viaText =
    report.via === 'combat' ? 'completed in combat' :
    report.via === 'death-star-plans' ? 'completed — the Death Star is destroyed!' :
    'completed';
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5200 }}>
      <div style={{ background: '#15171c', border: '2px solid #ffd54a', borderRadius: 8,
        padding: 22, maxWidth: 420, width: '92%', textAlign: 'center',
        boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
        <div style={{ color: '#ffd54a', fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
          Objective {viaText}
        </div>
        <div style={{ color: '#fff', fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
          {card?.name ?? report.objectiveId}
        </div>
        {art && (
          <img src={art} alt={card?.name ?? report.objectiveId}
            style={{ width: 200, height: 'auto', borderRadius: 6, margin: '0 auto 12px',
              display: 'block', boxShadow: '0 0 14px rgba(0,0,0,0.6)' }} />
        )}
        <div style={{ color: '#ffd54a', fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
          +{report.reputation} Rebel reputation
        </div>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 14 }}>
          The reputation marker advances — the Rebellion is one step closer to winning.
        </div>
        <button onClick={onDismiss}
          style={{ padding: '8px 24px', background: '#ffd54a', color: '#000',
            border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 700, fontSize: 14 }}>
          Continue
        </button>
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
        zIndex: 5000,
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

        {report.retreats && report.retreats.length > 0 && (
          <div style={{ marginTop: 8, padding: 6, background: '#14202a', borderRadius: 3 }}>
            <div style={{ fontSize: 12, color: '#9fd0ff', fontWeight: 600, marginBottom: 2 }}>
              Retreats
            </div>
            {report.retreats.map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: '#fff' }}>
                <span style={{ color: sideColor(r.side), fontWeight: 700 }}>{r.side}</span>
                {' '}retreated to <em>{G.catalog.systems[r.toSystemId]?.name ?? r.toSystemId}</em>
                {r.leaderId && <span style={{ color: '#aaa' }}> (led by {G.catalog.leaders[r.leaderId]?.name ?? r.leaderId})</span>}
              </div>
            ))}
          </div>
        )}

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

function ActivationReportModal({ G, report, onDismiss }: {
  G: GameState;
  report: import('../engine/types').SystemActivationReport;
  onDismiss: () => void;
}) {
  const color = sideColor(report.side);
  const ldr = G.catalog.leaders[report.leaderId];
  const sysName = G.catalog.systems[report.targetSystemId]?.name ?? report.targetSystemId;
  const unitName = (typeId: string) => G.catalog.unitTypes[typeId]?.name ?? typeId;
  const srcName = (sid: string) => G.catalog.systems[sid]?.name ?? sid;
  const totalUnits = report.moves.reduce(
    (n, m) => n + m.units.reduce((k, u) => k + u.count, 0), 0,
  );

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // Just under the mission report (2500) / above the combat board (2000).
      zIndex: 2450,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 8,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: `0 8px 40px ${color}44`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          {ldr?.image && (
            <img
              src={vmodAssetUrl(ldr.image, LEADER_IMAGE_BASE)}
              width={56} height={56}
              style={{ borderRadius: '50%', border: `2px solid ${color}`, objectFit: 'cover' }}
              alt={ldr.name}
            />
          )}
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>{ldr?.name ?? report.leaderId}</div>
            <div style={{ fontSize: 13, color: '#aaa' }}>
              <span style={{ color }}>{report.side}</span> activated{' '}
              <strong style={{ color: '#fff' }}>{sysName}</strong>
            </div>
          </div>
        </div>

        {report.moves.length > 0 ? (
          <div style={{
            background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 6,
            padding: '10px 12px', marginBottom: 12,
          }}>
            <div style={{ fontSize: 11, color: '#8aa', fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
              UNITS MOVED ({totalUnits})
            </div>
            {report.moves.map((m, i) => (
              <div key={i} style={{ fontSize: 13, color: '#e8e6f2', marginTop: i === 0 ? 0 : 6 }}>
                <span style={{ color: '#9bb' }}>from {srcName(m.fromSystemId)}:</span>{' '}
                {m.units.map((u) => `${u.count}× ${unitName(u.typeId)}`).join(', ')}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#888', fontStyle: 'italic', marginBottom: 12 }}>
            Leader repositioned; no units moved.
          </div>
        )}

        {report.startedCombat && (
          <div style={{
            padding: '10px 12px', borderRadius: 4, marginBottom: 12,
            background: '#2a1410', border: '2px solid #d4794a', textAlign: 'center',
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#ff9d6b', letterSpacing: 1 }}>
              ⚔ BATTLE AT {sysName.toUpperCase()}
            </div>
            <div style={{ fontSize: 12, color: '#f0c8b0', marginTop: 4 }}>
              Both sides have units here — the combat report follows.
            </div>
          </div>
        )}

        <div style={{ textAlign: 'right' }}>
          <button className="tab-button active" onClick={onDismiss} style={{ fontWeight: 700, fontSize: 14, padding: '8px 20px' }}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function MissionReportModal({ G, report, onDismiss }: {
  G: GameState;
  report: import('../engine/types').MissionResolutionReport;
  onDismiss: () => void;
}) {
  const card = G.catalog.missions[report.missionId];
  const sysName = G.catalog.systems[report.targetSystemId]?.name ?? report.targetSystemId;
  const cardImg = card?.image ? vmodAssetUrl(card.image, CARD_IMAGE_BASE) : null;
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
    dice: { count: number; faces: string[]; colors?: string[]; successes: number } | undefined,
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
                      src={vmodAssetUrl(ldr.image, LEADER_IMAGE_BASE)}
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
            // Per-die color: RoE minor-skill dice roll GREEN (weaker faces) and
            // must read as green, not red. Older reports lack colors → red.
            dice.faces.map((f, i) => (
              <DieFaceImg key={i} face={f}
                color={(dice.colors?.[i] as 'red' | 'black' | 'green' | undefined) ?? 'red'} />
            ))
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
      // Above the combat board (zIndex 2000) so a mission that triggers
      // combat (Ignite Rebellion, Plan The Assault, uprising missions)
      // shows the success/failure narrative BEFORE the player has to
      // engage with the combat board.
      zIndex: 2500,
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

        {/* Response-card intervention notes (Undercover, Blindside, Wookie
         *  Guardian, etc.). Surfaced so the player knows WHY a mission was
         *  diverted / auto-failed instead of seeing "nothing happened". */}
        {report.interventions && report.interventions.length > 0 && (
          <div style={{
            padding: '10px 12px', borderRadius: 4, marginBottom: 14,
            background: '#1a1410', border: '2px solid #d4a14a',
          }}>
            <div style={{ fontSize: 11, color: '#d4a14a', fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
              ACTION CARD INTERVENTIONS
            </div>
            {report.interventions.map((s, i) => (
              <div key={i} style={{ fontSize: 13, color: '#f0e0c0', marginTop: i === 0 ? 0 : 4 }}>
                • {s}
              </div>
            ))}
          </div>
        )}

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
  notices: { id: string; title: string; details?: string; kind?: 'info' | 'notImplemented' }[];
  onDismiss: () => void;
}) {
  // Real game-info notices (e.g. Local Rumors region intel) must not be framed
  // as "not yet implemented" bugs. Absent kind ⇒ legacy not-implemented notice.
  const infoNotices = notices.filter((n) => n.kind === 'info');
  const gapNotices = notices.filter((n) => n.kind !== 'info');
  const allInfo = gapNotices.length === 0;
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 5000,
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
          {allInfo ? 'Heads up' : 'Heads up — not yet implemented'}
        </div>
        {infoNotices.length > 0 && (
          <ul style={{ paddingLeft: 18, margin: '0 0 14px 0' }}>
            {infoNotices.map((n) => (
              <li key={n.id} style={{ marginBottom: 8 }}>
                <div style={{ color: '#e8e8ea', fontSize: 13, fontWeight: 600 }}>{n.title}</div>
                {n.details && (
                  <div style={{ color: '#bbb', fontSize: 12, marginTop: 2 }}>{n.details}</div>
                )}
              </li>
            ))}
          </ul>
        )}
        {gapNotices.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 12 }}>
              The game just hit {gapNotices.length === 1 ? 'a code path' : `${gapNotices.length} code paths`}
              {' '}that isn't fully implemented yet. Skip detailing as a bug — these are known gaps:
            </div>
            <ul style={{ paddingLeft: 18, margin: '0 0 14px 0' }}>
              {gapNotices.map((n) => (
                <li key={n.id} style={{ marginBottom: 8 }}>
                  <div style={{ color: '#e8e8ea', fontSize: 13, fontWeight: 600 }}>{n.title}</div>
                  {n.details && (
                    <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{n.details}</div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
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
  // Captured Rebel leaders held by the Empire at this system (bug #8).
  const capturedHere = (G.empire.capturedLeaders ?? [])
    .filter((c) => c.systemId === system.id);
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
          src={mapImageUrl()}
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
            <img src={vmodAssetUrl(loyaltyMarkerImg, MARKER_IMAGE_BASE)} width={28} height={28} alt="" />
          )}
          {state.subjugated && (
            <img src={vmodAssetUrl("MarkerLoyaltySubjugated.png", MARKER_IMAGE_BASE)} width={28} height={28} alt="" />
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
          {/* RoE target markers at this system (Secure the Plans / Raid
              Outposts / Rebel Cell / Show No Fear) — shown here too, not just
              on the map overview (player report #175). */}
          {(state.targetMarkers ?? []).map((tm, i) => {
            const img: Record<string, string> = {
              'secure-the-plans': 'MarkerSecureThePlans.png',
              'raid-outposts-2': 'MarkerRaidOutposts.png',
              'rebel-cell-2': 'MarkerRebelCell.png',
              'show-no-fear-3': 'MarkerShowNoFear.png',
            };
            const label: Record<string, string> = {
              'secure-the-plans': 'Secure the Plans',
              'raid-outposts-2': 'Raid Outposts',
              'rebel-cell-2': 'Rebel Cell',
              'show-no-fear-3': 'Show No Fear',
            };
            return (
              <span key={`tm-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#ffd54a', background: 'rgba(60,45,10,0.85)', padding: '2px 6px', borderRadius: 2, fontWeight: 600 }}>
                {img[tm.source] && (
                  <img src={vmodAssetUrl(img[tm.source], MARKER_IMAGE_BASE)} width={20} height={20} alt="" />
                )}
                TARGET — {label[tm.source] ?? tm.source}
              </span>
            );
          })}
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
                      position: 'relative',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 30, height: 30, borderRadius: 4,
                      background: r.type === 'space' ? 'rgba(79,195,247,0.85)' : 'rgba(255,183,77,0.85)',
                      // The ● glyph is visually smaller than ▲/■ at the same size,
                      // so bump it up so all three resource tiers read equally
                      // (player feedback — MightyFaben).
                      color: '#000', fontSize: r.shape === 'circle' ? 27 : 20, fontWeight: 700,
                      lineHeight: 1,
                      border: i === 0 && system.resources.length > 1 ? '2px solid #fff' : 'none',
                      // Desaturate sabotaged icons so the red strike-through reads as "disabled."
                      opacity: state.sabotage ? 0.45 : 1,
                    }} title={state.sabotage
                      ? 'SABOTAGED — this icon cannot produce until a Repair Damage or R&D Option B clears the marker'
                      : (i === 0 ? 'left icon (used when subjugated)' : 'right icon')}>
                      {r.shape === 'triangle' ? '▲' : r.shape === 'circle' ? '●' : '■'}
                      {state.sabotage && (
                        // Diagonal red bar across the icon. Pure CSS, no extra asset.
                        <span style={{
                          position: 'absolute', left: -2, right: -2, top: '50%',
                          height: 4, background: '#ff3a3a',
                          transform: 'translateY(-50%) rotate(-25deg)',
                          boxShadow: '0 0 6px rgba(255,58,58,0.8)',
                          pointerEvents: 'none',
                        }} />
                      )}
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
                const name = G.catalog.unitTypes[g.typeId]?.name ?? g.typeId;
                return (
                  <div key={g.typeId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 76 }}>
                    <div style={{ position: 'relative', width: 72, height: 72 }}>
                      <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={72} height={72} alt={name} />
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
                    <div style={{ fontSize: 9, color: '#e8e8ea', textAlign: 'center', lineHeight: 1.1, marginTop: 2, textShadow: '0 0 3px rgba(0,0,0,0.9)' }}>
                      {name}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Leaders */}
        {(rebelLeaders.length > 0 || empireLeaders.length > 0 || capturedHere.length > 0) && (
          <div>
            <div style={{ fontSize: 11, color: '#aaa', textShadow: '0 0 4px rgba(0,0,0,0.9)', marginBottom: 4 }}>
              Leaders
            </div>
            <div style={{ fontSize: 13 }}>
              {rebelLeaders.length > 0 && (
                <div style={{ color: '#aae0ff', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
                  Rebel: {rebelLeaders.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
                </div>
              )}
              {empireLeaders.length > 0 && (
                <div style={{ color: '#ffaaaa', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
                  Empire: {empireLeaders.map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(', ')}
                </div>
              )}
              {capturedHere.length > 0 && (
                <div style={{ color: '#ffcc66', textShadow: '0 0 4px rgba(0,0,0,0.9)' }}>
                  Captured: {capturedHere.map((c) =>
                    (G.catalog.leaders[c.leaderId]?.name ?? c.leaderId)
                    + (c.ring === 'carbonite' ? ' (carbonite)' : '')
                  ).join(', ')}
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
              const name = G.catalog.unitTypes[g.typeId]?.name ?? g.typeId;
              return (
                <div key={g.typeId} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 68 }}>
                  <div style={{ position: 'relative', width: 64, height: 64 }}>
                    <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={64} height={64} alt={name} />
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
                  <div style={{ fontSize: 9, color: '#e8e8ea', textAlign: 'center', lineHeight: 1.1, marginTop: 2 }}>
                    {name}
                  </div>
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
/** Hover-enlarge panel for one of the six build-queue trays. The kind
 *  string is "<slot>-<side>" e.g. "1-rebel" or "3-empire". */
function EnlargedBuildQueue({ G, kind }: { G: GameState; kind: string }) {
  const unitStyle = useUnitStyle();
  const m = kind.match(/^build-([123])-(rebel|empire)$/);
  if (!m) return null;
  const slot = Number(m[1]) as 1 | 2 | 3;
  const side: Side = m[2] === 'rebel' ? 'Rebel' : 'Empire';
  const queue = (side === 'Rebel' ? G.rebel : G.empire).buildQueue[slot];
  const grouped = groupTypeIds(queue);
  const sideColorVal = side === 'Rebel' ? '#aae0ff' : '#ffaaaa';
  const slotLabel = slot === 1 ? '1 — deploys next refresh'
                  : slot === 2 ? '2 — slides to 1 next refresh'
                                : '3 — slides to 2 next refresh';
  return (
    <div
      style={{
        position: 'absolute', top: 6, right: 6,
        width: 360,
        background: '#0c0d10',
        border: `2px solid ${sideColorVal}`,
        borderRadius: 4, padding: 12,
        pointerEvents: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 14, color: sideColorVal, flex: 1 }}>
          {side} build queue · slot {slot}
        </strong>
        <span style={{ fontSize: 11, color: '#888' }}>{queue.length} unit{queue.length === 1 ? '' : 's'}</span>
      </div>
      <div style={{ fontSize: 11, color: '#aaa', marginBottom: 10 }}>{slotLabel}</div>
      {grouped.length === 0 ? (
        <div style={{ color: '#666', fontStyle: 'italic', fontSize: 12 }}>(empty)</div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {grouped.map((g) => {
            const t = G.catalog.unitTypes[g.typeId];
            const url = unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle);
            return (
              <div key={g.typeId} style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                width: 72,
              }}>
                <div style={{ position: 'relative', width: 56, height: 56 }}>
                  {url ? (
                    <img src={url} width={56} height={56} alt={t?.name ?? g.typeId} />
                  ) : (
                    <div style={{ width: 56, height: 56, background: '#222' }} />
                  )}
                  {g.count > 1 && (
                    <span style={{
                      position: 'absolute', bottom: -3, right: -3,
                      background: '#000', color: '#fff', borderRadius: '50%',
                      fontSize: 11, fontWeight: 700, width: 20, height: 20,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: `1.5px solid ${sideColorVal}`,
                    }}>{g.count}</span>
                  )}
                </div>
                <div style={{ color: '#fff', fontSize: 10, marginTop: 4, textAlign: 'center', lineHeight: 1.2 }}>
                  {t?.name ?? g.typeId}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LeaderPips({ G, systemId, centerX, centerY }: {
  G: GameState; systemId: string; centerX: number; centerY: number;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  type Pip = {
    kind: 'active' | 'captured' | 'carbonite';
    side: Side; // owning side (captives are still Rebel/Empire leaders)
    leader: NonNullable<ReturnType<(typeof G.catalog.leaders)['__type']>> | (typeof G.catalog.leaders)[string];
  };
  const rebel: Pip[] = (G.rebel.leadersOnBoard[systemId] ?? [])
    .map((lid) => ({ kind: 'active' as const, side: 'Rebel' as Side, leader: G.catalog.leaders[lid] }))
    .filter((x): x is Pip => !!x.leader);
  const empire: Pip[] = (G.empire.leadersOnBoard[systemId] ?? [])
    .map((lid) => ({ kind: 'active' as const, side: 'Empire' as Side, leader: G.catalog.leaders[lid] }))
    .filter((x): x is Pip => !!x.leader);
  // Captured leaders pinned at this system. Their side is the side they
  // belong to (e.g. a captured Mon Mothma is still a Rebel leader). Visually
  // we paint them with a heavy red ring + chain glyph, or cyan for carbonite.
  const captured: Pip[] = (G.empire.capturedLeaders ?? [])
    .filter((cl) => cl.systemId === systemId)
    .map((cl) => {
      const ldr = G.catalog.leaders[cl.leaderId];
      if (!ldr) return null;
      // Captured Rebel leaders are the common case; a flipped Imperial leader
      // (e.g. Lure of the Dark Side) wouldn't show up here. Use side from the
      // catalog so we get the right value either way.
      return {
        kind: cl.ring === 'carbonite' ? 'carbonite' as const : 'captured' as const,
        side: ldr.side,
        leader: ldr,
      };
    })
    .filter((x): x is Pip => !!x);
  const all = [...rebel, ...empire, ...captured];
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
        // Active leaders use side colour. Captured/carbonite override with a
        // distinctive ring + label so the player can see who's held where.
        // Cinematic Confrontation: the leader is marked and will be
        // eliminated when the Command phase ends — show it, or the kill
        // looks like it didn't register (#176).
        const isMarked = x.kind === 'active'
          && (G.cinematicMarkedForElimination ?? []).includes(x.leader.id as LeaderId);
        const ringColor =
          x.kind === 'captured'  ? '#ff3a3a' :
          x.kind === 'carbonite' ? '#4fc3f7' :
          isMarked               ? '#ff7800' :
          x.side === 'Rebel'      ? '#aae0ff' : '#ffaaaa';
        const glowColor =
          x.kind === 'captured'  ? 'rgba(255,58,58,0.9)' :
          x.kind === 'carbonite' ? 'rgba(79,195,247,0.9)' :
          isMarked               ? 'rgba(255,120,0,0.95)' :
          x.side === 'Rebel'      ? 'rgba(170,224,255,0.85)' : 'rgba(255,170,170,0.85)';
        const clipId = `lpip-${systemId}-${x.leader.id}-${x.kind}`;
        const titlePrefix =
          x.kind === 'captured'  ? `CAPTURED ${x.side}` :
          x.kind === 'carbonite' ? `CARBONITE ${x.side}` :
          isMarked               ? `${x.side} — MARKED for elimination at end of this Command phase (Confrontation)` :
          x.side;
        const pipKey = `${x.kind}-${x.leader.id}`;
        return (
          <g key={pipKey}
            pointerEvents="auto"
            onMouseEnter={() => setHovered(pipKey)}
            onMouseLeave={() => setHovered((h) => h === pipKey ? null : h)}
            style={{ cursor: 'help' }}
          >
            <defs>
              <clipPath id={clipId}>
                <circle cx={cx} cy={centerY} r={SIZE / 2 - 1} />
              </clipPath>
            </defs>
            {/* Soft outer glow — easier to spot the cluster on a busy map */}
            <circle cx={cx} cy={centerY} r={SIZE / 2 + 1.5}
              style={{ fill: 'none', stroke: glowColor, strokeWidth: x.kind === 'active' && !isMarked ? 1 : 1.5, opacity: 0.75 }} />
            <image
              href={vmodAssetUrl(x.leader.image, LEADER_IMAGE_BASE)}
              x={cx - SIZE / 2} y={centerY - SIZE / 2}
              width={SIZE} height={SIZE}
              clipPath={`url(#${clipId})`}
              preserveAspectRatio="xMidYMid slice"
              // Desaturate captives so the red ring reads as "held."
              style={x.kind === 'active' ? undefined : { filter: 'grayscale(0.55) brightness(0.7)' }}
            />
            <circle cx={cx} cy={centerY} r={SIZE / 2}
              style={{ fill: 'none', stroke: ringColor, strokeWidth: x.kind === 'active' ? 2 : 2.5 }} />
            {/* Chain/snowflake glyph in the corner for captured/carbonite */}
            {x.kind !== 'active' && (
              <text
                x={cx + SIZE / 2 - 2} y={centerY + SIZE / 2 - 1}
                textAnchor="end" fontSize={11} fontWeight={700}
                style={{
                  fill: x.kind === 'carbonite' ? '#4fc3f7' : '#ff3a3a',
                  paintOrder: 'stroke',
                  stroke: '#000', strokeWidth: 2.5,
                }}
              >
                {x.kind === 'carbonite' ? '❄' : '⛓'}
              </text>
            )}
            <title>{titlePrefix}: {x.leader.name}</title>
          </g>
        );
      })}
      {/* Hover popup: shows the leader's actual card art + skill summary.
       *  Renders inside the SVG via foreignObject so positioning stays
       *  attached to the map coordinate system. */}
      {(() => {
        if (!hovered) return null;
        const x = all.find((p) => `${p.kind}-${p.leader.id}` === hovered);
        if (!x) return null;
        const l = x.leader;
        const CARD_W = 220;
        const CARD_H = 340;
        // Anchor above the pip strip; clamp to map width via SVG viewBox.
        const popX = centerX - CARD_W / 2;
        const popY = centerY - SIZE / 2 - CARD_H - 10;
        const cardUrl = getCachedArtUrlSync(l.image);
        return (
          <foreignObject x={popX} y={popY} width={CARD_W} height={CARD_H}
            style={{ overflow: 'visible', pointerEvents: 'none' }}>
            <div style={{
              background: 'rgba(0,0,0,0.96)', border: '1px solid #555',
              borderRadius: 4, padding: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
              color: '#fff', fontFamily: 'sans-serif',
            }}>
              {cardUrl ? (
                <img src={cardUrl} alt={l.name}
                  style={{ width: CARD_W - 12, height: 'auto', borderRadius: 3, display: 'block' }} />
              ) : (
                <div style={{
                  width: CARD_W - 12, height: 200, background: '#222',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#888', fontSize: 12, borderRadius: 3,
                }}>{l.name}</div>
              )}
              <div style={{ fontSize: 12, fontWeight: 700, marginTop: 4, textAlign: 'center' }}>
                {x.kind !== 'active' && (
                  <span style={{ color: x.kind === 'carbonite' ? '#4fc3f7' : '#ff3a3a' }}>
                    [{x.kind.toUpperCase()}]{' '}
                  </span>
                )}
                {l.name}
              </div>
              <div style={{ fontSize: 11, color: '#cbc4b0', marginTop: 4, textAlign: 'center' }}>
                Dip {l.skills.diplomacy} · Int {l.skills.intel}{' '}
                · Ops {l.skills.specOps} · Log {l.skills.logistics}
                {' · '}
                Space {l.tacticValues.space} / Ground {l.tacticValues.ground}
              </div>
            </div>
          </foreignObject>
        );
      })()}
    </g>
  );
}

/** Short tile-readable abbreviation for each unit type. Used as the always-
 *  visible text glyph rendered inside the on-map unit icon so that even with
 *  the strict-image deploy (where the PNG is a 1×1 transparent placeholder)
 *  the player can tell unit types apart. With the printed art back via
 *  copy-assets the icon image sits over the glyph and the abbreviation
 *  becomes invisible. */
const UNIT_ABBREV: Record<string, string> = {
  'tie-fighter': 'TIE',
  'assault-carrier': 'AC',
  'star-destroyer': 'SD',
  'super-star-destroyer': 'SSD',
  'death-star': 'DS',
  'death-star-under-construction': 'DSc',
  'stormtrooper': 'ST',
  'at-st': 'ATst',
  'at-at': 'ATat',
  'x-wing': 'XW',
  'y-wing': 'YW',
  'corellian-corvette': 'CC',
  'rebel-transport': 'RTp',
  'mon-cala-cruiser': 'MC',
  'rebel-trooper': 'RT',
  'airspeeder': 'AS',
  'shield-generator': 'SG',
  'ion-cannon': 'IC',
};

function UnitCluster({ centerX, centerY, groups, iconSize, maxWidth }: {
  centerX: number; centerY: number;
  groups: { typeId: string; count: number; side?: string }[];
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
        const abbrev = UNIT_ABBREV[g.typeId] ?? g.typeId.slice(0, 3).toUpperCase();
        return (
          <g key={g.typeId}>
            {/* Always-visible text behind the icon — pops to readable when
             *  the icon image is the strict-deploy 1×1 placeholder. */}
            <rect
              x={ix} y={iy} width={iconSize} height={iconSize}
              style={{ fill: '#1a1d22', stroke: 'rgba(120,140,160,0.4)', strokeWidth: 0.5 }}
            />
            <text
              x={ix + iconSize / 2} y={iy + iconSize / 2 + 3}
              textAnchor="middle"
              style={{ fill: '#e8e8ea', fontSize: Math.max(8, iconSize * 0.45), fontWeight: 700 }}
            >
              {abbrev}
            </text>
            <image
              href={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!}
              x={ix} y={iy}
              width={iconSize} height={iconSize}
            />
            {/* Count badge — always show, even for count=1, so single units
             *  on the strict-deploy map don't appear as just an empty
             *  square (#18). Count is the only way to distinguish "1
             *  of this type here" from "background tile noise" when the
             *  icon image is invisible. The badge is colored by side — blue
             *  for Rebel, red for Empire — so the two factions are
             *  distinguishable at a glance without clicking into a system
             *  (player report #107 / MightyFaben forum feedback). */}
            <g>
              <circle
                cx={ix + iconSize - 3} cy={iy + iconSize - 3} r={6}
                style={{
                  // Death Star & Super Star Destroyer get a distinct PURPLE
                  // badge so the game-defining capital ships stand out at a
                  // glance (MightyFaben forum feedback).
                  fill: (g.typeId === 'death-star' || g.typeId === 'death-star-under-construction' || g.typeId === 'super-star-destroyer')
                    ? '#8a4fc0'
                    : g.side === 'Rebel' ? '#2b6cb0' : g.side === 'Empire' ? '#b3322c' : '#000',
                  stroke: '#fff', strokeWidth: 0.75,
                }}
              />
              <text
                x={ix + iconSize - 3} y={iy + iconSize - 1}
                textAnchor="middle"
                style={{ fill: '#fff', fontSize: 8, fontWeight: 700 }}
              >
                {g.count}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

/** Systems the EMPIRE can rule out as the Rebel base, from probe knowledge.
 *  A system is ruled out once its probe card has left the deck — that happens
 *  when the Empire draws it (into probeHand) OR it was removed at setup because
 *  the system got Imperial loyalty. The base's own probe is also removed from
 *  the deck (rr p.15), so we MUST exclude the base or we'd reveal it. This is
 *  cumulative and matches "cards left in deck = still-possible systems" — the
 *  old version only marked the current probeHand, badly under-counting
 *  (reporter: "only 4 in deck but far more than 4 unmarked"). */
function empireRuledOutSystems(G: GameState): Set<string> {
  // Online: the probe deck is hidden, so the server precomputes the rule-outs
  // (from the real deck) into empireProbeRuledOut. Prefer it when present —
  // deriving from the redacted (all-hidden) deck would mark EVERY system ruled
  // out. Hotseat falls through to the deck-based computation below.
  if (G.empireProbeRuledOut) return new Set(G.empireProbeRuledOut);
  const inDeck = new Set(
    (G.probeDeck ?? []).map((pid) => G.catalog.probes[pid]?.systemId).filter(Boolean) as string[],
  );
  const ruledOut = new Set<string>();
  for (const p of Object.values(G.catalog.probes)) {
    const sid = p.systemId;
    if (!sid) continue;
    if (inDeck.has(sid)) continue;           // still a possible base location
    if (sid === G.rebelBaseSystemId) continue; // NEVER reveal the actual base
    ruledOut.add(sid);
  }
  // Coruscant is never a valid hidden-base location and has no probe card, so
  // mark it ruled out implicitly.
  for (const s of Object.values(G.catalog.systems)) {
    if (s.isCoruscant && s.id !== G.rebelBaseSystemId) ruledOut.add(s.id);
  }
  return ruledOut;
}

/** Systems ruled out by SEARCHING (subjugation / Imperial loyalty). Unions the
 *  engine-tracked cumulative set with systems that currently qualify, so the
 *  overlay shows correctly even on a game saved before the field existed (and
 *  immediately, before the next invariant pass). Excludes the base. */
function empireSearchedSystems(G: GameState): Set<string> {
  const out = new Set<string>(G.empireSearchedRuledOut ?? []);
  for (const [id, ss] of Object.entries(G.map.systems)) {
    if (id === G.rebelBaseSystemId) continue;
    if (ss.subjugated || ss.loyalty === 'imperial') out.add(id);
    // An Imperial presence rules a system out: if the base were here it would
    // already be revealed (RAW: the base reveals when the Empire has a unit in
    // its system). So any system the Empire occupies that ISN'T the revealed
    // base cannot be the base (player report #106 — moved troops to Hoth,
    // expected it to be marked).
    if (ss.units.some((u) => u.side === 'Empire')) out.add(id);
  }
  out.delete(G.rebelBaseSystemId);
  // Red (probe) rule-out wins over yellow (searched): drop any system already
  // marked by a probe so it never shows both / shows yellow when it should be
  // red.
  const red = empireRuledOutSystems(G);
  for (const id of red) out.delete(id);
  return out;
}

function Board({ G, systems, masks, eliminatedSystemIds, humanSide, highlightSystemIds, onSystemClick, selectedSystemIds }: {
  G: GameState; systems: System[]; masks: MaskRect[];
  eliminatedSystemIds?: Set<string> | null;
  humanSide?: Side;
  // Picker mode: highlight a set of candidate systems with a green ring and
  // make them clickable, so target-selection can happen ON the map instead of
  // in a board-covering modal.
  highlightSystemIds?: Set<string> | null;
  onSystemClick?: (systemId: string) => void;
  // Multi-select picker: systems currently selected get a filled green ring.
  selectedSystemIds?: Set<string> | null;
}) {
  // Compute aggregate of Rebel Base space units (offboard staging area)
  const rbsUnits = G.map.rebelBaseSpace.units.length;
  const BOARD_SCALE = DISPLAY_W / NATIVE_W;
  // When the player has loaded the .vmod, the printed map already shows
  // system names + build-slot indicators + resource icons natively. The
  // text overlays we render for strict-image mode then become redundant
  // (and ugly — they sit on top of the printed banner). Hide them when
  // art is loaded.
  const artLoaded = useArtLoaded().loaded;
  // The on-board text fallback (system names + resource glyphs) should appear
  // whenever the actual MAP image isn't rendering — NOT merely when "no vmod is
  // loaded". A vmod can be loaded yet its board image unavailable (e.g. the
  // v1.2e "Redux" board names it Map-Redux.png and the blob hasn't resolved, or
  // a partial module). Gating on artLoaded alone left such users with a blank
  // board AND no labels (player report). Tie the fallback to the map blob
  // specifically — useArtLoaded re-renders this on load so it stays reactive.
  const mapImageReady = typeof getCachedArtUrlSync('Map.png') === 'string';
  const [hoverSystemId, setHoverSystemId] = useState<string | null>(null);

  // Whole-territory hover/select: assign each system to the traced cell that
  // contains its boardPos. A cell with one system IS that system's hit area; a
  // cell with several (the untraced central blob) resolves to the nearest owned
  // system at the cursor; a cell with none is inert. Self-heals to 1:1 as cells
  // are subdivided in the dev 'territories' tab.
  const sysById = useMemo(() => new Map(systems.map((s) => [s.id, s])), [systems]);
  const interactiveTerritories = useMemo(() =>
    FALLBACK_TERRITORIES
      .filter((t) => !t.barrier) // barriers are impassable borders, not selectable cells
      .map((t) => ({
        exterior: t.exterior,
        systemIds: systems
          .filter((s) => pointInPoly([s.boardPos.x, s.boardPos.y], t.exterior))
          .map((s) => s.id),
      }))
      .filter((t) => t.systemIds.length > 0),
    [systems]);
  const coveredSystemIds = useMemo(
    () => new Set(interactiveTerritories.flatMap((t) => t.systemIds)),
    [interactiveTerritories],
  );
  const [hoverRebelBase, setHoverRebelBase] = useState<boolean>(false);
  // #98 follow-up (player request): let the Empire PIN the probe overlay by
  // clicking the Rebel Base marker, so the ruled-out X's stay visible while
  // moving units around — instead of vanishing the moment the cursor leaves.
  const [pinProbeOverlay, setPinProbeOverlay] = useState<boolean>(false);
  // After clicking to UNPIN, the cursor is still over the Rebel Base, so the
  // hover would instantly re-show the overlay — making the unpin look broken.
  // Suppress the hover display until the mouse actually leaves the base.
  const [suppressBaseHover, setSuppressBaseHover] = useState<boolean>(false);
  // Build-queue hover: "1-rebel" | "2-empire" | etc.
  const [hoverBuildKind, setHoverBuildKind] = useState<string | null>(null);
  const hoverSystem = hoverSystemId ? systems.find((s) => s.id === hoverSystemId) : null;
  const rebelBaseRect = masks.find((r) => r.kind === 'rebel-base');

  // #98 — when the Empire player hovers the Rebel Base, also dim out every
  // sector ruled out by drawn probe cards. RAW: the Empire has perfect
  // knowledge of which sectors the base ISN'T in via the probe deck. Show
  // the same overlay as hovering the probe deck. (Only fires for Empire
  // players because the Rebel knows exactly where their own base is.)
  const baseHoverEliminated: Set<string> | null =
    ((hoverRebelBase && !suppressBaseHover) || pinProbeOverlay) && humanSide === 'Empire'
      ? empireRuledOutSystems(G)
      : null;
  // Effective eliminated set is the union of the probe-deck hover and
  // the base hover, so highlighting one or the other looks the same.
  const effectiveEliminated: Set<string> | null =
    eliminatedSystemIds || baseHoverEliminated
      ? new Set([
          ...(eliminatedSystemIds ?? []),
          ...(baseHoverEliminated ?? []),
        ])
      : null;
  // "Searched" ruled-out systems (subjugated / Imperial-loyal since the base's
  // last placement) — shown yellow, distinct from the red probe X's. Same
  // hover/pin gating as the probe overlay.
  const showOverlay = !!effectiveEliminated || (((hoverRebelBase && !suppressBaseHover) || pinProbeOverlay) && humanSide === 'Empire');
  const effectiveSearched: Set<string> | null =
    showOverlay && humanSide === 'Empire'
      ? empireSearchedSystems(G)
      : null;

  return (
    <div style={{ position: 'relative', display: 'inline-block', border: '1px solid #2a2d34',
      // Dark backdrop so the vector fallback reads as a board when there's no map
      // art. Thin gaps between cells are just dividers (dark); the fat impassable
      // barrier regions are explicit barrier cells, drawn solid red below.
      background: mapImageReady ? undefined : '#0a0c10', width: DISPLAY_W, height: DISPLAY_H }}>
      {/* Only render the board image when a REAL map is available — otherwise the
          copyright-stripped placeholder is a blank transparent box. */}
      {mapImageReady && (
        <img src={mapImageUrl()} width={DISPLAY_W} height={DISPLAY_H} alt="Board" />
      )}
      <svg width={DISPLAY_W} height={DISPLAY_H} style={{ position: 'absolute', top: 0, left: 0 }}>
        {/* Territory cells — traced polygons from the printed board (edited via
            the dev 'territories' tab). Drawn behind the adjacency edges/planets
            so the no-art fallback reads as the board's partitioned galaxy. */}
        {!mapImageReady && FALLBACK_TERRITORIES.map((t) => {
          const points = t.exterior.map(([x, y]) => `${(x * SCALE).toFixed(1)},${(y * SCALE).toFixed(1)}`).join(' ');
          if (t.barrier) {
            // Fat impassable barrier region — solid red.
            return (
              <polygon key={`barrier-${t.id}`} points={points}
                style={{ fill: '#c0392b', stroke: '#7a1f15', strokeWidth: 1.5, strokeLinejoin: 'round' }} />
            );
          }
          const fill = territoryFill(t.id);
          // Opaque cell; thin gaps between cells show the dark backdrop (dividers).
          return (
            <polygon key={`terr-${t.id}`} points={points}
              style={{ fill, stroke: '#1a1d24', strokeWidth: 1, strokeLinejoin: 'round' }} />
          );
        })}
        {/* Adjacency edges used to be drawn here on the vector fallback, but the
            traced territory cells now convey the board layout, so the edge lines
            are no longer needed and were removed for a cleaner art-free board. */}
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
          // Full detail shown only on hover (<title>). Kept separate from the
          // short visible label so long strings (e.g. the Rebel-base secret
          // location) don't overflow the small staging box and bleed across
          // nearby systems on the map (#100 — overlapped Mon Calamari).
          let hoverDetail: string | null = null;
          let content: React.ReactNode = null;
          if (r.kind === 'rebel-base') {
            const units = G.map.rebelBaseSpace.units;
            const leaders = G.rebel.leadersOnBoard['rebel-base-space'] ?? [];
            const grouped = groupByType(units);
            // Rebel player knows where their own base is — show the sector
            // in the tooltip. Empire just sees "hidden" until revealed.
            const baseSys = G.catalog.systems[G.rebelBaseSystemId];
            const baseSysName = baseSys?.name ?? G.rebelBaseSystemId;
            const baseRegion = baseSys?.region;
            if (G.rebelBaseRevealed) {
              title = 'Rebel Base';
              hoverDetail = `Rebel Base — ${baseSysName} (revealed)`;
            } else if (humanSide === 'Rebel' && baseSys) {
              // Short visible label; full secret-location detail on hover so it
              // doesn't overflow the box and overlap nearby systems (#100).
              title = `Base: ${baseSysName}`;
              hoverDetail = `Rebel Base — secretly at ${baseSysName} (region ${baseRegion}). Only you can see this.`;
            } else {
              title = 'Rebel Base (hidden)';
            }
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
              // Short label — the rects are narrow on the right edge of the
              // board and a fuller label like "Build queue 3 (Empire)"
              // overflows past the printed map (bug #7). Hover to see the
              // full breakdown.
              title = `BQ${slot} ${side === 'Rebel' ? 'R' : 'E'}`;
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
          const isBuild = r.kind.startsWith('build-');
          return (
            <g key={r.id} pointerEvents={isBuild || hoverDetail ? 'all' : 'none'}
              onMouseEnter={isBuild ? () => setHoverBuildKind(r.kind) : undefined}
              onMouseLeave={isBuild ? () => setHoverBuildKind(null) : undefined}
            >
              <rect
                x={x} y={y} width={w} height={h}
                style={{
                  fill: 'rgba(20,25,30,0.85)',
                  stroke: hoverBuildKind === r.kind ? '#ffd54a' : 'rgba(120,140,160,0.5)',
                  strokeWidth: hoverBuildKind === r.kind ? 2 : 1,
                  cursor: isBuild ? 'help' : 'default',
                }}
              />
              <text x={x + 6} y={y + 14} style={{ fill: '#aaa', fontSize: 10, fontWeight: 600, pointerEvents: 'none' }}>
                {title}
              </text>
              {hoverDetail && <title>{hoverDetail}</title>}
              <g pointerEvents="none">{content}</g>
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
          const isEliminated = effectiveEliminated?.has(s.id) ?? false;
          // Yellow "searched" rule-out, only when not already red-X'd by a probe.
          const isSearched = !isEliminated && (effectiveSearched?.has(s.id) ?? false);
          const isHighlighted = highlightSystemIds?.has(s.id) ?? false;
          const isSelected = selectedSystemIds?.has(s.id) ?? false;
          return (
            <g key={s.id} style={isHighlighted && onSystemClick ? { cursor: 'pointer' } : undefined}>
              {/* No real map art → draw a visible region-colored "planet" so the
                  galaxy is usable as a vector board (player report: blank map). */}
              {!mapImageReady && (
                <circle cx={x} cy={y} r={MARKER_R + 3}
                  style={{ fill: REGION_FILL[s.region % REGION_FILL.length], stroke: '#c8cdd6', strokeWidth: 1.5 }} />
              )}
              {isBaseRevealed && (
                <circle cx={x} cy={y} r={MARKER_R + 6}
                  style={{ fill: 'none', stroke: '#80dc78', strokeWidth: 2 }} />
              )}
              {/* Target-picker highlight: a bright ring marking a legal candidate
                  system, clickable to select it directly on the map. Selected
                  candidates (multi-pick) get a filled green ring + check. */}
              {isHighlighted && (
                <circle cx={x} cy={y} r={MARKER_R + 10}
                  style={isSelected
                    ? { fill: 'rgba(128,220,120,0.30)', stroke: '#80dc78', strokeWidth: 4 }
                    : { fill: 'rgba(255,213,74,0.16)', stroke: '#ffd54a', strokeWidth: 3 }}
                  pointerEvents="none" />
              )}
              {isSelected && (
                <text x={x} y={y - MARKER_R - 14} textAnchor="middle"
                  style={{ fill: '#80dc78', fontSize: 16, fontWeight: 700, pointerEvents: 'none' }}>✓</text>
              )}
              {/* Searched/subjugated rule-out — yellow ring + cross, mirroring
                  the red probe X so both read as "not the base". */}
              {isSearched && (
                <g pointerEvents="none">
                  <circle cx={x} cy={y} r={MARKER_R + 8}
                    style={{ fill: 'rgba(255,213,74,0.16)', stroke: '#ffd54a', strokeWidth: 2 }} />
                  <line x1={x - MARKER_R} y1={y - MARKER_R} x2={x + MARKER_R} y2={y + MARKER_R}
                    style={{ stroke: '#ffd54a', strokeWidth: 3, strokeLinecap: 'round' }} />
                  <line x1={x + MARKER_R} y1={y - MARKER_R} x2={x - MARKER_R} y2={y + MARKER_R}
                    style={{ stroke: '#ffd54a', strokeWidth: 3, strokeLinecap: 'round' }} />
                </g>
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
              {!mapImageReady && (
                <text x={x} y={y + r + 11} textAnchor="middle"
                  style={{ fill: '#fff', fontSize: 9, pointerEvents: 'none', opacity: 0.85 }}
                >
                  {s.name}
                </text>
              )}
              {/* Inline resource / build-slot summary. Without the printed
               *  Map.png art the system tile shows nothing about WHAT this
               *  system is worth (build slot priority, resource icons,
               *  loyalty). Render a compact glyph line right under the
               *  system name. Format:
               *    BQ[n] ▲●■  ·  L (subjugated → Sj-L)
               *  where ▲/●/■ are the triangle/circle/square resource
               *  shapes and space (blue) vs ground (orange) is colored.
               *  Hidden when art is loaded — the printed map already shows
               *  this info as the yellow buildslot icon + resource tokens
               *  baked into each system tile. */}
              {!mapImageReady && (() => {
                const parts: React.ReactNode[] = [];
                if (s.buildSlot != null) {
                  parts.push(
                    <tspan key="bs" style={{ fill: '#ffd54a', fontWeight: 700 }}>
                      BQ{s.buildSlot}
                    </tspan>
                  );
                }
                if (s.resources.length > 0) {
                  s.resources.forEach((res, i) => {
                    const glyph = res.shape === 'triangle' ? '▲' : res.shape === 'circle' ? '●' : '■';
                    const col = res.type === 'space' ? '#4fc3f7' : '#ffb74d';
                    parts.push(
                      <tspan key={`r${i}`} dx={4} style={{ fill: col, fontWeight: 700 }}>
                        {glyph}
                      </tspan>
                    );
                  });
                }
                // Loyalty marker (compact letter). Subjugated takes precedence.
                if (state.subjugated) {
                  parts.push(
                    <tspan key="sj" dx={6} style={{ fill: '#ff7777', fontWeight: 700 }}>Sj</tspan>
                  );
                } else if (state.loyalty === 'rebel') {
                  parts.push(<tspan key="l" dx={6} style={{ fill: '#aae0ff', fontWeight: 700 }}>R</tspan>);
                } else if (state.loyalty === 'imperial') {
                  parts.push(<tspan key="l" dx={6} style={{ fill: '#ffaaaa', fontWeight: 700 }}>I</tspan>);
                }
                if (state.sabotage) {
                  parts.push(<tspan key="sb" dx={4} style={{ fill: '#ff3a3a', fontWeight: 700 }}>SAB</tspan>);
                }
                if (parts.length === 0) return null;
                return (
                  <text x={x} y={y + r + 22} textAnchor="middle"
                    style={{ fontSize: 9, pointerEvents: 'none' }}
                  >
                    {parts}
                  </text>
                );
              })()}
              {/* Leader portraits — small circular pip per leader, centered ON
                  the planet (the spot the old R#/E# unit-count labels used).
                  Unit counts are gone from the overview — the unit icons above
                  the planet / the zoomed system view carry that info. Keeps
                  the printed name banner and loyalty hex clear (player
                  feedback on the online board view). */}
              <LeaderPips G={G} systemId={s.id} centerX={x} centerY={y} />
            </g>
          );
        })}

        {/* Whole-territory hover/select surface (replaces the old per-token
            rect). The traced cell is the hit area: hovering it shows the
            system, and in picker mode clicking it selects the system. It's
            transparent — over the map (image mode) or the colored cell
            (no-art) — with a faint highlight on the hovered cell. A cell
            holding several systems resolves to the nearest one at the cursor. */}
        {interactiveTerritories.map((t, ti) => {
          const points = t.exterior.map(([x, y]) => `${x * SCALE},${y * SCALE}`).join(' ');
          const single = t.systemIds.length === 1;
          const nearestOwned = (e: React.MouseEvent, pool: string[]): string => {
            if (pool.length === 1) return pool[0];
            const svg = (e.currentTarget as SVGElement).ownerSVGElement;
            const rb = svg?.getBoundingClientRect();
            const px = e.clientX - (rb?.left ?? 0), py = e.clientY - (rb?.top ?? 0);
            let best = pool[0], bd = Infinity;
            for (const id of pool) {
              const s = sysById.get(id);
              if (!s) continue;
              const dx = s.boardPos.x * SCALE - px, dy = s.boardPos.y * SCALE - py;
              const d = dx * dx + dy * dy;
              if (d < bd) { bd = d; best = id; }
            }
            return best;
          };
          const highlightedOwned = onSystemClick
            ? t.systemIds.filter((id) => highlightSystemIds?.has(id))
            : [];
          const clickable = highlightedOwned.length > 0;
          const hoveredHere = hoverSystemId != null && t.systemIds.includes(hoverSystemId);
          return (
            <polygon
              key={`terr-hit-${ti}`}
              points={points}
              fill={hoveredHere ? 'rgba(255,255,255,0.10)' : 'transparent'}
              stroke={hoveredHere ? 'rgba(255,255,255,0.55)' : 'none'}
              strokeWidth={hoveredHere ? 1.5 : 0}
              pointerEvents="all"
              style={clickable ? { cursor: 'pointer' } : undefined}
              onMouseEnter={(e) => setHoverSystemId(nearestOwned(e, t.systemIds))}
              onMouseMove={single ? undefined : (e) => setHoverSystemId(nearestOwned(e, t.systemIds))}
              onMouseLeave={() => setHoverSystemId(null)}
              onClick={clickable ? (e) => onSystemClick!(nearestOwned(e, highlightedOwned)) : undefined}
            />
          );
        })}
        {/* Token-rect fallback for any system not inside a traced cell. */}
        {systems.filter((s) => !coveredSystemIds.has(s.id)).map((s) => {
          const x = s.boardPos.x * SCALE;
          const y = s.boardPos.y * SCALE;
          const clickable = !!onSystemClick && (highlightSystemIds?.has(s.id) ?? false);
          return (
            <rect
              key={`hover-${s.id}`}
              x={x - 40} y={y - 40} width={80} height={80}
              fill="transparent"
              pointerEvents="all"
              style={clickable ? { cursor: 'pointer' } : undefined}
              onMouseEnter={() => setHoverSystemId(s.id)}
              onMouseLeave={() => setHoverSystemId(null)}
              onClick={clickable ? () => onSystemClick!(s.id) : undefined}
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
            style={{ cursor: humanSide === 'Empire' ? 'pointer' : 'default' }}
            onMouseEnter={() => setHoverRebelBase(true)}
            onMouseLeave={() => { setHoverRebelBase(false); setSuppressBaseHover(false); }}
            onClick={humanSide === 'Empire' ? () => setPinProbeOverlay((p) => {
              const next = !p;
              // Unpinning while still hovering: hide the overlay until the
              // cursor leaves, so the click visibly does something.
              setSuppressBaseHover(!next);
              return next;
            }) : undefined}
          >
            <title>
              {humanSide === 'Empire'
                ? (pinProbeOverlay
                    ? 'Probe overlay pinned — click to unpin (X = sectors ruled out by your probes)'
                    : 'Click to PIN the probe overlay so the ruled-out X’s stay while you move units')
                : ''}
            </title>
          </rect>
        )}

        {/* Loyalty / subjugation marker images placed on the printed hex */}
        {systems.map((s) => {
          const state = G.map.systems[s.id];
          if (!state) return null;
          // Coruscant + remote systems have no loyalty hex, but a sabotage
          // badge or RoE target marker still needs to be visible. Fall back to
          // the planet position.
          if (!s.loyaltyMarkerPos && !state.sabotage && !(state.targetMarkers?.length)) return null;
          // Match the VASSAL module exactly: it draws the 84x76 loyalty-token
          // image at native size centered on each loyaltyMarkerPos (which we
          // take verbatim from the module's buildFile). Rendered at native
          // dimensions * BOARD_SCALE so it keeps the token's aspect and tracks
          // the board's display scale.
          const MARKER_NATIVE_W = 84;
          const MARKER_NATIVE_H = 76;
          const markerW = MARKER_NATIVE_W * BOARD_SCALE;
          const markerH = MARKER_NATIVE_H * BOARD_SCALE;
          const basePos = s.loyaltyMarkerPos ?? s.boardPos;
          const mx = basePos.x * BOARD_SCALE;
          const my = basePos.y * BOARD_SCALE;

          // One disc per system, exactly on the hex. Per rr p.13 the subjugation
          // marker sits ON TOP of any loyalty marker — so when subjugated we draw
          // ONLY the subjugation disc (it fully covers the loyalty hex; the
          // underneath loyalty is surfaced on hover below). Otherwise draw the
          // single loyalty marker.
          const markers: { src: string; offsetX: number; offsetY: number; opacity?: number }[] = [];
          if (state.subjugated) {
            markers.push({ src: 'MarkerLoyaltySubjugated.png', offsetX: 0, offsetY: 0 });
          } else if (state.loyalty === 'rebel') {
            markers.push({ src: 'MarkerLoyaltyRebel.png', offsetX: 0, offsetY: 0 });
          } else if (state.loyalty === 'imperial') {
            markers.push({ src: 'MarkerLoyaltyEmpire.png', offsetX: 0, offsetY: 0 });
          }
          // RoE target markers (Secure the Plans / Raid Outposts / Rebel Cell
          // / Show No Fear) — render the table-top marker art, stacked below
          // the loyalty/sabotage cluster so it never hides the loyalty disc.
          const TARGET_MARKER_IMG: Record<string, string> = {
            'secure-the-plans': 'MarkerSecureThePlans.png',
            'raid-outposts-2': 'MarkerRaidOutposts.png',
            'rebel-cell-2': 'MarkerRebelCell.png',
            'show-no-fear-3': 'MarkerShowNoFear.png',
          };
          const tMarkers = (state.targetMarkers ?? [])
            .map((m) => ({ src: TARGET_MARKER_IMG[m.source], source: m.source }))
            .filter((m) => !!m.src);
          if (markers.length === 0 && !state.sabotage && tMarkers.length === 0) return null;
          // Hover tooltip — lets the player read a system's loyalty at a glance,
          // INCLUDING what's hidden under a subjugation disc (#109 request).
          const sysName = s.name ?? s.id;
          const loyaltyTip = state.subjugated
            ? `${sysName} — Subjugated by the Empire${state.loyalty === 'rebel' ? ' (Rebel loyalty underneath)' : ' (neutral underneath)'}`
            : state.loyalty === 'rebel' ? `${sysName} — Rebel loyalty`
            : state.loyalty === 'imperial' ? `${sysName} — Imperial loyalty`
            : `${sysName}`;
          // Enable hover only when NOT picking a target on the map, so the
          // tooltip can't swallow clicks meant for the system underneath.
          const pickerActive = !!onSystemClick;
          return (
            <g key={`loyalty-${s.id}`} pointerEvents={pickerActive ? 'none' : 'auto'}>
              {markers.length > 0 && <title>{loyaltyTip}</title>}
              {markers.map((m, i) => (
                <image
                  key={i}
                  href={vmodAssetUrl(m.src, MARKER_IMAGE_BASE)}
                  x={mx + m.offsetX - markerW / 2}
                  y={my + m.offsetY - markerH / 2}
                  width={markerW}
                  height={markerH}
                  preserveAspectRatio="none"
                  opacity={m.opacity ?? 1}
                />
              ))}
              {state.sabotage && (() => {
                // Sabotage token — the table-top marker art (MarkerSabotage.png
                // from the .vmod). In the physical game it covers the system's
                // RESOURCE icons (sabotage disables production), so prefer the
                // calibrated sabotageMarkerPos (dev positions tab, #174); fall
                // back to the loyalty/planet cluster for systems not yet
                // calibrated.
                // The token art is a RECTANGLE (89x52 native) sized to cover a
                // system's two resource icons — render it at native size like
                // the loyalty tokens, not squeezed into a square.
                const sW = 89 * BOARD_SCALE;
                const sH = 52 * BOARD_SCALE;
                const spx = (s.sabotageMarkerPos?.x ?? basePos.x) * BOARD_SCALE;
                const spy = (s.sabotageMarkerPos?.y ?? basePos.y) * BOARD_SCALE;
                return (
                  <g>
                    <title>{`${sysName} — sabotaged (production disabled)`}</title>
                    <image
                      href={vmodAssetUrl('MarkerSabotage.png', MARKER_IMAGE_BASE)}
                      x={spx - sW / 2} y={spy - sH / 2}
                      width={sW} height={sH}
                      preserveAspectRatio="none"
                    />
                  </g>
                );
              })()}
              {/* RoE target markers, stacked in a row below the hex/planet. */}
              {tMarkers.map((tm, i) => {
                const tW = 40 * BOARD_SCALE;
                const tH = 40 * BOARD_SCALE;
                const spacing = tW * 0.85;
                const total = (tMarkers.length - 1) * spacing;
                const tx = mx - total / 2 + i * spacing;
                const ty = my + markerH / 2 + tH * 0.4;
                const labels: Record<string, string> = {
                  'secure-the-plans': 'Secure the Plans target marker',
                  'raid-outposts-2': 'Raid Outposts target marker',
                  'rebel-cell-2': 'Rebel Cell target marker',
                  'show-no-fear-3': 'Show No Fear target marker',
                };
                return (
                  <g key={`tmarker-${s.id}-${i}`}>
                    <title>{`${s.name ?? s.id} — ${labels[tm.source] ?? 'target marker'}`}</title>
                    <image
                      href={vmodAssetUrl(tm.src, MARKER_IMAGE_BASE)}
                      x={tx - tW / 2} y={ty - tH / 2}
                      width={tW} height={tH}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* Destroyed-system markers — drawn on top of everything, centered on the
            planet art (not the loyalty hex). A destroyed system has its loyalty
            cleared, so this gets its own pass rather than riding the loyalty loop
            (which early-returns for loyalty-less systems). Marker art comes from
            the loaded .vmod cache (DestroyedSystem.png, 250x250 native). */}
        {systems.map((s) => {
          const state = G.map.systems[s.id];
          if (!state?.destroyed) return null;
          const DESTROYED_NATIVE = 250;
          // Scale the marker down to roughly cover the planet disc rather than
          // the whole hex — half native size reads cleanly at board scale.
          const dW = DESTROYED_NATIVE * 0.5 * BOARD_SCALE;
          const dH = DESTROYED_NATIVE * 0.5 * BOARD_SCALE;
          const dx = s.boardPos.x * BOARD_SCALE;
          const dy = s.boardPos.y * BOARD_SCALE;
          const pickerActive = !!onSystemClick;
          return (
            <g key={`destroyed-${s.id}`} pointerEvents={pickerActive ? 'none' : 'auto'}>
              <title>{`${s.name ?? s.id} — destroyed`}</title>
              <image
                href={vmodAssetUrl('DestroyedSystem.png', MARKER_IMAGE_BASE)}
                x={dx - dW / 2}
                y={dy - dH / 2}
                width={dW}
                height={dH}
                preserveAspectRatio="xMidYMid meet"
              />
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
      {hoverBuildKind && <EnlargedBuildQueue G={G} kind={hoverBuildKind} />}

      {/* Legend */}
      <div style={{
        position: 'absolute', bottom: 6, left: 6,
        background: 'rgba(0,0,0,0.7)', padding: '6px 10px', borderRadius: 3,
        fontSize: 10, color: '#ccc', display: 'flex', gap: 12, flexWrap: 'wrap',
      }}>
        <span><img src={vmodAssetUrl("MarkerLoyaltyRebel.png", MARKER_IMAGE_BASE)} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> Rebel</span>
        <span><img src={vmodAssetUrl("MarkerLoyaltyEmpire.png", MARKER_IMAGE_BASE)} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> Imperial</span>
        <span><img src={vmodAssetUrl("MarkerLoyaltySubjugated.png", MARKER_IMAGE_BASE)} width={14} height={14} style={{ verticalAlign: 'middle', marginRight: 4 }} alt="" /> subjugated</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: 'transparent', border: '1px solid #80dc78', borderRadius: '50%', marginRight: 4, verticalAlign: 'middle' }} /> revealed Rebel base</span>
        <span>R<i>N</i> = Rebel units · E<i>N</i> = Empire units</span>
      </div>
    </div>
  );
}

// ============================================================================
// Leader roster — every leader for a side, with stats + current status. Lets
// you size up the enemy's leaders at a glance (skills, combat tactic values,
// where each one is). Mission commitments stay secret while the opponent is
// still assigning (#87); leader STATS are public knowledge (printed on the
// cards) so they always show. (Feature request: MightyFaben.)
// ============================================================================

/** Current whereabouts of a leader, for the roster status badge. */
function leaderStatusFor(
  G: GameState, side: Side, leaderId: string, humanSide: Side
): { label: string; color: string } {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  // Captured/carbonite leaders are held in the captor's capturedLeaders list
  // (only the Empire captures, so check the opposing faction).
  const captor = side === 'Rebel' ? G.empire : G.rebel;
  const cap = captor.capturedLeaders?.find((c) => c.leaderId === leaderId);
  if (cap) {
    return cap.ring === 'carbonite'
      ? { label: 'Carbonite', color: '#4fc3f7' }
      : { label: 'Captured', color: '#ff6b6b' };
  }
  for (const [sysId, list] of Object.entries(f.leadersOnBoard)) {
    if (list.includes(leaderId)) {
      return { label: G.catalog.systems[sysId]?.name ?? sysId, color: '#cbc4b0' };
    }
  }
  const inPool = f.leaderPool.includes(leaderId);
  const onMission = f.leadersOnMissions.some((m) => m.leaderIds.includes(leaderId));
  // RAW: assignment is secret. Hide pool-vs-mission for the opponent until the
  // Command phase, so the roster can't be used to peek at their commitments.
  if (side !== humanSide && G.phase === 'Assignment' && (inPool || onMission)) {
    return { label: 'assigning…', color: '#888' };
  }
  if (inPool) return { label: 'In pool', color: '#80dc78' };
  if (onMission) return { label: 'On a mission', color: '#ffd54a' };
  return { label: 'Not in play', color: '#5a5a5a' };
}

function LeaderRoster({ G, side, humanSide }: { G: GameState; side: Side; humanSide: Side }) {
  const color = sideColor(side);
  // A leader lured to the dark side becomes an Imperial leader for the rest of
  // the game — so list them under the side that CONTROLS them now, not their
  // printed side (player report #132: Empire lured Luke but he never showed up
  // in the Empire's roster because we filtered on catalog side).
  const effectiveSide = (l: { id: string; side: Side }): Side =>
    G.leaderAttachments?.[l.id]?.includes('dark-side') ? 'Empire' : l.side;
  const leaders = Object.values(G.catalog.leaders).filter((l) => effectiveSide(l) === side);
  if (leaders.length === 0) return null;
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {side} leaders ({leaders.length})
      </summary>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {leaders.map((l) => {
          const st = leaderStatusFor(G, side, l.id, humanSide);
          const art = l.image ? getCachedArtUrlSync(l.image) : null;
          return (
            <div
              key={l.id}
              title={`${l.name}\nDiplomacy ${l.skills.diplomacy} · Intel ${l.skills.intel} · SpecOps ${l.skills.specOps} · Logistics ${l.skills.logistics}\nTactics: space ${l.tacticValues.space} / ground ${l.tacticValues.ground}\n${st.label}`}
              style={{
                width: 132, background: '#0c0d10', border: `1px solid ${st.color}55`,
                borderLeft: `3px solid ${st.color}`, borderRadius: 4, padding: '4px 6px',
                display: 'flex', gap: 6, alignItems: 'center',
              }}
            >
              {art && (
                <img src={art} alt={l.name}
                  style={{ width: 26, height: 26, objectFit: 'cover', objectPosition: 'top',
                    borderRadius: 3, flex: '0 0 auto' }} />
              )}
              <div style={{ minWidth: 0, lineHeight: 1.25 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#fff',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {l.name}
                </div>
                <div style={{ fontSize: 9.5, color: '#9a937f', whiteSpace: 'nowrap' }}>
                  {/* Dim letters, bright numbers — keeps the stat line legible
                   *  even when a value is 0, where "I0 O0" used to smear into
                   *  one grey blob (MightyFaben forum feedback). */}
                  {([['D', l.skills.diplomacy], ['I', l.skills.intel], ['O', l.skills.specOps], ['L', l.skills.logistics]] as const).map(([k, v], i) => (
                    <span key={k}>
                      {i > 0 ? ' ' : ''}
                      <span style={{ color: '#6f6a5c' }}>{k}</span>
                      <span style={{ color: '#e0dac8', fontWeight: 700 }}>{v}</span>
                    </span>
                  ))}
                  {' · '}
                  {(l.tacticValues.space + l.tacticValues.ground) === 0 ? (
                    // No tactic values ("—" on the card): this leader cannot
                    // activate a system / lead a move (RR). Show a dash, not 0/0.
                    <span style={{ color: '#6f6a5c' }} title="No tactic value — cannot activate a system">S—/G—</span>
                  ) : (
                    <>
                      <span style={{ color: '#6f6a5c' }}>S</span><span style={{ color: '#cbc4b0', fontWeight: 700 }}>{l.tacticValues.space}</span>
                      <span style={{ color: '#6f6a5c' }}>/G</span><span style={{ color: '#cbc4b0', fontWeight: 700 }}>{l.tacticValues.ground}</span>
                    </>
                  )}
                </div>
                <div style={{ fontSize: 9.5, color: st.color, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {st.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9.5, color: '#666', marginTop: 4 }}>
        D/I/O/L = Diplomacy / Intel / Spec-Ops / Logistics skill · S/G = space / ground tactic value
      </div>
    </details>
  );
}

/** Per-faction unit roster: every unit type, its stats, and where each token
 *  currently is — in the holding-pool supply, on the board (by system), or in
 *  a build-queue slot. Mirrors LeaderRoster. Whereabouts are computed from the
 *  viewer's (already-redacted) G, so hidden Rebel-base deployments stay hidden
 *  to the Empire — those just read as "in supply" from their side, which is the
 *  most they can know. */
function UnitRoster({ G, side }: { G: GameState; side: Side }) {
  const color = sideColor(side);
  // Only list units that are part of THIS game: base units always, RoE-tagged
  // units only when the expansion is enabled. Without this, a base game shows
  // expansion units (Interdictor, TIE Striker, …) it can never field
  // (player report #152).
  const types = Object.values(G.catalog.unitTypes).filter(
    (t) => t.side === side && (t.set !== 'rote' || G.expansion?.enabled === true),
  );
  if (types.length === 0) return null;
  const f = side === 'Rebel' ? G.rebel : G.empire;

  // typeId → (locationName → count) across the board + Rebel-base space.
  const boardByType = new Map<string, Map<string, number>>();
  const tally = (units: { side: Side; typeId: string }[] | undefined, locName: string) => {
    for (const u of units ?? []) {
      if (u.side !== side) continue;
      const m = boardByType.get(u.typeId) ?? new Map<string, number>();
      m.set(locName, (m.get(locName) ?? 0) + 1);
      boardByType.set(u.typeId, m);
    }
  };
  for (const [sid, ss] of Object.entries(G.map.systems)) {
    tally(ss.units, G.catalog.systems[sid]?.name ?? sid);
  }
  tally(G.map.rebelBaseSpace?.units, 'Rebel Base space');

  // typeId → (slot → count) in this side's build queue.
  const queueByType = new Map<string, Map<1 | 2 | 3, number>>();
  for (const slot of [1, 2, 3] as const) {
    for (const t of f.buildQueue[slot] ?? []) {
      const m = queueByType.get(t) ?? new Map<1 | 2 | 3, number>();
      m.set(slot, (m.get(slot) ?? 0) + 1);
      queueByType.set(t, m);
    }
  }

  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', fontSize: 12, color, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {side} units ({types.length})
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {types.map((t) => {
          const board = boardByType.get(t.id);
          const queue = queueByType.get(t.id);
          const onBoard = board ? [...board.values()].reduce((a, b) => a + b, 0) : 0;
          const queued = queue ? [...queue.values()].reduce((a, b) => a + b, 0) : 0;
          const supply = Math.max(0, (t.supplyCount ?? 0) - onBoard - queued);
          const art = (t as { image?: string }).image ? getCachedArtUrlSync((t as { image?: string }).image!) : null;
          return (
            <div key={t.id} style={{
              background: '#0c0d10', border: `1px solid ${color}33`,
              borderLeft: `3px solid ${color}`, borderRadius: 4, padding: '4px 8px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {art && <img src={art} alt="" style={{ width: 22, height: 22, objectFit: 'contain', flex: '0 0 auto' }} />}
                <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', minWidth: 130 }}>{t.name}</span>
                <UnitStatLine G={G} typeId={t.id} />
                <span style={{ fontSize: 11, color: '#9a937f' }}>· build {t.buildResource}</span>
                <span style={{ fontSize: 11, color: '#666' }}>· total {t.supplyCount}</span>
              </div>
              <div style={{ fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>
                <span style={{ color: supply > 0 ? '#80dc78' : '#5a5a5a', fontWeight: 600 }}>
                  Supply {supply}
                </span>
                {board && [...board.entries()].map(([loc, n]) => (
                  <span key={loc} style={{ color: '#cbc4b0' }}>{' · '}{loc}{n > 1 ? `×${n}` : ''}</span>
                ))}
                {queue && [...queue.entries()].sort((a, b) => a[0] - b[0]).map(([slot, n]) => (
                  <span key={slot} style={{ color: '#ffd54a' }}>
                    {' · '}queue slot {slot}{n > 1 ? `×${n}` : ''}{slot === 1 ? ' (deploys next refresh)' : ''}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 9.5, color: '#666', marginTop: 4 }}>
        Supply = tokens still in the holding pool (printed total minus what's on the board or queued).
        atk R/B = red/black attack dice · HP = health · build = resource cost.
      </div>
    </details>
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
        <Row label="Leader pool" value={
          // RAW: assignment is simultaneous and SECRET. While the Assignment
          // phase is in progress, don't reveal the opponent's pool — its
          // shrinking would leak which leaders they've committed to missions
          // before you've locked in your own (player report #87).
          side !== humanSide && G.phase === 'Assignment'
            ? '(assigning in secret)'
            : (f.leaderPool.length ? f.leaderPool.join(', ') : '(empty)')
        } />
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
        <Row label="Active missions" value={
          // Hidden entirely while the opponent is still assigning (#87) —
          // revealed (as facedown missions) once the Command phase begins.
          side !== humanSide && G.phase === 'Assignment'
            ? '(assigning in secret)'
            : f.leadersOnMissions.length === 0
            ? '(none)'
            : side === humanSide
              // Your own missions: full hover-preview of each card.
              ? <HandTip count={f.leadersOnMissions.length} cards={f.leadersOnMissions.map((m) => {
                  const c = G.catalog.missions[m.missionId];
                  return { name: c?.name ?? m.missionId, image: c?.image, rulesText: c?.rulesText };
                })} />
              // Opponent's missions are FACEDOWN per RAW (reporter MightyFaben):
              // you can see leaders are committed and how many, but not which
              // mission, until it's revealed during your turn.
              : f.leadersOnMissions.map((m) => {
                  const leaders = m.leaderIds.map((l) => G.catalog.leaders[l]?.name ?? l).join(', ');
                  return `Facedown mission${leaders ? ` (${leaders})` : ''}`;
                }).join(' · ')
        } />
        <Row label="Action hand" value={
          side === humanSide
            ? <HandTip count={f.actionHand.length} cards={f.actionHand.map((cid) => {
                const c = G.catalog.actions[cid];
                return { name: c?.name ?? cid, image: c?.image, rulesText: c?.rulesText,
                  hint: actionCardPlayHint(G, side, cid) };
              })} />
            : `${f.actionHand.length} cards`
        } />
        <Row label="Action deck" value={`${f.actionDeck.length} cards`} />
        {side === 'Rebel' && (() => {
          // Show where every ring is attached. Previously only the R2-D2 / C-3PO
          // droid rings were listed, so a leader awarded the Master Yoda ring via
          // Seek Yoda (or the K-2SO / bounty / dark-side rings) showed nothing and
          // looked like they got no ring at all (player report #275).
          const RING_LABELS: Record<string, string> = {
            r2d2: 'R2-D2', c3po: 'C-3PO', k2so: 'K-2SO',
            yoda: 'Yoda', bounty: 'Bounty', 'dark-side': 'Dark Side',
          };
          const att = G.leaderAttachments ?? {};
          const entries: string[] = [];
          for (const lid of Object.keys(att)) {
            const name = G.catalog.leaders[lid]?.name ?? lid;
            for (const ring of att[lid]) {
              const label = RING_LABELS[ring];
              if (label) entries.push(`${label} → ${name}`);
            }
          }
          if (entries.length === 0) return null;
          return <Row label="Rings" value={entries.join(' · ')} />;
        })()}
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
            <Row
              label="Captured leaders"
              value={
                f.capturedLeaders && f.capturedLeaders.length > 0
                  ? (
                      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                        {f.capturedLeaders.map((cl) => {
                          const ldr = G.catalog.leaders[cl.leaderId];
                          const sysName = G.catalog.systems[cl.systemId]?.name ?? cl.systemId;
                          const ringTag = cl.ring === 'carbonite' ? ' ❄' : '';
                          return (
                            <span
                              key={cl.leaderId}
                              title={`${ldr?.name ?? cl.leaderId} — held at ${sysName}${cl.ring === 'carbonite' ? ' (in carbonite)' : ''}`}
                              style={{
                                background: '#3a1a1a', color: '#ffaaaa',
                                border: '1px solid #6a2a2a', borderRadius: 3,
                                padding: '1px 6px', fontSize: 11, fontWeight: 600,
                              }}
                            >
                              {ldr?.name ?? cl.leaderId}{ringTag} @ {sysName}
                            </span>
                          );
                        })}
                      </span>
                    )
                  : '(none)'
              }
            />
          </>
        )}
        <Row label="Build queue 3 / 2 / 1" value={(() => {
          const fmt = (slot: 1 | 2 | 3) => {
            const list = f.buildQueue[slot];
            if (list.length === 0) return '—';
            // Collapse duplicates: TIE×3, AT-ST×1
            const counts = new Map<string, number>();
            for (const t of list) counts.set(t, (counts.get(t) ?? 0) + 1);
            return [...counts.entries()].map(([t, n]) => {
              const name = G.catalog.unitTypes[t]?.name ?? t;
              return n > 1 ? `${name}×${n}` : name;
            }).join(', ');
          };
          return (
            <span>
              <span style={{ color: '#888' }}>slot 3: </span>{fmt(3)}
              {' · '}
              <span style={{ color: '#888' }}>slot 2: </span>{fmt(2)}
              {' · '}
              <span style={{ color: '#fff' }}>slot 1 (deploys next refresh): </span>{fmt(1)}
            </span>
          );
        })()} />
      </div>
    </div>
  );
}

// ============================================================================
// Map-with-side-picker overlay — pick a system ON the map (left) with the
// candidates highlighted + clickable, and a docked picker sidebar (right).
// Replaces the old board-covering target modals (reporter MightyFaben).
// ============================================================================

function MapPickerOverlay({
  G, systems, masks, humanSide, title, instructions, color, candidates, onPick, onCancel, cancelLabel, unitTokens, multi, headerExtra, handReference,
}: {
  G: GameState; systems: System[]; masks: MaskRect[]; humanSide: Side;
  title: string; instructions?: string; color: string;
  candidates: string[];
  onPick: (systemId: string) => void;
  onCancel?: () => void;
  // Label for the cancel/decline button (defaults to "Cancel").
  cancelLabel?: string;
  // Optional "still to deploy" tokens (unit typeIds) shown under the list.
  // The first entry is the unit being placed right now; the rest are queued.
  unitTokens?: string[];
  // Multi-select mode: pick exactly `count` systems, then Confirm.
  multi?: { count: number; onSubmit: (systemIds: string[]) => void };
  // Extra sidebar content rendered above the candidate list (e.g. a leader
  // selector for a two-step pick).
  headerExtra?: React.ReactNode;
  // Optional "your cards" reference (the human's hands) shown in the sidebar —
  // used during deployment so you can check missions/objectives without
  // leaving the deploy screen (reporter MightyFaben).
  handReference?: Side;
}) {
  const highlight = new Set(candidates);
  const unitStyle = getUnitStyle();
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (sid: string) => setSelected((prev) =>
    prev.includes(sid) ? prev.filter((s) => s !== sid)
      : (prev.length < (multi?.count ?? 1) ? [...prev, sid] : prev));
  const handleClick = multi ? toggle : onPick;
  const selectedSet = new Set(selected);
  // Group the remaining-to-deploy tokens by type, preserving the "current"
  // (first) unit so we can flag it.
  const currentTokenType = unitTokens && unitTokens.length > 0 ? unitTokens[0] : null;
  const tokenGroups = unitTokens && unitTokens.length > 0 ? groupTypeIds(unitTokens) : [];
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000, padding: 12 }}>
      <div style={{ display: 'flex', gap: 12, maxWidth: '98vw', maxHeight: '94vh' }}>
        {/* Map (left) — candidates highlighted + clickable. */}
        <div style={{ overflow: 'auto', border: `1px solid ${color}`, borderRadius: 6, background: '#0a0b0e' }}>
          <Board G={G} systems={systems} masks={masks} humanSide={humanSide}
            highlightSystemIds={highlight} onSystemClick={handleClick}
            selectedSystemIds={multi ? selectedSet : null} />
        </div>
        {/* Picker sidebar (right). */}
        <div style={{ width: 280, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
          background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
          padding: 14, maxHeight: '94vh', overflowY: 'auto' }}>
          <div style={{ color, fontWeight: 700, fontSize: 15, marginBottom: 6 }}>{title}</div>
          {instructions && <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>{instructions}</div>}
          {headerExtra}
          <div style={{ color: '#9bb8d6', fontSize: 11, marginBottom: 8 }}>
            {multi
              ? `Pick ${multi.count} system${multi.count === 1 ? '' : 's'} — click on the map or the list (selected ${selected.length}/${multi.count}):`
              : 'Click a highlighted system on the map, or pick from the list:'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {candidates.map((sid) => {
              const sys = G.catalog.systems[sid];
              const sel = selectedSet.has(sid);
              return (
                <button key={sid} className="tab-button" onClick={() => handleClick(sid)}
                  style={{ textAlign: 'left', border: multi && sel ? '1px solid #80dc78' : undefined }}>
                  <div style={{ fontWeight: 700 }}>{multi && sel ? '✓ ' : ''}{sys?.name ?? sid}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>region {sys?.region}</div>
                </button>
              );
            })}
          </div>
          {multi && (
            <button
              className="tab-button"
              disabled={selected.length !== multi.count}
              onClick={() => multi.onSubmit(selected)}
              style={{ marginTop: 10, fontWeight: 700,
                background: selected.length === multi.count ? color : '#1a1c22',
                color: selected.length === multi.count ? '#000' : '#555' }}
            >
              Confirm {selected.length}/{multi.count}
            </button>
          )}
          {handReference && (() => {
            // Your cards, for planning while you deploy. Names are hoverable
            // (CardArtHover shows the full card).
            const f = handReference === 'Rebel' ? G.rebel : G.empire;
            const groups: { label: string; ids: string[]; cat: 'missions' | 'actions' | 'objectives' }[] = [
              { label: 'Missions', ids: f.missionHand ?? [], cat: 'missions' },
              { label: 'Action cards', ids: f.actionHand ?? [], cat: 'actions' },
              ...(handReference === 'Rebel' ? [{ label: 'Objectives', ids: f.objectiveHand ?? [], cat: 'objectives' as const }] : []),
            ];
            const lookup = (cat: string, id: string) =>
              cat === 'missions' ? G.catalog.missions[id]
              : cat === 'actions' ? G.catalog.actions[id]
              : G.catalog.objectives[id];
            return (
              <div style={{ marginTop: 14, borderTop: '1px solid #2a2d34', paddingTop: 10 }}>
                <div style={{ fontSize: 11, color: '#9bb8d6', marginBottom: 4 }}>Your cards (hover to read):</div>
                {groups.map((g) => g.ids.length > 0 && (
                  <div key={g.label} style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 10, color: '#888' }}>{g.label} ({g.ids.length}):</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                      {g.ids.map((id, i) => {
                        const c = lookup(g.cat, id);
                        return (
                          <span key={id + i} style={{ fontSize: 11 }}>
                            <CardArtHover name={c?.name ?? id} image={c?.image}
                              style={{ color: '#cfe2f5', textDecoration: c?.image ? 'underline dotted' : undefined }} />
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
          {tokenGroups.length > 0 && (
            <div style={{ marginTop: 14, borderTop: '1px solid #2a2d34', paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: '#9bb8d6', marginBottom: 6 }}>
                Still to deploy ({unitTokens!.length}):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tokenGroups.map((g) => {
                  const img = unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle);
                  const name = G.catalog.unitTypes[g.typeId]?.name ?? g.typeId;
                  const isCurrent = g.typeId === currentTokenType;
                  return (
                    <div key={g.typeId} title={name} style={{
                      position: 'relative', width: 34, height: 34, borderRadius: 4,
                      background: '#0c0d10', overflow: 'hidden',
                      border: isCurrent ? `2px solid ${color}` : '1px solid #2a2d34',
                      boxShadow: isCurrent ? `0 0 6px ${color}` : undefined,
                    }}>
                      {img ? <img src={img} alt={name} draggable={false}
                        style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        : <span style={{ fontSize: 9, color: '#ccc' }}>{name.slice(0, 3)}</span>}
                      {g.count > 1 && (
                        <div style={{ position: 'absolute', bottom: -2, right: -2,
                          minWidth: 14, height: 14, padding: '0 3px', background: '#222',
                          color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: 7,
                          border: '1px solid #000', display: 'flex', alignItems: 'center',
                          justifyContent: 'center', lineHeight: 1 }}>
                          {g.count}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: '#888', marginTop: 6 }}>
                The glowing token is being placed now; tokens drop off as you deploy.
              </div>
            </div>
          )}
          {onCancel && (
            <button className="tab-button" style={{ marginTop: 12 }} onClick={onCancel}>{cancelLabel ?? 'Cancel'}</button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Homing Beacon: two-step pick (which rescued leader, then which system in the
 *  base's region) on the map layout. Leader chosen in the sidebar, system
 *  clicked on the map. */
function HomingBeaconMapModal({
  G, systems, masks, humanSide, leaderCandidates, systemCandidates, onSubmit,
}: {
  G: GameState; systems: System[]; masks: MaskRect[]; humanSide: Side;
  leaderCandidates: string[]; systemCandidates: string[];
  onSubmit: (leaderId: string, systemId: string) => void;
}) {
  const [leaderId, setLeaderId] = useState<string>(leaderCandidates[0] ?? '');
  return (
    <MapPickerOverlay
      G={G} systems={systems} masks={masks} humanSide={humanSide}
      color={sideColor('Rebel')}
      title="Homing Beacon — place the rescued leader"
      instructions="Your leader was rescued; place them in any system in the base's region. Pick the leader, then click a highlighted system."
      candidates={systemCandidates}
      onPick={(sid) => { if (leaderId) onSubmit(leaderId, sid); }}
      headerExtra={
        leaderCandidates.length > 1 ? (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: '#9bb8d6', marginBottom: 4 }}>Leader to place:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {leaderCandidates.map((lid) => (
                <button key={lid} className="tab-button"
                  onClick={() => setLeaderId(lid)}
                  style={{ textAlign: 'left', fontWeight: lid === leaderId ? 700 : 400,
                    border: lid === leaderId ? '1px solid #4fc3f7' : undefined }}>
                  {lid === leaderId ? '● ' : '○ '}{G.catalog.leaders[lid]?.name ?? lid}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#cfe2f5', marginBottom: 10 }}>
            Rescuing <strong>{G.catalog.leaders[leaderId]?.name ?? leaderId}</strong>.
          </div>
        )
      }
    />
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

function SetupPanel({ G, side, onDeploy, onAutoFill, onUndo, onUndoUnit, onReset, undoCount }: {
  G: GameState;
  side: Side;
  onDeploy: (side: Side, typeId: string, systemId: string) => void;
  onAutoFill: (side: Side) => void;
  onUndo: () => void;
  onUndoUnit: (side: Side, typeId: string, systemId: string) => void;
  onReset: () => void;
  undoCount: number;
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
    const roe = !!G.expansion?.enabled;
    const placingDsuc = selectedType === 'death-star-under-construction';
    // The Death Star Under Construction may only go on the chosen remote system;
    // all other units go on Imperial-loyalty / subjugated worlds (and may also
    // reinforce the remote that holds the DSUC — RoE rules p.8).
    if (!placingDsuc) {
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
    }
    if (roe) {
      if (G.empireDeployTarget) {
        const sysDef = G.catalog.systems[G.empireDeployTarget];
        legalTargets.push({ id: G.empireDeployTarget, name: sysDef?.name ?? G.empireDeployTarget, note: 'Death Star site' });
      } else {
        for (const [sysId] of Object.entries(G.map.systems)) {
          const sysDef = G.catalog.systems[sysId];
          if (sysDef?.isRemote) legalTargets.push({ id: sysId, name: sysDef?.name ?? sysId, note: 'choose as Death Star site' });
        }
      }
    }
  } else {
    legalTargets.push({ id: 'rebel-base-space', name: 'Rebel Base space', note: 'staging area (hidden)' });
    // Rebel starting units: the base, plus ONE populous system of your choice —
    // neutral or Rebel-loyal (RAW). Once you've placed in one such system, that
    // becomes your only off-base target for the rest of setup.
    if (G.rebelDeployTarget) {
      const sysDef = G.catalog.systems[G.rebelDeployTarget];
      legalTargets.push({ id: G.rebelDeployTarget, name: sysDef?.name ?? G.rebelDeployTarget, note: 'your chosen system' });
    } else {
      for (const [sysId, ss] of Object.entries(G.map.systems)) {
        const sysDef = G.catalog.systems[sysId];
        if (sysDef?.isCoruscant || sysDef?.isRemote) continue;
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
          {side === 'Empire' && (G.expansion?.enabled
            ? '(Place in Imperial-loyalty or subjugated systems; every Imperial system needs ≥1 ground unit. The Death Star Under Construction goes on one chosen remote system.)'
            : '(Place in Imperial-loyalty or subjugated systems; every Imperial system needs ≥1 ground unit.)')}
          {side === 'Rebel' && '(Rebel Base space and/or one populous system of your choice — neutral or Rebel-loyal.)'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            className="tab-button"
            onClick={onUndo}
            disabled={undoCount === 0}
            title={undoCount === 0 ? 'Nothing to undo yet' : 'Undo your last placement'}
          >
            ↶ Undo
          </button>
          <button
            className="tab-button"
            onClick={onReset}
            disabled={undoCount === 0}
            title={undoCount === 0 ? 'Nothing to reset yet' : 'Clear all your placements and start over'}
          >
            Reset setup
          </button>
          <button
            className="tab-button"
            onClick={() => onAutoFill(side)}
            disabled={pending.length === 0}
          >
            Auto-fill (computer chooses)
          </button>
        </div>
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
              const unitName = G.catalog.unitTypes[g.typeId]?.name ?? g.typeId;
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
                    // Wider button to fit the unit name as a visible text
                    // label — strict-image deploys ship transparent
                    // placeholders, so the image alone is an empty square
                    // and the player has no way to tell units apart.
                    minWidth: 84,
                    height: 64,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 2,
                  }}
                  title={unitName}
                >
                  {file && <img src={unitImageUrl(g.typeId, UNIT_IMAGE_BASE, unitStyle)!} width={28} height={28} alt={unitName} />}
                  <span style={{ fontSize: 9, color: isSelected ? '#000' : '#e8e8ea', textAlign: 'center', lineHeight: 1.1, fontWeight: 600 }}>
                    {unitName}
                  </span>
                  <span style={{
                    position: 'absolute', top: 2, right: 2,
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

      {/* Placed units — click any to pull it back off the board (player request:
          change a setup placement without undoing everything after it). */}
      {(() => {
        const placed: { systemId: string; sysName: string; typeId: string; count: number }[] = [];
        const collect = (container: { units: { side: Side; typeId: string }[] } | undefined, systemId: string, sysName: string) => {
          if (!container) return;
          const counts = new Map<string, number>();
          for (const u of container.units) if (u.side === side) counts.set(u.typeId, (counts.get(u.typeId) ?? 0) + 1);
          for (const [typeId, count] of counts) placed.push({ systemId, sysName, typeId, count });
        };
        if (side === 'Rebel') collect(G.map.rebelBaseSpace, 'rebel-base-space', 'Rebel Base space');
        for (const [sysId, ss] of Object.entries(G.map.systems)) collect(ss, sysId, G.catalog.systems[sysId]?.name ?? sysId);
        if (placed.length === 0) return null;
        return (
          <div style={{ marginTop: 10, borderTop: '1px solid #2a2d34', paddingTop: 8 }}>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
              Placed so far — click a unit to pull it back off the board:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {placed.map((p) => (
                <button key={`${p.systemId}:${p.typeId}`} className="tab-button"
                  onClick={() => onUndoUnit(side, p.typeId, p.systemId)}
                  title={`Pull a ${G.catalog.unitTypes[p.typeId]?.name ?? p.typeId} back from ${p.sysName}`}
                  style={{ fontSize: 11, padding: '3px 8px' }}>
                  ↩ {G.catalog.unitTypes[p.typeId]?.name ?? p.typeId}{p.count > 1 ? ` ×${p.count}` : ''} @ {p.sysName}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
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
  onActivate: (leaderId: string, targetSystemId: string, moveOrders: MoveOrder[]) => boolean | void;
  onReveal: (missionId: string, targetSystemId: string, targetLeaderId?: string) => boolean | void;
  onPass: () => void;
}) {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  const color = sideColor(side);
  const [leaderId, setLeaderId] = useState<string | null>(null);
  const [targetSystemId, setTargetSystemId] = useState<string | null>(null);
  // moveCounts: fromSystemId -> typeId -> count to move
  const [moveCounts, setMoveCounts] = useState<Record<string, Record<string, number>>>({});

  // Eligible leaders: only leaders WITH tactic values. RR (twice): "A leader
  // that does not have tactic values cannot activate a system." The three
  // no-tactic leaders (Boba Fett, Janus Greejatus, Mon Mothma) can run
  // missions and block enemy move-outs, but cannot lead a move.
  const eligibleLeaders = f.leaderPool.filter((lid) => {
    const l = G.catalog.leaders[lid];
    return l && (l.tacticValues.space + l.tacticValues.ground) > 0;
  });

  // Valid sources for moves: systems adjacent to target (or the target itself —
  // pre-existing friendly units), where the human has no leader.
  const sources: string[] = [];
  if (targetSystemId === 'rebel-base-space') {
    // Activating the hidden Rebel Base space: pull units IN from the base's own
    // system or a system adjacent to it (rr "Moving to or from the Rebel Base").
    const baseId = G.rebelBaseSystemId;
    const candidates = [baseId, ...(G.catalog.adjacency[baseId] ?? [])];
    for (const sysId of candidates) {
      if ((f.leadersOnBoard[sysId] ?? []).length > 0) continue;
      const ss = G.map.systems[sysId];
      if (ss && ss.units.some((u) => u.side === side)) sources.push(sysId);
    }
  } else if (targetSystemId) {
    const adj = G.catalog.adjacency[targetSystemId] ?? [];
    for (const sysId of adj) {
      if ((f.leadersOnBoard[sysId] ?? []).length > 0) continue;
      const ss = G.map.systems[sysId];
      if (!ss) continue;
      const hasOwn = ss.units.some((u) => u.side === side);
      if (hasOwn) sources.push(sysId);
    }
    // Rebel can pull from rebel-base-space ONLY when the target is the base's
    // own system or adjacent to it (RAW: base units move only to base/adjacent
    // while hidden), and no leader sits in the base space. The Rebel knows
    // their base, so this leaks nothing.
    if (side === 'Rebel' && G.map.rebelBaseSpace.units.length > 0) {
      const baseId = G.rebelBaseSystemId;
      const baseAdj = G.catalog.adjacency[baseId] ?? [];
      const baseLeaderBlocks = (f.leadersOnBoard['rebel-base-space'] ?? []).length > 0;
      if (!baseLeaderBlocks && (targetSystemId === baseId || baseAdj.includes(targetSystemId))) {
        sources.push('rebel-base-space');
      }
    }
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
  const [revealTargetLeaderId, setRevealTargetLeaderId] = useState<string | null>(null);

  const assignedMissions = f.leadersOnMissions;
  // Missions that resolve WITHOUT targeting a system (Contingency Plan just
  // re-assigns a leader). The reveal UI shouldn't force a planet pick for these
  // (player report #133: had to type a random planet to activate it). The engine
  // ignores the target for them, so we pass a throwaway system on reveal.
  const TARGETLESS_REVEAL = new Set(['contingency-plan']);
  const revealNeedsTarget = !!revealMissionId && !TARGETLESS_REVEAL.has(revealMissionId);

  const handleReveal = () => {
    if (!revealMissionId) return;
    // Target-less missions: the engine ignores the system, so pass any valid one.
    const target = revealNeedsTarget ? revealTargetSysId : (revealTargetSysId ?? Object.keys(G.map.systems)[0]);
    if (!target) return;
    const ok = onReveal(revealMissionId, target, revealTargetLeaderId ?? undefined);
    if (ok !== false) {
      setRevealMissionId(null);
      setRevealTargetSysId(null);
      setRevealTargetLeaderId(null);
    }
  };

  const handleActivate = () => {
    if (!leaderId || !targetSystemId) return;
    // Build moveOrders: convert (sysId × typeId × count) → unit instance IDs.
    const orders: MoveOrder[] = [];
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
    // Guard the common misclick: committing a leader with NO units moving
    // wastes the activation (a leader alone can't fight, subjugate, or carry
    // troops) — reporter MightyFaben lost a turn this way. Confirm first.
    const totalUnits = orders.reduce((n, o) => n + o.unitInstanceIds.length, 0);
    if (totalUnits === 0) {
      const sysName = targetSystemId === 'rebel-base-space' ? 'the Rebel Base space'
        : (G.catalog.systems[targetSystemId]?.name ?? targetSystemId);
      const ok = window.confirm(
        `Activate ${sysName} with NO units moving?\n\n`
        + `Your leader will go there alone — this can't move troops, subjugate, `
        + `or start a battle, and it uses up the activation. Continue anyway?`);
      if (!ok) return;
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
              // Skill total — mirror the engine's reveal check: major + minor
              // icons, where minor includes printed minors AND ring-granted
              // bonuses (e.g. K-2SO from He Means Well). Summing only major
              // here previously hid the ring/minor contribution (#173).
              const need = card.skill;
              let total = 0;
              if (need) {
                const sc = phases.totalSkill(G, am.leaderIds, need);
                total = sc.major + sc.minor;
              }
              const meets = need ? total >= card.skillCost : true;
              // Portrait bonus: if the pictured leader is among the assigned
              // leaders, this mission gets +2 automatic successes. It was shown
              // during assignment but vanished at reveal time, even though it's
              // key for deciding play order (MightyFaben forum feedback).
              const portraitId = card.leaderPortrait ?? null;
              const portraitActive = !!(portraitId && (am.leaderIds as string[]).includes(portraitId));
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
                  {portraitActive && (
                    <div style={{ fontSize: 10, color: isSel ? '#5a4500' : '#ffd54a', fontWeight: 700 }}>
                      🖼 +2 portrait ({(portraitId && G.catalog.leaders[portraitId]?.name) || portraitId})
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {revealMissionId && (() => {
            const targets = missionTargets(G, side, revealMissionId);
            const leaderTargets = missionLeaderTargets(G, side, revealMissionId);
            const isLeaderPick = leaderTargets !== null;
            return revealNeedsTarget ? (
            <>
              <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
                Step 2 — pick the target {isLeaderPick ? 'leader' : 'system'}
                {targets.note && !isLeaderPick && (
                  <span style={{ marginLeft: 6, color: targets.permissive ? '#ff8866' : '#80dc78' }}>
                    {targets.note}
                  </span>
                )}
              </div>
              {isLeaderPick && leaderTargets!.length === 0 && (() => {
                // Explain WHY there's no target. Empty can mean "no Rebel
                // leaders anywhere" OR "leaders exist but none are in a
                // system that qualifies" — e.g. Capture Rebel Operative needs
                // one of your units in the leader's system. (#56: leaders sat
                // at Corellia with no Imperial unit, so the old "no leaders"
                // message was misleading.)
                const anyRebelLeaders = Object.values(G.rebel.leadersOnBoard)
                  .some((arr) => (arr?.length ?? 0) > 0);
                const needsImperialUnit = (targets.note ?? '').toLowerCase().includes('imperial unit');
                return (
                  <div style={{ color: '#ff8866', fontSize: 12, marginBottom: 6 }}>
                    {!anyRebelLeaders
                      ? 'No Rebel leaders are on the board to target right now.'
                      : needsImperialUnit
                        ? 'There are Rebel leaders on the board, but this mission can only target a Rebel leader in a system where you have a unit. Move one of your units into their system first, then run the mission.'
                        : <>There are Rebel leaders on the board, but none are in a system that qualifies for this mission{targets.note ? <> (needs: {targets.note})</> : null}.</>}
                  </div>
                );
              })()}
              {!isLeaderPick && targets.systemIds.length === 0 && (
                <div style={{ color: '#ff8866', fontSize: 12, marginBottom: 6 }}>
                  No legal targets for this mission right now.
                </div>
              )}
              {isLeaderPick ? (
                <select
                  value={revealTargetLeaderId ? `${revealTargetSysId}|${revealTargetLeaderId}` : ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (!v) { setRevealTargetSysId(null); setRevealTargetLeaderId(null); return; }
                    const [s, l] = v.split('|');
                    setRevealTargetSysId(s);
                    setRevealTargetLeaderId(l);
                  }}
                  disabled={leaderTargets!.length === 0}
                  style={{
                    background: '#0c0d10', color: '#e8e8ea',
                    border: '1px solid #3a3d44', borderRadius: 3, padding: '4px 8px', fontSize: 12,
                    minWidth: 260,
                  }}
                >
                  <option value="">— pick target leader —</option>
                  {leaderTargets!
                    .map((t) => ({
                      ...t,
                      sysName: G.catalog.systems[t.systemId]?.name ?? t.systemId,
                      leaderName: G.catalog.leaders[t.leaderId]?.name ?? t.leaderId,
                    }))
                    .sort((a, b) =>
                      a.sysName.localeCompare(b.sysName) || a.leaderName.localeCompare(b.leaderName))
                    .map((t) => (
                      <option key={`${t.systemId}|${t.leaderId}`} value={`${t.systemId}|${t.leaderId}`}>
                        {t.sysName} — {t.leaderName}
                      </option>
                    ))}
                </select>
              ) : (
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
                    <option key={sysId} value={sysId}>
                      {sysId === 'rebel-base-space' ? 'Rebel Base space' : (G.catalog.systems[sysId]?.name ?? sysId)}
                    </option>
                  ))}
                </select>
              )}
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
            ) : (
            <>
              <div style={{ fontSize: 12, color: '#80dc78', marginBottom: 8 }}>
                This mission resolves with no target — just reveal it.
              </div>
              <button
                className="tab-button active"
                onClick={handleReveal}
                disabled={!revealMissionId}
                style={{ fontWeight: 700 }}
              >
                Reveal mission
              </button>
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
        {(() => {
          // Explain why any no-tactic leaders in the pool aren't offered here.
          // RR (twice): "A leader that does not have tactic values cannot
          // activate a system." They're mission specialists, not commanders —
          // surfacing this stops the "why can't I use them?" confusion (#172).
          const noTactic = f.leaderPool
            .map((lid) => G.catalog.leaders[lid])
            .filter((l): l is NonNullable<typeof l> => !!l && (l.tacticValues.space + l.tacticValues.ground) === 0);
          if (noTactic.length === 0) return null;
          return (
            <div style={{ fontSize: 11, color: '#888', marginTop: 6, fontStyle: 'italic' }}>
              {noTactic.map((l) => l.name).join(', ')} can&apos;t activate a system (no tactic values) —
              use {noTactic.length === 1 ? 'them' : 'these'} for missions instead.
            </div>
          );
        })()}
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
            {/* Rebel can activate the hidden "Rebel Base" space itself to pull
                units IN from the base's system or an adjacent one (rr "Moving to
                or from the Rebel Base"; player request). */}
            {side === 'Rebel' && !G.rebelBaseRevealed && G.rebelBaseSystemId && (
              <option value="rebel-base-space">Rebel Base space (hidden)</option>
            )}
            {Object.keys(G.map.systems).sort().map((sysId) => {
              const sd = G.catalog.systems[sysId];
              return <option key={sysId} value={sysId}>{sd?.name ?? sysId}</option>;
            })}
          </select>
        )}
        {targetSystemId && (
          <span style={{ marginLeft: 8, fontSize: 12, color: '#ffd54a' }}>
            → {targetSystemId === 'rebel-base-space' ? 'Rebel Base space (hidden)' : (G.catalog.systems[targetSystemId]?.name ?? targetSystemId)}
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
              // Live transport summary for this source. Sums capacity provided
              // by SELECTED capacity-ships against capacity needed by SELECTED
              // ground / restriction-icon units. Surfaces the "I have an AC
              // here but didn't include it" pitfall before activation.
              const sel = moveCounts[sysId] ?? {};
              let capProvided = 0, capNeeded = 0, capAvailableUnselected = 0;
              for (const g of byType) {
                const t = G.catalog.unitTypes[g.typeId];
                if (!t) continue;
                const sCount = sel[g.typeId] ?? 0;
                if (t.transport.capacity > 0) {
                  capProvided += t.transport.capacity * sCount;
                  capAvailableUnselected += t.transport.capacity * (g.count - sCount);
                }
                if (t.transport.restriction) capNeeded += sCount;
                if (t.theater === 'ground' && t.class !== 'structure') capNeeded += sCount;
              }
              const short = capNeeded > capProvided;
              return (
                <div key={sysId} style={{ background: '#0c0d10', padding: 6, borderRadius: 3, border: short ? '1px solid #ff6b6b' : '1px solid #2a2d34' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#ccc', fontWeight: 600, flex: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    {/* One-click "grab the whole stack" / clear (reporter MightyFaben). */}
                    <button className="tab-button" style={{ padding: '0 6px', fontSize: 10 }}
                      title="Select every unit in this system"
                      onClick={() => setMoveCounts((m) => ({
                        ...m, [sysId]: Object.fromEntries(byType.map((g) => [g.typeId, g.count])),
                      }))}
                    >all</button>
                    <button className="tab-button" style={{ padding: '0 6px', fontSize: 10 }}
                      title="Deselect all units from this system"
                      onClick={() => setMoveCounts((m) => { const c = { ...m }; delete c[sysId]; return c; })}
                    >none</button>
                  </div>
                  {byType.map((g) => {
                    const cur = moveCounts[sysId]?.[g.typeId] ?? 0;
                    return (
                      <div key={g.typeId} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 2 }}>
                        {/* Fixed-width name (not flex:1) so the +/- stepper sits
                            right next to it instead of being pushed to the far
                            right of a wide panel (reporter: controls were way
                            out on the right, names all the way left). */}
                        <span style={{ width: 132, flex: '0 0 auto', fontSize: 11, color: '#aaa',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {G.catalog.unitTypes[g.typeId]?.name ?? g.typeId}
                        </span>
                        <button className="tab-button" style={{ padding: '0 6px', fontSize: 14 }} onClick={() => bump(sysId, g.typeId, -1, g.count)} disabled={cur <= 0}>−</button>
                        <span style={{ minWidth: 28, textAlign: 'center', fontSize: 12, color: cur > 0 ? '#ffd54a' : '#666' }}>
                          {cur}/{g.count}
                        </span>
                        <button className="tab-button" style={{ padding: '0 6px', fontSize: 14 }} onClick={() => bump(sysId, g.typeId, +1, g.count)} disabled={cur >= g.count}>+</button>
                      </div>
                    );
                  })}
                  {(capNeeded > 0 || capProvided > 0) && (
                    <div style={{
                      marginTop: 6, paddingTop: 4, borderTop: '1px solid #2a2d34',
                      fontSize: 10, color: short ? '#ff6b6b' : '#80dc78',
                      fontWeight: short ? 700 : 400,
                    }}>
                      transport: {capProvided} capacity / {capNeeded} needed
                      {short && capAvailableUnselected > 0 && (
                        <span> — add a capacity ship from this source (+{capAvailableUnselected} available)</span>
                      )}
                      {short && capAvailableUnselected === 0 && (
                        <span> — no capacity ships available; can't bring ground/fighters from here</span>
                      )}
                    </div>
                  )}
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

/** A mission name that floats the full card art on hover (issue #68 — during
 *  Assignment you couldn't see the card, only the name + skill). Falls back to
 *  just the name if the art isn't cached (the rulesText is shown inline too). */
/** Inline text that reveals an enlarged card image on hover. Reused for mission
 *  names, action-card names, etc. The preview uses position:fixed anchored to
 *  the text's on-screen rect (NOT an absolutely-positioned child), so it escapes
 *  maxHeight/overflow:auto scroll boxes that would otherwise clip it. It flips
 *  to the left of the text when there isn't room on the right and clamps
 *  vertically so a tall card never runs off the top/bottom. */
function CardArtHover({ name, image, color, style }: {
  name: string; image?: string; color?: string; style?: React.CSSProperties;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const resolved = image ? getCachedArtUrlSync(image) : null;

  const open = () => {
    const el = spanRef.current;
    if (!el || !resolved) return;
    const r = el.getBoundingClientRect();
    const PREVIEW_W = 252; // 240 img + padding/border
    const spaceRight = window.innerWidth - r.right;
    const left = spaceRight >= PREVIEW_W + 16
      ? r.right + 12
      : Math.max(8, r.left - PREVIEW_W - 12);
    const top = Math.min(Math.max(8, r.top + r.height / 2), window.innerHeight - 360);
    setPos({ left, top });
  };

  return (
    <>
      <span
        ref={spanRef}
        style={{ display: 'inline-block', cursor: resolved ? 'help' : 'default',
          color: color ?? undefined, ...style }}
        onMouseEnter={open}
        onMouseLeave={() => setPos(null)}
      >
        {name}
      </span>
      {pos && resolved && (
        <div style={{
          position: 'fixed', left: pos.left, top: pos.top, transform: 'translateY(-50%)',
          zIndex: 4000, pointerEvents: 'none',
          background: 'rgba(0,0,0,0.94)', border: '1px solid #555', borderRadius: 4,
          padding: 6, boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
        }}>
          <img src={resolved} alt={name} style={{ width: 240, height: 'auto', borderRadius: 4, display: 'block' }} />
        </div>
      )}
    </>
  );
}

/** Mission name in the assignment list: keeps flex:1 so the skill/assign
 *  controls stay right-aligned, with the hover target scoped to the text. */
function MissionNameHover({ name, image, color }: { name: string; image?: string; color?: string }) {
  return (
    <strong style={{ flex: 1, color: color ?? '#e8e8ea' }}>
      <CardArtHover name={name} image={image} />
    </strong>
  );
}

function AssignmentPanel({ G, side, humanSide, onChange }: { G: GameState; side: Side; humanSide: Side; onChange: () => void }) {
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

      {/* Action cards playable during Assignment surface a button right here in
          the on-screen panel. Previously the only "Play action card" button
          lived in the top toolbar, which scrolls off-screen — players saw the
          card's "use the Play action card button" hint but couldn't find the
          button (player report). Now lives below "Already assigned"; see
          renderPlayActionCard. */}

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
                    <MissionNameHover name={card.name} image={card.image} />
                    <span style={{ color: '#888', fontSize: 11 }}>
                      {card.skill} × {card.skillCost}
                    </span>
                    {card.leaderPortrait && (
                      <span
                        title={`This mission pictures ${G.catalog.leaders[card.leaderPortrait]?.name ?? card.leaderPortrait} — assign that leader here for +2 automatic successes.`}
                        style={{ fontSize: 10, color: '#ffb84d', fontWeight: 600,
                          background: 'rgba(80,50,10,0.5)', border: '1px solid #6a4a1a',
                          borderRadius: 3, padding: '0 5px' }}>
                        🖼 {G.catalog.leaders[card.leaderPortrait]?.name ?? card.leaderPortrait} +2
                      </span>
                    )}
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
                  <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <MissionNameHover name={card?.name ?? a.missionId} image={card?.image} color="#80dc78" />
                    <span>← {a.leaderIds.map(lid => G.catalog.leaders[lid]?.name ?? lid).join(', ')}</span>
                    <button
                      onClick={() => {
                        const r = phases.unassignLeader(G, side, a.missionId);
                        if (!r.ok) { alert(`Cannot undo: ${r.reason}`); return; }
                        if (pickerMissionId === a.missionId) { setPickerMissionId(null); setSelectedLeaders([]); }
                        onChange();
                      }}
                      title="Take this assignment back — returns the leader(s) to your pool and the mission to your hand."
                      style={{ marginLeft: 'auto', padding: '1px 6px', fontSize: 10, cursor: 'pointer',
                        background: '#2a2c33', color: '#ddd', border: '1px solid #555', borderRadius: 3 }}
                    >
                      ↩ undo
                    </button>
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
            {(() => {
              // When a mission with a pictured leader is being assigned,
              // highlight that leader in the pool (+2 successes if assigned).
              const picturedLeaderId = pickerMissionId
                ? G.catalog.missions[pickerMissionId]?.leaderPortrait : undefined;
              // #232: also highlight leaders who carry the mission's required
              // skill, so the player can see at a glance who's worth assigning.
              const requiredSkill = pickerMissionId
                ? G.catalog.missions[pickerMissionId]?.skill : undefined;
              const skillValueFor = (leader: typeof G.catalog.leaders[string]) =>
                ((leader.skills as Record<string, number>)?.[requiredSkill as string] ?? 0)
                + ((leader.minorSkills as Record<string, number> | undefined)?.[requiredSkill as string] ?? 0);
              return f.leaderPool.map((lid) => {
              const leader = G.catalog.leaders[lid];
              if (!leader) return null;
              const selectable = pickerMissionId !== null;
              const isSelected = selectedLeaders.includes(lid);
              const isPictured = !!picturedLeaderId && lid === picturedLeaderId;
              const skillValue = requiredSkill ? skillValueFor(leader) : 0;
              // Show the skill highlight only when it isn't already the pictured
              // leader (gold takes precedence) and isn't selected.
              const skillMatch = skillValue > 0 && !isPictured;
              const accent = isSelected ? color : isPictured ? '#ffb84d' : skillMatch ? '#46c8b8' : '#2a2d34';
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
                    border: `${isPictured || skillMatch ? 2 : 1}px solid ${accent}`,
                    boxShadow: !isSelected && isPictured ? '0 0 6px rgba(255,184,77,0.6)'
                      : !isSelected && skillMatch ? '0 0 6px rgba(70,200,184,0.55)' : undefined,
                    borderRadius: 3,
                    cursor: selectable ? 'pointer' : 'default',
                    opacity: selectable ? 1 : 0.5,
                    fontSize: 12,
                  }}
                >
                  <strong>{leader.name}</strong>
                  {isPictured && <span style={{ marginLeft: 4, color: isSelected ? '#000' : '#ffb84d', fontWeight: 700 }}>🖼 +2</span>}
                  {skillMatch && <span style={{ marginLeft: 4, color: isSelected ? '#000' : '#46c8b8', fontWeight: 700 }}>✓{requiredSkill} {skillValue}</span>}
                  <span style={{ marginLeft: 6, color: isSelected ? '#000a' : '#888', fontSize: 10 }}>
                    {Object.entries(leader.skills)
                      .filter(([, v]) => v > 0)
                      .map(([k, v]) => `${k}:${v}`)
                      .join(' ')}
                    {' '}· tactic s{leader.tacticValues.space}/g{leader.tacticValues.ground}
                  </span>
                </button>
              );
              });
            })()}
          </div>

          {pickerMissionId && (() => {
            const card = G.catalog.missions[pickerMissionId];
            const skill = card?.skill;
            const cost = card?.skillCost ?? 0;
            let total = 0;
            if (skill) {
              const sc = phases.totalSkill(G, selectedLeaders as LeaderId[], skill);
              total = sc.major + sc.minor;
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

          {/* Play-an-action-card button, placed under the leader pool where the
              player is looking. The top-toolbar button (still there) scrolls
              off-screen, so players couldn't find it (report). Gated to the
              human's own turn with no pending sub-choice. */}
          {side === humanSide && !G.pendingChoice && (() => {
            const playable = phases.playableAssignmentActionCards(G, side);
            if (playable.length === 0) return null;
            return (
              <div style={{
                marginTop: 12, padding: '8px 10px', background: '#1c1f27',
                borderRadius: 4, border: '1px solid #3a6ea5',
              }}>
                <button
                  className="tab-button"
                  onClick={() => {
                    const r = phases.requestAssignmentActionCardPlay(G, side);
                    if (!r.ok) alert(`Cannot play: ${r.reason}`);
                    onChange();
                  }}
                  style={{ fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  ▶ Play action card ({playable.length})
                </button>
                <div style={{ color: '#9bb8d6', fontSize: 12, marginTop: 6 }}>
                  Playable now:{' '}
                  {playable.map((cid, i) => {
                    const card = G.catalog.actions[cid];
                    return (
                      <span key={cid}>
                        {i > 0 && ', '}
                        <CardArtHover
                          name={card?.name ?? cid}
                          image={card?.image}
                          style={{ color: '#cfe2f5', fontWeight: 700,
                            textDecoration: card?.image ? 'underline dotted' : undefined }}
                        />
                      </span>
                    );
                  })}
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
// Single source of truth shared with the engine's recruit step (issues
// #48/#59) — the tracker badge and the actual recruit can't drift apart.
const RECRUIT_TURNS = phases.RECRUIT_TIME_MARKERS;
// Shared with the engine's build step (was wrongly including turn 16, the
// final space, which has no build icon). Single source of truth.
const BUILD_TURNS = phases.BUILD_TIME_MARKERS;
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
    }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              {/* Turn marker — the table-top token on the current turn cell. */}
              {isCurrent && (
                <img
                  src={vmodAssetUrl('MarkerTurn.png', MARKER_IMAGE_BASE)}
                  alt="" title="Turn marker"
                  style={{ position: 'absolute', top: -7, left: -7, width: 18, height: 18 }}
                />
              )}
              {/* Reputation marker — the table-top token on the reputation cell. */}
              {isReputation && (
                <img
                  src={vmodAssetUrl('MarkerReputation.png', MARKER_IMAGE_BASE)}
                  alt="" title="Reputation marker"
                  style={{ position: 'absolute', top: -7, right: -7, width: 18, height: 18 }}
                />
              )}
            </div>
          );
        })}
      </div>
      <span style={{ fontSize: 11, color: '#888', marginLeft: 8 }}>
        Reputation: <span style={{ color: '#aae0ff', fontWeight: 600 }}>{G.reputationMarker}</span> · <span style={{ color: '#888' }}>R=Recruit, B=Build</span>
      </span>
    </div>
    {/* Rebel objectives scored for reputation (player request: Foggy Leggy). */}
    {(G.rebel.scoredObjectives?.length ?? 0) > 0 && (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 8 }}>
        <span style={{ fontSize: 12, color: '#aaa', minWidth: 70 }}>Scored:</span>
        {(G.rebel.scoredObjectives ?? []).map((s, i) => (
          <span key={i} title={`Scored on turn ${s.turn} · +${s.reputation} reputation`} style={{
            fontSize: 11, background: '#0c1620', border: '1px solid #2a4a5a',
            borderRadius: 3, padding: '1px 6px', color: '#aae0ff',
          }}>
            {G.catalog.objectives[s.objectiveId]?.name ?? s.objectiveId}{' '}
            <span style={{ color: '#7fd6a8', fontWeight: 600 }}>+{s.reputation}</span>
          </span>
        ))}
      </div>
    )}
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
  // The COUNT is public (you can watch the draws / deduce it from the deck);
  // only which systems they name is secret.
  if (!visible) return <>{probeHand.length} card{probeHand.length === 1 ? '' : 's'} held <span style={{ color: '#666' }}>(which systems hidden)</span></>;
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
  // Short text glyph that's always visible. Useful (a) when no image
  // exists for the color/face combo, and (b) when the strict-image deploy
  // strips the die PNG — without text the dice row is invisible.
  const glyph =
    f === 'direct-hit' ? '✕' :
    f === 'hit'        ? '●' :
    f === 'special'    ? '★' :
                         '·';
  const tint =
    color === 'red'   ? '#ff8866' :
    color === 'black' ? '#cccccc' :
                        '#80dc78';
  const textBadge = (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, fontSize: 14, fontWeight: 700, color: tint,
      background: '#0c0d10', border: `1px solid ${tint}`, borderRadius: 3,
      marginRight: 1, verticalAlign: 'middle',
    }} title={`${color} ${face}`}>
      {glyph}
    </span>
  );
  if (!url) return textBadge;
  // Layered: badge (always visible) underneath, real image on top. With
  // real art the image fully covers the badge; with the strict-deploy 1×1
  // transparent placeholder the badge shows through. The image loads OK
  // (no onerror) either way so we can't use a fallback handler.
  return (
    <span style={{ position: 'relative', display: 'inline-block', width: 18, height: 18, marginRight: 1, verticalAlign: 'middle' }}>
      <span style={{
        position: 'absolute', inset: 0, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center',
        fontSize: 12, fontWeight: 700, color: tint,
        background: '#0c0d10', border: `1px solid ${tint}`, borderRadius: 3,
      }} title={`${color} ${face}`}>
        {glyph}
      </span>
      <img src={url} width={18} height={18} alt={`${color} ${face}`} title={`${color} ${face}`}
        style={{ position: 'absolute', inset: 0, imageRendering: 'pixelated' }} />
    </span>
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

/** Log kinds that leak private info to the opposing player. Filtered from
 *  the on-screen log entirely. The disk/file log (uploaded for AI training,
 *  attached to problem reports) still contains them — those audiences need
 *  full information. */
const ONSCREEN_HIDDEN_KINDS = new Set<string>([
  // Combat tactic draws (private tactic hand; mid-combat noise).
  'draw-tactic',
  'objective-draw-only', 'objective-peek',
  // Empire's private project deck operations.
  'project-peek', 'project-draw',
  // Combat tactic draws (private tactic hand).
  'combat-draw-tactics', 'combat-special-draw',
  // Probe operations that would reveal eliminated systems / base location.
  'rapid-mobilization-probe-draw',
  // Interrogation mission reveal of Rebel objective hand.
  'interrogation-reveal',
  // Rebel base initial pick (base location is hidden until reveal).
  'pick-rebel-base',
  // Hand trims (which card discarded is private to the holder).
  'mission-hand-trim',
  // UI noise + would expose candidate lists in payload.
  'choice-request',
  // Internal/debug.
  'not-implemented', 'note', 'state', 'setup-warning',
]);

/** Log kinds where the OCCURRENCE is public (you can tell something
 *  happened) but the PAYLOAD contains private card IDs. Render the kind
 *  without the payload. */
const ONSCREEN_REDACTED_KINDS = new Set<string>([
  // Card-search effects: pulling a specific card from a deck is private.
  'our-most-desperate-hour-applied',
  'proceeding-as-planned-applied',
  'son-of-skywalker-applied',
  'contingency-plan-applied',
  // Empire intel that's private to the Empire (which region the base is in).
  'local-rumors-reveal',
  // Recruit picks reveal the drawn action card / leader.
  'recruit-action-only', 'recruit-leader', 'recruit-pick-resolved',
  // Build queue additions reveal which units were queued (could be private
  // for missions like Establish Trade Relations / Temporary Alliance).
  'establish-trade-relations-built',
  // Probe count and identity in deferred Rapid Mobilization.
  'rapid-mobilization-deferred',
]);

/** Log kinds that are SECRET when they belong to the opponent: leader
 *  assignments are hidden (RAW: simultaneous + face-down) until a mission is
 *  revealed. Your OWN show normally; the opponent's render as "(private)" so
 *  the log can't be used to peek at their plans (player report #90 — follow-up
 *  to the assignment info-leak fix #87). */
const OPPONENT_SECRET_KINDS = new Set<string>(['assign-leader', 'unassign-leader']);

/** Card draws where the NUMBER is public (you can watch the draws / deduce it
 *  from the deck size) but the card identities are private. Show "drew N",
 *  never the payload. (Player point: card-draw counts are public info.) */
const COUNT_ONLY_KINDS = new Set<string>(['draw-action', 'draw-mission', 'draw-objective', 'draw-probe']);

function LogPanel({ G, humanSide }: { G: GameState; humanSide: Side }) {
  // Pre-filter to count what's actually visible (so the header count
  // matches what the player sees).
  const visible = G.turnLog.filter((e) => !ONSCREEN_HIDDEN_KINDS.has(e.kind));
  return (
    <div style={{
      background: '#15171c', borderRadius: 4, padding: 12, marginTop: 12,
      maxHeight: 240, overflowY: 'auto',
    }}>
      <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
        Log ({visible.length} entries shown; {G.turnLog.length - visible.length} private hidden)
      </div>
      <div style={{ fontFamily: 'monospace', fontSize: 11 }}>
        {/* Newest-first: show the most recent 100 entries with the latest at
            the top (player request — easier to see what just happened without
            scrolling to the bottom). */}
        {visible.slice(-100).reverse().map((entry, i) => {
          const redacted = ONSCREEN_REDACTED_KINDS.has(entry.kind)
            || (!!entry.side && entry.side !== humanSide && OPPONENT_SECRET_KINDS.has(entry.kind));
          const countOnly = COUNT_ONLY_KINDS.has(entry.kind);
          const drawCount = countOnly ? ((entry.payload as { count?: number } | undefined)?.count ?? 1) : 0;
          return (
            <div key={i} style={{ color: entry.side ? sideColor(entry.side) : '#aaa', marginBottom: entry.kind === 'mission-roll' ? 6 : 1 }}>
              <span style={{ color: '#666' }}>[t{entry.turn}]</span>{' '}
              {entry.side ? <span style={{ marginRight: 4 }}>{entry.side}</span> : null}
              <span style={{ color: '#fff' }}>{entry.kind}</span>
              {countOnly ? (
                // Number is public; identities are not.
                <span style={{ color: '#888', marginLeft: 4 }}>drew {drawCount} <span style={{ color: '#666', fontStyle: 'italic' }}>(which cards hidden)</span></span>
              ) : redacted ? (
                <span style={{ color: '#666', marginLeft: 4, fontStyle: 'italic' }}>(private)</span>
              ) : entry.kind === 'mission-roll' && entry.payload ? (
                <MissionRollEntry payload={entry.payload as MissionRollPayload} side={entry.side} />
              ) : entry.kind === 'combat-attack' && entry.payload ? (
                <CombatAttackEntry payload={entry.payload as CombatAttackPayload} />
              ) : entry.payload ? (
                <span style={{ color: '#888', marginLeft: 4 }}>{JSON.stringify(entry.payload)}</span>
              ) : null}
            </div>
          );
        })}
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
  // Screenshot arrives asynchronously now (modal opens immediately on click,
  // capture runs in the background with a 5s timeout). Flip the include flag
  // ON when the screenshot lands so users who opened-then-waited get it.
  useEffect(() => {
    if (screenshotBase64) setIncludeScreenshot(true);
  }, [screenshotBase64]);
  const stateCodec = canEncode(G) ? encode(G) : '(state is mid-resolution; codec not safe to capture)';

  // Which side the reporter controlled (and which the AI did). This modal is a
  // sibling component, so humanSide isn't in scope here — read the recorded
  // value straight from localStorage (same source the main game sets it from).
  const humanSide = (() => {
    try { return localStorage.getItem(LS_HUMAN_SIDE) || undefined; } catch { return undefined; }
  })();
  const aiSide = humanSide === 'Rebel' ? 'Empire' : humanSide === 'Empire' ? 'Rebel' : undefined;

  const buildReport = () => ({
    schema: 'rebellion-report-v1',
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    reporterId: getReporterId(),
    description,
    // Recorded so a bug triager never has to infer it from the outcome.
    humanSide,
    aiSide,
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
      const res = await fetch('/api/report', {
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
        padding: 40, zIndex: 8000,
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
          {submitState.status === 'ok' && submitState.issueUrl ? (
            // After a successful submission, collapse the bottom row to a
            // single Close button. The user has nothing further to do here —
            // the issue is filed; the modal should get out of the way.
            <button
              className="tab-button active"
              onClick={onClose}
              autoFocus
              style={{ fontWeight: 700 }}
            >
              Close
            </button>
          ) : (
            <>
              <button className="tab-button" onClick={onClose}>Cancel</button>
              <button className="tab-button" onClick={handleCopy}>Copy to clipboard</button>
              <button
                className="tab-button active"
                onClick={handleReportProblem}
                disabled={submitState.status === 'submitting' || !description.trim()}
              >
                Report a problem
              </button>
            </>
          )}
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

// ============================================================================
// Load VASSAL Art Modal
// ============================================================================
//
// Lets the player upload their own copy of swr.vmod. We unzip it client-side
// and persist every PNG to IndexedDB so the page renders the official art
// without us ever hosting FFG bytes. The Google Drive link in the prompt
// is just a suggested source; players who have their own copy can use that
// instead.

const VASSAL_DRIVE_URL = 'https://drive.google.com/file/d/1KRvMB2MHiXkNgd5wpKTD0O_Jo_s3QHX2/view?usp=sharing';

function LoadArtModal({ G, currentMeta, onClose, onLoaded }: {
  G: GameState;
  currentMeta: { loadedAt: string; fileCount: number; totalBytes: number; vmodFilename?: string } | null;
  onClose: () => void;
  onLoaded: () => void;
}) {
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failureReport, setFailureReport] = useState<{ reason: LoadFailure['reason']; report: LoadReport } | null>(null);
  const [successReport, setSuccessReport] = useState<LoadReport | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Auto-open the diagnostic if there are mismatches — surfaces silent
  // .vmod-version skew without making the player click a button to find
  // out why their art looks half-loaded.
  const [showDiagnosticManual, setShowDiagnosticManual] = useState<boolean | null>(null);
  // Board-image identity: which board file actually resolved (alias-aware),
  // plus its dimensions, byte size, and SHA-256 prefix — so we can confirm
  // exactly which board art the deployed app is showing (d Map.png vs the
  // v1.2e Map-Redux.png). Reference: v1.2e Map-Redux.png = 5.54 MB, sha256
  // 4d3d404754d6a548; v1.02d Map.png = 10.81 MB, sha256 1a1ef9aff451258d.
  const [boardInfo, setBoardInfo] = useState<string>('checking…');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const files = getCachedFilenames();
      const resolved =
        files.find((f) => /map-redux\.png/i.test(f)) ||
        files.find((f) => /(^|\/)map\.png$/i.test(f)) ||
        '(no board in cache — using stripped placeholder)';
      const url = mapImageUrl();
      try {
        const blob = await (await fetch(url)).blob();
        const buf = await blob.arrayBuffer();
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
          .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
        const dims = await new Promise<string>((res) => {
          const im = new Image();
          im.onload = () => res(`${im.naturalWidth}×${im.naturalHeight}`);
          im.onerror = () => res('?×?');
          im.src = url;
        });
        if (!cancelled) setBoardInfo(`${resolved} · ${dims} · ${(blob.size / 1048576).toFixed(2)} MB · sha256 ${hash}`);
      } catch {
        if (!cancelled) setBoardInfo(`${resolved} (couldn't read bytes)`);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Compute expected-filename vs. found diagnostic. The "expected" list
  // covers every image the runtime might ask for:
  //   - Static: map, loyalty markers, dice (10 base-game face combos)
  //   - From UNIT_IMAGE: the 18 base-game unit Unit*.png filenames
  //   - From the engine catalogs (G.catalog): every leader/mission/action/
  //     objective/tactic that has an .image field
  // We resolve each via getCachedArtUrlSync so the same alias + case-
  // insensitive logic the URL helpers use also drives the diagnostic —
  // a name shows up as "missing" only if no alias / case variant fired.
  const diagnostic = (() => {
    if (!currentMeta) return null;
    const allCached = getCachedFilenames();
    const found = new Set(allCached.map((f) => f.toLowerCase()));
    const expected: { kind: string; filename: string; source?: string }[] = [];
    expected.push({ kind: 'map', filename: 'Map.png' });
    for (const name of ['MarkerLoyaltyRebel.png', 'MarkerLoyaltyEmpire.png', 'MarkerLoyaltySubjugated.png', 'MarkerLoyaltyNeutral.png']) {
      expected.push({ kind: 'marker', filename: name });
    }
    // Dice — only the 10 base-game combos. Green hit/special are RoE-only
    // and the engine never asks for them.
    for (const color of ['Red', 'Black']) {
      for (const face of ['Blank', 'Hit', 'Direct', 'Special']) {
        expected.push({ kind: 'dice', filename: `Dice${color}${face}.png` });
      }
    }
    expected.push({ kind: 'dice', filename: 'DiceGreenBlank.png' });
    expected.push({ kind: 'dice', filename: 'DiceGreenDirect.png' });
    for (const name of Object.values(UNIT_IMAGE)) {
      expected.push({ kind: 'unit', filename: name });
    }
    // Catalog-driven: every entry in leaders / missions / actions /
    // objectives / tactics with a non-empty image field.
    const catalogs: { kind: string; items: Record<string, { image?: string; name?: string }> }[] = [
      { kind: 'leader',    items: G.catalog.leaders as never },
      { kind: 'mission',   items: G.catalog.missions as never },
      { kind: 'action',    items: G.catalog.actions as never },
      { kind: 'objective', items: G.catalog.objectives as never },
      { kind: 'tactic',    items: G.catalog.tactics as never },
    ];
    for (const cat of catalogs) {
      for (const [id, item] of Object.entries(cat.items)) {
        if (item && typeof item.image === 'string' && item.image.length > 0) {
          expected.push({ kind: cat.kind, filename: item.image, source: id });
        }
      }
    }
    // Resolve each via the same lookup the runtime uses (case-insensitive
    // + FILENAME_ALIASES). If the function returns a string the file is
    // present (directly or via alias); if undefined/null it's missing.
    const missing = expected.filter((e) => {
      // Direct + case-insensitive shortcut for speed (and to avoid a JS
      // function call per entry); aliases are checked via the runtime path.
      if (found.has(e.filename.toLowerCase())) return false;
      // Slower path: invoke the runtime resolver so aliases fire.
      const cache = (globalThis as { __rebellionArtCache?: { getSync: (f: string) => string | null | undefined } }).__rebellionArtCache;
      const resolved = cache?.getSync(e.filename);
      return typeof resolved !== 'string';
    });
    // Group missing by kind for compact display.
    const missingByKind: Record<string, { filename: string; source?: string }[]> = {};
    for (const m of missing) {
      (missingByKind[m.kind] ??= []).push({ filename: m.filename, source: m.source });
    }
    // SMART HINTS: for each missing-kind, look for cached filenames whose
    // base contains a token from any missing entry (or the kind name itself).
    // This surfaces e.g. all `*objective*` filenames when objectives are
    // missing, instead of the first-12-alphabetical block which usually
    // just shows action cards.
    const hintsByKind: Record<string, string[]> = {};
    for (const kind of Object.keys(missingByKind)) {
      const tokens = new Set<string>([kind.toLowerCase()]);
      for (const m of missingByKind[kind]) {
        // Use the source id and the bare filename (minus extension) as
        // token seeds; split on dashes/underscores.
        const seeds = [m.source ?? '', m.filename.replace(/\.[^.]+$/, '')];
        for (const s of seeds) {
          for (const t of s.toLowerCase().split(/[-_\s]+/)) {
            if (t.length >= 4) tokens.add(t);
          }
        }
      }
      const hits = [...found].filter((f) => {
        for (const t of tokens) if (f.includes(t)) return true;
        return false;
      }).sort();
      hintsByKind[kind] = hits.slice(0, 40);
    }
    return {
      foundCount: found.size,
      expectedCount: expected.length,
      missing,
      missingByKind,
      sampleFound: [...found].slice(0, 12).sort(),
      hintsByKind,
      allFilenames: [...found].sort(),
    };
  })();

  const handleFile = async (file: File) => {
    setError(null);
    setFailureReport(null);
    setSuccessReport(null);
    setProgress({ phase: 'reading' });
    try {
      const { report } = await loadVmodFromFile(file, setProgress);
      await preloadAllBlobUrls();
      notifyArtChanged();
      setSuccessReport(report);
      onLoaded();
      // Don't auto-close on success — let the player see the load report
      // (especially if any catalog gaps came back via the diagnostic).
    } catch (e) {
      if (e instanceof LoadFailure) {
        setError(e.message);
        setFailureReport({ reason: e.reason, report: e.report });
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      setProgress(null);
    }
  };

  const handleClear = async () => {
    if (!confirm('Clear all cached VASSAL art? You\'ll need to re-upload swr.vmod to restore it.')) return;
    await clearVmodCache();
    notifyArtChanged();
    onLoaded();
    onClose();
  };

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 5000,
  };
  const panel: React.CSSProperties = {
    width: 600, maxWidth: '92vw', background: '#15171c',
    border: '2px solid #4a5060', borderRadius: 6, padding: 0,
    color: '#e8e8ea', boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
    // Cap height to the viewport and let the body scroll internally, so the
    // modal never runs off-screen (the header + footer stay pinned). Was a
    // fixed-padding box with no height cap → tall content overflowed and the
    // player had to zoom out to reach the close button (user report).
    maxHeight: '90vh', display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  };
  // Header stays pinned at the top; body scrolls.
  const headerRow: React.CSSProperties = {
    display: 'flex', alignItems: 'baseline',
    padding: '16px 20px 12px', flexShrink: 0,
    borderBottom: '1px solid #2a2d34',
  };
  const bodyScroll: React.CSSProperties = {
    padding: '16px 20px 20px', overflowY: 'auto', flex: 1,
  };

  const percent = progress?.total && progress.current
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={panel}>
        <div style={headerRow}>
          <h2 style={{ margin: 0, color: '#ffd54a', fontSize: 18 }}>Load VASSAL Art</h2>
          <button onClick={onClose} style={{
            marginLeft: 'auto', background: 'transparent', color: '#888',
            border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1,
          }}>×</button>
        </div>

        <div style={bodyScroll}>
          {/* Board-image identity — confirms exactly which board art is live.
           *  v1.2e (correct): "Map-Redux.png · 3180×1590 · 5.54 MB · sha256
           *  4d3d404754d6a548". v1.02d (old): "Map.png · ... · 10.81 MB ·
           *  sha256 1a1ef9aff451258d". */}
          <div style={{
            fontSize: 11, color: '#9fb3d9', background: '#0c0d10',
            border: '1px solid #2a2d34', borderRadius: 4, padding: '6px 8px',
            marginBottom: 12, fontFamily: 'monospace', wordBreak: 'break-all',
          }}>
            <span style={{ color: '#80dc78' }}>Loaded board image:</span> {boardInfo}
          </div>
        <div style={{ fontSize: 13, color: '#ccc', lineHeight: 1.5, marginBottom: 14 }}>
          This game uses art from the official VASSAL <strong>Star Wars: Rebellion</strong> module.
          We don't host the art — you bring your own copy. It's stored in your browser
          (IndexedDB) and persists across sessions until you clear it.
        </div>

        <div style={{
          padding: 10, background: '#0c0d10', borderRadius: 4,
          border: '1px solid #2a2d34', fontSize: 12, marginBottom: 14, lineHeight: 1.5,
        }}>
          <strong style={{ color: '#80dc78' }}>How to get swr.vmod:</strong>
          <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
            <li>
              Download from{' '}
              <a href={VASSAL_DRIVE_URL} target="_blank" rel="noopener noreferrer"
                style={{ color: '#4fc3f7', fontWeight: 700 }}>this Google Drive link</a>.
              {' '}
              <span style={{ color: '#888', fontSize: 11 }}>
                (The module isn't currently listed on the official Vassal library, so the Drive link is the most reliable source.
                There's also a copy linked from the BGG Play-by-Forum thread.)
              </span>
            </li>
            <li>Drag the .vmod file into the box below, or click to pick it.</li>
          </ol>
        </div>

        {currentMeta && (
          <div style={{
            padding: 10, background: '#0d2014', borderRadius: 4,
            border: '1px solid #2a5028', fontSize: 12, marginBottom: 14,
          }}>
            <div style={{ color: '#80dc78', fontWeight: 600, marginBottom: 4 }}>
              ✓ Art currently loaded
            </div>
            <div style={{ color: '#aaa' }}>
              {currentMeta.vmodFilename ?? '(.vmod)'} — {currentMeta.fileCount} files,{' '}
              {(currentMeta.totalBytes / (1024 * 1024)).toFixed(1)} MB
              · {new Date(currentMeta.loadedAt).toLocaleString()}
            </div>
            <button onClick={handleClear} style={{
              marginTop: 8, background: '#2a1414', color: '#ff8866',
              border: '1px solid #5a2a2a', padding: '4px 10px', borderRadius: 3,
              cursor: 'pointer', fontSize: 11,
            }}>
              Clear cached art
            </button>
            <button onClick={() => setShowDiagnosticManual((s) => !(s ?? (diagnostic && diagnostic.missing.length > 0)))} style={{
              marginTop: 8, marginLeft: 6, background: '#0c0d10', color: '#aaa',
              border: '1px solid #3a3d44', padding: '4px 10px', borderRadius: 3,
              cursor: 'pointer', fontSize: 11,
            }}>
              {(showDiagnosticManual ?? (!!successReport || !!(diagnostic && diagnostic.missing.length > 0))) ? 'Hide diagnostic' : 'Diagnostic'}
            </button>
            {(showDiagnosticManual ?? (!!successReport || !!(diagnostic && diagnostic.missing.length > 0))) && diagnostic && (
              <div style={{
                marginTop: 8, padding: 8, background: '#0c0d10',
                border: '1px solid #2a2d34', borderRadius: 3,
                fontSize: 11, color: '#aaa', fontFamily: 'monospace', lineHeight: 1.4,
              }}>
                <div style={{ color: '#ffd54a', marginBottom: 4 }}>
                  {diagnostic.foundCount} files in cache · {diagnostic.expectedCount} expected (map+markers+dice+units)
                </div>
                {diagnostic.missing.length === 0 ? (
                  <div style={{ color: '#80dc78' }}>
                    ✓ All {diagnostic.expectedCount} expected filenames matched (direct, case-insensitive, or via alias).
                  </div>
                ) : (
                  <div>
                    <div style={{ color: '#ff8866', marginBottom: 6 }}>
                      ✗ {diagnostic.missing.length} of {diagnostic.expectedCount} expected filename{diagnostic.missing.length === 1 ? '' : 's'} not found:
                    </div>
                    {Object.entries(diagnostic.missingByKind).sort().map(([kind, items]) => (
                      <div key={kind} style={{ marginBottom: 6 }}>
                        <div style={{ color: '#ffd54a', fontWeight: 700, marginLeft: 4 }}>
                          {kind} ({items.length})
                        </div>
                        {items.map((m, i) => (
                          <div key={i} style={{ marginLeft: 16, color: '#ccc' }}>
                            {m.filename}{m.source ? <span style={{ color: '#666' }}> — {m.source}</span> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                    {diagnostic.hintsByKind && Object.entries(diagnostic.hintsByKind).map(([kind, hits]) => (
                      <div key={kind} style={{ marginTop: 8 }}>
                        <div style={{ color: '#888' }}>
                          Possible {kind} matches in your .vmod ({hits.length}):
                        </div>
                        {hits.length === 0 ? (
                          <div style={{ marginLeft: 8, color: '#888', fontStyle: 'italic' }}>
                            (no filenames in cache contain related tokens — art may be missing from this .vmod version)
                          </div>
                        ) : hits.map((f, i) => (
                          <div key={i} style={{ marginLeft: 8, color: '#aae0ff' }}>{f}</div>
                        ))}
                      </div>
                    ))}
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ color: '#888', cursor: 'pointer' }}>
                        Show all {diagnostic.allFilenames?.length ?? 0} cached filenames
                      </summary>
                      <div style={{ marginTop: 6, maxHeight: 240, overflowY: 'auto', background: '#000', padding: 6, borderRadius: 4 }}>
                        {diagnostic.allFilenames?.map((f, i) => (
                          <div key={i} style={{ color: '#aae0ff' }}>{f}</div>
                        ))}
                      </div>
                    </details>
                    <div style={{ color: '#888', marginTop: 6 }}>
                      If you recognize any of the missing files under a different name
                      here, paste this whole block into a GitHub issue and we'll add
                      the alias.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) handleFile(file);
          }}
          style={{
            display: 'block', padding: 30, textAlign: 'center',
            background: dragOver ? '#1a2030' : '#0c0d10',
            border: `2px dashed ${dragOver ? '#4fc3f7' : '#3a3d44'}`,
            borderRadius: 6, cursor: progress ? 'wait' : 'pointer',
            opacity: progress ? 0.6 : 1, marginBottom: 12,
          }}
        >
          <input
            type="file"
            accept=".vmod,.zip,application/zip"
            style={{ display: 'none' }}
            disabled={!!progress}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <div style={{ fontSize: 14, color: '#ccc' }}>
            {dragOver ? 'Drop swr.vmod here' : 'Drag swr.vmod here, or click to choose'}
          </div>
          <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
            (.vmod is a renamed .zip — we extract images/ in-browser)
          </div>
        </label>

        {progress && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: '#aaa', marginBottom: 4 }}>
              {progress.phase === 'reading' && 'Reading file…'}
              {progress.phase === 'unzipping' && 'Unzipping…'}
              {progress.phase === 'storing' && (
                <>Storing image {progress.current}/{progress.total}: <span style={{ color: '#fff' }}>{progress.filename}</span></>
              )}
              {progress.phase === 'done' && (
                <span style={{ color: '#80dc78' }}>✓ Done — {progress.total} images cached</span>
              )}
            </div>
            <div style={{ width: '100%', height: 6, background: '#0c0d10', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${percent}%`, height: '100%', background: '#4fc3f7', transition: 'width 0.15s' }} />
            </div>
          </div>
        )}

        {error && !failureReport && (
          <div style={{
            padding: 10, background: '#2a1414', borderRadius: 4,
            border: '1px solid #5a2a2a', color: '#ff8866', fontSize: 12, marginBottom: 12,
          }}>
            ✗ {error}
          </div>
        )}

        {failureReport && (
          <div style={{
            padding: 12, background: '#2a1414', borderRadius: 4,
            border: '1px solid #5a2a2a', color: '#ffccbb', fontSize: 12, marginBottom: 12,
            lineHeight: 1.5,
          }}>
            <div style={{ color: '#ff8866', fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
              ✗ Load failed — {failureReport.reason.replace(/-/g, ' ')}
            </div>
            <div style={{ marginBottom: 8 }}>{error}</div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#ccc', background: '#0c0d10', padding: 8, borderRadius: 3, border: '1px solid #3a2222' }}>
              <div><strong>file:</strong> {failureReport.report.inputFilename} ({(failureReport.report.inputSizeBytes / 1024 / 1024).toFixed(2)} MB)</div>
              <div><strong>parsed as ZIP:</strong> {failureReport.report.parsedAsZip ? 'yes' : 'no'}</div>
              <div><strong>top-level entries:</strong> {failureReport.report.topLevelEntryCount} ({failureReport.report.topLevelPngCount} PNG, {failureReport.report.nestedArchiveNames.length} archive)</div>
              {failureReport.report.topLevelSample.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <strong>sample of what's in the file:</strong>
                  <ul style={{ margin: '2px 0 2px 18px', padding: 0 }}>
                    {failureReport.report.topLevelSample.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                    {failureReport.report.topLevelEntryCount > failureReport.report.topLevelSample.length && (
                      <li style={{ color: '#888' }}>… and {failureReport.report.topLevelEntryCount - failureReport.report.topLevelSample.length} more</li>
                    )}
                  </ul>
                </div>
              )}
              {failureReport.report.nestedArchiveNames.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <strong>nested archives found:</strong>
                  <ul style={{ margin: '2px 0 2px 18px', padding: 0 }}>
                    {failureReport.report.nestedArchiveNames.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              )}
              {failureReport.report.recursedInto && (
                <div><strong>recursed into:</strong> {failureReport.report.recursedInto}</div>
              )}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#aaa' }}>
              If this looks unexpected, copy this block into a GitHub issue and I'll add support.
            </div>
          </div>
        )}

        {successReport && !error && (
          <div style={{
            padding: 12, background: '#0d2014', borderRadius: 4,
            border: '1px solid #2a5028', color: '#cce0cc', fontSize: 12, marginBottom: 12,
            lineHeight: 1.5,
          }}>
            <div style={{ color: '#80dc78', fontWeight: 700, marginBottom: 6, fontSize: 13 }}>
              ✓ Load complete
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#ccc', background: '#0c0d10', padding: 8, borderRadius: 3, border: '1px solid #224422' }}>
              <div><strong>file:</strong> {successReport.inputFilename} ({(successReport.inputSizeBytes / 1024 / 1024).toFixed(2)} MB)</div>
              <div><strong>top-level entries:</strong> {successReport.topLevelEntryCount} ({successReport.topLevelPngCount} PNG, {successReport.nestedArchiveNames.length} archive)</div>
              {successReport.recursedInto && (
                <div><strong>recursed into:</strong> {successReport.recursedInto}</div>
              )}
              <div><strong>final PNG count:</strong> {successReport.finalPngCount}</div>
              <div><strong>total stored:</strong> {(successReport.totalStoredBytes / 1024 / 1024).toFixed(1)} MB</div>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#aaa' }}>
              Check the catalog-coverage diagnostic above to see if any expected filenames are missing.
              Close this modal to see the art on the play board.
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
          Don't want to upload? You can play text-only — flip the <strong>images: off</strong> toggle
          in the play header. Unit abbreviations, dice glyphs, and system summary lines carry
          the UI without art.
        </div>
        </div>
      </div>
    </div>
  );
}

function UploadLogsDialog({ onClose }: { onClose: () => void }) {
  // Games we've already uploaded (by their unique encodedAt) — so we never
  // re-send them and the player isn't told a pile of logs were "redundant"
  // (player report #125).
  const uploadedIds = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(LS_UPLOADED) || '[]') as string[]); }
    catch { return new Set<string>(); }
  })();
  // Read archived games out of localStorage; only offer the ones not yet sent.
  const allGames = (() => {
    try {
      const raw = localStorage.getItem(LS_HISTORY);
      return raw ? (JSON.parse(raw) as Array<{ encodedAt: string; winner?: string; winReason?: string; codec: string; humanSide?: string }>) : [];
    } catch { return []; }
  })();
  const games = allGames.filter((g) => !uploadedIds.has(g.encodedAt));
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
    setConfirmed(true);
    setStatus({ kind: 'uploading' });
    const payload = {
      games: [
        ...games.map((g) => ({
          encodedAt: g.encodedAt,
          winner: g.winner,
          winReason: g.winReason,
          humanSide: g.humanSide,
          codec: g.codec,
          source: 'browser-game-archive',
        })),
        ...(inProgressCodec ? [{
          encodedAt: new Date().toISOString(),
          inProgress: true,
          humanSide: (() => { try { return localStorage.getItem(LS_HUMAN_SIDE) || undefined; } catch { return undefined; } })(),
          codec: inProgressCodec,
          source: 'browser-in-progress',
        }] : []),
      ],
    };
    try {
      const res = await fetch('/api/upload-logs', {
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
      // Remember every completed game we just sent so we don't offer it again.
      try {
        const next = new Set(uploadedIds);
        for (const g of games) next.add(g.encodedAt);
        localStorage.setItem(LS_UPLOADED, JSON.stringify([...next]));
      } catch { /* ignore */ }
    } catch (e) {
      setStatus({ kind: 'error', message: String(e) });
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
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
              a <b>public</b> GitHub repo. <b style={{ color: '#ffd54a' }}>
                These logs will be readable by anyone on the internet — including
                AI researchers and game developers who may use them to train and
                improve the game's AI opponent.
              </b>
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
            Thanks! Uploaded <b>{status.uploaded}</b> new game{status.uploaded === 1 ? '' : 's'}.
            {status.deduped > 0 && <span style={{ color: '#aab' }}> ({status.deduped} already on file, skipped.)</span>}
            {status.failed > 0 && <span style={{ color: '#ff8a80' }}> {status.failed} couldn't be saved.</span>}
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

// ----- Assignment-timed action card play (#99) -----

function PlayAssignmentActionCardModal({
  G, choice, onPick, onCancel,
}: {
  G: GameState;
  choice: { kind: 'PlayAssignmentActionCard'; side: Side; candidates: string[] };
  onPick: (cardId: string) => void;
  onCancel: () => void;
}) {
  const color = sideColor(choice.side);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 720, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>Play an action card — Assignment phase</h3>
        <div style={{ color: '#aaa', fontSize: 13, marginBottom: 10 }}>
          Pick one to play. Its leader is placed on the named space and the
          card's effect resolves immediately. Cancel to assign a mission instead.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.candidates.map((cid) => {
            const card = G.catalog.actions[cid];
            if (!card) return null;
            const reqLeader = (card.leaderRequirement ?? [])[0];
            const leaderName = reqLeader ? G.catalog.leaders[reqLeader]?.name ?? reqLeader : '(none)';
            return (
              <button
                key={cid}
                className="tab-button"
                onClick={() => onPick(cid)}
                style={{ textAlign: 'left', padding: '8px 10px' }}
              >
                <div style={{ fontWeight: 700, color: '#fff' }}>{card.name}</div>
                <div style={{ fontSize: 11, color: '#aaa' }}>Leader: {leaderName}</div>
                <div style={{ fontSize: 11, color: '#ccc', marginTop: 4, fontStyle: 'italic' }}>{card.rulesText}</div>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="tab-button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ArmCardProbePickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'ArmCardProbePick'; side: Side; cardId: string; candidates: string[] };
  onPick: (probeId: string) => void;
}) {
  const card = G.catalog.actions[choice.cardId];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 600, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>
          {card?.name ?? choice.cardId} — pick a facedown probe
        </h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          The chosen probe's system is the committed target. The card stays
          facedown until its reveal trigger fires (start of your next Command
          turn for Secret Facility; end of Command phase for Sweep the Area).
          Rebels won't see which system you picked.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((pid) => {
            const p = G.catalog.probes[pid];
            return (
              <button key={pid} className="tab-button" onClick={() => onPick(pid)} style={{ textAlign: 'left' }}>
                Commit to {p?.systemName ?? pid}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PlayImmediateActionCardModal({
  G, choice, onPick, onCancel,
}: {
  G: GameState;
  choice: { kind: 'PlayImmediateActionCard'; side: Side; candidates: string[] };
  onPick: (cardId: string) => void;
  onCancel: () => void;
}) {
  const color = sideColor(choice.side);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 720, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>Play an Immediate action card</h3>
        <div style={{ color: '#aaa', fontSize: 13, marginBottom: 10 }}>
          Pick one to play. Its effect resolves immediately and the card discards.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.candidates.map((cid) => {
            const card = G.catalog.actions[cid];
            if (!card) return null;
            const reqs = (card.leaderRequirement ?? [])
              .map((lid) => G.catalog.leaders[lid]?.name ?? lid).join(' / ');
            return (
              <button
                key={cid}
                className="tab-button"
                onClick={() => onPick(cid)}
                style={{ textAlign: 'left', padding: '8px 10px' }}
              >
                <div style={{ fontWeight: 700, color: '#fff' }}>{card.name}</div>
                <div style={{ fontSize: 11, color: '#aaa' }}>Requires: {reqs || '(none)'}</div>
                <div style={{ fontSize: 11, color: '#ccc', marginTop: 4, fontStyle: 'italic' }}>{card.rulesText}</div>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="tab-button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/** Attach a droid ring (R2-D2 / C-3PO) to a Rebel leader. The ring's discard
 *  effect later triggers only in the system where this leader is, so the modal
 *  shows each candidate's current location to inform the choice. */
function AttachRingPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'AttachRingPick'; side: Side; cardId: string; ringId: 'r2d2' | 'c3po' | 'k2so'; candidates: string[] };
  onPick: (leaderId: string) => void;
}) {
  const color = sideColor(choice.side);
  const card = G.catalog.actions[choice.cardId];
  // Where is each leader right now? (system name, or pool / on-mission)
  const locationOf = (lid: string): string => {
    for (const [sid, list] of Object.entries(G.rebel.leadersOnBoard)) {
      if (list.includes(lid)) {
        return sid === 'rebel-base-space' ? 'at the Rebel Base' : `at ${G.catalog.systems[sid]?.name ?? sid}`;
      }
    }
    for (const am of G.rebel.leadersOnMissions) {
      if (am.leaderIds.includes(lid)) {
        const m = G.catalog.missions[am.missionId];
        return `on a mission (${m?.name ?? am.missionId})`;
      }
    }
    return 'in your leader pool';
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>{card?.name ?? choice.cardId} — attach the ring to a leader</h3>
        <div style={{ color: '#ccc', fontSize: 13, marginBottom: 6, fontStyle: 'italic' }}>{card?.rulesText}</div>
        <div style={{ color: '#9bb8d6', fontSize: 12, marginBottom: 12 }}>
          The ring stays with this leader. Its discard ability only works in the
          system where this leader is — so pick someone you expect to be where
          the action is.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
          {choice.candidates.map((lid) => {
            const ld = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700 }}>{ld?.name ?? lid}</div>
                <div style={{ fontSize: 11, color: '#888' }}>{locationOf(lid)}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** A reference key of every unit type: picture, name, tier shape, theater.
 *  Players asked for a way to look up "which unit is the orange circle?"
 *  (reporter MightyFaben). */
// ============================================================================
// Dice key — what every die face means in combat vs on missions, with odds.
// Mirrors the RNG face tables in src/engine/rng.ts (keep in sync). Feature
// request: MightyFaben ("a key like the unit key ... to calculate odds").
// ============================================================================

function DiceKeyModal({ onClose }: { onClose: () => void }) {
  // Faces per die, matching RED_FACES / BLACK_FACES / GREEN_FACES in rng.ts exactly.
  const dice: { color: 'red' | 'black' | 'green'; faces: { face: string; n: number }[] }[] = [
    { color: 'red',   faces: [{ face: 'hit', n: 2 }, { face: 'direct-hit', n: 1 }, { face: 'special', n: 1 }, { face: 'blank', n: 2 }] },
    { color: 'black', faces: [{ face: 'hit', n: 2 }, { face: 'direct-hit', n: 1 }, { face: 'special', n: 1 }, { face: 'blank', n: 2 }] },
    { color: 'green', faces: [{ face: 'direct-hit', n: 2 }, { face: 'blank', n: 4 }] },
  ];
  const dieLabel = (c: 'red' | 'black' | 'green') => c === 'red' ? 'Red die' : c === 'black' ? 'Black die' : 'Green die (Rise of the Empire)';
  const dieColor = (c: 'red' | 'black' | 'green') => c === 'red' ? '#ff8866' : c === 'green' ? '#7ed957' : '#ccc';
  const Cell = ({ children, color }: { children: React.ReactNode; color?: string }) => (
    <td style={{ padding: '4px 8px', borderBottom: '1px solid #2a2d34', color: color ?? '#cbc4b0', verticalAlign: 'top' }}>{children}</td>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#15171c', border: '2px solid #5a6b8c', borderRadius: 8,
        padding: 22, maxWidth: 640, width: '94%', maxHeight: '88vh', overflowY: 'auto',
        color: '#fff', boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12 }}>
          <h3 style={{ margin: 0, color: '#9fb3d9' }}>🎲 Dice key</h3>
          <span style={{ color: '#888', fontSize: 12 }}>what each face does, and the odds</span>
          <button className="tab-button" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>

        <div style={{ fontSize: 13, color: '#cbc4b0', marginBottom: 10 }}>
          Units roll a number of <b style={{ color: '#ff8866' }}>red</b> and/or{' '}
          <b style={{ color: '#ccc' }}>black</b> dice equal to their attack values; on a mission you
          roll one die per matching skill icon. Rise of the Empire adds a{' '}
          <b style={{ color: '#7ed957' }}>green</b> die — rolled by some expansion units and by
          leaders' minor skill icons on missions (max 3 green per roll). Each die has 6 faces:
        </div>

        {dice.map((d) => (
          <div key={d.color} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: dieColor(d.color), marginBottom: 4 }}>
              {dieLabel(d.color)} (6 faces)
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {d.faces.flatMap((fc) =>
                Array.from({ length: fc.n }, (_, i) => (
                  <span key={`${fc.face}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <DieFaceImg face={fc.face} color={d.color} />
                  </span>
                ))
              )}
              <span style={{ color: '#888', fontSize: 12, marginLeft: 6 }}>
                {d.faces.map((fc) => `${fc.n}× ${fc.face}`).join(', ')}
              </span>
            </div>
          </div>
        ))}

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
          <thead>
            <tr style={{ color: '#9fb3d9', textAlign: 'left' }}>
              <th style={{ padding: '4px 8px' }}>Face</th>
              <th style={{ padding: '4px 8px' }}>In combat</th>
              <th style={{ padding: '4px 8px' }}>On a mission</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Cell color="#fff"><DieFaceImg face="hit" color="black" /> Hit</Cell>
              <Cell>1 damage — can be blocked, and must be assigned to a unit of the matching die colour.</Cell>
              <Cell>1 success.</Cell>
            </tr>
            <tr>
              <Cell color="#fff"><DieFaceImg face="direct-hit" color="red" /> Direct hit</Cell>
              <Cell>1 damage that <b>ignores blocks</b> and can be assigned to <b>any</b> unit (any colour). Only on red and green dice.</Cell>
              <Cell>1 success (same as a hit).</Cell>
            </tr>
            <tr>
              <Cell color="#fff"><DieFaceImg face="special" color="black" /> Special</Cell>
              <Cell>No damage by itself — it fuels special abilities (tactic cards and special-die spend actions like rerolls or extra damage).</Cell>
              <Cell><b>2 successes</b> — the most valuable mission face.</Cell>
            </tr>
            <tr>
              <Cell color="#fff"><DieFaceImg face="blank" color="black" /> Blank</Cell>
              <Cell>Nothing.</Cell>
              <Cell>0 successes.</Cell>
            </tr>
          </tbody>
        </table>

        <div style={{ fontSize: 12, color: '#9a937f', marginTop: 12, lineHeight: 1.5 }}>
          <b>Quick odds.</b> In combat, red and black deal damage on <b>3 of 6 faces</b> (½): the red die's
          come as 2 hits + 1 direct hit, the black die's as 3 hits. Red is better on attack because its
          direct hit can't be blocked and ignores colour matching; black's damage is all blockable. The
          green die is weaker — it damages on just <b>2 of 6 faces</b> (1 hit + 1 direct hit).
          For <b>missions</b>, red and black average <b>5/6 of a success</b> per die (the special's double-count
          balances black's extra hit); the green die averages <b>4/6</b>. A mission rolls at most
          5 red + 5 black + 3 green dice.
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Tactic key — every tactic card (space + ground) plus how the decks work.
// Feature request: MightyFaben ("have a look at all available tactic cards"
// and "do you keep them between rounds?"). RAW summary verified against the
// Rules Reference "Tactic Cards" + "Combat" entries.
// ============================================================================

function TacticKeyModal({ G, onClose }: { G: GameState; onClose: () => void }) {
  const all = Object.values(G.catalog.tactics);
  const space = all.filter((t) => t.theater === 'space');
  const ground = all.filter((t) => t.theater === 'ground');
  const Group = ({ title, cards, accent }: { title: string; cards: typeof all; accent: string }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, color: accent, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cards.map((t) => (
          <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline',
            borderLeft: `3px solid ${accent}`, paddingLeft: 8 }}>
            <div style={{ minWidth: 150, fontWeight: 600, color: '#fff', fontSize: 12 }}>
              {t.name}
              {t.requiresSpecial && <span title="Requires spending a special (★) die" style={{ color: '#ffd54a' }}> ★</span>}
            </div>
            <div style={{ fontSize: 12, color: '#cbc4b0' }}>{t.rulesText}</div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#15171c', border: '2px solid #8c7a5a', borderRadius: 8,
        padding: 22, maxWidth: 720, width: '94%', maxHeight: '88vh', overflowY: 'auto',
        color: '#fff', boxShadow: '0 8px 32px rgba(0,0,0,0.8)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, color: '#d9c79f' }}>🃏 Tactic cards</h3>
          <span style={{ color: '#888', fontSize: 12 }}>every card + how the decks work</span>
          <button className="tab-button" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>
        <div style={{ fontSize: 12.5, color: '#cbc4b0', marginBottom: 12, lineHeight: 1.5,
          background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4, padding: 10 }}>
          <b>How tactic cards work.</b> At the <b>start of each combat</b> you draw cards equal to your
          leader's tactic value — space cards for the space battle, ground cards for the ground battle
          (only if both sides have units in that theater). During an attack you can spend a die showing
          a <b>special (★)</b> to either draw another tactic card or play one that needs a ★. Cards aren't
          revealed to your opponent until played. <b>At the end of every combat, both players discard
          their whole hand and ALL tactic cards are shuffled back into the decks</b> — so you never keep
          cards between combats. The only reason to hold a card is for a later round of the <i>same</i>{' '}
          fight; there's no point hoarding one for next time.
        </div>
        <Group title="Space tactic cards" cards={space} accent="#7fb0ff" />
        <Group title="Ground tactic cards" cards={ground} accent="#ffb060" />
        <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
          ★ = costs a special (★) die to play.
        </div>
      </div>
    </div>
  );
}

/** Combat attack as a compact string showing only the dice colors that are
 *  non-zero (e.g. "2G" for an Interdictor, "1R+1B" for a Corvette, "0" for a
 *  Transport). Cleaner than always printing 0R+0B (idea from contributor PR
 *  #211, by wizard770 / Jiho Ahn). */
function unitAttackText(t: { attack: { red: number; black: number; green: number } }): string {
  const parts: string[] = [];
  if (t.attack.red > 0) parts.push(`${t.attack.red}R`);
  if (t.attack.black > 0) parts.push(`${t.attack.black}B`);
  if (t.attack.green > 0) parts.push(`${t.attack.green}G`);
  return parts.length > 0 ? parts.join('+') : '0';
}

/** Special-unit ability descriptions for the unit key (player request #210).
 *  Text condensed from the rules reference / faction sheets / RoE rulebook. */
const UNIT_ABILITY_TEXT: Record<string, string> = {
  'shield-generator': 'Structure (immobile). At the start of each ground battle step, draw 1 ground tactic card.',
  'ion-cannon': 'Structure (immobile). During each space battle step, your opponent rolls 2 fewer red dice.',
  'golan-arms-turret': 'Structure (immobile). Unlike other structures it actively fights in ground combat (green dice) and is not destroyed just for being your only ground unit left.',
  'interdictor': 'Rebel units cannot retreat from a system containing an Interdictor (and Rebel retreat abilities are blocked there). Applies until all Interdictors in the system are destroyed.',
  'shield-bunker': 'Death Stars and the DSUC cannot be damaged or destroyed (even by Death Star Plans) while sharing a system with a Shield Bunker. Also enables flexible deployment to Imperial-held / remote systems. Applies until all Shield Bunkers in the system are destroyed.',
  'death-star': 'Space station, not a ship. No health and cannot be dealt damage — only the Death Star Plans objective can destroy it. Can destroy a whole system; if it destroys the Rebel base system, the Empire wins immediately.',
  'death-star-under-construction': 'Immobile space station. A deployed Death Star replaces it in its system. If the DSUC is destroyed, the Death Star on the build queue is destroyed too.',
};

function UnitKeyModal({ G, unitStyle, onClose }: {
  G: GameState; unitStyle: UnitImageStyle; onClose: () => void;
}) {
  const shapeGlyph = (tier?: string) => tier === 'triangle' ? '▲' : tier === 'circle' ? '●' : '■';
  const all = Object.values(G.catalog.unitTypes);
  const renderSide = (side: Side) => {
    // Hide RoE-tagged units in a base game (only show them when the expansion
    // is enabled) — see player report #152.
    const units = all.filter((t) => t.side === side && (t.set !== 'rote' || G.expansion?.enabled === true));
    return (
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ color: sideColor(side), fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{side}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {units.map((t) => {
            const img = unitImageUrl(t.id, UNIT_IMAGE_BASE, unitStyle);
            return (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                padding: '3px 4px', background: '#0c0d10', borderRadius: 3 }}>
                <div style={{ width: 30, height: 30, flex: '0 0 auto', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {img ? <img src={img} alt={t.name} draggable={false}
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }} /> : '—'}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: '#e8e8ea', fontWeight: 600 }}>{t.name}</div>
                  <div style={{ fontSize: 10, color: '#9aa3ad' }}>
                    {shapeGlyph(t.tier)} {t.tier ?? '?'} · {t.theater}
                    {' · '}HP {t.health.value}{t.health.color ? ` (${t.health.color})` : ''}
                    {' · atk '}{unitAttackText(t)}
                    {/* Carry capacity / needs-a-lift (player request — MightyFaben). */}
                    {t.transport.capacity > 0 && ` · carries ${t.transport.capacity}`}
                    {t.transport.restriction && ' · needs a lift'}
                  </div>
                  {UNIT_ABILITY_TEXT[t.id] && (
                    <div style={{ fontSize: 10, color: '#cbb78a', marginTop: 2, lineHeight: 1.3 }}>
                      {UNIT_ABILITY_TEXT[t.id]}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000 }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: '#15171c', border: '2px solid #555', borderRadius: 6,
        padding: 20, maxWidth: 720, width: '94%', maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <h3 style={{ margin: 0, color: '#ffd54a' }}>Unit key</h3>
          <button className="tab-button" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
          ▲ triangle · ● circle · ■ square — the shape is the unit's tier (used by
          build icons and combat). atk R/B/G = red / black / green attack dice.
          Pictures use your current unit style ({unitStyle}).
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {renderSide('Rebel')}
          {renderSide('Empire')}
        </div>
      </div>
    </div>
  );
}

// ----- Refresh-phase deploy pick (#100) -----

// ----- R2-D2 mission-context flip -----

// ----- Mission-context Yoda reroll -----

function YodaMissionRerollModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: {
    kind: 'YodaReroll'; side: Side; context: 'combat' | 'mission' | 'dsplans';
    systemId: string; blankIndices: number[]; holderLeaderId: string;
    missionFaces?: string[];
    missionOwnSuccesses?: number;
    missionOppFaces?: string[];
    missionOppSuccesses?: number;
  };
  onPick: (rerollIndex: number | null) => void;
}) {
  const faces = choice.missionFaces ?? [];
  const oppFaces = choice.missionOppFaces ?? [];
  const ownSucc = choice.missionOwnSuccesses ?? 0;
  const oppSucc = choice.missionOppSuccesses ?? 0;
  const winning = ownSucc > oppSucc;
  const glyphFor = (face: string) =>
    face === 'hit' ? '✓' : face === 'direct-hit' ? '✶' : face === 'special' ? '◈' : '·';
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const holderName = G.catalog.leaders[choice.holderLeaderId]?.name ?? choice.holderLeaderId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2700,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #80dc78', borderRadius: 8,
        padding: 24, maxWidth: 640, width: '92%',
        boxShadow: '0 8px 32px rgba(128,220,120,0.4)',
      }}>
        <h3 style={{ color: '#80dc78', marginTop: 0 }}>
          Yoda's training — reroll a blank die?
        </h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, fontStyle: 'italic', marginBottom: 8 }}>
          Yoda's training: once per round, reroll one blank die on a mission
          or combat attack rolled by the leader bearing the Yoda ring.
        </div>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          <b>{holderName}</b> (Yoda ring holder) is at <b>{sysName}</b>.
          Both sides have now rolled. You may reroll one blank die on your
          mission roll. The reroll is once per round, so skipping here
          preserves it for any combat or mission later this round.
        </div>

        {/* Both rolls + current standings, so the player decides the reroll
            with full information (#121). */}
        <div style={{
          background: '#1b1e24', border: '1px solid #333', borderRadius: 6,
          padding: '10px 12px', marginBottom: 12,
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 6, fontSize: 13, fontWeight: 600,
          }}>
            <span style={{ color: winning ? '#80dc78' : '#e0b84f' }}>
              Your successes: {ownSucc}
            </span>
            <span style={{ color: '#9aa' }}>
              Opponent: {oppSucc}
            </span>
          </div>
          <div style={{ fontSize: 12, color: winning ? '#80dc78' : '#e08a5f' }}>
            {winning
              ? 'You are currently winning the mission — a reroll could pad your margin.'
              : `You need more successes than the opponent to win — you are ${ownSucc === oppSucc ? 'tied' : 'behind'}.`}
          </div>
          {oppFaces.length > 0 && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#888', alignSelf: 'center', marginRight: 4 }}>
                Opponent rolled:
              </span>
              {oppFaces.map((face, i) => (
                <span key={i} style={{
                  width: 30, height: 30, borderRadius: 4,
                  background: face === 'blank' ? '#222' : '#5a3a3a',
                  color: '#fff', fontSize: 15, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }} title={face}>{glyphFor(face)}</span>
              ))}
            </div>
          )}
        </div>

        <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>Your roll:</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {faces.map((face, i) => {
            const rerollable = choice.blankIndices.includes(i);
            const glyph = glyphFor(face);
            return (
              <button
                key={i}
                disabled={!rerollable}
                onClick={() => onPick(i)}
                style={{
                  width: 56, height: 56, borderRadius: 6,
                  background: face === 'blank' ? '#222' : '#357a3a',
                  color: '#fff', fontSize: 24, fontWeight: 700,
                  border: rerollable ? '2px solid #80dc78' : '1px solid #444',
                  opacity: rerollable ? 1 : 0.4,
                  cursor: rerollable ? 'pointer' : 'not-allowed',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}
                title={rerollable ? `Reroll this ${face} die` : 'Not a blank — Yoda only rerolls blanks'}
              >
                <span>{glyph}</span>
                <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.8 }}>{face}</span>
              </button>
            );
          })}
        </div>
        <div style={{ textAlign: 'right' }}>
          <button className="tab-button" onClick={() => onPick(null)}>
            Skip (save Yoda for later this round)
          </button>
        </div>
      </div>
    </div>
  );
}

function R2D2MissionFlipModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: {
    kind: 'R2D2Flip'; side: Side; context: 'combat' | 'mission';
    systemId: string; flippableDieIndices: number[]; missionFaces?: string[];
    ownFaces?: string[]; ownSuccesses?: number; empireSuccesses?: number;
  };
  onPick: (flipIndex: number | null) => void;
}) {
  const faces = choice.missionFaces ?? [];
  const ownFaces = choice.ownFaces ?? [];
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const dieGlyph = (face: string) =>
    face === 'hit' ? '✓' : face === 'direct-hit' ? '✶' : face === 'special' ? '◈' : '·';
  // Show the player where they stand so the flip isn't decided blind to their
  // own roll. Factual only (both rolls + both tallies) — who ultimately "wins"
  // depends on whether the Rebel is the resolver or the opposer and on ties.
  const own = choice.ownSuccesses;
  const emp = choice.empireSuccesses;
  const haveTally = own !== undefined && emp !== undefined;
  // High z-index — must sit above the soon-to-arrive MissionReportModal.
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2700,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 8,
        padding: 24, maxWidth: 640, width: '92%',
        boxShadow: '0 8px 32px rgba(170,224,255,0.4)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>
          R2-D2 (Resourceful Astromech) — flip an Empire mission die?
        </h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, fontStyle: 'italic', marginBottom: 8 }}>
          "R2-D2 ring — discard to turn 1 opponent's die to the blank side."
        </div>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Empire rolled this mission at <b>{sysName}</b>. You may discard the
          ring to turn one of Empire's dice to blank. Once discarded, the card
          is gone for the rest of the game.
        </div>

        {/* Your own roll — shown so the flip isn't decided blind (forum
            report: "you can see the empire result but not your own"). */}
        {ownFaces.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: '#8fdca0', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
              YOUR ROLL{own !== undefined ? ` — ${own} success${own === 1 ? '' : 'es'}` : ''}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ownFaces.map((face, i) => (
                <div key={i} style={{
                  width: 44, height: 44, borderRadius: 6,
                  background: face === 'blank' ? '#222' : '#2f7d4a',
                  color: '#fff', fontSize: 18, fontWeight: 700,
                  border: '1px solid #3a6d4a',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }} title={face}>
                  <span>{dieGlyph(face)}</span>
                  <span style={{ fontSize: 8, fontWeight: 500, opacity: 0.8 }}>{face}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {haveTally && (
          <div style={{ fontSize: 12, color: '#ddd', marginBottom: 8, fontFamily: 'monospace' }}>
            You <b style={{ color: '#8fdca0' }}>{own}</b> vs Empire <b style={{ color: '#ff8a80' }}>{emp}</b>
            {' '}— flipping a hit to blank drops the Empire by 1.
          </div>
        )}

        <div style={{ color: '#ff9d6b', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>
          EMPIRE'S ROLL — pick one to flip to blank
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {faces.map((face, i) => {
            const flippable = choice.flippableDieIndices.includes(i);
            const glyph = face === 'hit' ? '✓' : face === 'direct-hit' ? '✶' : face === 'special' ? '◈' : '·';
            return (
              <button
                key={i}
                disabled={!flippable}
                onClick={() => onPick(i)}
                style={{
                  width: 56, height: 56, borderRadius: 6,
                  background: face === 'blank' ? '#222' : '#c4423a',
                  color: '#fff', fontSize: 24, fontWeight: 700,
                  border: flippable ? '2px solid #aae0ff' : '1px solid #444',
                  opacity: flippable ? 1 : 0.4,
                  cursor: flippable ? 'pointer' : 'not-allowed',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                }}
                title={flippable ? `Flip ${face} → blank` : 'Already blank — no effect'}
              >
                <span>{glyph}</span>
                <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.8 }}>{face}</span>
              </button>
            );
          })}
        </div>
        <div style={{ textAlign: 'right' }}>
          <button className="tab-button" onClick={() => onPick(null)}>
            Skip (keep R2-D2 in hand)
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- Death Star Plans 2/3 attempt (#6) -----

function DeathStarPlansAttemptModal({
  G, choice, onAttempt,
}: {
  G: GameState;
  choice: { kind: 'DeathStarPlansAttempt'; side: Side; objectiveId: string; systemId: string; deathStarInstanceIds: string[] };
  onAttempt: (attempt: boolean, deathStarId?: string) => void;
}) {
  const card = G.catalog.objectives[choice.objectiveId];
  const sys = G.catalog.systems[choice.systemId];
  const [pickedDS, setPickedDS] = useState<string>(choice.deathStarInstanceIds[0]);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2600,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #80dc78', borderRadius: 8,
        padding: 24, maxWidth: 640, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(128,220,120,0.4)',
      }}>
        <h3 style={{ color: '#80dc78', marginTop: 0 }}>
          🌟 {card?.name ?? 'Death Star Plans'} — attempt the destruction?
        </h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 12, fontStyle: 'italic' }}>
          {card?.rulesText}
        </div>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12, lineHeight: 1.4 }}>
          You have at least one fighter at <b>{sys?.name ?? choice.systemId}</b> and{' '}
          {choice.deathStarInstanceIds.length === 1
            ? 'a Death Star is here.'
            : `${choice.deathStarInstanceIds.length} Death Stars are here.`}
          {' '}If you reveal, you roll <b>3 red dice</b>. Any <b>direct hit</b> (1/6 each die,
          ~42% combined) destroys the chosen Death Star and grants{' '}
          <b>{card?.reputation ?? 2} reputation</b>. Otherwise the card returns to your hand —
          no penalty for trying.
        </div>
        {choice.deathStarInstanceIds.length > 1 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ color: '#aaa', fontSize: 12, marginBottom: 4 }}>Pick which Death Star:</div>
            <select
              value={pickedDS}
              onChange={(e) => setPickedDS(e.target.value)}
              style={{ background: '#0c0d10', color: '#fff', border: '1px solid #555', padding: '4px 8px' }}
            >
              {choice.deathStarInstanceIds.map((id) => {
                const ss = G.map.systems[choice.systemId];
                const u = ss?.units.find((x) => x.instanceId === id);
                const name = u ? (G.catalog.unitTypes[u.typeId]?.name ?? u.typeId) : id;
                return <option key={id} value={id}>{name} ({id.slice(0, 6)})</option>;
              })}
            </select>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="tab-button"
            onClick={() => onAttempt(false)}
            title="Keep the card in hand for a later combat (Death Star can be destroyed by direct attack too)."
          >
            Decline (save for later)
          </button>
          <button
            className="tab-button active"
            onClick={() => onAttempt(true, pickedDS)}
            style={{ fontWeight: 700, background: '#80dc78', color: '#000' }}
          >
            Reveal &amp; roll 3 dice
          </button>
        </div>
      </div>
    </div>
  );
}

// ----- Which objective to score (only one per Refresh / per combat) -----

function PlayObjectiveModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'PlayObjective'; side: Side; legal: string[]; window: 'combat' | 'refresh'; logStart?: number; allowDecline?: boolean };
  onPick: (objectiveId: string) => void;
}) {
  const windowLabel = choice.window === 'combat' ? 'combat' : 'Refresh phase';
  // Show highest-reputation first so the "default best" is obvious, but the
  // choice is the player's — they may prefer to bank a card for later.
  const cards = [...choice.legal].sort(
    (a, b) => (G.catalog.objectives[b]?.reputation ?? 0) - (G.catalog.objectives[a]?.reputation ?? 0)
  );
  // Hover/focus an option to preview the actual card art — the objective cards
  // carry no rules text in our data, so seeing the card is the only way to read
  // what it does (player request).
  const [hoverOid, setHoverOid] = useState<string | null>(null);
  const hoverCard = hoverOid ? G.catalog.objectives[hoverOid] : null;
  const hoverArt = hoverCard?.image ? getCachedArtUrlSync(hoverCard.image) : null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 2600,
    }}>
      {/* Card-art preview for the hovered option (to the left of the modal). */}
      {hoverCard && (
        <div style={{ width: 260, flex: '0 0 auto', textAlign: 'center' }}>
          {hoverArt
            ? <img src={hoverArt} alt={hoverCard.name}
                style={{ width: 260, borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }} />
            : <div style={{ color: '#9a937f', fontSize: 12, padding: 16, border: '1px dashed #3a3d44', borderRadius: 8 }}>
                {hoverCard.name}<br /><span style={{ fontSize: 11 }}>(load the VASSAL module to see the card image)</span>
              </div>}
        </div>
      )}
      <div style={{
        background: '#15171c', border: '2px solid #aed581', borderRadius: 8,
        padding: 24, maxWidth: 680, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(174,213,129,0.4)',
      }}>
        <h3 style={{ color: '#aed581', marginTop: 0 }}>
          🎯 Choose an objective to accomplish
        </h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          Only <b>one objective card</b> can be accomplished per {windowLabel}. You qualify for
          more than one right now — pick which to score for its reputation. The others stay in
          your hand for a future {choice.window === 'combat' ? 'combat or Refresh phase' : 'Refresh phase'}.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cards.map((oid) => {
            const card = G.catalog.objectives[oid];
            return (
              <button
                key={oid}
                className="tab-button"
                onClick={() => onPick(oid)}
                onMouseEnter={() => setHoverOid(oid)}
                onMouseLeave={() => setHoverOid((cur) => (cur === oid ? null : cur))}
                onFocus={() => setHoverOid(oid)}
                style={{
                  textAlign: 'left', padding: '10px 14px', display: 'flex',
                  alignItems: 'center', gap: 12, borderColor: '#aed581',
                }}
              >
                <span style={{
                  flex: '0 0 auto', minWidth: 28, height: 28, borderRadius: 14,
                  background: '#aed581', color: '#000', fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {card?.reputation ?? '?'}
                </span>
                <span>
                  <div style={{ fontWeight: 700, color: '#fff' }}>{card?.name ?? oid}</div>
                  {card?.rulesText && (
                    <div style={{ color: '#9a937f', fontSize: 12, marginTop: 2 }}>{card.rulesText}</div>
                  )}
                </span>
              </button>
            );
          })}
          {/* Decline — for cost-bearing objectives (e.g. The Long War, which
              discards 2 of your other objectives). Playing is a "may" (#183). */}
          {choice.allowDecline && (
            <button
              className="tab-button"
              onClick={() => onPick('')}
              style={{ textAlign: 'left', padding: '10px 14px', borderColor: '#5a5d64', color: '#cbc4b0' }}
            >
              <div style={{ fontWeight: 700 }}>Don&apos;t play an objective this Refresh</div>
              <div style={{ color: '#9a937f', fontSize: 12, marginTop: 2 }}>
                Keep your cards — skip the cost (the objective stays in hand for a later Refresh).
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ----- RoE Raid Outposts: Imperial places the card's 2 markers in remotes ---

function RaidOutpostsPlaceModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RaidOutpostsPlace'; side: Side; legal: string[]; count: number };
  onPick: (systemIds: string[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (sid: string) => setSel((cur) =>
    cur.includes(sid) ? cur.filter((s) => s !== sid) : cur.length < choice.count ? [...cur, sid] : cur);
  const name = (sid: string) => G.catalog.systems[sid]?.name ?? sid;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 2600 }}>
      <div style={{ background: '#15171c', border: '2px solid #e57373', borderRadius: 8, padding: 24,
        maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <h3 style={{ color: '#e57373', marginTop: 0 }}>🎯 Raid Outposts — place target markers</h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          The Rebel played <b>Raid Outposts</b>. As the Imperial player you must place this card's
          <b> {choice.count} target markers</b> in {choice.count} remote systems. The Rebel scores
          1 reputation each time one is removed (by a Rebel ground unit reaching it, or a Heist).
          Choose carefully — pick remotes the Rebels will struggle to reach.
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {choice.legal.map((sid) => {
            const on = sel.includes(sid);
            return (
              <button key={sid} onClick={() => toggle(sid)} className="tab-button"
                style={{ borderColor: on ? '#e57373' : '#444', background: on ? '#3a1f1f' : '#181818',
                  padding: '8px 12px' }}>
                {on ? '✓ ' : ''}{name(sid)}
              </button>
            );
          })}
        </div>
        <button className="tab-button" disabled={sel.length !== choice.count}
          onClick={() => onPick(sel)}
          style={{ borderColor: '#e57373', opacity: sel.length === choice.count ? 1 : 0.5,
            padding: '8px 16px', fontWeight: 700 }}>
          Place {choice.count} markers ({sel.length}/{choice.count} chosen)
        </button>
      </div>
    </div>
  );
}

// ----- RoE Rebel Cell: place a marker in a chosen Rebel system -----

function RebelCellPlaceModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RebelCellPlace'; side: Side; legal: string[] };
  onPick: (systemId: string) => void;
}) {
  const name = (sid: string) => G.catalog.systems[sid]?.name ?? sid;
  const rebelUnits = (sid: string) => (G.map.systems[sid]?.units ?? []).filter((u) => u.side === 'Rebel').length;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 2600 }}>
      <div style={{ background: '#15171c', border: '2px solid #aed581', borderRadius: 8, padding: 24,
        maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <h3 style={{ color: '#aed581', marginTop: 0 }}>🎯 Rebel Cell — place your target marker</h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          Place this card's target marker in any <b>Rebel-loyalty system</b>. While the marker stands,
          at the start of each Refresh you may discard 1 objective card from your hand to gain 1
          reputation (instead of playing an objective). Pick somewhere safe.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {choice.legal.map((sid) => (
            <button key={sid} onClick={() => onPick(sid)} className="tab-button"
              style={{ textAlign: 'left', borderColor: '#aed581', padding: '8px 14px' }}>
              <b style={{ color: '#fff' }}>{name(sid)}</b>
              <span style={{ color: '#9a937f', fontSize: 12, marginLeft: 8 }}>
                ({rebelUnits(sid)} Rebel unit{rebelUnits(sid) === 1 ? '' : 's'})
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ----- RoE Rebel Cell: optional discard-an-objective-for-reputation -----

function RebelCellDiscardModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RebelCellDiscard'; side: Side; legal: string[] };
  onPick: (objectiveId: string | null) => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 2600 }}>
      <div style={{ background: '#15171c', border: '2px solid #aed581', borderRadius: 8, padding: 24,
        maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <h3 style={{ color: '#aed581', marginTop: 0 }}>🛰️ Rebel Cell — discard for reputation?</h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          Your Rebel Cell marker still stands. <b>Instead of playing an objective this Refresh</b>,
          you may discard 1 objective card from your hand to gain 1 reputation. This is optional.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {choice.legal.map((oid) => {
            const card = G.catalog.objectives[oid];
            return (
              <button key={oid} onClick={() => onPick(oid)} className="tab-button"
                style={{ textAlign: 'left', borderColor: '#aed581', padding: '8px 14px' }}>
                <b style={{ color: '#fff' }}>{card?.name ?? oid}</b>
                {card?.rulesText && (
                  <div style={{ color: '#9a937f', fontSize: 12, marginTop: 2 }}>{card.rulesText}</div>
                )}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}
          style={{ borderColor: '#ffd54a', padding: '8px 16px' }}>
          Decline — keep my objectives and play normally
        </button>
      </div>
    </div>
  );
}

// ----- Detained / Retrieve The Plans / Interrogation Droid (#4: stub-mission fixes) -----

function DetainedTargetPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'DetainedTargetPick'; side: Side; candidates: string[] };
  onPick: (leaderId: string) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Detained — pick a Rebel leader to detain</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          The chosen leader will skip the next Refresh phase's retrieve step
          and remain on the board for another full round.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.candidates.map((lid) => {
            const ldr = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                {ldr?.name ?? lid}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function OneInAMillionMissionModal({
  choice, onSubmit,
}: {
  choice: { faces: string[]; colors: readonly string[]; rebelRoleInRoll: 'attacker' | 'opposer' };
  onSubmit: (picks: { index: number; face: string }[]) => void;
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
  const dieGlyph = (face: string) =>
    face === 'hit' ? '✓' : face === 'direct-hit' ? '✶' : face === 'special' ? '◈' : '·';
  const dieBg = (color: string) => color === 'red' ? '#c4423a' : '#222';
  const submit = (skip: boolean) => {
    onSubmit(skip ? [] : Array.from(picks.entries()).map(([index, face]) => ({ index, face })));
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 580, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>One In A Million — set dice</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Discard One In A Million to set up to 2 of your dice ({choice.rebelRoleInRoll}) to faces of your choice.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {choice.faces.map((face, i) => {
            const overridden = picks.get(i);
            return (
              <div key={i} style={{
                background: '#0c0d10', border: `2px solid ${overridden ? '#80dc78' : '#2a2d34'}`,
                borderRadius: 4, padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
              }}>
                <div style={{
                  width: 22, height: 22, background: dieBg(choice.colors[i]),
                  border: '1px solid #000', borderRadius: 3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 700, color: face === 'blank' ? '#555' : '#fff',
                }}>
                  {dieGlyph(face)}
                </div>
                <span style={{ color: '#888' }}>→</span>
                <select value={overridden ?? ''} onChange={(e) => setFace(i, e.target.value || null)}
                  style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #555', fontSize: 11 }}
                >
                  <option value="">(keep)</option>
                  <option value="blank">blank</option>
                  <option value="hit">hit ✓</option>
                  <option value="direct-hit">direct-hit ✶</option>
                </select>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
          Set: {picks.size} / 2
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" disabled={picks.size === 0} onClick={() => submit(false)}>
            Apply ({picks.size})
          </button>
          <button className="tab-button" onClick={() => submit(true)}>Skip (keep card)</button>
        </div>
      </div>
    </div>
  );
}

function NobleSacrificeOfferModal({
  onAccept,
}: {
  onAccept: (accept: boolean) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Noble Sacrifice — eliminate Obi-Wan?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Obi-Wan has just been captured. Discard Noble Sacrifice to eliminate him instead,
          gaining +1 reputation. He becomes one with the Force.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Discard → eliminate for +1 rep
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep, accept capture
          </button>
        </div>
      </div>
    </div>
  );
}

function DrawThemOutPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[]; systemId: string };
  onPick: (leaderId: string) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Draw Them Out — pull a Rebel leader</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Pick a Rebel leader from their pool to place at <b>{sysName}</b>:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            if (!l) return null;
            const t = l.tacticValues;
            const sk = l.skills;
            const skillStr = ['diplomacy', 'intel', 'specOps', 'logistics']
              .map((k) => `${k[0].toUpperCase()}${sk[k as keyof typeof sk]}`)
              .filter((s) => !s.endsWith('0')).join(' ') || 'no major skills';
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left', padding: '8px 10px' }}>
                <div style={{ fontWeight: 700, color: '#fff' }}>{l.name}</div>
                <div style={{ fontSize: 11, color: '#aaa' }}>
                  Tactics S{t.space} G{t.ground} · {skillStr}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReconnaissancePickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[] };
  onPick: (missionId: string) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 680, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Reconnaissance — recover a discarded mission</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Pick a mission from your discard pile to return to your hand:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((mid) => {
            const m = G.catalog.missions[mid];
            if (!m) return null;
            return (
              <button
                key={mid}
                className="tab-button"
                onClick={() => onPick(mid)}
                style={{ textAlign: 'left', padding: '8px 10px' }}
              >
                <div style={{ fontWeight: 700, color: '#fff' }}>{m.name}</div>
                <div style={{ fontSize: 11, color: '#ccc', marginTop: 4, fontStyle: 'italic' }}>
                  {m.rulesText}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MissionRecruitLeaderPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { side: Side; candidates: string[]; systemId: string; cause: string };
  onPick: (leaderId: string) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const causeName = G.catalog.missions[choice.cause]?.name ?? choice.cause;
  const color = sideColor(choice.side);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>{causeName} — recruit which leader?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Pick a leader to recruit into your pool and place at <b>{sysName}</b>:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            if (!l) return null;
            const t = l.tacticValues;
            const sk = l.skills;
            const skillStr = ['diplomacy', 'intel', 'specOps', 'logistics']
              .map((k) => `${k[0].toUpperCase()}${sk[k as keyof typeof sk]}`)
              .filter((s) => !s.endsWith('0')).join(' ') || 'no major skills';
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left', padding: '8px 10px' }}>
                <div style={{ fontWeight: 700, color: '#fff' }}>{l.name}</div>
                <div style={{ fontSize: 11, color: '#aaa' }}>
                  Tactics S{t.space} G{t.ground} · {skillStr}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SecretMissionPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { remaining: string[]; kept: string[]; keepCount: 1 | 2 };
  onPick: (missionId: string) => void;
}) {
  const remaining = choice.keepCount - choice.kept.length;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      // Above the mission-resolve report (zIndex 5000) so the active pick shows
      // first even when that report is queued behind it (BGG: Secret Mission).
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5600,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 680, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>
          Secret Mission — keep {remaining} more mission{remaining === 1 ? '' : 's'}
        </h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          You see the top {choice.remaining.length + choice.kept.length} cards of your
          mission deck. Pick {choice.keepCount} to add to your hand
          {choice.keepCount === 2 ? ' (Cassian Andor lets you keep 2)' : ''}.
          The rest will be shuffled back into the deck.
        </div>
        {choice.kept.length > 0 && (
          <div style={{ color: '#cbc4b0', fontSize: 12, marginBottom: 10 }}>
            Already kept: {choice.kept.map((mid) => G.catalog.missions[mid]?.name ?? mid).join(', ')}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.remaining.map((mid) => {
            const m = G.catalog.missions[mid];
            return (
              <button
                key={mid}
                className="tab-button"
                onClick={() => onPick(mid)}
                style={{ textAlign: 'left', padding: '8px 10px' }}
              >
                <div style={{ fontWeight: 700, color: '#fff' }}>{m?.name ?? mid}</div>
                {m && (
                  <div style={{ fontSize: 11, color: '#ccc', marginTop: 4, fontStyle: 'italic' }}>
                    {m.rulesText}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StartingCardBranchModal({
  G, choice, onAction,
}: {
  G: GameState;
  choice: { side: Side; cardId: string; canDraw: boolean };
  onAction: (action: 'draw' | 'recruit') => void;
}) {
  const cardName = G.catalog.actions[choice.cardId]?.name ?? choice.cardId;
  const color = sideColor(choice.side);
  const recruitLabel = choice.cardId === 'early-promotion'
    ? 'Recruit Admiral Motti, place Motti & Tarkin in an Imperial system'
    : 'Lose 1 reputation, recruit Saw Gerrera';
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>{cardName} — choose</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Pick one effect:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.canDraw && (
            <button className="tab-button" onClick={() => onAction('draw')} style={{ textAlign: 'left' }}>
              Draw a starting action card
            </button>
          )}
          <button className="tab-button active" onClick={() => onAction('recruit')} style={{ textAlign: 'left', fontWeight: 700 }}>
            {recruitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function UnderTheRadarKeepModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[] };
  onPick: (probeId: string) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Under the Radar — hold a probe facedown</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          You see the top {choice.candidates.length} probe cards. Keep one facedown — it's
          pulled out of the deck so the Empire can't draw it. You may return it to the top of
          the deck at the start of a future Command turn.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((pid) => {
            const p = G.catalog.probes[pid];
            return (
              <button key={pid} className="tab-button" onClick={() => onPick(pid)} style={{ textAlign: 'left' }}>
                Hold {p?.systemName ?? pid}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UnderTheRadarReturnModal({
  G, choice, onAccept,
}: {
  G: GameState;
  choice: { heldProbe: string };
  onAccept: (accept: boolean) => void;
}) {
  const sysName = G.catalog.probes[choice.heldProbe]?.systemName ?? choice.heldProbe;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Under the Radar — return held probe?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          You're holding the <b>{sysName}</b> probe facedown. Return it to the top of the
          probe deck now (the Empire would draw it next), or keep holding it out of the deck.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Return to top of deck
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep holding
          </button>
        </div>
      </div>
    </div>
  );
}

function HeistChoiceModal({
  G, choice, onAction,
}: {
  G: GameState;
  choice: { systemId: string; canDrawObjective: boolean; markerSources: string[] };
  onAction: (action: string) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  // Friendly label for a marker's source card (mission or action card name).
  const sourceLabel = (src: string) =>
    G.catalog.missions[src]?.name ?? G.catalog.actions[src]?.name ?? src;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Heist — at {sysName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          {choice.canDrawObjective
            ? 'A Death Star is here — you may draw the top objective card instead of removing a target marker.'
            : 'Choose which target marker to remove.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.canDrawObjective && (
            <button className="tab-button active" onClick={() => onAction('draw')} style={{ textAlign: 'left', fontWeight: 700 }}>
              Draw the top objective card
            </button>
          )}
          {choice.markerSources.map((src) => (
            <button key={src} className="tab-button" onClick={() => onAction(`remove:${src}`)} style={{ textAlign: 'left' }}>
              Remove the {sourceLabel(src)} target marker
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Establish Trade Relations: gain 2 loyalty here, or queue a Mon Cala Cruiser. */
function EstablishTradeChoiceModal({
  G, choice, onAction,
}: {
  G: GameState;
  choice: { kind: 'EstablishTradeChoice'; side: Side; systemId: string };
  onAction: (action: 'loyalty' | 'cruiser') => void;
}) {
  const color = sideColor('Rebel');
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2600,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 8,
        padding: 24, maxWidth: 460, width: '92%',
      }}>
        <h3 style={{ color, marginTop: 0 }}>Establish Trade Relations</h3>
        <div style={{ color: '#cbc4b0', fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
          Choose one:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button className="tab-button" style={{ textAlign: 'left', padding: '10px 14px', borderColor: color }}
            onClick={() => onAction('loyalty')}>
            <div style={{ fontWeight: 700, color: '#fff' }}>Gain 2 loyalty</div>
            <div style={{ color: '#9a937f', fontSize: 12, marginTop: 2 }}>+2 Rebel loyalty in {sysName}.</div>
          </button>
          <button className="tab-button" style={{ textAlign: 'left', padding: '10px 14px', borderColor: color }}
            onClick={() => onAction('cruiser')}>
            <div style={{ fontWeight: 700, color: '#fff' }}>Build a Mon Calamari Cruiser</div>
            <div style={{ color: '#9a937f', fontSize: 12, marginTop: 2 }}>
              Place 1 Mon Calamari Cruiser on space 3 of your build queue (deploys in 3 Refreshes).
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function DiscreditRebellionModal({
  G, choice, onAction,
}: {
  G: GameState;
  choice: { diceCount: 1 | 2; sabotageSystemIds: string[] };
  onAction: (action: 'remove' | 'roll') => void;
}) {
  const sysNames = choice.sabotageSystemIds
    .map((sid) => G.catalog.systems[sid]?.name ?? sid)
    .join(', ');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Discredit Rebellion — remove markers or roll?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          The Empire resolved <i>Discredit Rebellion</i>. You must choose: remove
          ALL sabotage markers from the board ({choice.sabotageSystemIds.length} —
          {' '}{sysNames}) and stay safe, OR roll {choice.diceCount} red die{choice.diceCount === 1 ? '' : 's'}
          {' '}— if you roll at least 1 special symbol the Rebels lose 1 reputation, but the sabotage
          markers stay in play.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button" onClick={() => onAction('remove')} style={{ fontWeight: 700 }}>
            Remove all {choice.sabotageSystemIds.length} sabotage marker{choice.sabotageSystemIds.length === 1 ? '' : 's'}
          </button>
          <button className="tab-button active" onClick={() => onAction('roll')}>
            Roll {choice.diceCount} die
          </button>
        </div>
      </div>
    </div>
  );
}

function PostBountyOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[]; missionId: string };
  onPick: (leaderId: string | null) => void;
}) {
  const missionName = G.catalog.missions[choice.missionId]?.name ?? choice.missionId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Post Bounty — bounty a Rebel leader?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          <i>{missionName}</i> just failed. Discard <i>Post Bounty</i> to attach a bounty ring to one of
          the Rebel leaders who attempted it — when that leader is captured, the Rebels lose 1 reputation:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                Bounty {l?.name ?? lid}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep, skip
        </button>
      </div>
    </div>
  );
}

function AmbitionsOfPowerOfferModal({
  choice, onAccept,
}: {
  choice: { currentPoolSize: number; currentCap: number };
  onAccept: (accept: boolean) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Ambitions of Power — raise the cap?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Your leader pool is at {choice.currentPoolSize}, over the cap of {choice.currentCap}.
          Discard <i>Ambitions of Power</i> to raise your pool cap by 1 for the rest of the game (keeping the
          leader who would otherwise be eliminated). Without it, the bottom of the pool is eliminated.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Discard → cap +1
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep, accept elimination
          </button>
        </div>
      </div>
    </div>
  );
}

function LeaderPoolEliminateModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { side: Side; candidates: string[]; overBy: number };
  onPick: (leaderId: string) => void;
}) {
  const skillTotal = (lid: string): number => {
    const l = G.catalog.leaders[lid];
    if (!l) return 0;
    const sk = Object.values(l.skills ?? {}).reduce((a, b) => a + ((b as number) ?? 0), 0);
    const minor = Object.values((l as { minorSkills?: Record<string, number> }).minorSkills ?? {}).reduce((a, b) => a + ((b as number) ?? 0), 0);
    return sk + minor;
  };
  // Show weakest-first so the suggested cut is obvious — but the choice is yours.
  const ordered = [...choice.candidates].sort((a, b) => {
    const la = G.catalog.leaders[a], lb = G.catalog.leaders[b];
    const va = (la?.tacticValues?.space ?? 0) + (la?.tacticValues?.ground ?? 0) + skillTotal(a);
    const vb = (lb?.tacticValues?.space ?? 0) + (lb?.tacticValues?.ground ?? 0) + skillTotal(b);
    return va - vb;
  });
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${sideColor(choice.side)}`, borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: sideColor(choice.side), marginTop: 0 }}>
          {choice.side} — leader pool over the limit
        </h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Your pool exceeds the cap of 8 by {choice.overBy}. Choose a leader to eliminate
          (you keep the rest). {choice.overBy > 1 && 'You will be asked again until you are at 8.'}
          {' '}They’re listed weakest-first as a suggestion — the choice is yours.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ordered.map((lid) => {
            const l = G.catalog.leaders[lid];
            const sp = l?.tacticValues?.space ?? 0, gr = l?.tacticValues?.ground ?? 0;
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)}
                style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontWeight: 700, color: '#fff' }}>{l?.name ?? lid}</span>
                <span style={{ color: '#9a937f', fontSize: 11 }}>
                  tactics {sp}/{gr} · {skillTotal(lid)} skill icons
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TrackThemOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[]; systemId: string };
  onPick: (leaderId: string | null) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Track Them — pull a leader home?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          The Rebels just retreated from {G.catalog.systems[choice.systemId]?.name ?? choice.systemId}.
          Discard <i>Track Them</i> to return one of your leaders here back to the leader pool:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                Return {l?.name ?? lid}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep, skip
        </button>
      </div>
    </div>
  );
}

function SomethingToFightForOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[] };
  onPick: (objectiveId: string | null) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Something to Fight For — recycle an objective?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          You just won a battle. Discard <i>Something to Fight For</i> to put one discarded objective card on top of the deck:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((oid) => {
            const o = G.catalog.objectives[oid];
            return (
              <button key={oid} className="tab-button" onClick={() => onPick(oid)} style={{ textAlign: 'left' }}>
                {o?.name ?? oid}{o ? ` (stage ${o.stage}, +${o.reputation} rep)` : ''}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep, skip
        </button>
      </div>
    </div>
  );
}

function ItIsYourDestinyOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[] };
  onPick: (leaderId: string | null) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>It Is Your Destiny — capture a rescuer?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          A Rebel rescue just happened at Vader's system. Discard the card to have Vader capture one of these rescuers:
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                Capture {l?.name ?? lid}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep, skip
        </button>
      </div>
    </div>
  );
}

function UndercoverOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { missionId: string; targetSystemId: string; candidates: string[] };
  onPick: (leaderId: string | null) => void;
}) {
  const m = G.catalog.missions[choice.missionId];
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Undercover — relocate to {sysName}?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Empire is attempting <b>{m?.name ?? choice.missionId}</b> at <b>{sysName}</b>.
          Discard Undercover to move Lando or Obi-Wan to that system; they'll join opposition.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                Move {l?.name ?? lid}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep Undercover, skip
        </button>
      </div>
    </div>
  );
}

function SonOfSkywalkerOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidates: string[] };
  onPick: (missionId: string | null) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Son of Skywalker — pull a mission</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Luke's mission succeeded. Discard Son of Skywalker to pull one of these into your hand.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((mid) => {
            const m = G.catalog.missions[mid];
            return (
              <button key={mid} className="tab-button" onClick={() => onPick(mid)} style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{m?.name ?? mid}</div>
                {m?.rulesText && <div style={{ fontSize: 10, opacity: 0.8 }}>{m.rulesText}</div>}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep Son of Skywalker, skip
        </button>
      </div>
    </div>
  );
}

function BlindsideOfferModal({
  G, choice, onAccept,
}: {
  G: GameState;
  choice: { missionId: string; targetSystemId: string };
  onAccept: (accept: boolean) => void;
}) {
  const m = G.catalog.missions[choice.missionId];
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Blindside — deny pool opposers?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Revealing <b>{m?.name ?? choice.missionId}</b> at <b>{sysName}</b>.
          Discard Blindside to prevent the Rebel from sending pool leaders to oppose this mission.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Discard Blindside
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep, allow pool opposition
          </button>
        </div>
      </div>
    </div>
  );
}

function WookieGuardianOfferModal({
  G, choice, onAccept,
}: {
  G: GameState;
  choice: { missionId: string; targetSystemId: string };
  onAccept: (accept: boolean) => void;
}) {
  const m = G.catalog.missions[choice.missionId];
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  // Who's making the attempt — the Empire leader(s) resolving the mission.
  // The reporter could only tell it was Vader AFTER playing the card (#95/forum).
  const attackers = (G.pendingMission?.leaderIds ?? [])
    .map((lid) => G.catalog.leaders[lid as string]?.name ?? lid)
    .join(' & ');
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Wookie Guardian — auto-stop?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          {attackers ? <><b style={{ color: '#ff8866' }}>{attackers}</b> is attempting </> : 'Empire is attempting '}
          <b>{m?.name ?? choice.missionId}</b> (special-ops) at <b>{sysName}</b>,
          where Chewbacca is. Discard Wookie Guardian to auto-fail it before the roll.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Discard Wookie Guardian → auto-fail
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep, let it proceed
          </button>
        </div>
      </div>
    </div>
  );
}

function C3POOfferModal({
  G, choice, onAccept,
}: {
  G: GameState;
  choice: { kind: 'C3POOffer'; missionId: string; targetSystemId: string };
  onAccept: (accept: boolean) => void;
}) {
  const m = G.catalog.missions[choice.missionId];
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 480, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>C-3PO — convert failure to success?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 12 }}>
          Your diplomacy mission <b>{m?.name ?? choice.missionId}</b> at <b>{sysName}</b> just failed.
          You can discard the C-3PO ring to flip it to a success.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onAccept(true)} style={{ fontWeight: 700 }}>
            Discard C-3PO → succeed
          </button>
          <button className="tab-button" onClick={() => onAccept(false)}>
            Keep C-3PO, accept failure
          </button>
        </div>
      </div>
    </div>
  );
}

function FalconOfferModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'FalconOffer'; missionId: string; targetSystemId: string; candidates: string[] };
  onPick: (leaderId: string | null) => void;
}) {
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Millennium Falcon — rescue a captured leader?</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Mission succeeded at <b>{sysName}</b>. Discard the Falcon ring to rescue one of these captured leaders.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {choice.candidates.map((lid) => {
            const l = G.catalog.leaders[lid];
            return (
              <button key={lid} className="tab-button" onClick={() => onPick(lid)} style={{ textAlign: 'left' }}>
                Rescue {l?.name ?? lid}
              </button>
            );
          })}
        </div>
        <button className="tab-button" onClick={() => onPick(null)}>
          Keep Falcon, skip rescue
        </button>
      </div>
    </div>
  );
}

function BrilliantAdministratorBuildPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'BrilliantAdministratorBuildPick'; side: Side; systemId: string; icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[] };
  onPick: (picks: (string | null)[]) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const legalForIcon = (icon: { theater: string; shape: string }): string[] => {
    const need = tierRank[icon.shape] ?? 2;
    return Object.values(G.catalog.unitTypes)
      .filter((t) => t.side === 'Empire'
        && t.theater === icon.theater
        && (tierRank[t.tier ?? 'square'] ?? 2) === need
        && t.class !== 'structure'
        && !PROJECT_ONLY_UNIT_IDS.has(t.id)
        // RoE units only buildable when the expansion's unit toggle is on.
        && (t.set !== 'rote' || G.expansion?.roeUnits === true))
      .map((t) => t.id);
  };
  const defaults = choice.icons.map((icon) => {
    const opts = legalForIcon(icon);
    return opts[opts.length - 1] ?? null;
  });
  const [picks, setPicks] = useState<(string | null)[]>(defaults);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Brilliant Administrator — build at {sysName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Tarkin grants an immediate build at this system. One unit per resource icon.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {choice.icons.map((icon, i) => {
            const opts = legalForIcon(icon);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#aaa', minWidth: 110 }}>{icon.theater} · {icon.shape}</span>
                <select
                  value={picks[i] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setPicks((prev) => { const next = [...prev]; next[i] = v; return next; });
                  }}
                  style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px', minWidth: 200 }}
                >
                  <option value="">— skip this icon —</option>
                  {opts.map((tid) => (
                    <option key={tid} value={tid}>{G.catalog.unitTypes[tid]?.name ?? tid}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <button className="tab-button active" onClick={() => onPick(picks)}>
          Add to build queue
        </button>
      </div>
    </div>
  );
}

function CatchThemBySurpriseMovePickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { targetSystemId: string; candidateSourceSystemIds: string[] };
  onPick: (sourceSystemId: string, ids: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const [srcId, setSrcId] = useState<string | null>(null);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const sourceUnits = srcId
    ? G.map.systems[srcId].units.filter((u) => u.side === 'Empire')
    : [];
  const toggle = (uid: string) => {
    const next = new Set(picks);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    setPicks(next);
  };
  let cap = 0, riders = 0;
  for (const uid of picks) {
    const u = sourceUnits.find((x) => x.instanceId === uid);
    if (!u) continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.transport.capacity > 0) cap += t.transport.capacity;
    if (t.transport.restriction || (t.theater === 'ground' && t.class !== 'structure')) riders++;
  }
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Catch Them By Surprise — move fleet to {targetName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
          Ozzel's immediate fleet move. Pick an adjacent source system, then units to bring. Transport rules apply.
        </div>
        <div style={{ marginBottom: 10 }}>
          <select value={srcId ?? ''}
            onChange={(e) => { setSrcId(e.target.value || null); setPicks(new Set()); }}
            style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px' }}
          >
            <option value="">— pick source system —</option>
            {choice.candidateSourceSystemIds.map((sid) => (
              <option key={sid} value={sid}>{G.catalog.systems[sid]?.name ?? sid}</option>
            ))}
          </select>
        </div>
        {srcId && (
          <>
            <div style={{ color: cap >= riders ? '#80dc78' : '#ff8866', fontSize: 12, marginBottom: 8 }}>
              Capacity: {cap} · Riders: {riders} {cap >= riders ? '' : '(insufficient transport)'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
              {sourceUnits.map((u) => {
                const t = G.catalog.unitTypes[u.typeId];
                const on = picks.has(u.instanceId);
                return (
                  <label key={u.instanceId} style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                    border: `1px solid ${on ? '#80dc78' : '#2a2d34'}`, borderRadius: 3, fontSize: 12,
                  }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(u.instanceId)} />
                    {t?.name ?? u.typeId}
                    {t && t.transport.capacity > 0 && <span style={{ color: '#80dc78', fontSize: 10 }}>+{t.transport.capacity} cap</span>}
                    {t && t.transport.restriction && <span style={{ color: '#ffaaaa', fontSize: 10 }}>needs ride</span>}
                    {t && t.theater === 'ground' && t.class !== 'structure' && <span style={{ color: '#ffaaaa', fontSize: 10 }}>ground</span>}
                  </label>
                );
              })}
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" disabled={!srcId}
            onClick={() => srcId && onPick(srcId, [...picks])}
          >Move {picks.size} unit{picks.size === 1 ? '' : 's'}</button>
        </div>
      </div>
    </div>
  );
}

function ScoutingMissionTIEPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { targetSystemId: string; candidateUnitIds: string[]; maxPicks: number };
  onPick: (ids: string[]) => void;
}) {
  const targetName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const [picks, setPicks] = useState<Set<string>>(new Set());
  // Map TIE Fighter instance → source system name for display.
  const tieInfo = choice.candidateUnitIds.map((uid) => {
    for (const sid of Object.keys(G.map.systems)) {
      if (G.map.systems[sid].units.some((u) => u.instanceId === uid)) {
        return { uid, sysId: sid, sysName: G.catalog.systems[sid]?.name ?? sid };
      }
    }
    return { uid, sysId: '?', sysName: '?' };
  });
  const toggle = (uid: string) => {
    const next = new Set(picks);
    if (next.has(uid)) next.delete(uid);
    else if (next.size < choice.maxPicks) next.add(uid);
    setPicks(next);
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 540, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Scouting Mission — relocate TIE Fighters to {targetName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
          Pick up to {choice.maxPicks} TIE Fighters from any systems. Ignores transport + adjacency.
          If Rebel ships are at {targetName}, combat resolves automatically.
        </div>
        <div style={{ color: '#80dc78', fontSize: 12, marginBottom: 8 }}>
          {picks.size} / {choice.maxPicks} selected
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {tieInfo.map(({ uid, sysName }) => {
            const on = picks.has(uid);
            const atCap = !on && picks.size >= choice.maxPicks;
            return (
              <label key={uid} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                border: `1px solid ${on ? '#80dc78' : '#2a2d34'}`, borderRadius: 3, fontSize: 12,
                opacity: atCap ? 0.4 : 1,
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(uid)} disabled={atCap} />
                TIE Fighter
                <span style={{ color: '#aaa', fontSize: 10 }}>from {sysName}</span>
              </label>
            );
          })}
        </div>
        <button className="tab-button active" onClick={() => onPick([...picks])}>
          Relocate {picks.size} TIE{picks.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

function MissionListPickModal({
  G, choice, title, subtitle, color, onPick, assignedLeaderId,
}: {
  G: GameState;
  choice: { candidates: string[] };
  title: string;
  subtitle: string;
  color: string;
  onPick: (missionId: string) => void;
  // The leader who'll be placed on the chosen mission (Leia for Most Desperate
  // Hour, the resolver for Proceeding As Planned). When given, we show their
  // skills and flag missions whose skill requirement they can't meet alone, so
  // the player isn't surprised when the mission later can't be resolved (#108).
  assignedLeaderId?: string;
}) {
  const ldr = assignedLeaderId ? G.catalog.leaders[assignedLeaderId] : null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${color}`, borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color, marginTop: 0 }}>{title}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>{subtitle}</div>
        {ldr && (
          <div style={{ fontSize: 12, color: '#cbc4b0', marginBottom: 10,
            padding: '6px 8px', background: '#0c0d10', borderRadius: 4 }}>
            <b style={{ color: '#fff' }}>{ldr.name}</b>{' — '}
            <span style={{ color: '#6f6a5c' }}>Dip</span> {ldr.skills.diplomacy}{'  '}
            <span style={{ color: '#6f6a5c' }}>Int</span> {ldr.skills.intel}{'  '}
            <span style={{ color: '#6f6a5c' }}>Ops</span> {ldr.skills.specOps}{'  '}
            <span style={{ color: '#6f6a5c' }}>Log</span> {ldr.skills.logistics}
            <div style={{ fontSize: 11, color: '#8a8470', marginTop: 2 }}>
              You can pick a mission {ldr.name} can't fulfill alone — it just won't
              resolve unless another leader's skill covers it.
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidates.map((mid) => {
            const m = G.catalog.missions[mid];
            const art = m?.image ? getCachedArtUrlSync(m.image) : null;
            const skillName = (s?: string) => s === 'specOps' ? 'spec-ops' : (s ?? '');
            // Can the assigned leader meet this mission's skill requirement alone?
            // Ring/minor-aware (matches the engine reveal check) so K-2SO etc. count (#173).
            const have = ldr && m?.skill
              ? (() => { const sc = phases.totalSkill(G, [ldr.id] as LeaderId[], m.skill); return sc.major + sc.minor; })()
              : 0;
            const shortfall = !!(ldr && m?.skill && m.skillCost > 0 && have < m.skillCost);
            // A leader pictured on the card grants +2 successes if that leader
            // resolves it (the "portrait bonus") — surface it so the player can
            // line up the right leader (e.g. Chewbacca for a Kashyyyk uprising).
            const portrait = m?.leaderPortrait ? (G.catalog.leaders[m.leaderPortrait]?.name ?? m.leaderPortrait) : null;
            return (
              <button key={mid} className="tab-button" onClick={() => onPick(mid)}
                style={{ textAlign: 'left', display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px' }}>
                {art && (
                  <img src={art} alt={m?.name ?? mid}
                    style={{ width: 36, height: 50, objectFit: 'cover', objectPosition: 'top',
                      borderRadius: 3, flex: '0 0 auto' }} />
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{m?.name ?? mid}</div>
                  {m && (
                    <div style={{ fontSize: 11, color: '#9fb3d9' }}>
                      Needs {m.skillCost} {skillName(m.skill)} icon{m.skillCost === 1 ? '' : 's'}
                      {m.isAttempt ? ' · attempt (rolls dice vs opposition)' : ' · auto-resolves if unopposed'}
                    </div>
                  )}
                  {portrait && (
                    <div style={{ fontSize: 11, color: '#ffd54a' }}>
                      🖼 Pictures {portrait} — +2 successes if {portrait} resolves it
                    </div>
                  )}
                  {shortfall && ldr && (
                    <div style={{ fontSize: 11, color: '#ff8866', fontWeight: 600 }}>
                      ⚠ {ldr.name} has {have} {skillName(m?.skill)} — can't fulfill {m?.skillCost} alone
                    </div>
                  )}
                  {m?.rulesText && <div style={{ fontSize: 10, opacity: 0.85 }}>{m.rulesText}</div>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StartEvacuationPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { candidateSystemIds: string[]; candidateUnitIds: string[] };
  onPick: (sysId: string, ids: string[]) => void;
}) {
  const [sysId, setSysId] = useState<string | null>(null);
  const [picks, setPicks] = useState<Set<string>>(() => new Set(choice.candidateUnitIds));
  const baseUnits = G.map.rebelBaseSpace.units.filter((u) => choice.candidateUnitIds.includes(u.instanceId));
  const toggle = (uid: string) => {
    const next = new Set(picks);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    setPicks(next);
  };
  let cap = 0, riders = 0;
  for (const uid of picks) {
    const u = baseUnits.find((x) => x.instanceId === uid);
    if (!u) continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.transport.capacity > 0) cap += t.transport.capacity;
    if (t.transport.restriction || (t.theater === 'ground' && t.class !== 'structure')) riders++;
  }
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 620, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Start The Evacuation — pick destination + units</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
          Move Rebel Base units to any system without Imperial units. Transport rules still apply.
        </div>
        <div style={{ marginBottom: 10 }}>
          <select value={sysId ?? ''}
            onChange={(e) => setSysId(e.target.value || null)}
            style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px' }}
          >
            <option value="">— pick destination system —</option>
            {[...choice.candidateSystemIds].sort().map((sid) => (
              <option key={sid} value={sid}>{G.catalog.systems[sid]?.name ?? sid}</option>
            ))}
          </select>
        </div>
        <div style={{ color: cap >= riders ? '#80dc78' : '#ff8866', fontSize: 12, marginBottom: 8 }}>
          Capacity: {cap} · Riders: {riders} {cap >= riders ? '' : '(insufficient transport)'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {baseUnits.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            const on = picks.has(u.instanceId);
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                border: `1px solid ${on ? '#80dc78' : '#2a2d34'}`, borderRadius: 3, fontSize: 12,
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(u.instanceId)} />
                {t?.name ?? u.typeId}
                {t && t.transport.capacity > 0 && <span style={{ color: '#80dc78', fontSize: 10 }}>+{t.transport.capacity} cap</span>}
                {t && t.transport.restriction && <span style={{ color: '#ffaaaa', fontSize: 10 }}>needs ride</span>}
                {t && t.theater === 'ground' && t.class !== 'structure' && <span style={{ color: '#ffaaaa', fontSize: 10 }}>ground</span>}
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" disabled={!sysId}
            onClick={() => sysId && onPick(sysId, [...picks])}
          >Move {picks.size} unit{picks.size === 1 ? '' : 's'}</button>
          <button className="tab-button" onClick={() => setPicks(new Set())}>Select none</button>
          <button className="tab-button" onClick={() => setPicks(new Set(choice.candidateUnitIds))}>Select all</button>
        </div>
      </div>
    </div>
  );
}

function IndependentOperationEvacPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { fromSystemId: string; candidateSystemIds: string[]; groundUnitIds: string[] };
  onPick: (sysId: string) => void;
}) {
  const fromName = G.catalog.systems[choice.fromSystemId]?.name ?? choice.fromSystemId;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 520, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>Independent Operation — pick evac destination</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Lando placed in {fromName}; your {choice.groundUnitIds.length} ground unit{choice.groundUnitIds.length === 1 ? '' : 's'} there
          {' '}must retreat to one of your other Imperial-occupied systems.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {choice.candidateSystemIds.map((sid) => (
            <button key={sid} className="tab-button" onClick={() => onPick(sid)} style={{ textAlign: 'left' }}>
              {G.catalog.systems[sid]?.name ?? sid}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HiddenFleetUnitPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'HiddenFleetUnitPick'; side: Side; targetSystemId: string; candidateUnitIds: string[] };
  onPick: (ids: string[]) => void;
}) {
  const sysName = G.catalog.systems[choice.targetSystemId]?.name ?? choice.targetSystemId;
  const baseUnits = G.map.rebelBaseSpace.units.filter((u) => choice.candidateUnitIds.includes(u.instanceId));
  const [picks, setPicks] = useState<Set<string>>(() => new Set(choice.candidateUnitIds));
  const toggle = (uid: string) => {
    const next = new Set(picks);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    setPicks(next);
  };
  // Live capacity hint (no validation — engine checks on submit).
  let cap = 0, riders = 0;
  for (const uid of picks) {
    const u = baseUnits.find((x) => x.instanceId === uid);
    if (!u) continue;
    const t = G.catalog.unitTypes[u.typeId];
    if (!t) continue;
    if (t.transport.capacity > 0) cap += t.transport.capacity;
    if (t.transport.restriction || (t.theater === 'ground' && t.class !== 'structure')) riders++;
  }
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 580, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Hidden Fleet — pick units to move to {sysName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
          Adjacency bypassed; transport rules still apply. Capital ships carry fighters/ground (1 capacity each).
        </div>
        <div style={{ color: cap >= riders ? '#80dc78' : '#ff8866', fontSize: 12, marginBottom: 8 }}>
          Capacity: {cap} · Riders needing transport: {riders}
          {cap >= riders ? '' : ' (insufficient transport)'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {baseUnits.map((u) => {
            const t = G.catalog.unitTypes[u.typeId];
            const on = picks.has(u.instanceId);
            return (
              <label key={u.instanceId} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                border: `1px solid ${on ? '#80dc78' : '#2a2d34'}`, borderRadius: 3, fontSize: 12,
              }}>
                <input type="checkbox" checked={on} onChange={() => toggle(u.instanceId)} />
                {t?.name ?? u.typeId}
                {t && t.transport.capacity > 0 && (
                  <span style={{ color: '#80dc78', fontSize: 10 }}>+{t.transport.capacity} cap</span>
                )}
                {t && t.transport.restriction && (
                  <span style={{ color: '#ffaaaa', fontSize: 10 }}>needs ride</span>
                )}
                {t && t.theater === 'ground' && t.class !== 'structure' && (
                  <span style={{ color: '#ffaaaa', fontSize: 10 }}>ground</span>
                )}
              </label>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active" onClick={() => onPick([...picks])}>
            Move {picks.size} unit{picks.size === 1 ? '' : 's'}
          </button>
          <button className="tab-button" onClick={() => setPicks(new Set())}>Select none</button>
          <button className="tab-button" onClick={() => setPicks(new Set(choice.candidateUnitIds))}>Select all</button>
        </div>
      </div>
    </div>
  );
}

function TemporaryAllianceBuildPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'TemporaryAllianceBuildPick'; side: Side; systemId: string; icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[] };
  onPick: (picks: (string | null)[]) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  // Build legal-unit-type list per icon.
  const legalForIcon = (icon: { theater: string; shape: string }): string[] => {
    const need = tierRank[icon.shape] ?? 2;
    return Object.values(G.catalog.unitTypes)
      .filter((t) => t.side === 'Rebel'
        && t.theater === icon.theater
        && (tierRank[t.tier ?? 'square'] ?? 2) === need
        // Structures (Shield Generator / Ion Cannon / Golan Turret) ARE legal on
        // a ground build icon (#161, #209) — don't exclude them.
        // RoE units are only buildable when the expansion's unit toggle is on
        // (base-game build must not offer U-Wing / Nebulon-B / etc.).
        && (t.set !== 'rote' || G.expansion?.roeUnits === true))
      .map((t) => t.id);
  };
  const defaults = choice.icons.map((icon) => {
    const opts = legalForIcon(icon);
    return opts[opts.length - 1] ?? null; // highest tier ≤ icon
  });
  const [picks, setPicks] = useState<(string | null)[]>(defaults);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Temporary Alliance — pick units for {sysName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          One pick per resource icon. Skip an icon to leave that slot empty.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {choice.icons.map((icon, i) => {
            const opts = legalForIcon(icon);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#aaa', minWidth: 110 }}>
                  {icon.theater} · {icon.shape}
                </span>
                <select
                  value={picks[i] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setPicks((prev) => { const next = [...prev]; next[i] = v; return next; });
                  }}
                  style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px', minWidth: 200 }}
                >
                  <option value="">— skip this icon —</option>
                  {opts.map((tid) => (
                    <option key={tid} value={tid}>{G.catalog.unitTypes[tid]?.name ?? tid}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <button className="tab-button active" onClick={() => onPick(picks)}>
          Add to build queue
        </button>
      </div>
    </div>
  );
}

function BuildFromIconsPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'BuildFromIconsPick'; side: Side; systemId: string; label: string; icons: { theater: 'space' | 'ground'; shape: 'triangle' | 'circle' | 'square' }[] };
  onPick: (picks: (string | null)[]) => void;
}) {
  const sysName = G.catalog.systems[choice.systemId]?.name ?? choice.systemId;
  const tierRank: Record<string, number> = { triangle: 0, circle: 1, square: 2 };
  const legalForIcon = (icon: { theater: string; shape: string }): string[] => {
    const need = tierRank[icon.shape] ?? 2;
    return Object.values(G.catalog.unitTypes)
      .filter((t) => t.side === choice.side
        && t.theater === icon.theater
        && (tierRank[t.tier ?? 'square'] ?? 2) === need
        // Structures ARE buildable from a ground build icon (#161, #209).
        && !PROJECT_ONLY_UNIT_IDS.has(t.id)
        // RoE units only buildable when the expansion's unit toggle is on.
        && (t.set !== 'rote' || G.expansion?.roeUnits === true))
      .map((t) => t.id);
  };
  const defaults = choice.icons.map((icon) => {
    const opts = legalForIcon(icon);
    return opts[opts.length - 1] ?? null; // highest tier <= icon
  });
  const [picks, setPicks] = useState<(string | null)[]>(defaults);
  const accent = choice.side === 'Rebel' ? '#aae0ff' : '#ffaaaa';
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: `2px solid ${accent}`, borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: accent, marginTop: 0 }}>{choice.label} — build units at {sysName}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          One unit per resource icon (choose among the units that match that icon's size). Skip an icon to leave that slot empty.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {choice.icons.map((icon, i) => {
            const opts = legalForIcon(icon);
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#aaa', minWidth: 110 }}>{icon.theater} · {icon.shape}</span>
                <select
                  value={picks[i] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    setPicks((prev) => { const next = [...prev]; next[i] = v; return next; });
                  }}
                  style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px', minWidth: 200 }}
                >
                  <option value="">— skip this icon —</option>
                  {opts.map((tid) => (
                    <option key={tid} value={tid}>{G.catalog.unitTypes[tid]?.name ?? tid}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
        <button className="tab-button active" onClick={() => onPick(picks)}>
          Add to build queue
        </button>
      </div>
    </div>
  );
}

function ContingencyPlanPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'ContingencyPlanPick'; side: Side; leaderId: string; candidates: string[] };
  onPick: (missionId: string) => void;
}) {
  const ldr = G.catalog.leaders[choice.leaderId];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Contingency Plan — re-assign {ldr?.name ?? choice.leaderId}</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Pick a starting mission from your hand to assign this leader to.
          You can pick one that was already attempted or resolved this round.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {choice.candidates.map((mid) => {
            const m = G.catalog.missions[mid];
            return (
              <button key={mid} className="tab-button" onClick={() => onPick(mid)} style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 600 }}>{m?.name ?? mid}</div>
                {m?.rulesText && <div style={{ fontSize: 10, opacity: 0.8 }}>{m.rulesText}</div>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GameOverModal({
  winner, winReason, humanSide, onDismiss,
}: {
  winner: Side | null;
  winReason: string | null;
  humanSide: Side;
  onDismiss: () => void;
}) {
  const won = winner != null && winner === humanSide;
  // Plain-language explanation of HOW the game ended.
  const reasonText = (() => {
    switch (winReason) {
      case 'base-captured':
        return 'The Empire found and captured the Rebel base.';
      case 'reputation-time':
        return 'The Rebellion survived long enough — the reputation marker reached the time marker, so the Rebels win.';
      case 'max-rounds-reached':
        return 'The game reached its final round.';
      default:
        return winReason ? `Game ended: ${winReason}.` : 'The game has ended.';
    }
  })();
  const accent = winner ? sideColor(winner) : '#888';
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6000,
    }}
      onClick={onDismiss}
    >
      <div style={{
        background: won ? '#13241a' : '#241313',
        border: `3px solid ${accent}`, borderRadius: 8,
        padding: '28px 32px', maxWidth: 480, width: '92%', textAlign: 'center',
        boxShadow: '0 12px 48px rgba(0,0,0,0.8)',
      }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 34, fontWeight: 800, color: won ? '#7be08a' : '#e88', marginBottom: 4 }}>
          {won ? 'Victory!' : 'Defeat'}
        </div>
        <div style={{ fontSize: 16, color: accent, fontWeight: 600, marginBottom: 14 }}>
          {winner ? `${winner} wins` : 'Game over'}
          {winner && humanSide ? ` — you played ${humanSide}` : ''}
        </div>
        <div style={{ fontSize: 14, color: '#cfd2d6', lineHeight: 1.5, marginBottom: 20 }}>
          {reasonText}
        </div>
        <button className="tab-button active" onClick={onDismiss} style={{ padding: '8px 20px' }}>
          Close
        </button>
      </div>
    </div>
  );
}

function RapidMobilizationBranchModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RapidMobilizationBranch'; side: Side; twoLeaders: boolean; baseRevealed: boolean;
    moveUnitsAvailable: boolean; drawnProbeIds?: string[]; baseCandidates?: string[] };
  onPick: (branch: 'move-units' | 'establish-base') => void;
}) {
  const n = choice.twoLeaders ? 8 : 4;
  // The probes are drawn and LOOKED AT before you decide (RR p.11). Show the
  // systems they name — these are eliminated as base locations, and if you keep
  // your base they go to the bottom of the deck (so you know what's down there).
  const probeNames = (choice.drawnProbeIds ?? [])
    .map((pid) => G.catalog.probes[pid]?.systemId)
    .map((sid) => (sid ? (G.catalog.systems[sid]?.name ?? sid) : '?'));
  const candidateSet = new Set(choice.baseCandidates ?? []);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Rapid Mobilization — choose</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          Two leaders: {choice.twoLeaders ? 'yes (8 probes for new-base pick)' : 'no (4 probes for new-base pick)'}.
          Base currently {choice.baseRevealed ? 'REVEALED' : 'hidden'}. Only "Establish a new Rebel Base" relocates you.
        </div>
        {probeNames.length > 0 && (
          <div style={{ background: '#0c0d10', border: '1px solid #2a2d34', borderRadius: 4,
            padding: '8px 10px', marginBottom: 10, fontSize: 12, color: '#cfd2d6' }}>
            <div style={{ color: '#aae0ff', fontWeight: 600, marginBottom: 4 }}>
              Probe cards drawn (you looked at these — {n} of them):
            </div>
            {(choice.drawnProbeIds ?? []).map((pid, i) => {
              const sid = G.catalog.probes[pid]?.systemId;
              const legal = sid ? candidateSet.has(sid) : false;
              return (
                <span key={pid} style={{ display: 'inline-block', marginRight: 8,
                  color: legal ? '#7be08a' : '#888' }}>
                  {probeNames[i]}{legal ? '' : ' (not a legal base)'}
                </span>
              );
            })}
            <div style={{ color: '#9a937f', fontSize: 11, marginTop: 4 }}>
              If you keep your base, these are shuffled to the BOTTOM of the probe deck.
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button className="tab-button"
            disabled={!choice.moveUnitsAvailable}
            onClick={() => onPick('move-units')}
            style={{ textAlign: 'left', opacity: choice.moveUnitsAvailable ? 1 : 0.5 }}
            title={choice.moveUnitsAvailable ? '' : 'A revealed base cannot be kept — Rapid Mobilization must establish a new (hidden) base.'}
          >
            <div style={{ fontWeight: 600 }}>Keep current base (move up to 5 units to it)</div>
            <div style={{ fontSize: 10, opacity: 0.8 }}>
              {choice.moveUnitsAvailable
                ? 'Your base stays where it is. Optionally pull up to 5 Rebel units from one system to it (ignores adjacency); you can also move none.'
                : 'Unavailable: a REVEALED base cannot be kept via Rapid Mobilization — you must establish a new hidden base below.'}
            </div>
          </button>
          <button className="tab-button" onClick={() => onPick('establish-base')} style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600 }}>Relocate — establish a new Rebel Base</div>
            <div style={{ fontSize: 10, opacity: 0.8 }}>
              {choice.baseRevealed
                ? 'Pick any system on the map to be the new base.'
                : `Draw ${n} probe cards; pick one of those systems as the new hidden base.`}
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function RapidMobilizationMovePickModal({
  G, onPick,
}: {
  G: GameState;
  onPick: (systemId: string, unitInstanceIds: string[]) => void;
}) {
  const [sysId, setSysId] = useState<string | null>(null);
  const [picks, setPicks] = useState<Set<string>>(new Set());
  // RAW (rr p.2): you cannot move units out of a system that contains your
  // own leader — and Rapid Mobilization does NOT lift that. So a system with
  // a Rebel leader in it can't be a source, even though it has Rebel units.
  const rebelSystems = Object.keys(G.map.systems).filter(
    (sid) => G.map.systems[sid].units.some((u) => u.side === 'Rebel')
      && (G.rebel.leadersOnBoard[sid] ?? []).length === 0
  );
  // Immobile structures (Shield Generator / Ion Cannon / Golan Turret) can't be
  // moved by Rapid Mobilization — don't offer them as movable units (BGG report).
  const units = sysId
    ? G.map.systems[sysId].units.filter(
        (u) => u.side === 'Rebel' && !G.catalog.unitTypes[u.typeId]?.transport.immobile)
    : [];
  const toggle = (uid: string) => {
    const next = new Set(picks);
    if (next.has(uid)) next.delete(uid);
    else if (next.size < 5) next.add(uid);
    setPicks(next);
  };
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 640, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Rapid Mobilization — move units</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8 }}>
          Pick a source system and up to 5 Rebel units to move into the Rebel Base space (ignores adjacency).
          Systems containing one of your own leaders can't be a source — a friendly leader locks its units in place (rr p.2).
        </div>
        <div style={{ marginBottom: 10 }}>
          <select value={sysId ?? ''}
            onChange={(e) => { setSysId(e.target.value || null); setPicks(new Set()); }}
            style={{ background: '#0c0d10', color: '#e8e8ea', border: '1px solid #3a3d44', padding: '4px 8px' }}
          >
            <option value="">— pick a source system —</option>
            {rebelSystems.map((sid) => (
              <option key={sid} value={sid}>{G.catalog.systems[sid]?.name ?? sid}</option>
            ))}
          </select>
        </div>
        {sysId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            {units.map((u) => {
              const t = G.catalog.unitTypes[u.typeId];
              const on = picks.has(u.instanceId);
              return (
                <label key={u.instanceId} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px',
                  border: `1px solid ${on ? '#80dc78' : '#2a2d34'}`, borderRadius: 3, fontSize: 12,
                }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(u.instanceId)} />
                  {t?.name ?? u.typeId}
                </label>
              );
            })}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tab-button active"
            disabled={!sysId || picks.size === 0}
            onClick={() => sysId && onPick(sysId, [...picks])}
          >Move {picks.size} unit{picks.size === 1 ? '' : 's'} to base</button>
          <button className="tab-button"
            onClick={() => onPick(sysId ?? '', [])}
            title="Keep your base where it is and move no units"
          >Keep base, move nothing</button>
        </div>
      </div>
    </div>
  );
}

function RapidMobilizationBasePickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RapidMobilizationBasePick'; side: Side; baseRevealed: boolean; probeSystemIds?: string[] };
  onPick: (systemId: string) => void;
}) {
  // RR: establishing a new base always picks from the drawn probe cards (4 or
  // 8), whether or not the old base was revealed. The new base is hidden.
  const candidates = choice.probeSystemIds ?? [];
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #aae0ff', borderRadius: 6,
        padding: 20, maxWidth: 560, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#aae0ff', marginTop: 0 }}>Rapid Mobilization — establish new base</h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          {candidates.length === 0
            ? 'None of the drawn probe systems are legal (all have Imperial loyalty, Imperial units, or are destroyed). You cannot establish a new base this round.'
            : `Pick one of the ${candidates.length} systems drawn from probes as the new hidden Rebel Base.`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {candidates.map((sid) => (
            <button key={sid} className="tab-button" onClick={() => onPick(sid)} style={{ textAlign: 'left' }}>
              {G.catalog.systems[sid]?.name ?? sid}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function RetrieveThePlansPickModal({
  G, choice, onPick,
}: {
  G: GameState;
  choice: { kind: 'RetrieveThePlansPick'; side: Side; candidates: string[] };
  onPick: (objectiveId: string) => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5000,
    }}>
      <div style={{
        background: '#15171c', border: '2px solid #ffaaaa', borderRadius: 6,
        padding: 20, maxWidth: 720, width: '92%', maxHeight: '88vh', overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
      }}>
        <h3 style={{ color: '#ffaaaa', marginTop: 0 }}>
          Retrieve The Plans — pick one Rebel objective to bottom-of-deck
        </h3>
        <div style={{ color: '#aaa', fontSize: 12, marginBottom: 10 }}>
          The Rebel's objective hand is revealed below. Pick one to send to
          the bottom of the objective deck (delaying its trigger).
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {choice.candidates.map((oid) => {
            const obj = G.catalog.objectives[oid];
            return (
              <button key={oid} onClick={() => onPick(oid)}
                style={{
                  textAlign: 'left', padding: 8, width: 200,
                  background: '#0c0d10', border: '1px solid #2a2d34',
                  borderRadius: 4, color: '#e8e8ea', cursor: 'pointer',
                }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{obj?.name ?? oid}</div>
                <div style={{ color: '#80dc78', fontSize: 11 }}>
                  Reputation: {obj?.reputation ?? '?'} · {obj?.timing ?? ''}
                </div>
                {obj?.rulesText && (
                  <div style={{ color: '#cbc4b0', fontSize: 11, marginTop: 4, lineHeight: 1.3 }}>
                    {obj.rulesText}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function archiveCompletedGame(G: GameState): void {
  try {
    const raw = localStorage.getItem(LS_HISTORY);
    const history: Array<{ encodedAt: string; winner?: string; winReason?: string; codec: string; humanSide?: string }> =
      raw ? JSON.parse(raw) : [];
    const codec = canEncode(G) ? encode(G) : null;
    if (!codec) return;
    // Capture which side the human played so log analysts (and the AI-
    // improvement loop) can tell at a glance whether the AI was Empire
    // or Rebel. Read from the same localStorage key the play tab uses
    // for the current human-side preference.
    const humanSide = (() => {
      try { return localStorage.getItem(LS_HUMAN_SIDE) || undefined; } catch { return undefined; }
    })();
    history.unshift({
      encodedAt: new Date().toISOString(),
      winner: G.winner,
      winReason: G.winReason,
      codec,
      humanSide,
    });
    while (history.length > HISTORY_CAP) history.pop();
    localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  } catch (e) {
    console.warn('archive failed', e);
  }
}

/** Rise of the Empire opt-in panel. Default closed (base game); the master
 *  switch reveals the sub-toggles. See docs/rise-of-the-empire.md. */
function ExpansionPanel({ cfg, onChange }: {
  cfg: ExpansionConfig;
  onChange: (patch: Partial<ExpansionConfig>) => void;
}) {
  const labelStyle: React.CSSProperties = {
    color: '#cbc4b0', fontSize: 12, display: 'inline-flex',
    alignItems: 'center', gap: 6, cursor: 'pointer',
  };
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
      padding: '8px 12px', border: '1px solid #2c2e36', borderRadius: 4,
      background: '#101218', maxWidth: 560,
    }}>
      <label style={{ ...labelStyle, fontSize: 13, color: '#e8e6f2' }}>
        <input
          type="checkbox" checked={cfg.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        Rise of the Empire expansion
      </label>
      {cfg.enabled && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', justifyContent: 'center' }}>
          <label style={labelStyle}>
            <input type="checkbox" checked={cfg.roeUnits}
              onChange={(e) => onChange({ roeUnits: e.target.checked })} />
            RoE units
          </label>
          <label style={labelStyle}
            title="Choice of mission deck. Checked: use the Rise of the Empire mission set (expansion missions + the shared leader-icon missions). Unchecked: use the base mission set. Per the rules you play one set or the other, not both.">
            <input type="checkbox" checked={cfg.roeMissions}
              onChange={(e) => onChange({ roeMissions: e.target.checked })} />
            RoE mission set
          </label>
          <label style={labelStyle}>
            <input type="checkbox" checked={cfg.cinematicCombat}
              onChange={(e) => onChange({ cinematicCombat: e.target.checked })} />
            Cinematic Combat
          </label>
        </div>
      )}
    </div>
  );
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
