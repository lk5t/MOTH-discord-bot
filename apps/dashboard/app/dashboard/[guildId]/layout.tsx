import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, guilds } from "@moth/core";
import { getSession } from "@/lib/session";
import { guildAccess, isPlatformOwner, SECTIONS, atLeast } from "@/lib/access";
import { Shell } from "./shell";

export const dynamic = "force-dynamic";

export default async function GuildLayout({ children, params }: { children: React.ReactNode; params: Promise<{ guildId: string }> }) {
  const { guildId } = await params;
  const s = await getSession();
  if (!s) redirect(`/api/auth/login?next=/dashboard/${guildId}`);
  if (!/^\d{15,22}$/.test(guildId)) redirect("/dashboard");
  const level = await guildAccess(s, guildId);
  if (level === "none") redirect("/dashboard");
  const [g] = await getDb().select().from(guilds).where(eq(guilds.id, guildId));
  const platform = isPlatformOwner(s.userId);
  const nav = SECTIONS.filter((x) => (x.key === "system" ? platform : atLeast(level, x.level))).map((x) => ({ key: x.key, label: x.label }));
  return <Shell guild={{ id: guildId, name: g?.name ?? "Server", icon: g?.icon ?? null }} user={s.user} level={level} nav={nav}>{children}</Shell>;
}
