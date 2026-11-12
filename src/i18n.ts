/** Interface text in English and French. Every string a player can read
 * lives here; the UI asks for it by key. Hints are small trusted HTML
 * fragments (they contain <kbd> tags) and are the only strings inserted
 * as markup. */

export type Locale = "en" | "fr";
export type LanguageSetting = "auto" | Locale;

const EN = {
  tagline: "An endless world of light, built block by block.",
  play: "Play",
  resume: "Resume",
  settings: "Settings",
  worlds: "Worlds",
  fullscreen: "Fullscreen",
  back: "Back",
  hintDesktop:
    "<kbd>WASD</kbd> move &middot; <kbd>Space</kbd> jump (twice to fly) &middot; <kbd>Shift</kbd> sprint<br />" +
    "<kbd>Left click</kbd> break &middot; <kbd>Right click</kbd> place &middot; <kbd>Middle click</kbd> pick<br />" +
    "<kbd>E</kbd> blocks &middot; <kbd>1</kbd>-<kbd>9</kbd> or scroll to choose &middot; <kbd>F1</kbd> photo mode",
  hintTouch:
    "Left thumb moves &middot; drag the right side to look<br />" +
    "Tap to break &middot; the buttons jump, place and fly<br />" +
    "Tap a slot to choose a block",
  version: "v{version} · seed {seed}",
  graphics: "Graphics",
  qualityLow: "Low",
  qualityMedium: "Medium",
  qualityHigh: "High",
  qualityUltra: "Ultra",
  viewDistance: "View distance",
  chunks: "{n} chunks",
  fov: "Field of view",
  sensitivity: "Look sensitivity",
  volume: "Volume",
  invertY: "Invert vertical look",
  autoJump: "Auto-jump up ledges",
  viewBob: "View bobbing",
  showStats: "Show performance stats",
  language: "Language",
  languageAuto: "Auto",
  worldsIntro:
    "Every world grows from a seed. You're in world {seed} — share that number and a friend gets the same land.",
  seedPlaceholder: "A number or any word",
  seedLabel: "World seed",
  exploreWorld: "Explore this world",
  surpriseMe: "Surprise me",
  resetWorld: "Undo all my changes to this world",
  resetConfirm: "Tap again to erase everything you built here",
  blocks: "Blocks",
  inventoryHint: "Pick a block to put it in the selected slot.",
  close: "Close",
  flying: "Flying",
  walking: "Walking",
  screenshotSaved: "Screenshot saved",
  fatalTitle: "{name} couldn't start",
  fatalHint:
    "Try a hard refresh or another browser. If it keeps happening, please report this exact message.",
} as const;

export type TextKey = keyof typeof EN;

const FR: Record<TextKey, string> = {
  tagline: "Un monde infini de lumière, à bâtir bloc par bloc.",
  play: "Jouer",
  resume: "Reprendre",
  settings: "Réglages",
  worlds: "Mondes",
  fullscreen: "Plein écran",
  back: "Retour",
  hintDesktop:
    "<kbd>ZQSD</kbd> se déplacer &middot; <kbd>Espace</kbd> sauter (deux fois : voler) &middot; <kbd>Maj</kbd> courir<br />" +
    "<kbd>Clic gauche</kbd> casser &middot; <kbd>Clic droit</kbd> poser &middot; <kbd>Clic molette</kbd> copier<br />" +
    "<kbd>E</kbd> blocs &middot; <kbd>1</kbd>-<kbd>9</kbd> ou molette pour choisir &middot; <kbd>F1</kbd> mode photo",
  hintTouch:
    "Pouce gauche pour avancer &middot; glissez à droite pour regarder<br />" +
    "Touchez pour casser &middot; les boutons sautent, posent et volent<br />" +
    "Touchez une case pour choisir un bloc",
  version: "v{version} · graine {seed}",
  graphics: "Graphismes",
  qualityLow: "Bas",
  qualityMedium: "Moyen",
  qualityHigh: "Élevé",
  qualityUltra: "Ultra",
  viewDistance: "Distance d'affichage",
  chunks: "{n} tronçons",
  fov: "Champ de vision",
  sensitivity: "Sensibilité du regard",
  volume: "Volume",
  invertY: "Inverser l'axe vertical",
  autoJump: "Saut automatique",
  viewBob: "Balancement de la vue",
  showStats: "Afficher les performances",
  language: "Langue",
  languageAuto: "Auto",
  worldsIntro:
    "Chaque monde naît d'une graine. Vous êtes dans le monde {seed} — partagez ce nombre et un ami obtiendra les mêmes terres.",
  seedPlaceholder: "Un nombre ou un mot",
  seedLabel: "Graine du monde",
  exploreWorld: "Explorer ce monde",
  surpriseMe: "Surprends-moi",
  resetWorld: "Annuler toutes mes modifications dans ce monde",
  resetConfirm: "Touchez encore pour effacer tout ce que vous avez construit ici",
  blocks: "Blocs",
  inventoryHint: "Choisissez un bloc pour le placer dans la case sélectionnée.",
  close: "Fermer",
  flying: "En vol",
  walking: "À pied",
  screenshotSaved: "Capture enregistrée",
  fatalTitle: "{name} n'a pas pu démarrer",
  fatalHint:
    "Essayez un rechargement complet ou un autre navigateur. Si le problème persiste, signalez ce message exact.",
};

const TEXT: Record<Locale, Record<TextKey, string>> = { en: EN, fr: FR };

/** French names for the blocks, keyed by their English (registry) name. */
const BLOCK_NAMES_FR: Record<string, string> = {
  air: "air",
  grass: "herbe",
  dirt: "terre",
  stone: "pierre",
  sand: "sable",
  water: "eau",
  "oak log": "bûche de chêne",
  "oak leaves": "feuilles de chêne",
  bedrock: "socle rocheux",
  snow: "neige",
  "tall grass": "hautes herbes",
  "ember bloom": "fleur de braise",
  "sun daisy": "marguerite solaire",
  "sky bell": "clochette céleste",
  planks: "planches",
  cobblestone: "pavés",
  "stone bricks": "briques de pierre",
  glass: "verre",
  lantern: "lanterne",
  "coal ore": "minerai de charbon",
  "gold ore": "minerai d'or",
  "lumen crystal": "cristal de lumen",
  "pale log": "bûche pâle",
  "autumn leaves": "feuilles d'automne",
  "pine log": "bûche de pin",
  "pine needles": "aiguilles de pin",
  cactus: "cactus",
  gravel: "gravier",
  ice: "glace",
  bricks: "briques",
  sandstone: "grès",
  "dry bush": "buisson sec",
  "frosted grass": "herbe givrée",
  glowshroom: "champignon luisant",
  clay: "argile",
};

export const LOCALES: readonly Locale[] = ["en", "fr"];

/** Picks the first supported language from the browser's preference list. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "fr") return "fr";
    if (base === "en") return "en";
  }
  return "en";
}

export function resolveLocale(setting: LanguageSetting, languages: readonly string[]): Locale {
  return setting === "auto" ? detectLocale(languages) : setting;
}

export interface Translator {
  readonly locale: Locale;
  /** The text for a key, with `{name}` placeholders filled in. */
  (key: TextKey, values?: Record<string, string | number>): string;
  /** A block's display name, from its registry name. */
  block(name: string): string;
}

export function createTranslator(locale: Locale): Translator {
  const table = TEXT[locale];
  const translate = (key: TextKey, values?: Record<string, string | number>): string => {
    let text = table[key];
    if (values) {
      for (const [name, value] of Object.entries(values)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
  return Object.assign(translate, {
    locale,
    block: (name: string): string => (locale === "fr" ? (BLOCK_NAMES_FR[name] ?? name) : name),
  });
}

/** Every key, for tests and tooling. */
export const TEXT_KEYS = Object.keys(EN) as TextKey[];
export function hasFrenchBlockName(name: string): boolean {
  return name in BLOCK_NAMES_FR;
}
