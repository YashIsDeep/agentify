/**
 * A curated emoji set for workflow icons.
 *
 * Deliberately not the full Unicode set: a workflow is named for the kind of work it carries, so a
 * few hundred sensible choices are easier to pick from than a few thousand, and the list stays small
 * enough to ship inline — no picker dependency, no network fetch.
 */
export interface EmojiEntry {
  char: string;
  /** Shown as the button's tooltip and matched by search. */
  name: string;
  /** Extra search terms; the name is always searched too. */
  keywords?: string;
}

export interface EmojiGroup {
  name: string;
  emoji: EmojiEntry[];
}

export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: "Work",
    emoji: [
      { char: "✨", name: "Sparkles", keywords: "feature new magic shiny" },
      { char: "🐛", name: "Bug", keywords: "bugfix defect issue insect" },
      { char: "🔥", name: "Fire", keywords: "hotfix urgent burning incident" },
      { char: "🚀", name: "Rocket", keywords: "ship launch release deploy" },
      { char: "🧪", name: "Test tube", keywords: "test experiment qa lab" },
      { char: "🔧", name: "Wrench", keywords: "fix maintenance repair tooling" },
      { char: "🛠️", name: "Hammer and wrench", keywords: "build tooling maintenance" },
      { char: "🧹", name: "Broom", keywords: "cleanup chore tidy sweep" },
      { char: "♻️", name: "Recycle", keywords: "refactor rewrite reuse" },
      { char: "🏗️", name: "Construction", keywords: "infrastructure platform building" },
      { char: "📦", name: "Package", keywords: "release dependency library shipping" },
      { char: "🔒", name: "Lock", keywords: "security auth private closed" },
      { char: "🩹", name: "Bandage", keywords: "patch fix small hotfix" },
      { char: "⚡", name: "High voltage", keywords: "performance fast speed power" },
      { char: "🧭", name: "Compass", keywords: "discovery direction explore" },
      { char: "🎯", name: "Target", keywords: "goal focus objective aim" },
      { char: "🗺️", name: "Map", keywords: "roadmap plan journey" },
      { char: "🔬", name: "Microscope", keywords: "research analysis investigate spike" },
      { char: "📐", name: "Set square", keywords: "design spec measure architecture" },
      { char: "🎨", name: "Palette", keywords: "design ui art visual" },
      { char: "📝", name: "Memo", keywords: "docs notes write spec" },
      { char: "📚", name: "Books", keywords: "documentation reference knowledge" },
      { char: "🔍", name: "Magnifying glass", keywords: "review search audit inspect" },
      { char: "🧱", name: "Brick", keywords: "foundation core building block" },
    ],
  },
  {
    name: "Status",
    emoji: [
      { char: "✅", name: "Check mark", keywords: "done complete pass green" },
      { char: "❌", name: "Cross mark", keywords: "failed blocked no stop" },
      { char: "⚠️", name: "Warning", keywords: "caution risk attention" },
      { char: "🚧", name: "Construction sign", keywords: "wip progress blocked roadworks" },
      { char: "⏳", name: "Hourglass", keywords: "waiting pending time queue" },
      { char: "⏸️", name: "Pause", keywords: "hold paused stopped" },
      { char: "▶️", name: "Play", keywords: "start run go resume" },
      { char: "🔁", name: "Repeat", keywords: "loop recurring retry cycle" },
      { char: "🟢", name: "Green circle", keywords: "healthy good go ok" },
      { char: "🟡", name: "Yellow circle", keywords: "warning caution middling" },
      { char: "🔴", name: "Red circle", keywords: "critical down broken" },
      { char: "🔵", name: "Blue circle", keywords: "info neutral cool" },
      { char: "🟣", name: "Purple circle", keywords: "neutral colour" },
      { char: "🟠", name: "Orange circle", keywords: "neutral colour" },
      { char: "⭐", name: "Star", keywords: "favourite important priority" },
      { char: "🏁", name: "Chequered flag", keywords: "finish done complete race" },
      { char: "🎉", name: "Party popper", keywords: "launch celebrate shipped" },
      { char: "🏆", name: "Trophy", keywords: "win success achievement" },
      { char: "💯", name: "Hundred", keywords: "perfect score complete" },
      { char: "🆕", name: "New", keywords: "new fresh recent" },
      { char: "🔝", name: "Top", keywords: "priority highest top" },
      { char: "⛔", name: "No entry", keywords: "blocked forbidden stop" },
      { char: "🧊", name: "Ice", keywords: "frozen icebox parked cold" },
      { char: "🗑️", name: "Wastebasket", keywords: "discard delete trash drop" },
    ],
  },
  {
    name: "Tools",
    emoji: [
      { char: "💻", name: "Laptop", keywords: "code dev computer engineering" },
      { char: "🖥️", name: "Desktop", keywords: "computer machine workstation" },
      { char: "⌨️", name: "Keyboard", keywords: "typing input code" },
      { char: "🖱️", name: "Mouse", keywords: "click pointer input" },
      { char: "📱", name: "Mobile phone", keywords: "mobile app ios android" },
      { char: "🗄️", name: "File cabinet", keywords: "database storage archive records" },
      { char: "🗂️", name: "Dividers", keywords: "organise index categories" },
      { char: "📁", name: "Folder", keywords: "files project directory" },
      { char: "📊", name: "Bar chart", keywords: "analytics metrics data report" },
      { char: "📈", name: "Chart up", keywords: "growth increase metrics" },
      { char: "📉", name: "Chart down", keywords: "decline decrease regression" },
      { char: "⚙️", name: "Gear", keywords: "settings config system engine" },
      { char: "🔩", name: "Nut and bolt", keywords: "internals plumbing hardware" },
      { char: "🧰", name: "Toolbox", keywords: "tooling utilities devex" },
      { char: "🔗", name: "Link", keywords: "integration connect url chain" },
      { char: "📌", name: "Pushpin", keywords: "pinned important note" },
      { char: "📎", name: "Paperclip", keywords: "attachment file clip" },
      { char: "✂️", name: "Scissors", keywords: "cut trim remove split" },
      { char: "🖊️", name: "Pen", keywords: "write edit draft sign" },
      { char: "🧾", name: "Receipt", keywords: "billing invoice record finance" },
      { char: "💾", name: "Floppy disk", keywords: "save storage legacy backup" },
      { char: "🔌", name: "Plug", keywords: "integration connector power" },
      { char: "🛡️", name: "Shield", keywords: "security protection defence" },
      { char: "🔑", name: "Key", keywords: "auth access secret credential" },
    ],
  },
  {
    name: "People",
    emoji: [
      { char: "💬", name: "Speech balloon", keywords: "chat comment discuss feedback" },
      { char: "🗣️", name: "Speaking head", keywords: "voice announce talk" },
      { char: "📣", name: "Megaphone", keywords: "announcement marketing shout" },
      { char: "🔔", name: "Bell", keywords: "notification alert reminder" },
      { char: "📨", name: "Envelope", keywords: "email message inbox" },
      { char: "📞", name: "Telephone", keywords: "call support contact" },
      { char: "🤝", name: "Handshake", keywords: "agreement partner deal onboarding" },
      { char: "👀", name: "Eyes", keywords: "review watching look attention" },
      { char: "👍", name: "Thumbs up", keywords: "approve ok good lgtm" },
      { char: "👎", name: "Thumbs down", keywords: "reject bad no" },
      { char: "🙌", name: "Raising hands", keywords: "celebrate praise done" },
      { char: "👋", name: "Waving hand", keywords: "hello onboarding welcome intro" },
      { char: "🤖", name: "Robot", keywords: "bot agent automation ai" },
      { char: "👤", name: "Silhouette", keywords: "user person account profile" },
      { char: "👥", name: "Two people", keywords: "team users group pair" },
      { char: "🧗", name: "Climber", keywords: "challenge effort hard climb" },
      { char: "🕵️", name: "Detective", keywords: "investigate debug find clue" },
      { char: "🦸", name: "Superhero", keywords: "hero rescue save" },
      { char: "🧙", name: "Mage", keywords: "magic wizard clever trick" },
      { char: "🙋", name: "Raised hand", keywords: "question request volunteer ask" },
      { char: "🎓", name: "Graduation cap", keywords: "training onboarding learn course" },
      { char: "🦺", name: "Safety vest", keywords: "ops on-call safety support" },
      { char: "🧠", name: "Brain", keywords: "thinking ai research idea" },
      { char: "💡", name: "Light bulb", keywords: "idea proposal insight" },
    ],
  },
  {
    name: "Nature",
    emoji: [
      { char: "🌱", name: "Seedling", keywords: "new growth start early" },
      { char: "🌳", name: "Tree", keywords: "branch growth stable mature" },
      { char: "🍀", name: "Four leaf clover", keywords: "luck chance fortune" },
      { char: "🌸", name: "Blossom", keywords: "spring fresh pretty" },
      { char: "🌊", name: "Wave", keywords: "flow stream surge water" },
      { char: "☀️", name: "Sun", keywords: "day bright sunny clear" },
      { char: "🌙", name: "Crescent moon", keywords: "night dark late" },
      { char: "🌟", name: "Glowing star", keywords: "highlight special shine" },
      { char: "☁️", name: "Cloud", keywords: "cloud infra hosting aws" },
      { char: "🌈", name: "Rainbow", keywords: "colour variety spectrum" },
      { char: "❄️", name: "Snowflake", keywords: "freeze cold winter frozen" },
      { char: "🌋", name: "Volcano", keywords: "eruption incident pressure" },
      { char: "🪐", name: "Ringed planet", keywords: "space big world" },
      { char: "🌍", name: "Globe", keywords: "world global international i18n" },
      { char: "🏔️", name: "Mountain", keywords: "climb challenge peak epic" },
      { char: "🦋", name: "Butterfly", keywords: "transform change pretty" },
      { char: "🐢", name: "Turtle", keywords: "slow steady performance" },
      { char: "🐇", name: "Rabbit", keywords: "fast quick speed" },
      { char: "🦉", name: "Owl", keywords: "wise night knowledge" },
      { char: "🐙", name: "Octopus", keywords: "many arms multitask git" },
      { char: "🐝", name: "Honeybee", keywords: "busy work swarm hive" },
      { char: "🌵", name: "Cactus", keywords: "dry hardy spiky desert" },
      { char: "🍂", name: "Fallen leaves", keywords: "autumn deprecate old" },
      { char: "🔆", name: "Bright", keywords: "brightness highlight light" },
    ],
  },
  {
    name: "Fun",
    emoji: [
      { char: "☕", name: "Coffee", keywords: "morning break daily routine" },
      { char: "🍵", name: "Tea", keywords: "calm break routine" },
      { char: "🍕", name: "Pizza", keywords: "food slice fun team" },
      { char: "🍩", name: "Doughnut", keywords: "food treat sweet" },
      { char: "🍪", name: "Cookie", keywords: "food sweet session cache" },
      { char: "🧁", name: "Cupcake", keywords: "food sweet treat" },
      { char: "🍎", name: "Apple", keywords: "food fruit health" },
      { char: "🌶️", name: "Hot pepper", keywords: "spicy hot risky" },
      { char: "🥇", name: "Gold medal", keywords: "first best winner" },
      { char: "🎲", name: "Dice", keywords: "random chance experiment" },
      { char: "🎮", name: "Video game", keywords: "game play fun" },
      { char: "🧩", name: "Puzzle piece", keywords: "plugin integration piece fit" },
      { char: "🎁", name: "Gift", keywords: "release present bonus" },
      { char: "🎈", name: "Balloon", keywords: "celebrate light party" },
      { char: "🪄", name: "Magic wand", keywords: "magic automation transform" },
      { char: "🔮", name: "Crystal ball", keywords: "predict forecast future" },
      { char: "🎬", name: "Clapper board", keywords: "action video media start" },
      { char: "🎧", name: "Headphones", keywords: "audio focus music" },
      { char: "🎸", name: "Guitar", keywords: "music jam band" },
      { char: "🃏", name: "Joker", keywords: "wildcard card random" },
      { char: "🎪", name: "Circus tent", keywords: "chaos show event" },
      { char: "🕹️", name: "Joystick", keywords: "control game arcade" },
      { char: "🧸", name: "Teddy bear", keywords: "soft friendly cosy" },
      { char: "🏀", name: "Basketball", keywords: "sport team play" },
    ],
  },
  {
    name: "Travel",
    emoji: [
      { char: "✈️", name: "Aeroplane", keywords: "travel ship fast journey" },
      { char: "🚢", name: "Ship", keywords: "shipping release cargo" },
      { char: "🚂", name: "Train", keywords: "pipeline journey rail" },
      { char: "🚗", name: "Car", keywords: "drive travel move" },
      { char: "🛵", name: "Scooter", keywords: "quick delivery small" },
      { char: "🚲", name: "Bicycle", keywords: "mvp simple lightweight" },
      { char: "🛰️", name: "Satellite", keywords: "monitoring telemetry signal" },
      { char: "🛸", name: "Flying saucer", keywords: "experimental strange alien" },
      { char: "🧳", name: "Luggage", keywords: "migration move baggage" },
      { char: "🏭", name: "Factory", keywords: "production pipeline build" },
      { char: "🏢", name: "Office", keywords: "company internal business" },
      { char: "🏠", name: "House", keywords: "home personal local" },
      { char: "🚦", name: "Traffic light", keywords: "gate control flow signal" },
      { char: "🛑", name: "Stop sign", keywords: "halt blocked stop" },
      { char: "⛽", name: "Fuel pump", keywords: "refuel energy supply" },
      { char: "🚁", name: "Helicopter", keywords: "rescue quick overview" },
      { char: "⚓", name: "Anchor", keywords: "stable pinned base" },
      { char: "🪂", name: "Parachute", keywords: "safety fallback landing" },
      { char: "🎢", name: "Roller coaster", keywords: "ups downs volatile ride" },
      { char: "🗼", name: "Tower", keywords: "landmark beacon monitoring" },
      { char: "🏝️", name: "Island", keywords: "isolated standalone holiday" },
      { char: "🗿", name: "Moai", keywords: "legacy stone ancient" },
      { char: "🌉", name: "Bridge", keywords: "migration connect transition" },
      { char: "🛤️", name: "Railway track", keywords: "path pipeline route" },
    ],
  },
  {
    name: "Symbols",
    emoji: [
      { char: "❤️", name: "Red heart", keywords: "love favourite care" },
      { char: "🧡", name: "Orange heart", keywords: "love colour" },
      { char: "💛", name: "Yellow heart", keywords: "love colour" },
      { char: "💚", name: "Green heart", keywords: "love colour" },
      { char: "💙", name: "Blue heart", keywords: "love colour" },
      { char: "💜", name: "Purple heart", keywords: "love colour" },
      { char: "🖤", name: "Black heart", keywords: "love dark colour" },
      { char: "🤍", name: "White heart", keywords: "love light colour" },
      { char: "♾️", name: "Infinity", keywords: "endless continuous devops" },
      { char: "⚛️", name: "Atom", keywords: "react physics science core" },
      { char: "☢️", name: "Radioactive", keywords: "danger toxic risky" },
      { char: "⚖️", name: "Balance scale", keywords: "decision tradeoff legal fair" },
      { char: "🧿", name: "Nazar amulet", keywords: "protection charm luck" },
      { char: "♠️", name: "Spade", keywords: "card suit" },
      { char: "♦️", name: "Diamond", keywords: "card suit valuable" },
      { char: "➕", name: "Plus", keywords: "add new create" },
      { char: "➖", name: "Minus", keywords: "remove subtract" },
      { char: "❓", name: "Question mark", keywords: "unknown question unclear" },
      { char: "❗", name: "Exclamation mark", keywords: "important urgent attention" },
      { char: "🔱", name: "Trident", keywords: "fork branch split" },
      { char: "🧬", name: "DNA", keywords: "core genetics structure" },
      { char: "🩺", name: "Stethoscope", keywords: "health check diagnostics" },
      { char: "⌛", name: "Hourglass done", keywords: "timeout expired waiting" },
      { char: "🕐", name: "Clock", keywords: "time schedule deadline" },
    ],
  },
];

/** Every entry, flattened — for search and for looking a character's name up. */
export const ALL_EMOJI: EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.emoji);

/** Case-insensitive match on name and keywords. A blank query matches nothing, so callers show the groups instead. */
export function searchEmoji(query: string): EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const terms = needle.split(/\s+/);
  return ALL_EMOJI.filter((entry) => {
    const haystack = `${entry.name} ${entry.keywords ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export const emojiName = (char: string): string => ALL_EMOJI.find((entry) => entry.char === char)?.name ?? char;
