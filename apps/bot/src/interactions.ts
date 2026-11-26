import { type Interaction } from "discord.js";
import { commandMap, componentMap } from "./commands/index.js";
import { runCustomSlash } from "./modules/customCommands.js";
import { handleDmAppeal } from "./modules/appeals.js";
import { hasAccess } from "./lib/permissions.js";
import { respondError } from "./lib/util.js";
import { log } from "./context.js";
import { analytics } from "./modules/analytics.js";

export async function handleInteraction(i: Interaction): Promise<void> {
  try {
    if (await handleDmAppeal(i)) return;
    if (!i.inCachedGuild()) {
      if (i.isRepliable()) await respondError(i, "MOTH commands only work inside servers.");
      return;
    }
    if (i.isAutocomplete()) {
      await commandMap.get(i.commandName)?.autocomplete?.(i).catch(() => undefined);
      return;
    }
    if (i.isChatInputCommand()) {
      analytics.command(i.guildId);
      const cmd = commandMap.get(i.commandName);
      if (!cmd) { if (!(await runCustomSlash(i))) await respondError(i, "Unknown command."); return; }
      const sub = i.options.getSubcommand(false);
      const required = (sub && cmd.subAccess?.[sub]) || cmd.access;
      if (required && required !== "member" && !(await hasAccess(i.member, required))) {
        await respondError(i, `You need **${required}** access to use this command.`);
        return;
      }
      await cmd.execute(i);
      return;
    }
    if (i.isMessageComponent() || i.isModalSubmit()) {
      const [ns, prefix, ...args] = i.customId.split(":");
      if (ns !== "moth") return;
      const handler = componentMap.get(prefix);
      if (handler) await handler.handle(i, args);
    }
  } catch (err) {
    log.error({ err, type: i.type, guild: i.guildId }, "interaction failed");
    await respondError(i, `Something went wrong: ${(err as Error).message.slice(0, 200)}`);
  }
}
