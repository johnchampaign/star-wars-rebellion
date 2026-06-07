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
  if (t.includes('contains an imperial unit') || t.includes('contains imperial units')) {
    preds.push((id) => unitsAt(G, id).some((u) => u.side === 'Empire'));
    notes.push('contains an Imperial unit');
  }
  if (t.includes('contains a rebel unit') || t.includes('contains rebel units')) {
    preds.push((id) => unitsAt(G, id).some((u) => u.side === 'Rebel'));
    notes.push('contains a Rebel unit');
  }

  // Named unit lists: "contains a Death Star", "contains a Death Star, Star
  // Destroyer or Super Star Destroyer", etc.
  const namedMatch = t.match(/contains a (?:death star|star destroyer|super star destroyer|assault carrier|tie fighter|stormtrooper|at-at|at-st|x-wing|y-wing|corellian corvette|rebel transport|mon cala(?:mari)? cruiser|rebel trooper|airspeeder|shield generator|ion cannon)[^.]*/);
  if (namedMatch) {
    const phrase = namedMatch[0];
    const unitMap: Record<string, string> = {
      'super star destroyer':  'super-star-destroyer',
      'death star':            'death-star',
      'star destroyer':        'star-destroyer',
      'assault carrier':       'assault-carrier',
      'tie fighter':           'tie-fighter',
      'stormtrooper':          'stormtrooper',
      'at-st':                 'at-st',
      'at-at':                 'at-at',
      'x-wing':                'x-wing',
      'y-wing':                'y-wing',
      'corellian corvette':    'corellian-corvette',
      'rebel transport':       'rebel-transport',
      'mon calamari cruiser':  'mon-cala-cruiser',
      'mon cala cruiser':      'mon-cala-cruiser',
      'rebel trooper':         'rebel-trooper',
      'airspeeder':            'airspeeder',
      'shield generator':      'shield-generator',
      'ion cannon':            'ion-cannon',
    };
    const sorted = Object.entries(unitMap).sort((a, b) => b[0].length - a[0].length);
    const wanted = new Set<string>();
    let remain = phrase;
    for (const [name, typeId] of sorted) {
      if (remain.includes(name)) {
        wanted.add(typeId);
        if (typeId === 'death-star') wanted.add('death-star-under-construction');
        remain = remain.split(name).join('');
      }
    }
    if (wanted.size > 0) {
      preds.push((id) => unitsAt(G, id).some((u) => wanted.has(u.typeId)));
      const human = [...wanted].map((tid) => G.catalog.unitTypes[tid]?.name ?? tid).join(', ');
      notes.push(`contains ${human}`);
    }
  }

  // ----- "does not contain" qualifiers ------------------------------------

  if (t.includes('does not contain a rebel unit')) {
    preds.push((id) => !unitsAt(G, id).some((u) => u.side === 'Rebel'));
    notes.push('no Rebel units');
  }
  if (t.includes('does not contain an imperial unit')) {
    preds.push((id) => !unitsAt(G, id).some((u) => u.side === 'Empire'));
    notes.push('no Imperial units');
  }
  if (t.includes('does not contain a sabotage marker')) {
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
  if (t.includes('against a captured leader') || t.includes('contains a captured leader')) {
    // Per RAW: captured leaders stay at a system. The target is that system.
    const sysIds = new Set<SystemId>();
    for (const cap of G.empire.capturedLeaders ?? []) sysIds.add(cap.systemId);
    return {
      systemIds: [...sysIds],
      permissive: false,
      note: sysIds.size === 0
        ? 'Systems containing a captured leader (none currently).'
        : 'Systems containing a captured leader.',
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
  } else if (t.includes('any rebel system')) {
    basePred = (id) => {
      const ss = G.map.systems[id];
      return !!ss && ss.loyalty === 'rebel' && !ss.subjugated;
    };
    noteParts.push('Rebel-loyalty (not subjugated)');
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
  } else if (t.includes('any subjugated system')) {
    basePred = (id) => !!G.map.systems[id]?.subjugated;
    noteParts.push('Subjugated');
  } else if (t.includes('any populous system')) {
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
      const match = allSystems(G).find((id) => (G.catalog.systems[id]?.name ?? id).toLowerCase() === target);
      if (match) {
        return { systemIds: [match], permissive: false, note: `Specific system: ${G.catalog.systems[match]?.name ?? match}.` };
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
  if (!haveBase && (t.includes('in any system') || t.includes('anywhere'))) {
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
  // genuinely can't host: gaining loyalty, subjugating, or sabotaging — which
  // keeps the Rule by Fear exclusion intact (player report #112).
  const effectNeedsLiveSystem = /loyalty|subjugat|sabotage/.test(t);
  const candidates = effectNeedsLiveSystem ? allSystems(G) : Object.keys(G.map.systems);
  const systemIds = candidates.filter(finalPred);
  return { systemIds, permissive: false, note: noteParts.join(' + ') + '.' };
}
