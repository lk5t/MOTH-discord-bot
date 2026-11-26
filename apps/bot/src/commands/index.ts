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

export const commands: SlashCommand[] = [...moderationCommands, ...ticketCommands, ...architectCommands, ...aiCommands, ...communityCommands, ...adminCommands];
export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
export const BUILTIN_NAMES = new Set(commands.map((c) => c.data.name));

export const components: ComponentHandler[] = [ticketComponents, architectComponents, verifyComponents, roleMenuComponents, giveawayComponents, pollComponents, appealReviewComponents, backupComponents];
export const componentMap = new Map(components.map((c) => [c.prefix, c]));
