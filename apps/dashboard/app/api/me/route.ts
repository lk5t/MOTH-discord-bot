import { eq, inArray } from "drizzle-orm";
import { getDb, guilds } from "@moth/core";
import { handleError, json, ApiError } from "@/lib/api";
import { getSession, userGuilds } from "@/lib/session";
import { guildAccess, isPlatformOwner } from "@/lib/access";
import { inviteUrl } from "@/lib/discord";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const s = await getSession();
    if (!s) throw new ApiError(401, "Not signed in");
    const force = new URL(req.url).searchParams.get("refresh") === "1";
    const list = await userGuilds(s, force);
    const ids = list.map((g) => g.id);
    const present = ids.length ? await getDb().select().from(guilds).where(inArray(guilds.id, ids)) : [];
    const active = new Map(present.filter((g) => g.active).map((g) => [g.id, g]));
    const platform = isPlatformOwner(s.userId);
    const out = await Promise.all(list.map(async (g) => {
      const manage = g.owner || (BigInt(g.permissions) & 0x28n) !== 0n;
      const inGuild = active.has(g.id);
      const level = inGuild ? await guildAccess(s, g.id) : "none";
      return { id: g.id, name: g.name, icon: g.icon, inGuild, level, canInvite: manage && !inGuild, inviteUrl: manage && !inGuild ? inviteUrl(g.id) : null, memberCount: active.get(g.id)?.memberCount ?? null };
    }));
    // Platform owners also see every guild MOTH is in.
    if (platform) {
      const all = await getDb().select().from(guilds).where(eq(guilds.active, true));
      for (const g of all) if (!out.some((x) => x.id === g.id)) out.push({ id: g.id, name: g.name, icon: g.icon, inGuild: true, level: "owner", canInvite: false, inviteUrl: null, memberCount: g.memberCount });
    }
    return json({ user: s.user, platformOwner: platform, guilds: out.filter((g) => g.level !== "none" || g.canInvite).sort((a, b) => Number(b.inGuild) - Number(a.inGuild) || a.name.localeCompare(b.name)) });
  } catch (err) { return handleError(err); }
}
