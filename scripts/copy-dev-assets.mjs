// Copies dev-time assets into public/dev-assets/ for the dev-mode UI.
// These are NOT bundled into production builds (the prod art-loader fetches
// the .vmod at first run from vassalengine.org; see docs/core-model.md).

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public', 'dev-assets');
mkdirSync(PUBLIC, { recursive: true });
mkdirSync(join(PUBLIC, 'markers'), { recursive: true });
mkdirSync(join(PUBLIC, 'units'), { recursive: true });

const copies = [
  // JSON data files (the dev tabs read these)
  ['assets/systems.json',    'systems.json'],
  ['assets/adjacency.json',  'adjacency.json'],
  ['assets/leaders.json',    'leaders.json'],
  ['assets/actions.json',    'actions.json'],
  ['assets/missions.json',   'missions.json'],
  ['assets/objectives.json', 'objectives.json'],
  ['assets/tactics.json',    'tactics.json'],
  ['assets/probes.json',     'probes.json'],
  ['assets/board-mask.json', 'board-mask.json'],
  // Board image (the adjacency tab needs it)
  ['vmod_extracted/images/Map.png', 'Map.png'],
  // Loyalty/subjugation markers
  ['vmod_extracted/images/MarkerLoyaltyRebel.png',       'markers/MarkerLoyaltyRebel.png'],
  ['vmod_extracted/images/MarkerLoyaltyEmpire.png',      'markers/MarkerLoyaltyEmpire.png'],
  ['vmod_extracted/images/MarkerLoyaltySubjugated.png',  'markers/MarkerLoyaltySubjugated.png'],
  ['vmod_extracted/images/MarkerLoyaltyNeutral.png',     'markers/MarkerLoyaltyNeutral.png'],
  // RoE target markers (shown on the board for the objective/mission cards
  // that place them — Secure the Plans / Raid Outposts / Rebel Cell / Show No Fear)
  ['vmod_extracted/images/MarkerSecureThePlans.png',     'markers/MarkerSecureThePlans.png'],
  ['vmod_extracted/images/MarkerRaidOutposts.png',       'markers/MarkerRaidOutposts.png'],
  ['vmod_extracted/images/MarkerRebelCell.png',          'markers/MarkerRebelCell.png'],
  ['vmod_extracted/images/MarkerShowNoFear.png',         'markers/MarkerShowNoFear.png'],
  // Sabotage token (board) + reputation/turn track markers
  ['vmod_extracted/images/MarkerSabotage.png',           'markers/MarkerSabotage.png'],
  ['vmod_extracted/images/MarkerReputation.png',         'markers/MarkerReputation.png'],
  ['vmod_extracted/images/MarkerTurn.png',               'markers/MarkerTurn.png'],
  // Unit miniatures
  ['vmod_extracted/images/UnitTIE.png',                  'units/UnitTIE.png'],
  ['vmod_extracted/images/UnitAssaultCarrier.png',       'units/UnitAssaultCarrier.png'],
  ['vmod_extracted/images/UnitStarDestroyer.png',        'units/UnitStarDestroyer.png'],
  ['vmod_extracted/images/UnitSuperStarDestroyer.png',   'units/UnitSuperStarDestroyer.png'],
  ['vmod_extracted/images/UnitDeathStar.png',            'units/UnitDeathStar.png'],
  ['vmod_extracted/images/UnitDeathStarUC.png',          'units/UnitDeathStarUC.png'],
  ['vmod_extracted/images/UnitStormtrooper.png',         'units/UnitStormtrooper.png'],
  ['vmod_extracted/images/UnitATST.png',                 'units/UnitATST.png'],
  ['vmod_extracted/images/UnitATAT.png',                 'units/UnitATAT.png'],
  ['vmod_extracted/images/UnitXWing.png',                'units/UnitXWing.png'],
  ['vmod_extracted/images/UnitYWing.png',                'units/UnitYWing.png'],
  ['vmod_extracted/images/UnitCorellianCorvette.png',    'units/UnitCorellianCorvette.png'],
  ['vmod_extracted/images/UnitRebelTransport.png',       'units/UnitRebelTransport.png'],
  ['vmod_extracted/images/UnitMonCalamari.png',          'units/UnitMonCalamari.png'],
  ['vmod_extracted/images/UnitRebelTrooper.png',         'units/UnitRebelTrooper.png'],
  ['vmod_extracted/images/UnitAirspeeder.png',           'units/UnitAirspeeder.png'],
  ['vmod_extracted/images/UnitShieldGenerator.png',      'units/UnitShieldGenerator.png'],
  ['vmod_extracted/images/UnitIonCannon.png',            'units/UnitIonCannon.png'],
  // Rise of the Empire unit miniatures. Copied regardless of base/expansion so
  // ALL unit art is always available; the engine only ever places these on the
  // board when the expansion is enabled, so a base game still never shows them.
  // Filenames match the .vmod / images/ set (issue #255).
  ['vmod_extracted/images/UnitTIEStriker.png',           'units/UnitTIEStriker.png'],
  ['vmod_extracted/images/UnitAssaultTank.png',          'units/UnitAssaultTank.png'],
  ['vmod_extracted/images/UnitShieldBunker.png',         'units/UnitShieldBunker.png'],
  ['vmod_extracted/images/UnitInterdictor.png',          'units/UnitInterdictor.png'],
  ['vmod_extracted/images/UnitUWing.png',                'units/UnitUWing.png'],
  ['vmod_extracted/images/UnitNebulonB.png',             'units/UnitNebulonB.png'],
  ['vmod_extracted/images/UnitRebelVanguard.png',        'units/UnitRebelVanguard.png'],
  ['vmod_extracted/images/UnitGolanTurret.png',          'units/UnitGolanTurret.png'],
  // Combat / mission dice faces (34x34 RGBA). Base game uses black + red;
  // green is RoE-only and the .vmod ships only Blank + Direct for it.
  ['vmod_extracted/images/DiceBlackBlank.png',           'dice/DiceBlackBlank.png'],
  ['vmod_extracted/images/DiceBlackHit.png',             'dice/DiceBlackHit.png'],
  ['vmod_extracted/images/DiceBlackDirect.png',          'dice/DiceBlackDirect.png'],
  ['vmod_extracted/images/DiceBlackSpecial.png',         'dice/DiceBlackSpecial.png'],
  ['vmod_extracted/images/DiceRedBlank.png',             'dice/DiceRedBlank.png'],
  ['vmod_extracted/images/DiceRedHit.png',               'dice/DiceRedHit.png'],
  ['vmod_extracted/images/DiceRedDirect.png',            'dice/DiceRedDirect.png'],
  ['vmod_extracted/images/DiceRedSpecial.png',           'dice/DiceRedSpecial.png'],
  ['vmod_extracted/images/DiceGreenBlank.png',           'dice/DiceGreenBlank.png'],
  ['vmod_extracted/images/DiceGreenDirect.png',          'dice/DiceGreenDirect.png'],
];

let ok = 0;
let missing = [];
for (const [src, dst] of copies) {
  const from = join(ROOT, src);
  const to = join(PUBLIC, dst);
  if (!existsSync(from)) { missing.push(src); continue; }
  copyFileSync(from, to);
  ok++;
  console.log(`  ✓ ${src} → public/dev-assets/${dst}`);
}

if (missing.length) {
  console.warn(`\nMissing source files (not copied):`);
  missing.forEach(m => console.warn(`  - ${m}`));
}

console.log(`\nCopied ${ok}/${copies.length} dev assets.`);
