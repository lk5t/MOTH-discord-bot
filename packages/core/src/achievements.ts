/** Built-in achievement catalogue. Each guild can disable individual keys. */
export interface AchievementDef { key: string; name: string; description: string; icon: string; check: (s: AchievementStats) => boolean }
export interface AchievementStats { messages: number; level: number; streak: number; balance: number; giveawaysWon: number; voiceMinutes: number; ticketsOpened?: number }

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: "first_words", name: "First Words", description: "Send your first message", icon: "💬", check: (s) => s.messages >= 1 },
  { key: "chatterbox", name: "Chatterbox", description: "Send 1,000 messages", icon: "🗣️", check: (s) => s.messages >= 1000 },
  { key: "storyteller", name: "Storyteller", description: "Send 10,000 messages", icon: "📚", check: (s) => s.messages >= 10000 },
  { key: "level_5", name: "Getting Started", description: "Reach level 5", icon: "⭐", check: (s) => s.level >= 5 },
  { key: "level_10", name: "Rising Star", description: "Reach level 10", icon: "🌟", check: (s) => s.level >= 10 },
  { key: "level_25", name: "Veteran", description: "Reach level 25", icon: "🎖️", check: (s) => s.level >= 25 },
  { key: "level_50", name: "Legend", description: "Reach level 50", icon: "👑", check: (s) => s.level >= 50 },
  { key: "streak_7", name: "Dedicated", description: "Claim daily rewards 7 days in a row", icon: "🔥", check: (s) => s.streak >= 7 },
  { key: "streak_30", name: "Unstoppable", description: "Claim daily rewards 30 days in a row", icon: "☄️", check: (s) => s.streak >= 30 },
  { key: "rich", name: "High Roller", description: "Hold 10,000 currency", icon: "💰", check: (s) => s.balance >= 10000 },
  { key: "lucky", name: "Lucky", description: "Win a giveaway", icon: "🍀", check: (s) => s.giveawaysWon >= 1 },
  { key: "voice_10h", name: "Voice Regular", description: "Spend 10 hours in voice", icon: "🎧", check: (s) => s.voiceMinutes >= 600 },
];
