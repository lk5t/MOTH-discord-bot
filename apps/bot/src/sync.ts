import { REST, Routes, type Client, type Guild } from "discord.js";
import { commands, BUILTIN_NAMES } from "./commands/index.js";
import { customSlashDefinitions } from "./modules/customCommands.js";
import { env } from "./env.js";
import { log } from "./context.js";

const rest = () => new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
const pending = new Map<string, NodeJS.Timeout>();

/** Registers built-in (when guild scoped) + custom slash commands for a guild. Debounced. */
export function scheduleGuildCommandSync(guild: Guild, delayMs = 3000): void {
  clearTimeout(pending.get(guild.id));
  pending.set(guild.id, setTimeout(() => { pending.delete(guild.id); void syncGuildCommands(guild); }, delayMs));
}

export async function syncGuildCommands(guild: Guild): Promise<number> {
  try {
    const custom = await customSlashDefinitions(guild.id, BUILTIN_NAMES);
    const body = env.COMMAND_SCOPE === "guild" ? [...commands.map((c) => c.data), ...custom] : custom;
    await rest().put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guild.id), { body });
    return body.length;
  } catch (err) {
    log.warn({ err, guild: guild.id }, "guild command sync failed");
    return 0;
  }
}

export async function syncAllCommands(client: Client): Promise<void> {
  if (env.COMMAND_SCOPE === "global") {
    await rest().put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: commands.map((c) => c.data) }).catch((err) => log.error({ err }, "global command sync failed"));
  } else {
    // Remove stale global commands when switching to guild scope.
    await rest().put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] }).catch(() => undefined);
  }
  for (const g of client.guilds.cache.values()) await syncGuildCommands(g);
  log.info({ guilds: client.guilds.cache.size, scope: env.COMMAND_SCOPE }, "slash commands synced");
}
