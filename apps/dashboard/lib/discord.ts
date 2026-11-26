import "server-only";
import { env } from "./env";

const API = "https://discord.com/api/v10";

export interface DiscordUser { id: string; username: string; global_name: string | null; avatar: string | null }
export interface DiscordGuild { id: string; name: string; icon: string | null; owner: boolean; permissions: string }

export function oauthUrl(state: string): string {
  const e = env();
  const p = new URLSearchParams({ client_id: e.DISCORD_CLIENT_ID, redirect_uri: `${e.DASHBOARD_URL.replace(/\/$/, "")}/api/auth/callback`, response_type: "code", scope: "identify guilds", state, prompt: "none" });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export function inviteUrl(guildId?: string): string {
  const p = new URLSearchParams({ client_id: env().DISCORD_CLIENT_ID, permissions: "8", scope: "bot applications.commands" });
  if (guildId) { p.set("guild_id", guildId); p.set("disable_guild_select", "true"); }
  return `https://discord.com/oauth2/authorize?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const e = env();
  const res = await fetch(`${API}/oauth2/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.DISCORD_CLIENT_ID, client_secret: e.DISCORD_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed (${res.status})`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>;
}

export const exchangeCode = (code: string) => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: `${env().DASHBOARD_URL.replace(/\/$/, "")}/api/auth/callback` });
export const refreshToken = (token: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: token });

async function api<T>(path: string, token: string): Promise<T> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000)); continue; }
    if (!res.ok) throw new Error(`Discord API ${path} failed (${res.status})`);
    return res.json() as Promise<T>;
  }
  throw new Error("Discord API rate limited");
}

export const fetchUser = (token: string) => api<DiscordUser>("/users/@me", token);
export const fetchGuilds = (token: string) => api<DiscordGuild[]>("/users/@me/guilds", token);

export function avatarUrl(u: { id: string; avatar: string | null }, size = 64) {
  return u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=${size}` : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(u.id) >> 22n) % 6}.png`;
}
export function guildIconUrl(g: { id: string; icon: string | null }, size = 64) {
  return g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=${size}` : null;
}
