/** Discord OAuth2 token helpers shared by the dashboard and the bot. */
export interface DiscordTokenSet { access_token: string; refresh_token: string; expires_in: number; scope: string }

export class OAuthRevokedError extends Error {}

export async function discordTokenRequest(clientId: string, clientSecret: string, body: Record<string, string>): Promise<DiscordTokenSet> {
  const res = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 400 || res.status === 401) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    if (err.error === "invalid_grant") throw new OAuthRevokedError("Access was revoked by the member");
  }
  if (!res.ok) throw new Error(`Discord token request failed (${res.status})`);
  return res.json() as Promise<DiscordTokenSet>;
}

export const refreshDiscordToken = (clientId: string, clientSecret: string, refreshToken: string) =>
  discordTokenRequest(clientId, clientSecret, { grant_type: "refresh_token", refresh_token: refreshToken });
