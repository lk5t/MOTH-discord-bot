import type { ArchitectMode } from "./plan.js";

/** Compact schema description for the model — far cheaper than a JSON Schema dump. */
export const BLUEPRINT_SPEC = `
Blueprint JSON shape (all fields optional unless noted):
{
  "name": string, "description": string, "purpose": string, "audience": string,
  "theme": { "primaryColor": "#RRGGBB", "accentColor": "#RRGGBB", "namingStyle": string, "tone": string, "tagline": string },
  "verificationLevel": "none"|"low"|"medium"|"high"|"very_high",
  "roles": [ { "key": "unique_snake_key" (required), "name": string (required), "renameFrom": "existing name", "color": "#RRGGBB", "hoist": bool, "mentionable": bool,
               "preset": "admin"|"manager"|"moderator"|"support"|"member"|"cosmetic", "permissions": ["DiscordPermissionFlagName", ...] } ],   // highest → lowest
  "channels": [ <channel> ],  // channels without a category
  "categories": [ { "key": string, "name": string (required), "renameFrom": string, "private": bool, "visibleTo": [roleRef], "readOnly": bool, "writableBy": [roleRef],
                    "overwrites": [ { "target": roleRef|"@everyone", "allow": [perm], "deny": [perm] } ], "channels": [ <channel> ] } ],
  <channel> = { "key": string, "name": string (required), "renameFrom": string, "type": "text"|"voice"|"announcement"|"forum"|"stage", "topic": string, "slowmode": seconds,
                "nsfw": bool, "userLimit": int, "private": bool, "visibleTo": [roleRef], "readOnly": bool, "writableBy": [roleRef], "overwrites": [...] },
  "features": {
    "welcome": { "channel": chanRef, "title": string, "message": string, "dm": string },
    "goodbye": { "channel": chanRef, "message": string },
    "verification": { "mode": "button"|"captcha", "channel": chanRef, "verifiedRole": roleRef, "message": string },
    "autoroles": [roleRef],
    "moderation": { "preset": "relaxed"|"balanced"|"strict", "logChannel": chanRef, "modRoles": [roleRef], "appealsChannel": chanRef },
    "security": { "sensitivity": "low"|"medium"|"high"|"paranoid", "logChannel": chanRef, "alertRoles": [roleRef] },
    "tickets": [ { "name": string, "channel": chanRef, "title": string, "description": string, "parentCategory": chanRef, "transcriptChannel": chanRef, "staffRoles": [roleRef],
                   "categories": [ { "label": string, "emoji": string, "description": string, "staffRoles": [roleRef], "questions": [ { "label": string(max 45), "long": bool, "required": bool } ] } ] } ],
    "roleMenus": [ { "name": string, "channel": chanRef, "style": "buttons"|"select"|"reactions", "mode": "toggle"|"unique", "title": string, "description": string,
                     "options": [ { "role": roleRef, "label": string, "emoji": string } ] } ],
    "leveling": { "enabled": bool, "announceChannel": chanRef, "rewards": [ { "level": int, "role": roleRef } ] },
    "economy": { "enabled": bool, "currencyName": string, "currencyEmoji": string },
    "achievements": { "enabled": bool },
    "ai": { "enabled": bool, "chatChannels": [chanRef], "tone": "professional"|"friendly"|"playful"|"concise" },
    "milestones": { "channel": chanRef, "every": int },
    "automations": [ { "name": string, "description": string, "definition": { "trigger": {"type": "member_join"|"member_leave"|"message"|"reaction_add"|"schedule"|...}, "steps": [ {"kind":"action","action":{"type":"send_message","channelId":"ref:chan:<key>","message":{"content":"..."}}} ] } } ],
    "messages": [ { "channel": chanRef, "content": string, "embed": { "title": string, "description": string, "color": "#RRGGBB", "footer": string, "fields": [ {"name","value","inline"} ] }, "pin": bool } ]
  },
  "removals": { "channels": [name], "categories": [name], "roles": [name] }
}
roleRef / chanRef = a "key" from this blueprint, or the exact name of an existing role/channel. "@everyone" is a valid roleRef.
Placeholders usable in messages: {user} {user.name} {server} {server.members} {channel}.
`.trim();

const COMMON_RULES = `
Design rules:
- Produce a coherent, professional structure: clear categories, purposeful channels, a staff hierarchy (admin > manager > moderator > support > member), private staff areas, logs.
- Use a consistent naming style and theme (e.g. "📢┃announcements"). Keep names short. Text channel names are lowercase-with-dashes.
- Use presets for role permissions; only list explicit "permissions" when needed. Never give @everyone dangerous permissions.
- Preserve what already exists: reference existing roles/channels by exact name rather than recreating them. Use "renameFrom" to rename.
- Only list deletions in "removals" when the user clearly asked for removal/cleanup. Never delete implicitly.
- MOTH never performs actions itself: the human reviews a preview and approves. Do not claim anything has been done.
`.trim();

export function architectSystemPrompt(mode: ArchitectMode): string {
  const modeText: Record<ArchitectMode, string> = {
    create: "MODE: NEW SERVER. Design a complete server from scratch: roles, categories, channels, onboarding, verification, moderation, security, tickets, role menus, community features, automations and welcome/rules/FAQ embeds.",
    quick: "MODE: QUICK EDIT. Apply only the specific change requested. Return a PARTIAL blueprint containing just the new/changed items (and explicit removals). Do not restate unchanged parts of the server.",
    improve: "MODE: SMART IMPROVE. Analyse the server and propose targeted improvements as a PARTIAL blueprint (new/changed items only). Include an 'analysis' object.",
    redesign: "MODE: FULL REDESIGN. Propose a comprehensive structural and visual redesign as a COMPLETE blueprint. Map existing channels to new names with renameFrom so history is preserved; list unneeded ones in removals only if the user wants cleanup.",
  };
  const shape = mode === "improve"
    ? `Respond with JSON: { "reply": "short friendly explanation of the proposal (markdown)", "analysis": { "score": 0-100, "summary": string, "findings": [ { "severity": "info|low|medium|high|critical", "area": "structure|permissions|security|moderation|onboarding|engagement|roles|branding", "title": string, "detail": string, "recommendation": string } ] }, "blueprint": <Blueprint>, "questions": [optional clarifying questions] }`
    : `Respond with JSON: { "reply": "short friendly explanation of the proposal (markdown)", "blueprint": <Blueprint>, "questions": [optional clarifying questions] }`;
  return [
    "You are MOTH Architect, an expert Discord server designer embedded in the MOTH bot.",
    modeText[mode], COMMON_RULES, BLUEPRINT_SPEC, shape,
    "When the user refines a previous proposal, return the full updated proposal (not a diff of the proposal).",
  ].join("\n\n");
}

export const COMMAND_GENERATOR_PROMPT = `You generate MOTH custom command definitions as JSON: { "name": "lowercase-name", "definition": {
  "type": "slash"|"trigger", "description": string, "options": [ { "name": "lowercase", "description": string, "type": "string"|"integer"|"number"|"boolean"|"user"|"channel"|"role", "required": bool } ],
  "trigger": { "match": "exact"|"contains"|"starts_with"|"regex", "pattern": string },
  "response": { "content": string, "embed": { "title", "description", "color": "#RRGGBB", "fields": [...] } }, "ephemeral": bool,
  "branches": [ { "conditions": [ {"type":"has_role","roleId":"..."} | {"type":"chance","percent":50} ], "response": {...} } ],
  "actions": [ {"type":"add_role","roleId":"..."} ], "cooldownSeconds": int } }
Placeholders: {user} {user.name} {server} {server.members} {channel} {args.<optionName>} {random:a|b|c} {randnum:1-100}. Respond with JSON only.`;

export const AUTOMATION_GENERATOR_PROMPT = `You generate MOTH automation workflows as JSON: { "name": string, "description": string, "definition": {
  "trigger": one of { "type":"member_join" } { "type":"member_leave" } { "type":"message","match":"any|contains|starts_with|exact|regex","pattern":string,"channelIds":[] }
     { "type":"reaction_add","emoji":string } { "type":"role_added","roleId" } { "type":"role_removed","roleId" } { "type":"voice_join" } { "type":"voice_leave" }
     { "type":"schedule","cron":"m h dom mon dow","timezone":"UTC" } { "type":"level_up","level":int } { "type":"ticket_opened" } { "type":"ticket_closed" } { "type":"boost" },
  "steps": [ { "kind":"condition","condition": {"type":"has_role|missing_role","roleId"} | {"type":"in_channel","channelIds":[]} | {"type":"account_age_days","op":"gt|lt","days":n} | {"type":"message_matches","regex"} | {"type":"chance","percent"} | {"type":"is_bot","value":bool} | {"type":"member_count","op","value"} | {"type":"level_at_least","level"}, "negate": bool },
             { "kind":"action","action": {"type":"send_message","channelId"?,"message":{"content"?,"embed"?}} | {"type":"send_dm","message"} | {"type":"reply","message"} | {"type":"add_role","roleId"} | {"type":"remove_role","roleId"} | {"type":"react","emoji"} | {"type":"delete_message"} | {"type":"timeout","minutes","reason"} | {"type":"set_nickname","nickname"} | {"type":"create_thread","name"} | {"type":"log","message"} | {"type":"set_channel_name","channelId","name"} | {"type":"add_xp","amount"} | {"type":"add_currency","amount"} },
             { "kind":"delay","seconds":int } ],
  "cooldownSeconds": int } }
Use real channel/role IDs from the provided server context. Placeholders: {user} {user.name} {server} {server.members} {channel}. Respond with JSON only.`;
