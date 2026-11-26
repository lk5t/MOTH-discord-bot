"use client";
import { useState } from "react";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtNum, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, SaveBar, Select, Seg, Skeleton, Textarea, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, RoleMulti } from "@/components/pickers";
import { Columns } from "@/components/charts";
import { I } from "@/components/icons";

type Provider = { id: string; guildId: string | null; name: string; kind: "openai" | "anthropic" | "ollama" | "openai-compatible"; baseUrl: string | null; model: string; temperature: number; isDefault: boolean; hasKey: boolean };
const KINDS = [
  { value: "openai", label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { value: "anthropic", label: "Anthropic", base: "https://api.anthropic.com/v1", model: "claude-sonnet-5-5" },
  { value: "openai-compatible", label: "OpenAI-compatible (OpenRouter, Groq, vLLM, LM Studio…)", base: "https://openrouter.ai/api/v1", model: "" },
  { value: "ollama", label: "Local — Ollama", base: "http://host.docker.internal:11434/v1", model: "llama3.1" },
] as const;

export function AiView() {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const cfg = useGuildConfig();
  const q = useApi<{ rows: Provider[]; envProvider: { kind: string; model: string } | null }>(`/api/guilds/${guildId}/ai/providers`);
  const usage = useApi<{ day: string; n: number; tokens: number }[]>(`/api/guilds/${guildId}/ai/usage`);
  const [edit, setEdit] = useState<(Partial<Provider> & { apiKey?: string }) | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  async function save() {
    if (!edit) return;
    try { const { id, hasKey, guildId: g, ...body } = edit; void hasKey; void g; await api(id ? `/api/guilds/${guildId}/ai/providers/${id}` : `/api/guilds/${guildId}/ai/providers`, { method: id ? "PATCH" : "POST", body: { ...body, baseUrl: body.baseUrl || null, apiKey: body.apiKey || undefined } }); toast("Provider saved (API key encrypted at rest)"); setEdit(null); void q.reload(); }
    catch (e) { toast((e as Error).message, true); }
  }
  async function test(p: Provider) {
    setTesting(p.id);
    try { const r = await api<{ ok: boolean; latencyMs: number; model: string; error?: string }>(`/api/guilds/${guildId}/ai/providers/${p.id}/test`, { body: {} }); toast(r.ok ? `✓ ${r.model} responded in ${r.latencyMs}ms` : `✗ ${r.error}`, !r.ok); }
    catch (e) { toast((e as Error).message, true); } finally { setTesting(null); }
  }
  const c = cfg.config;
  return (
    <>
      <PageHead title="AI Settings" description="Provider-independent AI: bring your own key, any OpenAI-compatible endpoint, or a local model." />
      <div className="grid g3">
        <Card className="span2" title="Providers" subtitle="Keys are encrypted with AES-256-GCM and never sent back to the browser." actions={<Button variant="primary" icon={<I.plus />} onClick={() => setEdit({ kind: "openai", name: "OpenAI", baseUrl: KINDS[0].base, model: KINDS[0].model, temperature: 0.4, isDefault: !q.data?.rows.some((r) => r.guildId) })}>Add provider</Button>}>
          {!q.data ? <Skeleton h={120} /> : !q.data.rows.length && !q.data.envProvider ? <Empty icon={<I.ai />} title="No AI provider configured">Architect still works using MOTH&apos;s built-in designer, but AI chat, generation and free-form requests need a provider.</Empty> : (
            <div className="stack" style={{ gap: 0 }}>
              {q.data.envProvider && <div className="list-item"><Chip>instance</Chip><div className="grow"><b>Environment provider</b><div className="small faint">{q.data.envProvider.kind} · {q.data.envProvider.model}</div></div></div>}
              {q.data.rows.map((p) => <div key={p.id} className="list-item"><Chip tone={p.isDefault ? "crim" : undefined}>{p.guildId ? (p.isDefault ? "default" : "server") : "instance"}</Chip><div className="grow"><b>{p.name}</b><div className="small faint">{KINDS.find((k) => k.value === p.kind)?.label} · {p.model}{p.hasKey ? " · key set" : ""}</div></div>
                <Button size="sm" loading={testing === p.id} onClick={() => test(p)} icon={<I.play />}>Test</Button>
                {p.guildId && <><Button size="sm" variant="ghost" icon={<I.edit />} onClick={() => setEdit({ ...p, apiKey: "" })} /><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: `Remove ${p.name}?`, body: "Features using it will fall back to the instance provider (if any).", danger: true })) { await api(`/api/guilds/${guildId}/ai/providers/${p.id}`, { method: "DELETE" }); void q.reload(); } }} /></>}
              </div>)}
            </div>
          )}
          {c && q.data && q.data.rows.length > 0 && <Field label="Provider used by this server" className="mt"><Select value={c.ai.providerId ?? ""} onChange={(v) => cfg.update("ai", { providerId: v || null })} placeholder="Server default → instance default" options={q.data.rows.map((p) => ({ value: p.id, label: `${p.name} (${p.model})` }))} /></Field>}
        </Card>
        <Card title="Usage · 30 days"><Columns labels={(usage.data ?? []).map((u) => u.day)} values={(usage.data ?? []).map((u) => Number(u.n))} height={110} /><div className="small faint mt">{fmtNum((usage.data ?? []).reduce((a, u) => a + Number(u.n), 0))} requests · {fmtNum((usage.data ?? []).reduce((a, u) => a + Number(u.tokens), 0))} tokens</div></Card>
      </div>
      {!c ? <Skeleton h={300} /> : <div className="grid g2 mt">
        <Card title="Assistant">
          <ToggleRow title="AI assistant enabled" description="/ask, /summarize, mentions and AI chat channels." checked={c.ai.enabled} onChange={(v) => cfg.update("ai", { enabled: v })} />
          <ToggleRow title="Respond when mentioned" checked={c.ai.respondToMentions} onChange={(v) => cfg.update("ai", { respondToMentions: v })} />
          <div className="stack mt"><Field label="AI chat channels" hint="MOTH replies to every message here"><ChannelMulti value={c.ai.chatChannelIds} onChange={(v) => cfg.update("ai", { chatChannelIds: v })} /></Field>
            <Field label="Restrict to roles" hint="Empty = everyone"><RoleMulti value={c.ai.allowedRoleIds} onChange={(v) => cfg.update("ai", { allowedRoleIds: v })} /></Field>
            <div className="grid g2"><Field label="Daily requests per user" hint="0 = unlimited; admins exempt"><NumberInput value={c.ai.dailyRequestLimitPerUser} min={0} max={10000} onChange={(v) => cfg.update("ai", { dailyRequestLimitPerUser: v })} /></Field><Field label="Max reply tokens"><NumberInput value={c.ai.maxTokens} min={64} max={8192} onChange={(v) => cfg.update("ai", { maxTokens: v })} /></Field></div></div>
        </Card>
        <Card title="Personality">
          <div className="stack"><Field label="Name"><Input value={c.ai.personality.name} onChange={(e) => cfg.update("ai", { personality: { ...c.ai.personality, name: e.target.value } })} /></Field>
            <Field label="Tone"><Seg value={c.ai.personality.tone} onChange={(v) => cfg.update("ai", { personality: { ...c.ai.personality, tone: v } })} options={["professional", "friendly", "playful", "concise", "custom"].map((t) => ({ value: t as "friendly", label: t }))} crimson /></Field>
            <Field label="Custom instructions" hint="Added to the system prompt. Safety rules always apply: the AI can never take administrative actions itself."><Textarea value={c.ai.personality.customPrompt} maxLength={4000} rows={6} onChange={(e) => cfg.update("ai", { personality: { ...c.ai.personality, customPrompt: e.target.value } })} placeholder="e.g. You're the friendly mascot of a Minecraft server. The server IP is play.example.com." /></Field></div>
        </Card>
        <Card title="AI-powered features" className="span2">
          <ToggleRow title="Moderation assist" description="Flag harmful messages to moderators with explanations (configure in Moderation → Auto-moderation)." checked={c.automod.aiAssist.enabled} onChange={(v) => cfg.update("automod", { aiAssist: { ...c.automod.aiAssist, enabled: v } })} />
          <ToggleRow title="Ticket first responses" description="Draft a first reply to new tickets from the ticket form answers." checked={c.tickets.aiFirstResponse} onChange={(v) => cfg.update("tickets", { aiFirstResponse: v })} />
        </Card>
      </div>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit provider" : "Add AI provider"} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save} disabled={!edit?.name || !edit?.model}>Save</Button></>}>
        {edit && <div className="stack">
          <Field label="Type"><Select value={edit.kind ?? "openai"} onChange={(v) => { const k = KINDS.find((x) => x.value === v)!; setEdit({ ...edit, kind: k.value, baseUrl: k.base, model: k.model || edit.model, name: edit.name && !KINDS.some((x) => x.label.startsWith(edit.name!)) ? edit.name : k.label.split(" ")[0] }); }} options={KINDS.map((k) => ({ value: k.value, label: k.label }))} /></Field>
          <div className="grid g2"><Field label="Display name"><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Model"><Input value={edit.model ?? ""} onChange={(e) => setEdit({ ...edit, model: e.target.value })} /></Field></div>
          <Field label="Base URL" hint="Any OpenAI-compatible /v1 endpoint works. For a local Ollama on the host use http://host.docker.internal:11434/v1"><Input value={edit.baseUrl ?? ""} onChange={(e) => setEdit({ ...edit, baseUrl: e.target.value })} /></Field>
          <Field label="API key" hint={edit.id && edit.hasKey ? "Leave blank to keep the existing key" : edit.kind === "ollama" ? "Not needed for local models" : undefined}><Input type="password" autoComplete="off" value={edit.apiKey ?? ""} onChange={(e) => setEdit({ ...edit, apiKey: e.target.value })} /></Field>
          <div className="grid g2"><Field label={`Temperature · ${edit.temperature ?? 0.4}`}><input type="range" min={0} max={1.5} step={0.1} value={edit.temperature ?? 0.4} onChange={(e) => setEdit({ ...edit, temperature: Number(e.target.value) })} style={{ accentColor: "var(--crimson)" }} /></Field><ToggleRow title="Default for this server" checked={!!edit.isDefault} onChange={(v) => setEdit({ ...edit, isDefault: v })} /></div>
        </div>}
      </Modal>
      {c && <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />}
    </>
  );
}
