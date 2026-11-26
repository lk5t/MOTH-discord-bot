import type {
  AutocompleteInteraction, ChatInputCommandInteraction, MessageComponentInteraction, ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import type { AccessLevel } from "../lib/permissions.js";

export interface SlashCommand {
  data: RESTPostAPIChatInputApplicationCommandsJSONBody;
  /** Minimum MOTH access level. Discord default_member_permissions are also set where sensible. */
  access?: AccessLevel;
  /** Per-subcommand overrides, e.g. { "rollback": "admin" }. */
  subAccess?: Record<string, AccessLevel>;
  execute(i: ChatInputCommandInteraction<"cached">): Promise<void>;
  autocomplete?(i: AutocompleteInteraction<"cached">): Promise<void>;
}

export interface ComponentHandler {
  /** customId prefix, e.g. "ticket" matches "moth:ticket:...". */
  prefix: string;
  handle(i: MessageComponentInteraction<"cached"> | ModalSubmitInteraction<"cached">, args: string[]): Promise<unknown>;
}

export const cid = (...parts: (string | number)[]) => ["moth", ...parts].join(":").slice(0, 100);
