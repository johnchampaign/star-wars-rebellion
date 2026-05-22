"""Audit every mission's expected target rule vs. what the engine would
produce. Mirrors src/engine/missionTargets.ts logic in Python so we can
catch divergences without booting the dev server.

Run: python scripts/audit-mission-targets.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
missions = json.load(open(ROOT / 'assets/missions.json'))['missions']
systems = json.load(open(ROOT / 'assets/systems.json'))['systems']
systems_by_id = {s['id']: s for s in systems}

# Synthesize a plausible game state for "what would the engine return."
# Loyalty: Coruscant Imperial, Mon Calamari Rebel (per typical setup), some
# subjugated systems. Imperial units on Coruscant + 2 subjugated systems.
# Rebel units in Rebel base region (we'll say Yavin).
state_loyalty = {s['id']: 'neutral' for s in systems}
state_loyalty['coruscant'] = 'imperial'
state_loyalty['mon-calamari'] = 'rebel'
state_loyalty['kashyyyk'] = 'rebel'
state_loyalty['naboo'] = 'rebel'
state_loyalty['corellia'] = 'imperial'
state_loyalty['geonosis'] = 'imperial'
state_subjugated = {s['id']: False for s in systems}
state_subjugated['saleucami'] = True
state_subjugated['mandalore'] = True
state_sabotage = {s['id']: False for s in systems}
state_sabotage['felucia'] = True
# Empire units present at:
state_empire_units = {
    'coruscant': ['stormtrooper', 'star-destroyer', 'tie-fighter'],
    'corellia': ['stormtrooper', 'star-destroyer'],
    'mandalore': ['stormtrooper'],     # subjugated, ground present
    'kessel': ['super-star-destroyer'],
    'sullust': ['death-star'],
}
state_rebel_units = {
    'yavin': ['rebel-trooper', 'x-wing'],
    'mon-calamari': ['mon-cala-cruiser'],
    'hoth': ['rebel-trooper'],
}
# Leaders on systems
state_rebel_leaders = { 'yavin': ['mon-mothma'], 'hoth': ['princess-leia'] }
state_empire_leaders = { 'corellia': ['darth-vader'] }


def has_empire_unit(sysid):
    return sysid in state_empire_units and len(state_empire_units[sysid]) > 0
def has_rebel_unit(sysid):
    return sysid in state_rebel_units and len(state_rebel_units[sysid]) > 0
def has_empire_ship(sysid):
    units = state_empire_units.get(sysid, [])
    ships = {'tie-fighter','assault-carrier','star-destroyer','super-star-destroyer','death-star','death-star-under-construction'}
    return any(u in ships for u in units)
def has_empire_leader(sysid):
    return sysid in state_empire_leaders and len(state_empire_leaders[sysid]) > 0
def has_rebel_leader(sysid):
    return sysid in state_rebel_leaders and len(state_rebel_leaders[sysid]) > 0
def has_specific_units(sysid, wanted):
    all_units = state_empire_units.get(sysid, []) + state_rebel_units.get(sysid, [])
    return any(u in wanted for u in all_units)
def has_blue_square_resource(sysid):
    s = systems_by_id.get(sysid, {})
    for r in s.get('resources', []):
        if r.get('type') == 'space' and r.get('shape') == 'square':
            return True
    return False


# Mirror the engine logic.
def engine_targets(card):
    full = card['rulesText'].lower()
    # First-sentence-only (matches engine).
    t = full.split('.')[0] + '.'
    note_parts = []
    quals_notes = []
    quals = []
    # Step 1: assignment / captured-leader.
    if 'assign this leader to a starting mission' in t:
        return ('PERMISSIVE-no-system', None)
    if 'against a captured leader' in t or 'contains a captured leader' in t:
        return ('PERMISSIVE-captured-leader', None)
    # Step 2: base predicate.
    base = None
    if ('any imperial system' in t
        or 'any system that has imperial loyalty' in t
        or 'any system with imperial loyalty' in t):
        base = 'IMPERIAL'
        base_pred = lambda id: state_loyalty[id]=='imperial' or state_subjugated[id] or systems_by_id[id].get('isCoruscant')
        note_parts.append('Imperial-loyalty or subjugated')
    elif ('any rebel system' in t
        or 'any system that has rebel loyalty' in t
        or 'any system with rebel loyalty' in t):
        base = 'REBEL'
        base_pred = lambda id: state_loyalty[id]=='rebel' and not state_subjugated[id]
        note_parts.append('Rebel-loyalty')
    elif ('any neutral system' in t
        or 'any system that has neutral loyalty' in t
        or 'any system with neutral loyalty' in t):
        base = 'NEUTRAL'
        base_pred = lambda id: state_loyalty[id]=='neutral' and not state_subjugated[id] and not systems_by_id[id].get('isCoruscant')
        note_parts.append('Neutral')
    elif 'any subjugated system' in t:
        base = 'SUBJUGATED'
        base_pred = lambda id: state_subjugated[id]
        note_parts.append('Subjugated')
    elif 'any populous system' in t:
        base = 'POPULOUS'
        base_pred = lambda id: not systems_by_id[id].get('isRemote')
        note_parts.append('Populous (non-remote)')
    elif 'a remote system' in t or 'any remote system' in t:
        base = 'REMOTE'
        base_pred = lambda id: systems_by_id[id].get('isRemote')
        note_parts.append('Remote')
    else:
        # named-system regex
        m = re.search(r'in the "?([a-z\' -]+?)"? (?:system|space)', t)
        if m:
            target = m.group(1).strip()
            if target == 'rebel base':
                return ('NAMED-rebel-base-space', None)
            for s in systems:
                if s['name'].lower() == target:
                    return (f'NAMED-{s["id"]}', [s['id']])
        base_pred = lambda id: True

    # Leader-target overrides base.
    if 'rebel leader that is in a system that contains an imperial unit' in t:
        base = 'REBEL-LEADER-AND-IMPERIAL-UNIT'
        base_pred = lambda id: has_rebel_leader(id) and has_empire_unit(id)
        note_parts.append('Rebel leader + Imperial unit present')
    elif 'against a rebel leader' in t or 'against the rebel leader' in t:
        base = 'REBEL-LEADER'
        base_pred = lambda id: has_rebel_leader(id)
        note_parts.append('Rebel leader present')
    elif 'against an imperial leader' in t or 'against the imperial leader' in t:
        base = 'EMPIRE-LEADER'
        base_pred = lambda id: has_empire_leader(id)
        note_parts.append('Imperial leader present')
    elif 'against a leader' in t:
        base = 'ANY-LEADER'
        base_pred = lambda id: has_rebel_leader(id) or has_empire_leader(id)
        note_parts.append('any leader present')

    # Step 3: qualifiers.
    if 'contains an imperial ship' in t or 'contains imperial ships' in t:
        quals.append(has_empire_ship); quals_notes.append('contains an Imperial ship')
    if 'contains an imperial unit' in t or 'contains imperial units' in t:
        quals.append(has_empire_unit); quals_notes.append('contains an Imperial unit')
    if 'contains a rebel unit' in t or 'contains rebel units' in t:
        quals.append(has_rebel_unit); quals_notes.append('contains a Rebel unit')
    nm = re.search(r'contains a (?:death star|star destroyer|super star destroyer|assault carrier|tie fighter|stormtrooper|at-at|at-st|x-wing|y-wing|corellian corvette|rebel transport|mon cala(?:mari)? cruiser|rebel trooper|airspeeder|shield generator|ion cannon)[^.]*', t)
    if nm:
        phrase = nm.group(0)
        unit_map = {
            'super star destroyer': 'super-star-destroyer',
            'death star': 'death-star',
            'star destroyer': 'star-destroyer',
        }
        wanted = set()
        remain = phrase
        for name, tid in sorted(unit_map.items(), key=lambda x: -len(x[0])):
            if name in remain:
                wanted.add(tid)
                if tid == 'death-star':
                    wanted.add('death-star-under-construction')
                remain = remain.replace(name, '')
        if wanted:
            quals.append(lambda id, w=wanted: has_specific_units(id, w))
            quals_notes.append(f'contains specific units')
    if 'does not contain a rebel unit' in t:
        quals.append(lambda id: not has_rebel_unit(id)); quals_notes.append('no Rebel units')
    if 'does not contain an imperial unit' in t:
        quals.append(lambda id: not has_empire_unit(id)); quals_notes.append('no Imperial units')
    if 'does not contain a sabotage marker' in t:
        quals.append(lambda id: not state_sabotage[id]); quals_notes.append('no sabotage marker')
    if 'and no rebel units' in t:
        quals.append(lambda id: not has_rebel_unit(id)); quals_notes.append('no Rebel units')
    if 'blue square resource icon' in t:
        quals.append(has_blue_square_resource); quals_notes.append('blue square resource')

    have_base = len(note_parts) > 0 or len(quals) > 0
    if not have_base and ('in any system' in t or 'anywhere' in t):
        return ('ANY-SYSTEM', [s['id'] for s in systems])
    if not have_base:
        return ('NOT-ENCODED', [s['id'] for s in systems])
    ids = [s['id'] for s in systems if base_pred(s['id']) and all(q(s['id']) for q in quals)]
    return (' + '.join(note_parts + quals_notes), ids)


# Audit table.
print(f'{"id":34s} {"category":42s} {"# targets"}')
print('-' * 90)
issues = []
for x in missions:
    cat, ids = engine_targets(x)
    n = '-' if ids is None else str(len(ids))
    print(f'{x["id"]:34s} {cat:42s} {n}')

# Print sample target lists for tricky cases.
print('\n\n--- Sample target lists ---')
sample_ids = ['research-and-development', 'construct-super-star-destroyer',
              'fear-will-keep-them-in-line', 'establish-trade-relations',
              'hidden-fleet', 'rule-by-fear', 'oversee-project',
              'support-of-mon-calamari', 'wookie-uprising', 'seek-yoda',
              'capture-rebel-operative', 'sabotage', 'ignite-rebellion',
              'gather-intel', 'plant-false-lead', 'plan-the-assault',
              'probe-droid-initiative', 'superlaser-online']
for sid in sample_ids:
    card = next(m for m in missions if m['id']==sid)
    cat, ids = engine_targets(card)
    print(f'\n{sid}  ->  ({cat})')
    if ids:
        names = [systems_by_id[i]['name'] for i in ids if i in systems_by_id]
        print(f'  {", ".join(names)}')
