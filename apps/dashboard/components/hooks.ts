"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class FetchError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function api<T = unknown>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers: init.body !== undefined ? { "content-type": "application/json" } : undefined, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new FetchError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Minimal SWR-style data hook with manual refresh and optional polling. */
export function useApi<T>(url: string | null, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!url);
  const seq = useRef(0);
  const load = useCallback(async (silent = false) => {
    if (!url) return;
    const n = ++seq.current;
    if (!silent) setLoading(true);
    try { const d = await api<T>(url); if (n === seq.current) { setData(d); setError(null); } }
    catch (e) { if (n === seq.current) setError((e as Error).message); }
    finally { if (n === seq.current) setLoading(false); }
  }, [url]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(() => void load(true), opts.refreshMs);
    return () => clearInterval(t);
  }, [load, opts.refreshMs]);
  return { data, error, loading, reload: () => load(true), setData };
}

type LiveHandler = (e: { type: string; guildId: string; data?: Record<string, unknown>; at: string }) => void;
const sources = new Map<string, { es: EventSource; handlers: Set<LiveHandler> }>();

/** Subscribes to the guild's live event stream (shared EventSource per guild). */
export function useLive(guildId: string, types: string[] | "*", handler: LiveHandler) {
  const ref = useRef(handler); ref.current = handler;
  const key = Array.isArray(types) ? types.join(",") : types;
  useEffect(() => {
    let entry = sources.get(guildId);
    if (!entry) {
      const es = new EventSource(`/api/guilds/${guildId}/events`);
      entry = { es, handlers: new Set() };
      sources.set(guildId, entry);
      const dispatch = (ev: MessageEvent) => { try { const e = JSON.parse(ev.data); sources.get(guildId)?.handlers.forEach((h) => h(e)); } catch { /* ignore */ } };
      ["config.updated", "commands.updated", "automations.updated", "ticket.updated", "case.created", "security.event", "architect.updated", "analytics.tick", "member.joined", "member.left", "guild.updated", "rolemenu.updated", "ticketpanel.updated"].forEach((t) => es.addEventListener(t, dispatch));
    }
    const wanted = key === "*" ? null : new Set(key.split(","));
    const h: LiveHandler = (e) => { if (!wanted || wanted.has(e.type)) ref.current(e); };
    entry.handlers.add(h);
    return () => {
      const en = sources.get(guildId); if (!en) return;
      en.handlers.delete(h);
      if (!en.handlers.size) { en.es.close(); sources.delete(guildId); }
    };
  }, [guildId, key]);
}

export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export const fmtNum = (n: number | string | null | undefined) => Number(n ?? 0).toLocaleString();
export const fmtDate = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—");
export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtDuration(sec: number): string {
  if (!sec) return "—";
  if (sec < 60) return `${Math.round(sec)}s`; if (sec < 3600) return `${Math.round(sec / 60)}m`; if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}
