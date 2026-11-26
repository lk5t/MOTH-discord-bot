"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { GuildConfig } from "@moth/core/shared";
import { api, useApi, useLive } from "./hooks";
import { useToast } from "./ui";

export type Level = "none" | "viewer" | "moderator" | "admin" | "owner";
const RANK: Record<Level, number> = { none: 0, viewer: 1, moderator: 2, admin: 3, owner: 4 };

export interface Channel { id: string; name: string; type: string; parentId: string | null; position: number; text: boolean }
export interface Role { id: string; name: string; color: string; position: number; managed: boolean; everyone: boolean; members: number; editable: boolean }

interface Ctx { guildId: string; level: Level; can: (l: Level) => boolean; channels: Channel[]; roles: Role[]; refreshDiscord: () => void; botOnline: boolean }
const GuildCtx = createContext<Ctx | null>(null);
export const useGuild = () => { const c = useContext(GuildCtx); if (!c) throw new Error("useGuild outside provider"); return c; };

export function GuildProvider({ guildId, level, children }: { guildId: string; level: Level; children: ReactNode }) {
  const ch = useApi<Channel[]>(`/api/guilds/${guildId}/discord/channels`);
  const ro = useApi<Role[]>(`/api/guilds/${guildId}/discord/roles`);
  const refreshDiscord = useCallback(() => { void ch.reload(); void ro.reload(); }, [ch, ro]);
  useLive(guildId, ["guild.updated"], refreshDiscord);
  const value = useMemo<Ctx>(() => ({
    guildId, level, can: (l) => RANK[level] >= RANK[l], channels: ch.data ?? [], roles: ro.data ?? [], refreshDiscord, botOnline: !ch.error,
  }), [guildId, level, ch.data, ro.data, ch.error, refreshDiscord]);
  return <GuildCtx.Provider value={value}>{children}</GuildCtx.Provider>;
}

/**
 * Edits the guild config with a local draft, optimistic concurrency and live
 * refresh when the config is changed from Discord or another dashboard tab.
 */
export function useGuildConfig() {
  const { guildId } = useGuild();
  const toast = useToast();
  const q = useApi<{ config: GuildConfig; version: number }>(`/api/guilds/${guildId}/config`);
  const [draft, setDraft] = useState<GuildConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const base = q.data?.config ?? null;
  const current = draft ?? base;
  const dirtySections = useMemo(() => {
    if (!draft || !base) return [] as (keyof GuildConfig)[];
    return (Object.keys(draft) as (keyof GuildConfig)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(base[k]));
  }, [draft, base]);
  useLive(guildId, ["config.updated"], (e) => {
    if (!draft) void q.reload();
    else if ((e.data?.version as number) !== q.data?.version) toast("Settings were changed elsewhere (Discord or another session). Save will ask you to reload.", true);
  });
  function update<K extends keyof GuildConfig>(section: K, patch: Partial<GuildConfig[K]>) {
    if (!current) return;
    setDraft({ ...current, [section]: { ...current[section], ...patch } });
  }
  async function save() {
    if (!draft || !dirtySections.length) return;
    setSaving(true);
    try {
      const out = await api<{ config: GuildConfig; version: number }>(`/api/guilds/${guildId}/config`, { method: "PATCH", body: { patch: Object.fromEntries(dirtySections.map((s) => [s, draft[s]])), version: q.data?.version } });
      q.setData(out); setDraft(null); toast("Settings saved and synced to Discord");
    } catch (e) { toast((e as Error).message, true); if ((e as { status?: number }).status === 409) { setDraft(null); void q.reload(); } }
    finally { setSaving(false); }
  }
  return { config: current, loading: q.loading, error: q.error, update, save, reset: () => setDraft(null), dirty: dirtySections.length > 0, saving, version: q.data?.version };
}
