import type { BlueprintInput, BlueprintCategory } from "./blueprint.js";
import { blueprintSchema, type Blueprint } from "./blueprint.js";

/**
 * Built-in blueprint templates and the offline "heuristic architect" that
 * designs a server from a natural-language description without any AI
 * provider. When AI is configured it refines these results further.
 */

export type ServerKind = "gaming" | "community" | "business" | "education" | "creator" | "developer" | "roleplay" | "esports";

export interface DesignIntent {
  kind: ServerKind;
  name?: string;
  topics: string[]; // e.g. game names, subjects
  tone: "professional" | "friendly" | "playful";
  emoji: boolean;
  features: Set<Feature>;
  primaryColor: string;
}

export type Feature =
  | "tickets" | "staff-applications" | "announcements" | "verification" | "leveling" | "economy" | "giveaways"
  | "events" | "voice" | "media" | "suggestions" | "role-menus" | "ai" | "partnerships" | "faq" | "polls" | "music" | "lfg" | "showcase";

const KIND_KEYWORDS: [ServerKind, RegExp][] = [
  ["esports", /\b(esports?|competitive team|scrims?|tournaments?|clan)\b/i],
  ["gaming", /\b(gam(e|ing|er)s?|minecraft|valorant|fortnite|roblox|league of legends|lol|apex|cs2|csgo|counter[- ]strike|overwatch|rust|ark|gta|fivem|warzone|cod|destiny|wow|mmo|rpg|smp|server ip)\b/i],
  ["roleplay", /\b(role ?play|rp server|lore|characters?)\b/i],
  ["business", /\b(business|company|startup|professional|clients?|customers?|brand|agency|corporate|saas|product)\b/i],
  ["education", /\b(study|students?|school|university|college|class(es)?|course|learning|tutor(ing)?|homework|education)\b/i],
  ["creator", /\b(stream(er|ing)?|youtube(r)?|twitch|content creator|creator|podcast|artist|fans?|subscribers?|vtuber)\b/i],
  ["developer", /\b(develop(er|ment)|programming|coding|code|open[- ]source|software|devs?|api|hackathon|engineering)\b/i],
];

const FEATURE_KEYWORDS: [Feature, RegExp][] = [
  ["tickets", /\b(tickets?|support|help ?desk|report)\b/i],
  ["staff-applications", /\b(staff app(lication)?s?|apply|applications?|recruit(ment|ing)?)\b/i],
  ["announcements", /\b(announce(ments?)?|news|updates?)\b/i],
  ["verification", /\b(verif(y|ication)|captcha|gate)\b/i],
  ["leveling", /\b(level(l?ing|s)?|xp|ranks?|rank ?up)\b/i],
  ["economy", /\b(economy|currency|coins?|shop|points)\b/i],
  ["giveaways", /\b(giveaways?|prizes?)\b/i],
  ["events", /\b(events?|tournaments?|game nights?|meetups?)\b/i],
  ["voice", /\b(voice|vc|talk|hang ?out)\b/i],
  ["media", /\b(media|clips?|screenshots?|art|memes?|photos?)\b/i],
  ["suggestions", /\b(suggestions?|feedback|ideas?)\b/i],
  ["role-menus", /\b(self[- ]?roles?|reaction roles?|role menus?|pick roles?|pronouns?|notifications? roles?)\b/i],
  ["ai", /\b(ai|assistant|chatbot|gpt)\b/i],
  ["partnerships", /\b(partner(s|ships?)?|affiliates?)\b/i],
  ["faq", /\b(faq|questions|info(rmation)?|rules)\b/i],
  ["polls", /\b(polls?|vote|voting)\b/i],
  ["music", /\b(music|songs?|dj|listening)\b/i],
  ["lfg", /\b(lfg|looking for (group|team|players)|squad|teammates?|duo)\b/i],
  ["showcase", /\b(showcase|portfolio|projects?|builds?|creations?)\b/i],
];

const KNOWN_GAMES = ["Minecraft", "Valorant", "Fortnite", "Roblox", "League of Legends", "Apex Legends", "Counter-Strike 2", "Overwatch 2", "Rust", "ARK", "GTA V", "FiveM", "Warzone", "Call of Duty", "Destiny 2", "World of Warcraft", "Rocket League", "Genshin Impact", "Terraria", "Palworld", "Elden Ring", "Dota 2", "Pokémon", "Sea of Thieves", "Lethal Company", "Helldivers 2", "Marvel Rivals", "Deadlock"];

const PALETTE: Record<ServerKind, string> = {
  gaming: "#DC143C", esports: "#E11D48", community: "#DC143C", business: "#B91C1C", education: "#BE123C", creator: "#E11D48", developer: "#DC2626", roleplay: "#9F1239",
};

export function inferIntent(prompt: string): DesignIntent {
  const kind = KIND_KEYWORDS.find(([, re]) => re.test(prompt))?.[0] ?? "community";
  const features = new Set<Feature>(FEATURE_KEYWORDS.filter(([, re]) => re.test(prompt)).map(([f]) => f));
  const lower = prompt.toLowerCase();
  const topics = KNOWN_GAMES.filter((g) => lower.includes(g.toLowerCase()) || (g === "League of Legends" && /\blol\b/i.test(prompt)) || (g === "Counter-Strike 2" && /\bcs2|csgo|counter[- ]strike\b/i.test(prompt)));
  const named = prompt.match(/(?:called|named)\s+["“']?([^"”'.,\n]{2,40})/i)?.[1]?.trim();
  const professional = /\b(professional|formal|corporate|clean|minimal)\b/i.test(prompt) || kind === "business";
  const playful = /\b(fun|chill|casual|playful|memes?|silly)\b/i.test(prompt);
  // Sensible defaults every server benefits from.
  features.add("announcements").add("faq");
  if (kind !== "business") features.add("voice");
  if (kind === "gaming" || kind === "esports") features.add("lfg").add("media").add("leveling").add("role-menus");
  if (kind === "creator") features.add("announcements").add("media").add("leveling").add("giveaways");
  if (kind === "business") features.add("tickets");
  if (/\bfriendly|welcom(e|ing)|community\b/i.test(prompt)) features.add("leveling");
  return {
    kind, name: named, topics, features, primaryColor: PALETTE[kind],
    tone: professional ? "professional" : playful ? "playful" : "friendly",
    emoji: !professional || /\bemoji\b/i.test(prompt),
  };
}

/** Composes a full blueprint from an intent. Deterministic and offline. */
export function composeBlueprint(intent: DesignIntent): Blueprint {
  const f = intent.features;
  const e = (emoji: string, name: string) => (intent.emoji ? `${emoji}┃${name}` : name);
  const isGame = intent.kind === "gaming" || intent.kind === "esports";
  const staffLabel = intent.kind === "business" ? "Team" : "Staff";

  const roles: BlueprintInput["roles"] = [
    { key: "owner", name: intent.kind === "business" ? "Leadership" : "Owner", color: "#DC143C", hoist: true, preset: "admin" },
    { key: "admin", name: "Admin", color: "#B91C1C", hoist: true, preset: "manager" },
    { key: "moderator", name: intent.kind === "business" ? "Community Manager" : "Moderator", color: "#F43F5E", hoist: true, preset: "moderator" },
  ];
  if (f.has("tickets") || f.has("staff-applications")) roles.push({ key: "support", name: "Support", color: "#FB7185", hoist: true, preset: "support" });
  if (intent.kind === "creator") roles.push({ key: "vip", name: "VIP", color: "#FDA4AF", hoist: true, preset: "member" }, { key: "subscriber", name: "Subscriber", color: "#FECDD3", preset: "member" });
  if (intent.kind === "esports") roles.push({ key: "player", name: "Roster", color: "#FDA4AF", hoist: true, preset: "member" });
  if (f.has("leveling")) roles.push(
    { key: "lvl_legend", name: "Legend", color: "#E5E5E5", hoist: false, preset: "cosmetic" },
    { key: "lvl_veteran", name: "Veteran", color: "#A3A3A3", preset: "cosmetic" },
    { key: "lvl_regular", name: "Regular", color: "#737373", preset: "cosmetic" },
  );
  roles.push({ key: "member", name: intent.kind === "business" ? "Customer" : "Member", color: "#525252", preset: "member" });
  const pingRoles: { key: string; label: string; emoji: string }[] = [];
  if (f.has("announcements")) pingRoles.push({ key: "ping_announcements", label: "Announcements", emoji: "📢" });
  if (f.has("events")) pingRoles.push({ key: "ping_events", label: "Events", emoji: "🎉" });
  if (f.has("giveaways")) pingRoles.push({ key: "ping_giveaways", label: "Giveaways", emoji: "🎁" });
  if (intent.kind === "creator") pingRoles.push({ key: "ping_live", label: "Live Alerts", emoji: "🔴" });
  for (const p of pingRoles) roles.push({ key: p.key, name: `${p.label} Ping`, preset: "cosmetic", mentionable: true });
  const gameRoles = isGame ? intent.topics.map((g) => ({ key: `game_${g.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, label: g })) : [];
  for (const g of gameRoles) roles.push({ key: g.key, name: g.label, preset: "cosmetic", mentionable: true });

  const categories: BlueprintCategory[] = [];
  const cat = (c: Omit<BlueprintCategory, "channels"> & { channels: BlueprintInput["channels"] }) => categories.push(c as BlueprintCategory);

  // Start / information
  const info: BlueprintInput["channels"] = [
    { key: "welcome", name: e("👋", "welcome"), readOnly: true, topic: "Say hello! New members are announced here." },
    { key: "rules", name: e("📜", "rules"), readOnly: true, topic: "Server rules — read before chatting." },
  ];
  if (f.has("verification")) info.unshift({ key: "verify", name: e("✅", "verify"), readOnly: true, topic: "Verify to unlock the server." });
  if (f.has("announcements")) info.push({ key: "announcements", name: e("📢", "announcements"), type: "announcement", readOnly: true, topic: "Official news and updates." });
  if (f.has("faq")) info.push({ key: "faq", name: e("❓", "faq"), readOnly: true, topic: "Frequently asked questions." });
  if (f.has("role-menus") || pingRoles.length || gameRoles.length) info.push({ key: "roles", name: e("🎭", "roles"), readOnly: true, topic: "Pick your roles and notifications." });
  cat({ key: "cat_start", name: intent.emoji ? "━━ ✦ START HERE ✦ ━━" : "Start Here", channels: info });

  // Community
  const community: BlueprintInput["channels"] = [
    { key: "general", name: e("💬", intent.kind === "business" ? "lounge" : "general"), topic: "General chat — keep it friendly." },
  ];
  if (f.has("media") || intent.kind === "creator") community.push({ key: "media", name: e("📸", "media"), slowmode: 10, topic: "Share clips, screenshots and creations." });
  if (intent.tone !== "professional") community.push({ key: "memes", name: e("😂", "memes"), slowmode: 5 });
  if (f.has("suggestions")) community.push({ key: "suggestions", name: e("💡", "suggestions"), type: "forum", topic: "Suggest ideas for the server." });
  if (f.has("leveling") || f.has("economy")) community.push({ key: "bot_commands", name: e("🤖", "bot-commands"), topic: "Use /rank, /daily, /leaderboard here." });
  if (f.has("ai")) community.push({ key: "ask_moth", name: e("🦋", "ask-moth"), topic: "Chat with the MOTH AI assistant." });
  if (f.has("events")) community.push({ key: "events", name: e("🎉", "events"), readOnly: true, topic: "Upcoming events." });
  if (f.has("giveaways")) community.push({ key: "giveaways", name: e("🎁", "giveaways"), readOnly: true });
  if (f.has("polls")) community.push({ key: "polls", name: e("📊", "polls"), readOnly: true });
  if (f.has("showcase")) community.push({ key: "showcase", name: e("✨", "showcase"), type: "forum", topic: "Show off your work." });
  if (f.has("partnerships")) community.push({ key: "partners", name: e("🤝", "partners"), readOnly: true });
  cat({ key: "cat_community", name: intent.emoji ? "━━ ✦ COMMUNITY ✦ ━━" : "Community", channels: community });

  // Kind-specific sections
  if (isGame) {
    const topics = intent.topics.length ? intent.topics : ["Gaming"];
    for (const g of topics.slice(0, 6)) {
      const slug = g.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const key = `game_${slug.replace(/-/g, "_")}`;
      const channels: BlueprintInput["channels"] = [
        { key: `${key}_chat`, name: e("🎮", `${slug}-chat`), topic: `Everything ${g}.` },
      ];
      if (f.has("lfg")) channels.push({ key: `${key}_lfg`, name: e("🔎", `${slug}-lfg`), slowmode: 30, topic: `Find teammates for ${g}.` });
      if (/minecraft/i.test(g)) channels.push(
        { key: "mc_server_info", name: e("🧱", "server-info"), readOnly: true, topic: "Server IP, version, and modpacks." },
        { key: "mc_builds", name: e("🏰", "builds"), slowmode: 10, topic: "Show off your builds." },
      );
      if (f.has("voice")) channels.push({ key: `${key}_vc`, name: `🔊 ${g}`, type: "voice" });
      cat({ key: `cat_${key}`, name: intent.emoji ? `━━ ✦ ${g.toUpperCase()} ✦ ━━` : g, channels });
    }
  }
  if (intent.kind === "esports") cat({ key: "cat_team", name: intent.emoji ? "━━ ✦ TEAM ✦ ━━" : "Team", private: true, visibleTo: ["player", "moderator", "admin"], channels: [
    { key: "team_chat", name: e("🏆", "team-chat") }, { key: "scrims", name: e("⚔️", "scrims") }, { key: "strategy", name: e("🧠", "strategy") }, { key: "team_vc", name: "🎧 Team Comms", type: "voice" },
  ] });
  if (intent.kind === "education") cat({ key: "cat_study", name: intent.emoji ? "━━ ✦ STUDY ✦ ━━" : "Study", channels: [
    { key: "homework_help", name: e("📚", "homework-help"), type: "forum" }, { key: "resources", name: e("🔗", "resources"), readOnly: true, writableBy: ["moderator"] },
    ...(intent.topics.length ? intent.topics : ["Maths", "Science", "Languages"]).map((s) => ({ name: e("📝", s.toLowerCase().replace(/\s+/g, "-")) })),
    { key: "study_vc", name: "📖 Study Room", type: "voice" as const },
  ] });
  if (intent.kind === "developer") cat({ key: "cat_dev", name: intent.emoji ? "━━ ✦ DEVELOPMENT ✦ ━━" : "Development", channels: [
    { key: "dev_help", name: e("🛠️", "help"), type: "forum", topic: "Ask technical questions." }, { key: "showcase_dev", name: e("🚀", "showcase") },
    { key: "snippets", name: e("🧩", "snippets") }, { key: "releases", name: e("🏷️", "releases"), type: "announcement", readOnly: true },
  ] });
  if (intent.kind === "creator") cat({ key: "cat_content", name: intent.emoji ? "━━ ✦ CONTENT ✦ ━━" : "Content", channels: [
    { key: "live", name: e("🔴", "live-now"), readOnly: true, topic: "Stream and upload alerts." }, { key: "fan_art", name: e("🎨", "fan-art"), slowmode: 10 },
    { key: "vip_lounge", name: e("💎", "vip-lounge"), private: true, visibleTo: ["vip", "moderator"] },
  ] });
  if (intent.kind === "business") cat({ key: "cat_product", name: "Product", channels: [
    { key: "product_updates", name: "product-updates", type: "announcement", readOnly: true }, { key: "feedback", name: "feedback", type: "forum" }, { key: "showcase_biz", name: "customer-showcase" },
  ] });
  if (intent.kind === "roleplay") cat({ key: "cat_rp", name: intent.emoji ? "━━ ✦ ROLEPLAY ✦ ━━" : "Roleplay", channels: [
    { key: "lore", name: e("📖", "lore"), readOnly: true }, { key: "characters", name: e("🧝", "characters"), type: "forum" }, { key: "rp_main", name: e("🌍", "main-rp"), slowmode: 5 }, { key: "ooc", name: e("💭", "out-of-character") },
  ] });

  if (f.has("voice") && !isGame) cat({ key: "cat_voice", name: intent.emoji ? "━━ ✦ VOICE ✦ ━━" : "Voice", channels: [
    { key: "vc_lounge", name: "🔊 Lounge", type: "voice" }, { key: "vc_chill", name: "🎧 Chill", type: "voice" }, ...(f.has("music") ? [{ key: "vc_music", name: "🎵 Music", type: "voice" as const }] : []),
  ] });
  else if (f.has("voice") && isGame) cat({ key: "cat_voice", name: intent.emoji ? "━━ ✦ VOICE ✦ ━━" : "Voice", channels: [
    { key: "vc_lounge", name: "🔊 Lounge", type: "voice" }, { key: "vc_squad1", name: "🎮 Squad 1", type: "voice", userLimit: 5 }, { key: "vc_squad2", name: "🎮 Squad 2", type: "voice", userLimit: 5 }, { key: "vc_afk", name: "💤 AFK", type: "voice" },
  ] });

  // Support
  if (f.has("tickets") || f.has("staff-applications")) cat({ key: "cat_support", name: intent.emoji ? "━━ ✦ SUPPORT ✦ ━━" : "Support", channels: [
    { key: "open_ticket", name: e("🎫", "open-a-ticket"), readOnly: true, topic: "Need help? Open a private ticket." },
  ] });
  cat({ key: "cat_tickets", name: "Tickets", private: true, visibleTo: ["support", "moderator", "admin"].filter((k) => roles.some((r) => r.key === k)), channels: [] });

  // Staff
  cat({ key: "cat_staff", name: intent.emoji ? `━━ ✦ ${staffLabel.toUpperCase()} ✦ ━━` : staffLabel, private: true, visibleTo: ["moderator", "admin", ...(roles.some((r) => r.key === "support") ? ["support"] : [])], channels: [
    { key: "staff_chat", name: e("🛡️", "staff-chat") },
    { key: "staff_announcements", name: e("📌", "staff-announcements"), readOnly: true, writableBy: ["admin"] },
    { key: "mod_log", name: e("📋", "mod-log"), readOnly: true, writableBy: [] },
    { key: "security_log", name: e("🚨", "security-log"), readOnly: true, writableBy: [] },
    ...(f.has("tickets") || f.has("staff-applications") ? [{ key: "transcripts", name: e("🗂️", "transcripts"), readOnly: true, writableBy: [] }] : []),
    { key: "appeals", name: e("⚖️", "appeals"), readOnly: true, writableBy: [] },
    { key: "staff_vc", name: "🔒 Staff Meeting", type: "voice" },
  ] });

  // Drop the tickets category if no ticket system.
  if (!f.has("tickets") && !f.has("staff-applications")) categories.splice(categories.findIndex((c) => c.key === "cat_tickets"), 1);

  // Features
  const serverName = intent.name ?? defaultName(intent);
  const features: BlueprintInput["features"] = {
    welcome: { channel: "welcome", title: `Welcome to ${serverName}!`, message: welcomeText(intent), dm: intent.tone === "professional" ? undefined : `Hey {user.name}! Thanks for joining **{server}**. Check out the rules and grab your roles. 🦋` },
    goodbye: { channel: "staff_chat", message: "**{user.name}** left the server. ({server.members} members)" },
    autoroles: f.has("verification") ? [] : ["member"],
    moderation: { preset: intent.tone === "professional" ? "strict" : "balanced", logChannel: "mod_log", modRoles: ["moderator", "admin"], appealsChannel: "appeals" },
    security: { sensitivity: intent.kind === "gaming" || intent.kind === "esports" || intent.kind === "creator" ? "high" : "medium", logChannel: "security_log", alertRoles: ["moderator", "admin"] },
    messages: [
      { channel: "rules", embed: { title: `📜 ${serverName} — Rules`, description: rulesText(intent), footer: "Breaking the rules may result in warnings, timeouts or bans." } },
    ],
  };
  if (f.has("verification")) features.verification = { mode: "oauth", channel: "verify", verifiedRole: "member", message: `Welcome to **${serverName}**! Press **Verify** below to confirm you're human and unlock the server.` };
  if (f.has("faq")) features.messages!.push({ channel: "faq", embed: { title: "❓ Frequently Asked Questions", description: faqText(intent) } });
  if (f.has("tickets") || f.has("staff-applications")) {
    const categoriesT: NonNullable<NonNullable<BlueprintInput["features"]>["tickets"]>[number]["categories"] = [];
    categoriesT.push(
      { label: "General Support", emoji: "🛟", description: "Questions or help with anything" },
      { label: "Report a Member", emoji: "🚩", description: "Report rule-breaking privately", staffRoles: ["moderator", "admin"], questions: [{ label: "Who are you reporting?", required: true }, { label: "What happened?", long: true, required: true }] },
    );
    if (intent.kind === "business") categoriesT.push({ label: "Billing", emoji: "💳", description: "Payments and invoices", staffRoles: ["admin"] });
    if (f.has("staff-applications")) categoriesT.push({ label: "Staff Application", emoji: "📝", description: `Apply to join the ${staffLabel.toLowerCase()} team`, staffRoles: ["admin"], questions: [
      { label: "How old are you?", required: true }, { label: "Timezone & weekly availability", required: true },
      { label: "Previous moderation experience", long: true, required: true }, { label: "Why do you want to join?", long: true, required: true },
    ] });
    if (f.has("partnerships")) categoriesT.push({ label: "Partnership", emoji: "🤝", description: "Partner with us", staffRoles: ["admin"] });
    features.tickets = [{ name: "Support", channel: "open_ticket", title: "🎫 Need help?", description: "Select a category below to open a private ticket with our team.", parentCategory: "cat_tickets", transcriptChannel: "transcripts", staffRoles: ["support", "moderator", "admin"].filter((k) => roles.some((r) => r.key === k)), categories: categoriesT }];
  }
  const menus: NonNullable<NonNullable<BlueprintInput["features"]>["roleMenus"]> = [];
  if (pingRoles.length) menus.push({ name: "Notifications", channel: "roles", style: "buttons", mode: "toggle", title: "🔔 Notification roles", description: "Choose which pings you want to receive.", options: pingRoles.map((p) => ({ role: p.key, label: p.label, emoji: p.emoji })) });
  if (gameRoles.length) menus.push({ name: "Games", channel: "roles", style: "select", mode: "toggle", title: "🎮 Your games", description: "Pick the games you play to unlock pings and find teammates.", options: gameRoles.map((g) => ({ role: g.key, label: g.label })) });
  if (menus.length) features.roleMenus = menus;
  if (f.has("leveling")) features.leveling = { enabled: true, announceChannel: community.some((c) => c.key === "bot_commands") ? "bot_commands" : "general", rewards: [{ level: 5, role: "lvl_regular" }, { level: 20, role: "lvl_veteran" }, { level: 50, role: "lvl_legend" }] };
  if (f.has("economy")) features.economy = { enabled: true, currencyName: isGame ? "gold" : "coins", currencyEmoji: isGame ? "🪙" : "💰" };
  if (f.has("leveling") || f.has("economy")) features.achievements = { enabled: true };
  if (f.has("ai")) features.ai = { enabled: true, chatChannels: ["ask_moth"], tone: intent.tone };
  if (intent.kind !== "business") features.milestones = { channel: "general", every: 100 };
  features.automations = [];
  if (f.has("tickets") || f.has("staff-applications")) features.automations.push({
    name: "Ticket opened alert", description: "Notify staff chat whenever a ticket is opened.",
    definition: { trigger: { type: "ticket_opened" }, steps: [{ kind: "action", action: { type: "send_message", channelId: "ref:chan:staff_chat", message: { content: "🎫 New ticket opened by {user}." } } }] },
  } as never);

  return blueprintSchema.parse({
    name: serverName,
    description: `A ${intent.tone} ${intent.kind} server${intent.topics.length ? ` for ${intent.topics.join(", ")}` : ""}.`,
    purpose: purposeText(intent), audience: audienceText(intent),
    theme: { primaryColor: intent.primaryColor, accentColor: "#1F1F1F", namingStyle: intent.emoji ? "emoji┃name" : "plain lowercase", tone: intent.tone, tagline: `${serverName} — ${purposeText(intent)}` },
    verificationLevel: f.has("verification") ? "medium" : "low",
    roles, categories, features,
  } satisfies BlueprintInput);
}

function defaultName(i: DesignIntent): string {
  if (i.topics.length === 1) return `${i.topics[0]} Hub`;
  return { gaming: "The Gaming Hub", esports: "Team HQ", community: "The Hive", business: "Customer Community", education: "Study Hall", creator: "Creator Community", developer: "Dev Hub", roleplay: "The Realm" }[i.kind];
}
function purposeText(i: DesignIntent) {
  return { gaming: `a home for ${i.topics.join(", ") || "gamers"}`, esports: "competitive play and team coordination", community: "a friendly place to hang out", business: "customer support and product community", education: "studying together and sharing knowledge", creator: "connecting a creator with their community", developer: "building, learning and shipping together", roleplay: "immersive collaborative storytelling" }[i.kind];
}
function audienceText(i: DesignIntent) {
  return { gaming: "players of all skill levels", esports: "players, staff and fans", community: "anyone looking for good company", business: "customers, partners and the team", education: "students and tutors", creator: "fans and supporters", developer: "developers and contributors", roleplay: "writers and roleplayers" }[i.kind];
}
function welcomeText(i: DesignIntent) {
  const base = "Hey {user.mention}, welcome aboard! You're member **#{server.members}**.";
  return i.tone === "professional" ? `Welcome {user.mention}. Please review the rules and let us know if you need help — you're member #{server.members}.` : `${base}\n\n📜 Read the rules\n🎭 Grab your roles\n💬 Say hi in general!`;
}
function rulesText(i: DesignIntent) {
  const rules = [
    "**Be respectful.** No harassment, hate speech, or discrimination.",
    "**No spam.** This includes excessive mentions, emojis, and self-promotion.",
    "**Keep it safe for work** outside of designated channels.",
    "**Use channels for their purpose.** Check channel topics.",
    "**No unauthorised advertising** or server invites.",
    "**Follow Discord's Terms of Service** and Community Guidelines.",
    "**Listen to staff.** If you disagree, open a ticket — don't argue in public.",
  ];
  if (i.kind === "gaming" || i.kind === "esports") rules.push("**No cheating, exploits or account trading** discussion.");
  return rules.map((r, n) => `**${n + 1}.** ${r}`).join("\n");
}
function faqText(i: DesignIntent) {
  const qs = [
    ["How do I get roles?", "Head to the roles channel and pick from the menus."],
    ["How do I contact staff?", "Open a ticket in the support section — never DM staff directly."],
    ["How do levels work?", "Chat to earn XP. Use `/rank` to check your progress."],
  ];
  if (i.topics.some((t) => /minecraft/i.test(t))) qs.unshift(["What's the server IP?", "Check the server-info channel for the IP and version."]);
  return qs.map(([q, a]) => `**${q}**\n${a}`).join("\n\n");
}

/** Built-in reusable blueprint templates. */
export const BUILTIN_TEMPLATES: { id: string; name: string; description: string; prompt: string; tags: string[] }[] = [
  { id: "gaming", name: "Gaming Community", description: "Game sections, LFG, voice squads, levels, giveaways and support.", prompt: "A friendly gaming community with LFG, voice channels, leveling, giveaways, events and support tickets", tags: ["gaming"] },
  { id: "minecraft", name: "Minecraft Server", description: "Professional Minecraft community with server info, builds, staff applications and tickets.", prompt: "A professional gaming community for Minecraft with staff applications, support tickets, announcements, game-specific channels, verification and a friendly community", tags: ["gaming", "minecraft"] },
  { id: "esports", name: "Esports Team", description: "Roster-only team area, scrims, fan community and tournaments.", prompt: "An esports team server with scrims, tournaments, events, giveaways and partnerships", tags: ["esports"] },
  { id: "community", name: "Social Community", description: "Hangout server with self-roles, events, polls and levels.", prompt: "A friendly community server with self roles, events, polls, leveling, economy, giveaways and voice", tags: ["community"] },
  { id: "creator", name: "Creator / Streamer", description: "Live alerts, VIP lounge, fan art, giveaways and subscriber roles.", prompt: "A streamer community with live alerts, fan art media, giveaways, leveling, verification and self roles", tags: ["creator"] },
  { id: "business", name: "Business & Support", description: "Professional customer community with ticketing, feedback forums and product updates.", prompt: "A professional business support community with tickets, product updates, feedback suggestions, faq and verification", tags: ["business"] },
  { id: "education", name: "Study Group", description: "Homework forum, subject channels, study rooms and resources.", prompt: "A study server for students with homework help, resources, study voice rooms, leveling and polls", tags: ["education"] },
  { id: "developer", name: "Developer Community", description: "Help forum, showcases, releases and an AI coding assistant.", prompt: "A developer community for an open-source project with help forum, showcase, releases, suggestions, tickets and an AI assistant", tags: ["developer"] },
  { id: "roleplay", name: "Roleplay Realm", description: "Lore, character forum, in-character and out-of-character channels.", prompt: "A roleplay server with lore, characters, events, verification and leveling", tags: ["roleplay"] },
];

export function builtinTemplate(id: string): Blueprint | null {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === id);
  return t ? composeBlueprint(inferIntent(t.prompt)) : null;
}

/** Offline designer: natural language → full blueprint. */
export function designFromPrompt(prompt: string): { blueprint: Blueprint; intent: DesignIntent; reply: string } {
  const intent = inferIntent(prompt);
  const blueprint = composeBlueprint(intent);
  const feats = [...intent.features].filter((x) => !["faq", "announcements"].includes(x));
  const reply = [
    `I've designed **${blueprint.name}** — ${blueprint.description}`,
    `• ${blueprint.roles.length} roles in a clear hierarchy, ${blueprint.categories.length} categories and ${blueprint.categories.reduce((n, c) => n + c.channels.length, 0)} channels.`,
    feats.length ? `• Features: ${feats.join(", ")}.` : "",
    "• Welcome messages, auto-moderation, anti-raid protection, mod logs and appeals are configured.",
    "Review the preview, then tell me what to change or approve it to build.",
  ].filter(Boolean).join("\n");
  return { blueprint, intent, reply };
}
