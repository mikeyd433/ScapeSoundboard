/**
 * Curated sprite rules — a tier between filename derivation and the generated
 * tile, for sounds whose artwork is obvious to a person and invisible to the
 * matcher.
 *
 * Level-up jingles are the case that motivated this. "Attack level up" is not
 * documented by `Template:SFXLine`, and deriving a subject from it lands on
 * the article *Attack* rather than the skill icon, so it fell through to a
 * tile despite there being exactly one right answer.
 *
 * Every candidate here is checked against the wiki before use, so a filename
 * remembered slightly wrong costs nothing — it fails verification and the clip
 * keeps its generated tile, exactly as it would have anyway.
 */

export type SpriteRule = {
  /** Article the sound is about; becomes the sprite's subject. */
  subject: string;
  /** Ordered `File:` candidates. The first one that exists wins. */
  files: string[];
};

/** All 23, spelled the way the wiki spells them. */
export const SKILLS = [
  'Attack',
  'Strength',
  'Defence',
  'Ranged',
  'Prayer',
  'Magic',
  'Runecraft',
  'Construction',
  'Hitpoints',
  'Agility',
  'Herblore',
  'Thieving',
  'Crafting',
  'Fletching',
  'Slayer',
  'Hunter',
  'Mining',
  'Smithing',
  'Fishing',
  'Cooking',
  'Firemaking',
  'Woodcutting',
  'Farming',
  // Not a skill, but it has its own level-up jingle and its own icon.
  'Combat',
] as const;

/** Spellings that turn up in filenames but are not the article title. */
const SKILL_ALIASES: Record<string, string> = {
  runecrafting: 'Runecraft',
  ranging: 'Ranged',
  range: 'Ranged',
  hitpoint: 'Hitpoints',
  hp: 'Hitpoints',
  defense: 'Defence',
  con: 'Construction',
};

const BY_LOWER = new Map<string, string>([
  ...SKILLS.map((s) => [s.toLowerCase(), s] as [string, string]),
  ...Object.entries(SKILL_ALIASES),
]);

const SKILL_ALTERNATION = [...BY_LOWER.keys()]
  .sort((a, b) => b.length - a.length) // longest first, so "runecrafting" beats "runecraft"
  .join('|');

/**
 * Deliberately narrow. A bare mention of a skill word is not enough: hundreds
 * of files are named `<entity> attack`, and mapping those to the Attack skill
 * icon would be worse than leaving them on a tile. So the skill has to be
 * either paired with a level-up word or be the entire name.
 */
const LEVEL_UP_PATTERNS = [
  new RegExp(`^(?:level\\s?up|levelup|advance|advanced)[\\s\\-_:]*(${SKILL_ALTERNATION})$`, 'i'),
  new RegExp(
    `^(${SKILL_ALTERNATION})[\\s\\-_:]*(?:level\\s?up|levelup|level|advance|advanced)$`,
    'i',
  ),
  new RegExp(`^(${SKILL_ALTERNATION})$`, 'i'),
];

/** Engine-style ids, the same ones tier 2 strips. */
const LEADING_ID = /^\d+[a-z]?\s+/i;

/**
 * The real names are `Attack Level Up!.ogg` and `Attack Level Up! (Unlocks).ogg`,
 * with `(Even)` / `(Odd)` variants too. Both the trailing bang and the
 * parenthetical have to come off before the name can be matched against a
 * pattern anchored at the end.
 */
function clean(displayFile: string): string {
  let n = displayFile
    .replace(/\.(wav|ogg|mp3)$/i, '')
    .replace(LEADING_ID, '')
    .replace(/_+/g, ' ')
    .trim();

  // Peel every trailing parenthetical, not just one.
  for (let prev = ''; prev !== n; ) {
    prev = n;
    n = n.replace(/\s*\([^()]*\)\s*$/, '').trim();
  }

  return n.replace(/[!?.]+$/, '').trim();
}

export function skillFor(displayFile: string): string | null {
  const name = clean(displayFile);
  for (const pattern of LEVEL_UP_PATTERNS) {
    const m = name.match(pattern);
    if (m) return BY_LOWER.get(m[1].toLowerCase()) ?? null;
  }
  return null;
}

/**
 * Skill icons follow `File:<Skill> icon.png` on the wiki. The bare name is
 * offered as a fallback in case a given skill does not follow it.
 */
export function skillIconFiles(skill: string): string[] {
  return [`File:${skill} icon.png`, `File:${skill}.png`, `File:${skill} icon (historical).png`];
}

export function matchRule(displayFile: string): SpriteRule | null {
  const skill = skillFor(displayFile);
  if (skill) return { subject: skill, files: skillIconFiles(skill) };
  return null;
}
