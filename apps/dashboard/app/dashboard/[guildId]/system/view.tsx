"use client";
import { useState } from "react";
import { api, fmtNum, timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, PageHead, Select, Skeleton, Stat, useToast } from "@/components/ui";
import { I } from "@/components/icons";

type Sys = {
  dashboard: { status: string; uptimeSeconds: number; memoryMb: number; node: string; version: string };
  bot: { status: string; ready?: boolean; ping?: number; guilds?: number; uptimeSeconds?: number; memoryMb?: number; error?: string };
  heartbeats: { service: string; status: string; details: Record<string, unknown>; startedAt: string; beatAt: string }[];
  database: { latencyMs: number; version: string; size: string; connections: string; tables: { table: string; rows: string; bytes: string }[] };
  guilds: { total: number; active: number };
  providers: { id: string; name: string; kind: string; model: string; baseUrl: string | null; hasKey: boolean }[];
};
const up = (s: number) => (s > 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);

export function SystemView() {
  const toast = useToast();
  const q = useApi<Sys>("/api/system", { refreshMs: 15_000 });
  const [p, setP] = useState({ kind: "anthropic", model: "claude-sonnet-5-5", baseUrl: "", apiKey: "", name: "Instance default" });
  const d = q.data;
  if (q.error) return <><PageHead title="System" /><Card><Empty title="Not available">{q.error}</Empty></Card></>;
  const botOk = d?.bot.status === "ok";
  return (
    <>
      <PageHead title="System" description="Hosting, services, database health and instance-wide settings for this MOTH installation." actions={<Button onClick={() => q.reload()} icon={<I.refresh />}>Refresh</Button>} />
      {!d ? <Skeleton h={400} /> : <div className="stack" style={{ gap: 16 }}>
        <div className="grid g4">
          <Stat label="Bot" value={<span className="row"><span className={`dot ${botOk ? "ok" : "bad pulse"}`} />{botOk ? "Online" : "Offline"}</span>} delta={botOk ? `${d.bot.ping}ms gateway · up ${up(d.bot.uptimeSeconds ?? 0)}` : d.bot.error} />
          <Stat label="Dashboard" value={<span className="row"><span className="dot ok" />Online</span>} delta={`v${d.dashboard.version} · up ${up(d.dashboard.uptimeSeconds)}`} />
          <Stat label="Database" value={`${d.database.latencyMs}ms`} delta={`${(Number(d.database.size) / 1048576).toFixed(1)} MB · ${d.database.connections} connections`} />
          <Stat label="Servers" value={fmtNum(d.guilds.active)} delta={`${fmtNum(d.guilds.total)} total`} />
        </div>
        <div className="grid g2">
          <Card title="Services" subtitle="Heartbeats every 15s — services restart automatically on failure">
            {d.heartbeats.map((h) => { const stale = Date.now() - new Date(h.beatAt).getTime() > 60_000; return <div key={h.service} className="list-item"><span className={`dot ${stale ? "bad" : "ok"}`} /><div className="grow"><b>{h.service}</b><div className="small faint">started {timeAgo(h.startedAt)} · {Object.entries(h.details ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div></div><Chip tone={stale ? "crim" : "ok"}>{stale ? "stale" : "healthy"}</Chip></div>; })}
            <div className="list-item"><span className="dot ok" /><div className="grow"><b>dashboard</b><div className="small faint">{d.dashboard.node} · {d.dashboard.memoryMb} MB</div></div><Chip tone="ok">healthy</Chip></div>
          </Card>
          <Card title="Database" subtitle={d.database.version.split(",")[0]}>
            <div className="table-wrap"><table className="t"><thead><tr><th>Table</th><th className="right">Rows</th><th className="right">Size</th></tr></thead><tbody>{d.database.tables.map((t) => <tr key={t.table}><td className="mono small">{t.table}</td><td className="right small">{fmtNum(t.rows)}</td><td className="right small">{(Number(t.bytes) / 1024).toFixed(0)} KB</td></tr>)}</tbody></table></div>
          </Card>
        </div>
        <Card title="Instance AI provider" subtitle="Used by every server that hasn't configured its own provider.">
          {d.providers.map((x) => <div key={x.id} className="list-item"><Chip tone="crim">default</Chip><div className="grow"><b>{x.name}</b> <span className="small faint">{x.kind} · {x.model}{x.hasKey ? " · key set" : ""}</span></div><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { await api("/api/system", { body: { action: "provider.delete", id: x.id } }); void q.reload(); }} /></div>)}
          <div className="grid mt" style={{ gridTemplateColumns: "160px 1fr 1fr 1fr auto", alignItems: "end" }}>
            <Field label="Type"><Select value={p.kind} onChange={(v) => setP({ ...p, kind: v })} options={[{ value: "anthropic", label: "Anthropic" }, { value: "openai", label: "OpenAI" }, { value: "openai-compatible", label: "OpenAI-compatible" }, { value: "ollama", label: "Ollama" }]} /></Field>
            <Field label="Model"><Input value={p.model} onChange={(e) => setP({ ...p, model: e.target.value })} /></Field>
            <Field label="Base URL (optional)"><Input value={p.baseUrl} onChange={(e) => setP({ ...p, baseUrl: e.target.value })} /></Field>
            <Field label="API key"><Input type="password" value={p.apiKey} onChange={(e) => setP({ ...p, apiKey: e.target.value })} /></Field>
            <Button variant="primary" onClick={async () => { try { await api("/api/system", { body: { action: "provider.upsert", ...p, baseUrl: p.baseUrl || null, apiKey: p.apiKey || undefined } }); toast("Instance provider saved"); setP({ ...p, apiKey: "" }); void q.reload(); } catch (e) { toast((e as Error).message, true); } }}>Save</Button>
          </div>
        </Card>
        <Card title="Maintenance" subtitle="Run these on the host">
          <div className="grid g2 small">{[["Status", "moth status"], ["Logs", "moth logs -f"], ["Update to latest release", "moth update"], ["Database backup", "moth backup"], ["Restore database", "moth restore <file>"], ["Restart services", "moth restart"]].map(([k, v]) => <div key={k} className="row between card flat" style={{ padding: 12 }}><span>{k}</span><code>{v}</code></div>)}</div>
        </Card>
      </div>}
    </>
  );
}
