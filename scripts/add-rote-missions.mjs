// One-shot script: append Rise of the Empire mission entries to
// assets/missions.json, tagged set: 'rote'. Run once; subsequent runs skip
// already-added entries (idempotent on id). Data-only — effectKey is empty
// pending Phase 5b handler bindings.
//
// Source: MissionReference_RotE_Final.pdf (pp. 1-4). The PDF doesn't print
// skill-icon colour explicitly, so skill assignments here follow the
// mission's flavour (intel for spying/reconnaissance, diplomacy for
// loyalty/recruit, specOps for direct-action, logistics for build/queue);
// they're best-effort and should be confirmed against actual card art in a
// follow-up pass. skillCost is 0 (RoE +2 leader missions show no cost on
// the PDF) except where the PDF marks a project mission cost (e.g. "(2)").

import { readFileSync, writeFileSync } from 'node:fs';

const PATH = 'assets/missions.json';
const data = JSON.parse(readFileSync(PATH, 'utf8'));
const existingIds = new Set(data.missions.map((m) => m.id));
const existingNames = new Set(data.missions.map((m) => m.name.toLowerCase()));

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Tuple shape: { name, side, isStarting, isProject, isAttempt, portrait, skill, skillCost, rules }
const ROTE = [
  // ----- Imperial — project missions -----
  { name: 'Interdictor Development', side: 'Empire', isStarting: false, isProject: true, isAttempt: false,
    portrait: null, skill: 'logistics', skillCost: 2,
    rules: 'Place 1 Interdictor on build space 2. If 2 leaders are assigned, place on space 1 and return the card.' },
  { name: 'Single Reactor Ignition', side: 'Empire', isStarting: false, isProject: true, isAttempt: false,
    portrait: null, skill: 'logistics', skillCost: 1,
    rules: 'Resolve on a Death Star (not a DSUC). Rebels must reveal their base if it is in this system. Destroy any Rebel ground units and remove any target markers in the system.' },
  // ----- Imperial — leader missions -----
  { name: 'Make An Example', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'jabba', skill: 'intel', skillCost: 0,
    rules: 'Attempt on a captured leader in a remote system. Count all skill icons; the captured leader is eliminated.' },
  { name: 'Secure The Plans', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'krennic', skill: 'intel', skillCost: 0,
    rules: 'Attempt on a remote system. Place a target marker. While the marker remains, Rebels cannot play "Death Star Plans".' },
  { name: 'Draw Them Out', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'krennic', skill: 'specOps', skillCost: 0,
    rules: "Attempt on a system with no Rebel units. Choose a Rebel leader in the leader pool; place that leader in this system." },
  { name: 'Discredit Rebellion', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: 'motti', skill: 'diplomacy', skillCost: 0,
    rules: 'Resolve on a sabotaged system. Rebel player must remove all sabotage markers on the board, or roll 1 die — on any success, Rebels lose 1 reputation. If Motti is assigned, Rebels roll 2 dice instead.' },
  // ----- Imperial — regular missions -----
  { name: 'Deployment', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'logistics', skillCost: 0,
    rules: 'Attempt on a system with no Rebel units or loyalty. Gain 1 triangle ground unit.' },
  { name: 'Message From High Command', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Attempt on a populous system. Gain 1 loyalty. Return all assigned leaders to the leader pool.' },
  { name: 'Stolen Intel', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Attempt on a Rebel system. Draw a probe card. Look at the Rebel hand of missions and discard one (not a starter).' },
  { name: 'Were The Bait', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'specOps', skillCost: 0,
    rules: "Attempt on a captured leader's system. Take 4-health of ground units from the Rebel Base and place them here. Resolve combat." },
  { name: 'Exploit Weakness', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Attempt on a captured leader. Rebel reveals 1 random Objective card from hand and places it on top of the deck.' },
  { name: 'Break Their Will', side: 'Empire', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: "Attempt on a captured leader. Count all icons. Name a system; Rebel must tell you if their base is in that system's region. If the mission fails, return this card to your hand." },
  { name: 'Hire Mercenaries', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Resolve in a remote system. Recruit 1 Imperial leader without tactic values and place them in this system.' },
  { name: 'Imperial Might', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'logistics', skillCost: 0,
    rules: 'Resolve on a Death Star, DSUC, or Shield Bunker with no Rebel units. Take 4 Imperial units from space 1 of the build queue and place them in this system. If 2 leaders are assigned, move those leaders to Coruscant.' },
  { name: 'Imperial Promotion', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Resolve in any Imperial system. Recruit 1 Imperial leader with tactic values and place them in this system.' },
  { name: 'Subversion New', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Oppose a Rebel mission (from the new RoE set). Place assigned leaders in that system. Roll 1 additional die to oppose the mission.' },
  { name: 'Subversion Original', side: 'Empire', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Oppose a Rebel mission (from the original base set). Place assigned leaders in that system. Roll 1 additional die to oppose the mission.' },

  // ----- Rebel — leader missions -----
  { name: 'Aggressive Negotiations', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'chirrut-imwe', skill: 'diplomacy', skillCost: 0,
    rules: 'Attempt on a captured leader. Rescue the leader. If the mission fails, you may destroy 1 triangle ground unit in the system.' },
  { name: 'Heist', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'jyn-erso', skill: 'specOps', skillCost: 0,
    rules: 'Attempt on a system with 1+ Imperial units. Remove 1 target marker. If on a Death Star or DSUC, you may draw the top objective card instead.' },
  { name: 'Prepare For Battle', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: 'saw-gerrera', skill: 'specOps', skillCost: 0,
    rules: 'Attempt on a subjugated system. Return assigned leaders to the pool. Look at the top 4 cards of any tactic deck and place them top/bottom in any order, or return discarded Rebel advanced tactic cards to their decks.' },
  { name: 'Secret Mission', side: 'Rebel', isStarting: false, isProject: false, isAttempt: false,
    portrait: 'cassian-andor', skill: 'intel', skillCost: 0,
    rules: 'Resolve on a Rebel system. Look at the top 6 mission cards; keep 1 and shuffle the deck. If Andor is assigned, you may keep 2 cards.' },

  // ----- Rebel — regular missions -----
  { name: 'Safe Haven', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'logistics', skillCost: 0,
    rules: 'Attempt on a Rebel system with no Imperial units. Take up to 2 units from the build queue and deploy them here.' },
  { name: 'Regional Aid', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Attempt on any system. Gain 1 loyalty here, and 1 loyalty elsewhere in the same region.' },
  { name: 'Reconnaissance', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Attempt on an Imperial system. Choose a discarded mission and return it to your hand.' },
  { name: 'Critical Rescue', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'specOps', skillCost: 0,
    rules: 'Attempt on a captured leader. Rescue the leader. If the mission fails, return this card to your hand.' },
  { name: 'Covert Operations', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'intel', skillCost: 0,
    rules: 'Attempt on a system with 1+ Imperial units. Draw 2 Objective cards, keep 1, put the other at the bottom of the deck.' },
  { name: 'Assault', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'specOps', skillCost: 0,
    rules: 'Attempt on a subjugated system. Roll even if unopposed. If more successes than the Imperial player, destroy up to 3 Stormtroopers, up to the difference in successes.' },
  { name: 'Plant Explosives', side: 'Rebel', isStarting: false, isProject: false, isAttempt: true,
    portrait: null, skill: 'specOps', skillCost: 0,
    rules: 'Attempt on any system. Roll even if unopposed. If more successes than the Imperial player, destroy up to 3 ground units, combined health up to the difference in successes.' },
  { name: 'Behind Enemy Lines', side: 'Rebel', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'specOps', skillCost: 0,
    rules: 'Resolve on a subjugated or Rebel system. Move 5 units from the Rebel Base, ignoring leaders and adjacency. Resolve combat.' },
  { name: 'My Only Hope', side: 'Rebel', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Resolve in a remote system. Recruit Luke, Obi-Wan, Jyn Erso, Han Solo, or Chirrut Imwe and place them here.' },
  { name: 'Rebel Promotion', side: 'Rebel', isStarting: false, isProject: false, isAttempt: false,
    portrait: null, skill: 'diplomacy', skillCost: 0,
    rules: 'Resolve in a Rebel system. Recruit Ackbar, Wedge, Madine, Cassian Andor, or Saw Gerrera and place them here.' },
];

let added = 0, skipped = 0;
for (const m of ROTE) {
  const id = slug(m.name);
  if (existingIds.has(id) || existingNames.has(m.name.toLowerCase())) {
    skipped++;
    continue;
  }
  data.missions.push({
    id, name: m.name, side: m.side,
    isStarting: m.isStarting, isProject: m.isProject,
    skill: m.skill, skillCost: m.skillCost,
    isAttempt: m.isAttempt, leaderPortrait: m.portrait,
    effectKey: '', // Phase 5b: bind to a handler in src/engine/handlers/index.ts
    rulesText: m.rules,
    image: '', // TODO: art when RoE mission art is loaded
    set: 'rote',
  });
  added++;
}

data._meta.notes = data._meta.notes || [];
data._meta.notes.push(
  `Phase 5 (data-only): appended ${added} Rise of the Empire missions tagged ` +
  `set: "rote". effectKey is empty pending Phase 5b handler bindings — the ` +
  `cards appear in the deck when expansion.roeMissions is on but resolve as ` +
  `no-ops until then. Skill assignments are best-effort from rule flavour; ` +
  `confirm against actual card art in a follow-up.`
);

writeFileSync(PATH, JSON.stringify(data, null, 2));
console.log(`Added ${added}, skipped ${skipped}. Total missions: ${data.missions.length}.`);
