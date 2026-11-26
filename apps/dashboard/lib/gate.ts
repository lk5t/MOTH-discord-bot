import "server-only";
import { redirect } from "next/navigation";
import { getSession } from "./session";
import { atLeast, guildAccess, isPlatformOwner, SECTIONS } from "./access";

/** Server-side guard for section pages (navigation hiding is not a security boundary). */
export async function gate(guildId: string, section: (typeof SECTIONS)[number]["key"]) {
  const s = await getSession();
  if (!s) redirect(`/api/auth/login?next=/dashboard/${guildId}`);
  const level = await guildAccess(s, guildId);
  const def = SECTIONS.find((x) => x.key === section)!;
  const ok = section === "system" ? isPlatformOwner(s.userId) : atLeast(level, def.level);
  if (!ok) redirect(`/dashboard/${guildId}`);
  return { session: s, level };
}
