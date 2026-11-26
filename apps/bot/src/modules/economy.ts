import { and, eq, sql } from "drizzle-orm";
import { economyAccounts, getDb } from "@moth/core";

export async function getAccount(guildId: string, userId: string) {
  const [row] = await getDb().select().from(economyAccounts).where(and(eq(economyAccounts.guildId, guildId), eq(economyAccounts.userId, userId)));
  return row ?? { guildId, userId, balance: 0, lifetimeEarned: 0, lastDailyAt: null, streak: 0, updatedAt: new Date() };
}

export async function addCurrency(guildId: string, userId: string, amount: number): Promise<number> {
  const [row] = await getDb().insert(economyAccounts).values({ guildId, userId, balance: Math.max(0, amount), lifetimeEarned: Math.max(0, amount) })
    .onConflictDoUpdate({ target: [economyAccounts.guildId, economyAccounts.userId], set: {
      balance: sql`greatest(0, ${economyAccounts.balance} + ${amount})`,
      lifetimeEarned: amount > 0 ? sql`${economyAccounts.lifetimeEarned} + ${amount}` : economyAccounts.lifetimeEarned, updatedAt: new Date(),
    } }).returning();
  return row.balance;
}

/** Atomic transfer; fails if the sender has insufficient funds. */
export async function transfer(guildId: string, from: string, to: string, amount: number): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const res = await tx.update(economyAccounts).set({ balance: sql`${economyAccounts.balance} - ${amount}` })
      .where(and(eq(economyAccounts.guildId, guildId), eq(economyAccounts.userId, from), sql`${economyAccounts.balance} >= ${amount}`)).returning();
    if (!res.length) return false;
    await tx.insert(economyAccounts).values({ guildId, userId: to, balance: amount, lifetimeEarned: amount })
      .onConflictDoUpdate({ target: [economyAccounts.guildId, economyAccounts.userId], set: { balance: sql`${economyAccounts.balance} + ${amount}`, lifetimeEarned: sql`${economyAccounts.lifetimeEarned} + ${amount}` } });
    return true;
  });
}

/** Claims the daily reward. Streak continues if claimed within 48h of the last claim. */
export async function claimDaily(guildId: string, userId: string, base: number, bonus: number, maxDays: number): Promise<{ ok: false; nextAt: Date } | { ok: true; amount: number; streak: number; balance: number }> {
  const acc = await getAccount(guildId, userId);
  const last = acc.lastDailyAt?.getTime() ?? 0;
  const now = Date.now();
  if (now - last < 20 * 3_600_000) return { ok: false, nextAt: new Date(last + 20 * 3_600_000) };
  const streak = now - last <= 48 * 3_600_000 ? acc.streak + 1 : 1;
  const amount = base + Math.min(streak - 1, maxDays) * bonus;
  const [row] = await getDb().insert(economyAccounts).values({ guildId, userId, balance: amount, lifetimeEarned: amount, lastDailyAt: new Date(), streak })
    .onConflictDoUpdate({ target: [economyAccounts.guildId, economyAccounts.userId], set: { balance: sql`${economyAccounts.balance} + ${amount}`, lifetimeEarned: sql`${economyAccounts.lifetimeEarned} + ${amount}`, lastDailyAt: new Date(), streak } }).returning();
  return { ok: true, amount, streak, balance: row.balance };
}
