// Compute the set of valid target systems for a given mission card.
//
// Approach: scan the rulesText for the *initial clause* describing where the
// mission resolves (the first sentence), and build a stack of filters:
//   1. A territorial filter (Imperial loyalty / Rebel loyalty / neutral /
//      subjugated / populous / remote / specific-named / any).
//   2. Zero or more qualifying filters ("contains an Imperial unit",
//      "does not contain a sabotage marker", "has a blue square resource icon",
//      named-unit-list, etc.).
//
// Each detected filter pushes onto the predicate chain. If no chain produced,
// fall back to permissive ("not yet encoded").
//
// Used by both the play UI (to filter the target dropdown) and the engine's
// revealMission (to reject known-illegal targets).

import type { GameState, LeaderId, Side, SystemId } from './types';

export type TargetResult = {
  systemIds: SystemId[];
  permissive: boolean;       // true if we couldn't narrow it; caller should hint
  note?: string;
};

/** Enumerate (system, leader) pairs for leader-target missions (Collect
 *  Bounty, Detained, Capture Rebel Operative). Returns null for system-target
 *  missions; the UI then falls back to a system dropdown. */
export function missionLeaderTargets(
  G: GameState, side: Side, missionId: string
): { systemId: SystemId; leaderId: LeaderId }[] | null {
  const card = G.catalog.missions[missionId];
  if (!card || !card.rulesText) return null;
  const t = card.rulesText.toLowerCase();
  // Only on-board-Rebel-leader missions for now. Captured-leader-target
  // missions (Carbon Freezing, Daring Rescue, For The Greater Good) are
  // handled separately at the system level.
  const isLeaderTarget =
    t.includes('against a rebel leader') ||
    t.includes('against the rebel leader');
  if (!isLeaderTarget) return null;
  // Reuse the system-level filter to scope where leaders are allowed.
  const sysScope = missionTargets(G, side, missionId);
  const allowedSystems = sysScope.permissive ? Object.keys(G.map.systems) : sysScope.systemIds;
  const out: { systemId: SystemId; leaderId: LeaderId }[] = [];
  for (const sysId of allowedSystems) {
    const leaders = G.rebel.leadersOnBoard[sysId] ?? [];
    for (const lid of leaders) out.push({ systemId: sysId, leaderId: lid });
  }
  return out;
}

type Pred = (id: SystemId) => boolean;

function allSystems(G: GameState): SystemId[] {
  // Destroyed systems are removed from play (Death Star / Superlaser) — they
  // hold no loyalty, produce nothing, and can't be sabotaged, so they're never
  // a valid mission target. Excluding them here stops e.g. the AI playing Rule
  // by Fear on a system the Superlaser already destroyed (player report #112).
  return Object.keys(G.map.systems).filter((id) => !G.map.systems[id]?.destroyed);
}
function hasLeaderOfSide(G: GameState, sysId: SystemId, side: Side): boolean {
  const f = side === 'Rebel' ? G.rebel : G.empire;
  return (f.leadersOnBoard[sysId] ?? []).length > 0;
}
function unitsAt(G: GameState, sysId: SystemId) {
  return G.map.systems[sysId]?.units ?? [];
}

/** Per-clause filters, keyed off natural-language phrases. Order doesn't
 *  matter — they all stack. */
function detectQualifiers(G: GameState, t: string): { preds: Pred[]; notes: string[] } {
  const preds: Pred[] = [];
  const notes: string[] = [];

  // ----- "contains" qualifiers --------------------------------------------

  if (t.includes('contains an imperial ship') || t.includes('contains imperial ships')) {
    preds.push((id) => unitsAt(G, id).some((u) => {
      if (u.side !== 'Empire') return false;
      return G.catalog.unitTypes[u.typeId]?.theater === 'space';
    }));
    notes.push('contains an Imperial ship');
  }
  // "contains an Imperial unit" plus the RoE "with 1+ Imperial units" /
  // "with an Imperial unit" phrasing (e.g. Covert Operations).
  if (t.includes('contains an imperial unit') || t.includes('contains imperial units')
      || t.includes('1+ imperial unit') || t.includes('1 or more imperial unit')
      || t.includes('with an imperial unit') || t.includes('with imperial units')) {
    preds.push((id) => unitsAt(G, id).some((u) => u.side === 'Empire'));
    notes.push('contains an Imperial unit');
  }
  if (t.includes('contains a rebel unit') || t.includes('contains rebel units')
      || t.includes('1+ rebel unit') || t.includes('1 or more rebel unit')
      || t.includes('with a rebel unit') || t.includes('with rebel units')) {
    preds.push((id) => unitsAt(G, id).some((u) => u.side === 'Rebel'));
    notes.push('contains a Rebel unit');
  }

  // Named unit lists: "contains a Death Star", "contains a Death Star, Star
  // Destroyer or Super Star Destroyer", etc.
  // "contains a <unit>" (base) and the RoE "Resolve on a <unit>" phrasing
  // (Single Reactor Ignition, Imperial Might).
  const namedMatch = t.match(/(?:contains|on) a (?:death star|dsuc|star destroyer|super star destroyer|assault carrier|tie fighter|tie striker|stormtrooper|at-at|at-st|assault tank|interdictor|shield bunker|x-wing|y-wing|u-wing|corellian corvette|rebel transport|mon cala(?:mari)? cruiser|nebulon-b frigate|rebel trooper|rebel vanguard|airspeeder|shield generator|golan arms turret|ion cannon)[^.]*/);
  if (namedMatch) {
    const phrase = namedMatch[0];
    const unitMap: Record<string, string> = {
      'super star destroyer':  'super-star-destroyer',
      'death star':            'death-star',
      'dsuc':                  'death-star-under-construction',
      'star destroyer':        'star-destroyer',
      'assault carrier':       'assault-carrier',
      'tie fighter':           'tie-fighter',
      'tie striker':           'tie-striker',
      'stormtrooper':          'stormtrooper',
      'at-st':                 'at-st',
      'at-at':                 'at-at',
      'assault tank':          'assault-tank',
      'interdictor':           'interdictor',
      'shield bunker':         'shield-bunker',
      'x-wing':                'x-wing',
      'y-wing':                'y-wing',
      'u-wing':                'u-wing',
      'corellian corvette':    'corellian-corvette',
      'rebel transport':       'rebel-transport',
      'mon calamari cruiser':  'mon-cala-cruiser',
      'mon cala cruiser':      'mon-cala-cruiser',
      'nebulon-b frigate':     'nebulon-b-frigate',
      'rebel trooper':         'rebel-trooper',
      'rebel vanguard':        'rebel-vanguard',
      'airspeeder':            'airspeeder',
      'shield generator':      'shield-generator',
      'golan arms turret':     'golan-arms-turret',
      'ion cannon':            'ion-cannon',
    };
    const sorted = Object.entries(unitMap).sort((a, b) => b[0].length - a[0].length);
    const wanted = new Set<string>();
    let remain = phrase;
    for (const [name, typeId] of sorted) {
      if (remain.includes(name)) {
        wanted.add(typeId);
        remain = remain.split(name).join('');
      }
    }
    // "Death Star" means the COMPLETED station only (#546). The card set names
    // the DSUC explicitly whenever it's included ("Death Star, DSUC, or Shield
    // Bunker", "Death Star or DSUC", "(not a DSUC)") — so a card that says just
    // "Death Star" excludes it. An earlier blanket auto-include let Superlaser
    // Online fire the superlaser of an unfinished Death Star.
    // Belt-and-braces: honor an explicit "(not a DSUC)" even if 'dsuc' was
    // parsed from elsewhere in the sentence.
    if (t.includes('not a dsuc') || t.includes('not dsuc')) {
      wanted.delete('death-star-under-construction');
    }
    if (wanted.size > 0) {
      preds.push((id) => unitsAt(G, id).some((u) => wanted.has(u.typeId)));
      const human = [...wanted].map((tid) => G.catalog.unitTypes[tid]?.name ?? tid).join(', ');
      notes.push(`contains ${human}`);
    }
  }

  // ----- "does not contain" qualifiers ------------------------------------

  if (t.includes('does not contain a rebel unit')
      || t.includes('with no rebel units') || t.includes('no rebel units')) {
    preds.push((id) => !unitsAt(G, id).some((u) => u.side === 'Rebel'));
    notes.push('no Rebel units');
  }
  // RoE Deployment: "with no Rebel units or loyalty" — the loyalty half.
  if (t.includes('no rebel units or loyalty')) {
    preds.push((id) => G.map.systems[id]?.loyalty !== 'rebel');
    notes.push('no Rebel loyalty');
  }
  if (t.includes('does not contain an imperial unit')
      || t.includes('with no imperial units') || t.includes('no imperial units')) {
    preds.push((id) => !unitsAt(G, id).some((u) => u.side === 'Empire'));
    notes.push('no Imperial units');
  }
  if (t.includes('does not contain a sabotage marker') || t.includes('no sabotage marker')) {
    preds.push((id) => !G.map.systems[id]?.sabotage);
    notes.push('no sabotage marker');
  }
  if (t.includes('and no rebel units')) {
    // Stack with whatever territorial filter was set.
    preds.push((id) => !unitsAt(G, id).some((u) => u.side === 'Rebel'));
    notes.push('no Rebel units');
  }

  // ----- Resource-icon qualifiers ---------------------------------------
  // "Blue square resource icon" (Construct Super Star Destroyer) refers to a
  // SPACE-type resource icon of SQUARE shape — the icon that indicates the
  // system can produce capital ships of the top tier.
  if (t.includes('blue square resource icon')) {
    preds.push((id) => {
      const def = G.catalog.systems[id];
      return !!def && def.resources.some((r) => r.type === 'space' && r.shape === 'square');
    });
    notes.push('has a blue square (space) resource icon');
  }

  return { preds, notes };
}

export function missionTargets(G: GameState, _side: Side, missionId: string): TargetResult {
  const card = G.catalog.missions[missionId];
  if (!card) return { systemIds: allSystems(G), permissive: true };
  // CRITICAL: only the FIRST sentence describes the target. Subsequent
  // sentences describe the mission's effect ("Move units from the 'Rebel
  // Base' space to this system", "the closest system that contains an
  // Imperial unit", etc.) and must NOT be mistaken for target restrictions.
  const full = card.rulesText.toLowerCase();
  const t = full.split('.')[0] + '.';

  // ----- Step 1: assignment-style or captured-leader (no system target) ---

  if (t.includes('assign this leader to a starting mission')) {
    return { systemIds: allSystems(G), permissive: true, note: 'No system target (assignment-style mission).' };
  }
  // RoE oppose-timing missions (Subversion) and build-track missions
  // (Interdictor Development) have no system target at all.
  if (t.startsWith('oppose ')) {
    return { systemIds: allSystems(G), permissive: true, note: 'No system target (opposes a mission).' };
  }
  if (t.includes('on build space')) {
    return { systemIds: allSystems(G), permissive: true, note: 'No system target (resolves on the build track).' };
  }
  // "against a captured leader" / "contains a captured leader" (base) and the
  // RoE "Attempt on a captured leader" / "on a captured leader's system".
  if (t.includes('captured leader')) {
    // Per RAW: captured leaders stay at a system. The target is that system.
    const sysIds = new Set<SystemId>();
    for (const cap of G.empire.capturedLeaders ?? []) sysIds.add(cap.systemId);
    // Some of these cards add a location clause. Make An Example reads
    // "Attempt on a captured leader in a REMOTE system", but this branch used
    // to return every system holding a captive, so it could be run on a
    // populous one — the reporter saw it fire at Alderaan (#675). Read the
    // clause off the card text rather than special-casing the id, so any other
    // card phrased the same way is restricted automatically.
    const remoteOnly = t.includes('remote');
    const ids = remoteOnly
      ? [...sysIds].filter((sid) => G.catalog.systems[sid]?.isRemote)
      : [...sysIds];
    return {
      systemIds: ids,
      permissive: false,
      note: ids.length === 0
        ? (remoteOnly
          ? 'Remote systems containing a captured leader (none currently).'
          : 'Systems containing a captured leader (none currently).')
        : (remoteOnly
          ? 'Remote systems containing a captured leader.'
          : 'Systems containing a captured leader.'),
    };
  }

  // ----- Step 2: territorial / leader-target base predicate ---------------

  let basePred: Pred = () => true;
  const noteParts: string[] = [];

  // "Imperial system" (glossary RR p.8) = Imperial loyalty marker OR
  // subjugation marker. "Has Imperial loyalty" / "with Imperial loyalty" is
  // STRICT — only the loyalty marker counts (subjugation does NOT). Two
  // different predicates.
  if (t.includes('any system that has imperial loyalty')
      || t.includes('any system with imperial loyalty')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && ss.loyalty === 'imperial';
    };
    noteParts.push('Imperial-loyalty marker (not subjugation)');
  } else if (t.includes('any imperial system')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && (ss.loyalty === 'imperial' || ss.subjugated || G.catalog.systems[id]?.isCoruscant === true);
    };
    noteParts.push('Imperial-loyalty or subjugated');
  } else if (t.includes('any system that has rebel loyalty')
      || t.includes('any system with rebel loyalty')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && ss.loyalty === 'rebel';
    };
    noteParts.push('Rebel-loyalty marker');
  } else if (t.includes('subjugated or rebel system')) {
    // RoE Behind Enemy Lines: "Resolve on a subjugated or Rebel system."
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && (ss.subjugated || ss.loyalty === 'rebel');
    };
    noteParts.push('Subjugated or Rebel-loyalty');
  } else if (t.includes('any rebel system')
      || t.includes('on a rebel system') || t.includes('in a rebel system')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && ss.loyalty === 'rebel' && !ss.subjugated;
    };
    noteParts.push('Rebel-loyalty (not subjugated)');
  } else if (t.includes('on an imperial system') || t.includes('in an imperial system')) {
    // RoE phrasing of the base "any Imperial system" (glossary: loyalty OR
    // subjugation; Coruscant always counts).
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && (ss.loyalty === 'imperial' || ss.subjugated || G.catalog.systems[id]?.isCoruscant === true);
    };
    noteParts.push('Imperial-loyalty or subjugated');
  } else if (t.includes('on a sabotaged system') || t.includes('in a sabotaged system')) {
    basePred = (id) => !!G.map.systems[id]?.sabotage;
    noteParts.push('Sabotaged');
  } else if (t.includes('any neutral system')
      || t.includes('any system that has neutral loyalty')
      || t.includes('any system with neutral loyalty')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      if (!ss) return false;
      if (G.catalog.systems[id]?.isCoruscant) return false;
      return ss.loyalty === 'neutral' && !ss.subjugated;
    };
    noteParts.push('Neutral');
  } else if (t.includes('any subjugated system')
      || t.includes('on a subjugated system') || t.includes('in a subjugated system')) {
    basePred = (id) => !!G.map.systems[id]?.subjugated;
    noteParts.push('Subjugated');
  } else if (t.includes('any populous system')
      || t.includes('on a populous system') || t.includes('in a populous system')) {
    basePred = (id) => !G.catalog.systems[id]?.isRemote;
    noteParts.push('Populous (non-remote)');
  } else if (t.includes('a remote system') || t.includes('any remote system')) {
    basePred = (id) => !!G.catalog.systems[id]?.isRemote;
    noteParts.push('Remote');
  }
  // Named specific system: "in the X system" or "in the X space".
  else {
    const namedMatch = t.match(/in the "?([a-z' -]+?)"? (?:system|space)/);
    if (namedMatch) {
      const target = namedMatch[1].trim();
      if (target === 'rebel base') {
        // Resolves in the Rebel Base space — there's no system to choose.
        // Return the base-space key as the sole (auto-selected) target so
        // the assignment UI doesn't read an empty list as "no legal targets"
        // and leave Reveal permanently disabled. (Issue #52: Rapid
        // Mobilization couldn't be played at all.)
        return { systemIds: ['rebel-base-space'], permissive: false, note: 'Resolves in the Rebel Base space (auto-targeted).' };
      }
      // Match against ALL systems, including DESTROYED ones. A mission naming a
      // specific system resolves there even if it's been destroyed — official
      // FAQ: "Seek Yoda can be resolved in the Dagobah system even if Dagobah
      // has been destroyed" (#552: Wookiee Uprising on a destroyed Kashyyyk was
      // wrongly redirected to another system because allSystems() drops
      // destroyed ones, so the named match failed and it fell through to the
      // permissive path). A live-system effect (gain loyalty) simply fizzles on
      // a destroyed system; the rest of the effect still resolves.
      const match = Object.keys(G.map.systems).find((id) => (G.catalog.systems[id]?.name ?? id).toLowerCase() === target);
      if (match) {
        const destroyed = G.map.systems[match]?.destroyed ? ' (destroyed — loyalty effects fizzle)' : '';
        return { systemIds: [match], permissive: false, note: `Specific system: ${G.catalog.systems[match]?.name ?? match}${destroyed}.` };
      }
    }
  }

  // Leader-target missions: target is the matching leader's system.
  if (t.includes('rebel leader that is in a system that contains an imperial unit')) {
    basePred = (id) => hasLeaderOfSide(G, id, 'Rebel')
      && unitsAt(G, id).some((u) => u.side === 'Empire');
    noteParts.push('Rebel leader + Imperial unit present');
  } else if (t.includes('against a rebel leader') || t.includes('against the rebel leader')) {
    basePred = (id) => hasLeaderOfSide(G, id, 'Rebel');
    noteParts.push('Rebel leader present');
  } else if (t.includes('against an imperial leader') || t.includes('against the imperial leader')) {
    basePred = (id) => hasLeaderOfSide(G, id, 'Empire');
    noteParts.push('Imperial leader present');
  } else if (t.includes('against a leader')) {
    basePred = (id) => hasLeaderOfSide(G, id, 'Rebel') || hasLeaderOfSide(G, id, 'Empire');
    noteParts.push('any leader present');
  }

  // ----- Step 3: stacking qualifiers --------------------------------------

  const { preds: quals, notes: qualNotes } = detectQualifiers(G, t);
  noteParts.push(...qualNotes);

  // ----- Step 4: apply ---------------------------------------------------

  // Did we detect *any* constraint?
  const haveBase = noteParts.length > 0 || quals.length > 0;
  if (!haveBase && (t.includes('in any system') || t.includes('on any system') || t.includes('anywhere'))) {
    return { systemIds: allSystems(G), permissive: false, note: 'Any system.' };
  }
  if (!haveBase) {
    return {
      systemIds: allSystems(G),
      permissive: true,
      note: 'Target validation not encoded for this mission — all systems shown.',
    };
  }
  const finalPred: Pred = (id) => basePred(id) && quals.every((q) => q(id));
  // Destroyed systems can still hold ships and host space combat, so they ARE
  // valid targets for unit/combat missions — e.g. Plan the Assault ("attempt in
  // any system that contains an Imperial ship", then move ships + resolve
  // combat there; player report #144 — a destroyed Naboo with ships wasn't
  // offered). Only exclude destroyed systems for effects a destroyed system
  // genuinely can't host: gaining loyalty, subjugating, or sabotaging.
  // NOTE: test the FULL rules text, not just the first (target) sentence `t` —
  // the effect that needs a live system lives in a LATER sentence ("…gain 1
  // loyalty in this system"). Testing `t` alone never matched, so Rule by Fear
  // was wrongly offered on destroyed systems (player reports #112, #159).
  const effectNeedsLiveSystem = /loyalty|subjugat|sabotage/.test(full);
  const candidates = effectNeedsLiveSystem ? allSystems(G) : Object.keys(G.map.systems);
  const systemIds = candidates.filter(finalPred);
  return { systemIds, permissive: false, note: noteParts.join(' + ') + '.' };
}

// ============================================================================
// Pointless-effect evaluation
// ============================================================================
//
// Some missions are RAW-legal to attempt anywhere their target filter allows,
// but their EFFECT is conditional on board state — so at a given target they
// can succeed yet accomplish nothing (a no-op). Examples:
//   - Imperial Propaganda: flips Rebel-loyal systems in the region to neutral —
//     useless in a region with no Rebel loyalty.
//   - Draw Them Out: places a Rebel pool leader — useless with an empty pool.
//   - Single Reactor Ignition: destroys Rebel ground / removes markers — useless
//     with neither present.
// This is the single source of truth for "would this reveal pay off here?",
// shared by the AI (skip such targets) and the play UI (warn the human before
// they waste a mission). Default: not pointless. Add a case per mission.
export function missionRevealIsPointless(
  G: GameState, side: Side, missionId: string, sysId: SystemId
): boolean {
  const ss = G.map.systems[sysId];
  switch (missionId) {
    case 'imperial-propaganda': {
      // "each system in this region that has Rebel loyalty becomes neutral" —
      // a no-op when no system in the target's region is Rebel-loyal.
      const region = G.catalog.systems[sysId]?.region;
      if (region == null) return false;
      return !Object.values(G.catalog.systems).some(
        (d) => d.region === region && G.map.systems[d.id]?.loyalty === 'rebel');
    }
    case 'draw-them-out':
      // Empire places a Rebel leader from the pool here — nothing to place when
      // the Rebel pool is empty.
      return side === 'Empire' && (G.rebel.leaderPool?.length ?? 0) === 0;
    case 'single-reactor-ignition': {
      // Resolves on the Empire's own Death Star (so the Empire already occupies
      // the system and the base would have auto-revealed). It only does
      // something if there are Rebel ground units to destroy or markers to clear.
      const rebelGround = (ss?.units ?? []).some(
        (u) => u.side === 'Rebel' && G.catalog.unitTypes[u.typeId]?.theater === 'ground');
      const markers = (ss?.targetMarkers?.length ?? 0) > 0;
      return !rebelGround && !markers;
    }
    case 'hidden-fleet': {
      // "Move units from the 'Rebel Base' space to this system" — RAW bypasses
      // adjacency but NOT transport (see the handler). A no-op when the base
      // space holds no DELIVERABLE units: immobile structures never move, and
      // ground can't move without a co-moving carrier's capacity. Just counting
      // units missed the common case where the base space holds only a lone
      // trooper + structures and the target has no ships — moving nothing
      // (players #553/#554: AI Rebel ran Hidden Fleet twice on a shipless system,
      // each a wasted card). Mirrors behind-enemy-lines' deliverability test.
      // The handler reads rebelBaseSpace directly, so post-reveal it's empty →
      // correctly pointless.
      const baseUnits = G.map.rebelBaseSpace?.units ?? [];
      let ships = 0, ground = 0, capacity = 0;
      for (const u of baseUnits) {
        if (u.side !== 'Rebel') continue;
        const t = G.catalog.unitTypes[u.typeId];
        if (!t || t.transport.immobile || t.class === 'structure') continue;
        if (t.theater === 'ground') ground++;
        else { ships++; if (t.transport.capacity > 0) capacity += t.transport.capacity; }
      }
      return ships + Math.min(ground, capacity) === 0;
    }
    case 'safe-haven': {
      // "Take up to 2 units from the build queue and deploy them here." The
      // ENTIRE effect is deploying queued units — a total no-op when the Rebel
      // build queue is empty (the handler just logs an empty deploy and the
      // mission is wasted). (#594: AI Rebel ran Safe Haven with 0 units queued.)
      // Equally a no-op on a sabotaged system: RR p.13 blocks any ability that
      // DEPLOYS units there, and markers "affect both factions equally" (#646).
      if (ss?.sabotage) return true;
      const anyQueued = ([1, 2, 3] as const).some((s) => (G.rebel.buildQueue[s]?.length ?? 0) > 0);
      return !anyQueued;
    }
    case 'imperial-might': {
      // "Take 4 Imperial units from space 1 of the build queue and place them in
      // this system. If 2 leaders are assigned, move those leaders to
      // Coruscant." The Empire's mirror of Safe Haven: the deploy IS the card,
      // so an empty space 1 makes it a total no-op — the handler logs an empty
      // deploy and the mission is spent for nothing (#689: the AI Empire ran it
      // on its Death Star at Dagobah with ALL THREE build spaces empty). The
      // leader clause is no reason to play it either — sending your own two
      // leaders back to Coruscant is the card's price, not its payoff.
      // Sabotage blocks the deploy outright (RR p.13), as for Safe Haven.
      if (ss?.sabotage) return true;
      return (G.empire.buildQueue[1]?.length ?? 0) === 0;
    }
    case 'oversee-project': {
      // "Choose 1 Imperial unit on space 1 or 2 of the build queue and deploy it
      // in this system." Nothing but a deploy, so it accomplishes nothing on a
      // sabotaged system (RR p.13) or with build spaces 1 and 2 both empty
      // (#646 — the AI ran it on a sabotaged Alderaan and the units landed
      // anyway; the deploy is now blocked, which would leave a wasted mission).
      if (ss?.sabotage) return true;
      return ([1, 2] as const).every((s) => (G.empire.buildQueue[s]?.length ?? 0) === 0);
    }
    case 'hunt-them-down':
    case 'hit-and-run':
    case 'rogue-squadron-raid': {
      // "Destroy up to N health worth of units of your choice IN THE SYSTEM" —
      // a no-op when the opponent has no destroyable units there. The Empire
      // shouldn't waste Hunt Them Down on a system with no Rebel units, and the
      // Rebel raids likewise need Imperial units present (#326).
      const opp: Side = side === 'Empire' ? 'Rebel' : 'Empire';
      return !(ss?.units ?? []).some(
        (u) => u.side === opp && G.catalog.unitTypes[u.typeId]?.health.color !== null);
    }
    case 'wookie-uprising': {
      // "Gain 1 loyalty in Kashyyyk AND destroy up to 4 health of Empire units
      // there." Both halves can be no-ops at once: gainLoyalty is inert when the
      // system is already Rebel-loyal (logs loyalty-already), and the destroy
      // does nothing with no Empire units present. Pointless only when BOTH hold
      // (#578: Rebel AI ran it on already-loyal Kashyyyk with 0 Empire units —
      // two leaders and a mission wasted for no gain).
      if (ss?.loyalty !== 'rebel') return false;
      return !(ss?.units ?? []).some(
        (u) => u.side === 'Empire' && G.catalog.unitTypes[u.typeId]?.health.color !== null);
    }
    case 'superlaser-online': {
      // Fires at the Death Star's OWN system, destroying everything there —
      // including the Empire's own escorts. Worth it only when there's Rebel
      // value to destroy: Rebel units (incl. the base, which always has units)
      // or a Rebel-loyal system. Otherwise it's self-harm for a marginal loyalty
      // tick — the AI shouldn't blow up its own forces over rubble (#313).
      if (side !== 'Empire') return false;
      const hasRebelUnits = (ss?.units ?? []).some((u) => u.side === 'Rebel');
      const rebelLoyal = ss?.loyalty === 'rebel';
      return !hasRebelUnits && !rebelLoyal;
    }
    case 'assault':
      // Destroys up to 3 Empire STORMTROOPERS at a subjugated system (the handler
      // targets typeId === 'stormtrooper' only, not AT-STs/AT-ATs). A no-op when
      // the target holds no Stormtroopers to destroy (#406: AI ran Assault on a
      // subjugated system with none, wasting the card).
      return !(ss?.units ?? []).some((u) => u.side === 'Empire' && u.typeId === 'stormtrooper');
    case 'behind-enemy-lines': {
      // "Move 5 units from the Rebel Base" — a no-op when the base location holds
      // no DELIVERABLE units: ships move themselves; ground needs co-located
      // carrier capacity (transport is NOT waived). With nothing movable the card
      // is wasted (#405: AI ran it but moved no units).
      const baseLoc = G.rebelBaseRevealed ? G.rebelBaseSystemId : null;
      const baseUnits = baseLoc ? (G.map.systems[baseLoc]?.units ?? []) : (G.map.rebelBaseSpace?.units ?? []);
      let ships = 0, ground = 0, capacity = 0;
      for (const u of baseUnits) {
        if (u.side !== 'Rebel') continue;
        const t = G.catalog.unitTypes[u.typeId];
        if (!t || t.transport.immobile || t.class === 'structure') continue;
        if (t.theater === 'ground') ground++;
        else { ships++; if (t.transport.capacity > 0) capacity += t.transport.capacity; }
      }
      return ships + Math.min(ground, capacity) === 0;
    }
    case 'plant-explosives':
      // Destroys Empire GROUND units (health.color !== null) up to the success
      // margin — a no-op when the target holds no such ground (mirrors Assault).
      return !(ss?.units ?? []).some((u) => u.side === 'Empire'
        && G.catalog.unitTypes[u.typeId]?.theater === 'ground'
        && G.catalog.unitTypes[u.typeId]?.health.color !== null);
    case 'plan-the-assault': {
      // Moves Rebel SHIPS from the base to a system with an Imperial ship, then
      // combat. The handler resolves WITHOUT combat when no Rebel ships are at the
      // base — wasted. (Source follows the base: base space pre-reveal, the base's
      // system after.)
      const baseLoc = G.rebelBaseRevealed ? G.rebelBaseSystemId : null;
      const baseUnits = baseLoc ? (G.map.systems[baseLoc]?.units ?? []) : (G.map.rebelBaseSpace?.units ?? []);
      return !baseUnits.some((u) => u.side === 'Rebel'
        && G.catalog.unitTypes[u.typeId]?.theater === 'space');
    }
    case 'lead-the-strike-team': {
      // Moves up to 4 Rebel ground units from the base (transport ignored). With
      // no movable ground there it only "resolves combat" at the target, which
      // does nothing unless the Rebel already has units there to fight — pointless
      // only when BOTH hold.
      const baseLoc = G.rebelBaseRevealed ? G.rebelBaseSystemId : null;
      const baseUnits = baseLoc ? (G.map.systems[baseLoc]?.units ?? []) : (G.map.rebelBaseSpace?.units ?? []);
      const hasGround = baseUnits.some((u) => {
        const t = G.catalog.unitTypes[u.typeId];
        return u.side === 'Rebel' && t?.theater === 'ground' && !t.transport.immobile;
      });
      if (hasGround) return false;
      // Nothing to move from base → the only effect is "resolve combat" at the
      // target, which does something ONLY if a fight can actually happen there,
      // i.e. the target holds BOTH Rebel and Empire units. Rebel-only (the AI's
      // own quiet system, #455) or Empire-only means no combat → pointless.
      const tgt = ss?.units ?? [];
      const rebelThere = tgt.some((u) => u.side === 'Rebel');
      const empireThere = tgt.some((u) => u.side === 'Empire');
      return !(rebelThere && empireThere);
    }
    case 'demolition': {
      // Destroys queued Empire units that match this system's resource icons
      // (theater + tier; stations never match a build icon). A no-op when nothing
      // currently queued matches any of the system's icons.
      const def = G.catalog.systems[sysId];
      if (!def) return false;
      const queued = ([1, 2, 3] as const).flatMap((s) => G.empire.buildQueue[s] ?? []);
      return !def.resources.some((icon) => queued.some((typeId) => {
        const u = G.catalog.unitTypes[typeId];
        return u != null && u.class !== 'station' && u.theater === icon.type && u.tier === icon.shape;
      }));
    }
    case 'heist': {
      // "Remove 1 target marker. If on a Death Star or DSUC, you MAY draw the top
      // objective instead." With no Death Star/DSUC present, the only effect is
      // removing a marker — a no-op when the target holds none (the handler itself
      // logs heist-no-effect here). The DS/DSUC draw keeps it worthwhile otherwise.
      // (Playtester report: Rebel AI ran Heist on a system with nothing to gain.)
      const hasDsOrDsuc = (ss?.units ?? []).some((u) => u.side === 'Empire'
        && (u.typeId === 'death-star' || u.typeId === 'death-star-under-construction'));
      if (hasDsOrDsuc) return false;
      return (ss?.targetMarkers?.length ?? 0) === 0;
    }
    case 'long-range-probe': {
      // "If successful, the Rebel player must tell you if the base is in this
      // system." The answer is already known — so the reveal is wasted — when:
      //  • the base is already revealed; or
      //  • the system has Imperial loyalty or Empire ground (either would have
      //    auto-revealed the base were it here — recomputeRebelBaseReveal); or
      //  • a prior probe/LRP already ruled the system out.
      // (#435: AI probed Alderaan where it already held ground — a guaranteed
      // "no".) Empire-only; nothing to learn for the Rebel.
      if (side !== 'Empire') return false;
      if (G.rebelBaseRevealed) return true;
      if (ss?.loyalty === 'imperial') return true;
      if ((ss?.units ?? []).some((u) => u.side === 'Empire'
        && G.catalog.unitTypes[u.typeId]?.theater === 'ground')) return true;
      if (G.empireSearchedRuledOut?.includes(sysId)) return true;
      return (G.empire.probeHand ?? [])
        .some((pid) => G.catalog.probes[pid]?.systemId === sysId);
    }
    default:
      return false;
  }
}

/** How many systems in `sysId`'s region currently hold Rebel loyalty — the
 *  "payoff size" for Imperial Propaganda. 0 means the mission would be wasted
 *  there (see missionRevealIsPointless). Exposed for AI target scoring. */
export function rebelLoyalSystemsInRegion(G: GameState, sysId: SystemId): number {
  const region = G.catalog.systems[sysId]?.region;
  if (region == null) return 0;
  return Object.values(G.catalog.systems).filter(
    (d) => d.region === region && G.map.systems[d.id]?.loyalty === 'rebel').length;
}
