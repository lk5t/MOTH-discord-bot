"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchitectPlan, Blueprint, PlanOp, ServerAnalysis } from "@moth/core/shared";
import { useGuild } from "@/components/guild";
import { api, timeAgo, useApi, useLive } from "@/components/hooks";
import { Button, Card, Chip, Empty, Modal, PageHead, Progress, Seg, Switch, Textarea, useConfirm, useToast, Field, Input } from "@/components/ui";
import { I } from "@/components/icons";

type Mode = "create" | "quick" | "improve" | "redesign";
type Session = { id: string; mode: Mode; title: string | null; status: string; messages: { role: "user" | "assistant"; content: string; at: string }[]; blueprint: Blueprint | null; plan: ArchitectPlan | null; analysis: ServerAnalysis | null; result: { completed: string[]; errors: { description: string; error: string }[]; skipped: string[] } | null; backupId: string | null; updatedAt: string };
type SessionRow = Pick<Session, "id" | "mode" | "title" | "status" | "updatedAt">;
type Template = { id: string; name: string; description: string; tags: string[] };

const MODES: { value: Mode; label: string; blurb: string; examples: string[] }[] = [
  { value: "create", label: "New server", blurb: "Describe your community and MOTH designs the entire server: structure, roles, permissions, onboarding, moderation, tickets and automations.", examples: ["I want a professional gaming community for Minecraft with staff applications, support tickets, announcements, game-specific channels and a friendly community.", "A cosy study server for university students with homework help, study rooms and leveling.", "A streamer community with live alerts, a VIP lounge, giveaways and fan art."] },
  { value: "quick", label: "Quick edit", blurb: "Make targeted changes in plain language. Nothing is deleted unless you ask.", examples: ["Create a new gaming section", "Set up a professional ticket system", "Improve server security", "Redesign the welcome experience", "Clean up unnecessary channels"] },
  { value: "improve", label: "Smart improve", blurb: "MOTH audits your server — permissions, structure, onboarding, security — and proposes fixes.", examples: ["Analyse my server and recommend improvements.", "Focus on security and permissions.", "Improve the staff hierarchy."] },
  { value: "redesign", label: "Full redesign", blurb: "A comprehensive structural and visual redesign. Existing channels are mapped to new ones so history is preserved.", examples: ["Completely reorganise my server with a clean, professional structure.", "Redesign everything with a dark, premium esports aesthetic."] },
];

const opIcon: Record<string, string> = { create: "＋", update: "✎", delete: "−" };
function opKind(o: PlanOp) { return o.kind.endsWith(".delete") ? "delete" : o.kind.endsWith(".create") ? "create" : "update"; }

export function ArchitectView() {
  const { guildId, refreshDiscord } = useGuild();
  const toast = useToast();
  const confirm = useConfirm();
  const [mode, setMode] = useState<Mode>("create");
  const [session, setSession] = useState<Session | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [opts, setOpts] = useState({ prune: false, resetPermissions: false, reorder: true });
  const [progress, setProgress] = useState<{ done: number; total: number; description: string } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const sessions = useApi<SessionRow[]>(`/api/guilds/${guildId}/architect/sessions`);
  const templates = useApi<{ builtin: Template[]; saved: (Template & { createdAt: string })[] }>(`/api/guilds/${guildId}/architect/templates`);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" }); }, [session?.messages.length, busy]);
  useEffect(() => { setExcluded(new Set()); setApproved(new Set()); }, [session?.plan?.generatedAt]);

  useLive(guildId, ["architect.updated"], async (e) => {
    if (!session || e.data?.sessionId !== session.id) return;
    if (e.data.progress) setProgress(e.data.progress as never);
    if (e.data.status || e.data.error) {
      setProgress(null);
      const s = await api<Session>(`/api/guilds/${guildId}/architect/sessions/${session.id}`);
      setSession(s); void sessions.reload(); refreshDiscord();
      if (e.data.error) toast(`Apply failed: ${e.data.error}`, true);
      else if (s.status === "applied") toast(`Applied ${s.result?.completed.length ?? 0} changes${s.result?.errors.length ? ` (${s.result.errors.length} failed)` : ""}`, !!s.result?.errors.length);
      else if (s.status === "rolled_back") toast("Rollback complete");
    }
  });

  async function send(text = input) {
    if (!text.trim() || busy) return;
    setBusy(true); setInput("");
    try {
      const s = session && session.status === "drafting"
        ? await api<Session>(`/api/guilds/${guildId}/architect/sessions/${session.id}/messages`, { body: { message: text } })
        : await api<Session>(`/api/guilds/${guildId}/architect/sessions`, { body: { mode, prompt: text } });
      setSession(s); void sessions.reload();
    } catch (e) { toast((e as Error).message, true); setInput(text); }
    finally { setBusy(false); }
  }

  async function startTemplate(id: string) {
    setBusy(true);
    try { const s = await api<Session>(`/api/guilds/${guildId}/architect/sessions/from-template`, { body: { templateId: id } }); setMode("create"); setSession(s); void sessions.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }

  async function open(id: string) {
    try { const s = await api<Session>(`/api/guilds/${guildId}/architect/sessions/${id}`); setSession(s); setMode(s.mode); } catch (e) { toast((e as Error).message, true); }
  }

  async function replan(next = opts) {
    if (!session) return;
    setOpts(next);
    try { setSession(await api<Session>(`/api/guilds/${guildId}/architect/sessions/${session.id}/plan`, { body: { options: next } })); } catch (e) { toast((e as Error).message, true); }
  }

  const plan = session?.plan ?? null;
  const ops = plan?.ops ?? [];
  const destructiveApproved = ops.filter((o) => o.destructive && approved.has(o.id) && !excluded.has(o.id));
  const willRun = ops.filter((o) => !excluded.has(o.id) && (!o.destructive || approved.has(o.id))).length;

  async function apply() {
    if (!session || !plan) return;
    const ok = await confirm({
      title: "Apply Architect changes?", confirm: `Apply ${willRun} changes`, danger: destructiveApproved.length > 0,
      typeToConfirm: destructiveApproved.length ? "APPLY" : undefined,
      body: <div className="stack"><div>MOTH will take a full backup, then apply <b>{willRun}</b> changes to your Discord server. You can roll back afterwards.</div>
        {destructiveApproved.length > 0 && <div><b style={{ color: "#ff6b85" }}>{destructiveApproved.length} destructive change(s) approved:</b><ul className="small">{destructiveApproved.slice(0, 12).map((o) => <li key={o.id}>{o.description}</li>)}</ul></div>}</div>,
    });
    if (!ok) return;
    try {
      await api(`/api/guilds/${guildId}/architect/sessions/${session.id}/apply`, { body: { excludeOpIds: [...excluded], approveDestructive: destructiveApproved.map((o) => o.id), ...opts, confirm: true } });
      setProgress({ done: 0, total: willRun, description: "Taking backup…" });
      setSession({ ...session, status: "applying" });
    } catch (e) { toast((e as Error).message, true); }
  }

  async function rollback() {
    if (!session) return;
    if (!(await confirm({ title: "Roll back these changes?", danger: true, confirm: "Roll back", body: "Created roles and channels will be deleted, modified ones restored and deleted ones recreated from the pre-change backup. Messages in deleted channels can't be recovered." }))) return;
    setBusy(true);
    try { await api(`/api/guilds/${guildId}/architect/sessions/${session.id}/rollback`, { body: {} }); setSession(await api<Session>(`/api/guilds/${guildId}/architect/sessions/${session.id}`)); refreshDiscord(); toast("Rolled back"); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }

  const modeDef = MODES.find((m) => m.value === mode)!;
  const opMap = useMemo(() => new Map(ops.map((o) => [("ref" in o ? o.ref : "") as string, o])), [ops]);

  return (
    <>
      <PageHead title="Architect" description="Design, improve and redesign your server with AI. Every change is previewed, approved and reversible."
        actions={<>{session && <Button onClick={() => { setSession(null); setInput(""); }} icon={<I.plus />}>New session</Button>}{session?.blueprint && <Button onClick={() => setSaveOpen(true)} icon={<I.download />}>Save as template</Button>}</>} />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.05fr) minmax(0, 1fr)", alignItems: "start" }}>
        <div className="stack" style={{ gap: 16 }}>
          <Card accent>
            <div className="row between wrap" style={{ marginBottom: 12 }}>
              <Seg value={mode} onChange={(m) => { setMode(m); if (session?.mode !== m) setSession(null); }} options={MODES.map((m) => ({ value: m.value, label: m.label }))} crimson />
              {session && <Chip tone={session.status === "applied" ? "ok" : session.status === "failed" ? "crim" : "info"}>{session.status}</Chip>}
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>{modeDef.blurb}{mode === "create" && <> Create the guild in Discord yourself and invite MOTH first — Discord doesn&apos;t allow bots to create servers.</>}</p>
            <div className="chat" ref={chatRef}>
              {!session?.messages.length && !busy && <div className="stack" style={{ gap: 8 }}>{modeDef.examples.map((ex) => <button key={ex} className="op" style={{ border: "1px dashed var(--line-2)", background: "transparent", color: "var(--text-2)", textAlign: "left", cursor: "pointer", font: "inherit" }} onClick={() => send(ex)}><I.sparkles width={16} style={{ color: "var(--crimson)", flex: "none" }} />{ex}</button>)}</div>}
              {session?.messages.map((m, i) => <div key={i} className={`msg ${m.role}`}><Md text={m.content.replace(/^template:(\w+)$/, "Use the $1 template")} /></div>)}
              {busy && <div className="msg assistant"><span className="muted"><I.refresh className="spin" width={14} style={{ verticalAlign: -2 }} /> Designing…</span></div>}
            </div>
            {(!session || session.status === "drafting") && (
              <div className="row mt" style={{ alignItems: "flex-end" }}>
                <Textarea value={input} onChange={(e) => setInput(e.target.value)} placeholder={session ? "Refine the proposal… e.g. “add a music category and make verification captcha”" : "Describe what you want…"} rows={2} style={{ minHeight: 56 }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
                <Button variant="primary" onClick={() => send()} loading={busy} icon={<I.send />} style={{ height: 56 }}>Send</Button>
              </div>
            )}
          </Card>
          {!session && mode === "create" && (
            <Card title="Blueprints" subtitle="Start from a reusable template, then refine it conversationally">
              <div className="grid g2">{templates.data?.builtin.map((t) => <button key={t.id} className="guild-card" style={{ cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }} onClick={() => startTemplate(t.id)} disabled={busy}><div className="grow"><div style={{ fontWeight: 600 }}>{t.name}</div><div className="small faint">{t.description}</div></div></button>)}</div>
              {!!templates.data?.saved.length && <><div className="divider" /><div className="field-label mb">Saved templates</div><div className="stack" style={{ gap: 6 }}>{templates.data.saved.map((t) => <div key={t.id} className="row between"><div><b>{t.name}</b> <span className="small faint">{t.description}</span></div><Button size="sm" onClick={() => startTemplate(t.id)} disabled={busy}>Use</Button></div>)}</div></>}
            </Card>
          )}
          <Card title="History" subtitle="Every Architect session, applied change and rollback">
            {!sessions.data?.length ? <Empty title="No sessions yet" /> : sessions.data.slice(0, 12).map((s) => (
              <div key={s.id} className="list-item" style={{ cursor: "pointer" }} onClick={() => open(s.id)}>
                <Chip tone={s.status === "applied" ? "ok" : s.status === "rolled_back" ? "warn" : s.status === "failed" ? "crim" : undefined}>{s.status.replace("_", " ")}</Chip>
                <div className="grow"><div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title ?? "Untitled"}</div><div className="small faint">{MODES.find((m) => m.value === s.mode)?.label}</div></div>
                <span className="small faint nowrap">{timeAgo(s.updatedAt)}</span>
              </div>
            ))}
          </Card>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          {!session?.blueprint ? <Card><Empty icon={<I.architect />} title="Your preview appears here">Describe a server or pick a blueprint. Nothing changes in Discord until you approve.</Empty></Card> : <>
            {session.analysis && <AnalysisCard a={session.analysis} />}
            <Card title={session.blueprint.name ?? "Proposed structure"} subtitle={session.blueprint.description}>
              {plan && <div className="row wrap mb"><Chip tone="ok">+{plan.summary.creates} create</Chip><Chip tone="warn">{plan.summary.updates} update</Chip><Chip tone="crim">−{plan.summary.deletes} delete</Chip><Chip tone="info">{plan.summary.features} features</Chip></div>}
              <Structure bp={session.blueprint} opMap={opMap} />
            </Card>
            {plan && <Card title="Changes" subtitle="Untick anything you don't want. Destructive changes need explicit approval." actions={<span className="small faint">{willRun}/{ops.length} selected</span>}>
              <div style={{ maxHeight: 360, overflowY: "auto", margin: "0 -10px" }}>
                {ops.map((o) => {
                  const on = !excluded.has(o.id) && (!o.destructive || approved.has(o.id));
                  return <label key={o.id} className={`op ${o.destructive ? "destructive" : ""}`}>
                    <input type="checkbox" checked={on} disabled={session.status !== "drafting"} onChange={(e) => {
                      if (o.destructive) { const a = new Set(approved); e.target.checked ? a.add(o.id) : a.delete(o.id); setApproved(a); const x = new Set(excluded); x.delete(o.id); setExcluded(x); }
                      else { const x = new Set(excluded); e.target.checked ? x.delete(o.id) : x.add(o.id); setExcluded(x); }
                    }} />
                    <span className="mono faint" style={{ width: 14 }}>{opIcon[opKind(o)]}</span>
                    <span className="grow small">{o.description}</span>
                    {o.destructive && <Chip tone="crim">destructive</Chip>}
                  </label>;
                })}
              </div>
              {!!plan.warnings.length && <details className="mt small"><summary className="faint" style={{ cursor: "pointer" }}>{plan.warnings.length} note(s)</summary><ul className="faint">{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></details>}
              <div className="divider" />
              <div className="stack" style={{ gap: 0 }}>
                {(session.mode === "redesign" || session.mode === "create") && <div className="toggle-row"><div><div className="t">Remove unlisted channels & roles</div><div className="d">Prune everything not in the blueprint (marked destructive).</div></div><Switch checked={opts.prune} onChange={(v) => replan({ ...opts, prune: v })} disabled={session.status !== "drafting"} /></div>}
                <div className="toggle-row"><div><div className="t">Replace channel permissions</div><div className="d">Off = merge with existing overwrites (recommended).</div></div><Switch checked={opts.resetPermissions} onChange={(v) => replan({ ...opts, resetPermissions: v })} disabled={session.status !== "drafting"} /></div>
                <div className="toggle-row"><div><div className="t">Reorder channels & roles</div><div className="d">Arrange everything in blueprint order.</div></div><Switch checked={opts.reorder} onChange={(v) => replan({ ...opts, reorder: v })} disabled={session.status !== "drafting"} /></div>
              </div>
              {progress && <div className="mt"><div className="row between small mb"><span>{progress.description}</span><span className="mono">{progress.done}/{progress.total}</span></div><Progress value={(progress.done / Math.max(1, progress.total)) * 100} /></div>}
              {session.result && <div className="mt small">{session.result.errors.length > 0 && <details><summary style={{ color: "#ff6b85", cursor: "pointer" }}>{session.result.errors.length} change(s) failed</summary><ul>{session.result.errors.map((e, i) => <li key={i}>{e.description}: <span className="faint">{e.error}</span></li>)}</ul></details>}</div>}
              <div className="row mt" style={{ justifyContent: "flex-end" }}>
                {session.status === "drafting" && <><Button variant="ghost" onClick={async () => { await api(`/api/guilds/${guildId}/architect/sessions/${session.id}/cancel`, { body: {} }); setSession(null); void sessions.reload(); }}>Discard</Button><Button variant="primary" onClick={apply} disabled={!willRun} icon={<I.check />}>Apply {willRun} changes</Button></>}
                {session.status === "applying" && <Button loading>Applying…</Button>}
                {session.status === "applied" && <Button variant="danger" onClick={rollback} loading={busy} icon={<I.undo />}>Roll back</Button>}
              </div>
            </Card>}
          </>}
        </div>
      </div>
      <SaveTemplate open={saveOpen} onClose={() => setSaveOpen(false)} blueprint={session?.blueprint ?? null} onSaved={() => templates.reload()} />
    </>
  );
}

function AnalysisCard({ a }: { a: ServerAnalysis }) {
  const tone: Record<string, "crim" | "warn" | "info" | undefined> = { critical: "crim", high: "crim", medium: "warn", low: "info" };
  return (
    <Card title="Server health" subtitle={a.summary}>
      <div className="row" style={{ gap: 20, alignItems: "flex-start" }}>
        <div className="score-ring" style={{ ["--p" as string]: a.score }}><span>{a.score}</span></div>
        <div className="grow stack" style={{ gap: 8, maxHeight: 260, overflowY: "auto" }}>
          {a.findings.map((f, i) => <div key={i}><div className="row"><Chip tone={tone[f.severity]}>{f.severity}</Chip><b className="small">{f.title}</b></div><div className="small faint" style={{ marginTop: 2 }}>{f.detail}{f.recommendation && <> — <span className="muted">{f.recommendation}</span></>}</div></div>)}
        </div>
      </div>
    </Card>
  );
}

function Structure({ bp, opMap }: { bp: Blueprint; opMap: Map<string, PlanOp> }) {
  const cls = (ref: string) => { const o = opMap.get(ref); return !o ? "" : o.kind.endsWith(".create") ? "new" : "mod"; };
  const icon = (t: string, name: string) => (/^[\p{L}\p{N}]/u.test(name) || t === "text" ? (t === "voice" || t === "stage" ? "🔊" : t === "forum" ? "💬" : t === "announcement" ? "📣" : "#") : "");
  const keyOf = (x: { key?: string; name: string }) => x.key ?? x.name.normalize("NFKD").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return (
    <div className="grid g2" style={{ alignItems: "start" }}>
      <div className="tree">
        <div className="cat" style={{ marginTop: 0 }}>Channels</div>
        {bp.channels.map((c) => <div key={c.name} className={`ch ${cls(`chan:${keyOf(c)}`)}`}>{icon(c.type, c.name)} {c.name}</div>)}
        {bp.categories.map((cat) => <div key={cat.name}><div className={`cat ${cls(`chan:${keyOf(cat)}`)}`}>{cat.private ? "🔒 " : ""}{cat.name}</div>{cat.channels.map((c) => <div key={c.name} className={`ch ${cls(`chan:${keyOf(c)}`)}`}>{icon(c.type, c.name)} {c.name}{(c.private || c.readOnly) && <span className="faint small">{c.private ? " · private" : " · read-only"}</span>}</div>)}</div>)}
        {[...bp.removals.channels, ...bp.removals.categories].map((n) => <div key={n} className="ch del">{n}</div>)}
      </div>
      <div className="tree">
        <div className="cat" style={{ marginTop: 0 }}>Roles</div>
        <div className="stack" style={{ gap: 6 }}>{bp.roles.map((r) => <span key={r.key} className={`role-pill ${cls(`role:${r.key}`) === "new" ? "" : ""}`}><i style={{ background: r.color ?? "#99aab5" }} />{r.name}{r.preset && <span className="faint small">{r.preset}</span>}</span>)}</div>
        {bp.removals.roles.map((n) => <div key={n} className="ch del">@{n}</div>)}
        {Object.keys(bp.features).length > 0 && <><div className="cat">Features</div><div className="row wrap" style={{ gap: 6 }}>{Object.entries(bp.features).filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k]) => <Chip key={k} tone="crim">{k}</Chip>)}</div></>}
      </div>
    </div>
  );
}

function SaveTemplate({ open, onClose, blueprint, onSaved }: { open: boolean; onClose: () => void; blueprint: Blueprint | null; onSaved: () => void }) {
  const { guildId, level } = useGuild();
  const toast = useToast();
  const [name, setName] = useState(""); const [desc, setDesc] = useState(""); const [shared, setShared] = useState(false); const [fromCurrent, setFromCurrent] = useState(false);
  async function save() {
    try { await api(`/api/guilds/${guildId}/architect/templates`, { body: { name, description: desc, blueprint: fromCurrent ? undefined : blueprint, fromCurrentServer: fromCurrent, shared } }); toast("Template saved"); onSaved(); onClose(); }
    catch (e) { toast((e as Error).message, true); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Save blueprint template" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!name}>Save</Button></>}>
      <div className="stack">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description"><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
        <div className="toggle-row"><div><div className="t">Export the current live server instead</div><div className="d">Captures roles, channels and permissions as they exist now.</div></div><Switch checked={fromCurrent} onChange={setFromCurrent} /></div>
        {level === "owner" && <div className="toggle-row"><div><div className="t">Share with every server on this MOTH instance</div></div><Switch checked={shared} onChange={setShared} /></div>}
      </div>
    </Modal>
  );
}

/** Minimal, XSS-safe markdown: **bold**, *italic*, `code`, line breaks. */
function Md({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return <>{parts.map((p, i) => p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith("`") && p.endsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? <i key={i}>{p.slice(1, -1)}</i> : <span key={i}>{p}</span>)}</>;
}
