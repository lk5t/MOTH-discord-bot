import type { ComponentHandler, SlashCommand } from "./types.js";
import { moderationCommands } from "./moderation.js";
import { ticketCommands } from "./tickets.js";
import { architectCommands, architectComponents } from "./architect.js";
import { aiCommands } from "./ai.js";
import { communityCommands } from "./community.js";
import { adminCommands, backupComponents } from "./admin.js";
import { ticketComponents } from "../modules/tickets.js";
import { verifyComponents } from "../modules/welcome.js";
import { roleMenuComponents } from "../modules/roleMenus.js";
import { giveawayComponents } from "../modules/giveaways.js";
import { pollComponents } from "../modules/polls.js";
import { appealReviewComponents } from "../modules/appeals.js";
import { toolCommands, setupComponents } from "./tools.js";
import { suggestionComponents } from "../modules/suggestions.js";
import { tempVoiceComponents } from "../modules/tempVoice.js";

export const commands: SlashCommand[] = [...moderationCommands, ...ticketCommands, ...architectCommands, ...aiCommands, ...communityCommands, ...adminCommands, ...toolCommands];
export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
export const BUILTIN_NAMES = new Set(commands.map((c) => c.data.name));

export const components: ComponentHandler[] = [ticketComponents, architectComponents, verifyComponents, roleMenuComponents, giveawayComponents, pollComponents, appealReviewComponents, backupComponents, setupComponents, suggestionComponents, tempVoiceComponents];
export const componentMap = new Map(components.map((c) => [c.prefix, c]));
