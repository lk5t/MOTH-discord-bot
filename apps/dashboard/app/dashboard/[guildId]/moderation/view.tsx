"use client";
import { useState } from "react";
import type { GuildConfig, PunishmentAction } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtDate, timeAgo, useApi, useLive } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, SaveBar, Select, Skeleton, Tabs, Textarea, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleMulti } from "@/components/pickers";
import { Columns, Donut } from "@/components/charts";
import { I } from "@/components/icons";

type Case = { id: number; caseNumber: number; type: string; targetId: string; targetTag: string | null; moderatorId: string; reason: string | null; durationMs: number | null; active: boolean; automated: boolean; explanation: { summary?: string } | null; createdAt: string };
type Appeal = { id: number; userId: string; userTag: string | null; content: string; status: string; createdAt: string; response: string | null };
const ACTIONS: { value: PunishmentAction; label: string }[] = [{ value: "none", label: "Log only" }, { value: "delete", label: "Delete message" }, { value: "warn", label: "Delete + warn" }, { value: "timeout", label: "Delete + timeout" }, { value: "kick", label: "Delete + kick" }, { value: "ban", label: "Delete + ban" }];

export function ModerationView() {
  const { can } = useGuild();
  const [tab, setTab] = useState<"cases" | "automod" | "escalation" | "appeals" | "settings">("cases");
  const cfg = useGuildConfig();
  return (
    <>
      <PageHead title="Moderation" description="Cases, automatic moderation, punishment rules and appeals. Every setting is also available through Discord commands." actions={can("moderator") && <QuickAction />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "cases", label: "Cases" }, ...(can("admin") ? [{ value: "automod" as const, label: "Auto-moderation" }, { value: "escalation" as const, label: "Punishments" }] : []), { value: "appeals", label: "Appeals" }, ...(can("admin") ? [{ value: "settings" as const, label: "Settings" }] : [])]} />
      {tab === "cases" && <Cases />}
      {tab === "appeals" && <Appeals />}
      {tab !== "cases" && tab !== "appeals" && (!cfg.config ? <Skeleton h={300} /> : <>
        {tab === "automod" && <Automod c={cfg.config.automod} set={(p) => cfg.update("automod", p)} />}
        {tab === "escalation" && <Escalation c={cfg.config.moderation} set={(p) => cfg.update("moderation", p)} />}
        {tab === "settings" && <ModSettings c={cfg.config} cfg={cfg} />}
        <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
      </>)}
    </>
  );
}

function Cases() {
  const { guildId } = useGuild();
  const toast = useToast();
  const [type, setType] = useState(""); const [user, setUser] = useState(""); const [page, setPage] = useState(0);
  const q = useApi<{ rows: Case[]; total: number }>(`/api/guilds/${guildId}/cases?page=${page}${type ? `&type=${type}` : ""}${user ? `&user=${user}` : ""}`);
  const stats = useApi<{ byType: { type: string; n: number }[]; byDay: { day: string; n: number }[]; automated: number; total: number }>(`/api/guilds/${guildId}/moderation/stats`);
  useLive(guildId, ["case.created"], () => { void q.reload(); void stats.reload(); });
  const [sel, setSel] = useState<Case | null>(null);
  const [reason, setReason] = useState("");
  const colors: Record<string, string> = { warn: "#f59e0b", automod: "#fbbf24", timeout: "#f97316", kick: "#ef4444", ban: "#dc143c", note: "#71717a", unban: "#22c55e", untimeout: "#4ade80", purge: "#60a5fa" };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid g3">
        <Card title="Last 30 days" className="span2"><Columns labels={(stats.data?.byDay ?? []).map((d) => new Date(d.day).toLocaleDateString())} values={(stats.data?.byDay ?? []).map((d) => Number(d.n))} height={120} /></Card>
        <Card title="By action"><Donut parts={(stats.data?.byType ?? []).map((t) => ({ label: t.type, value: Number(t.n), color: colors[t.type] ?? "#a1a1aa" }))} size={110} /><div className="small faint mt">{stats.data ? `${Math.round((Number(stats.data.automated) / Math.max(1, Number(stats.data.total))) * 100)}% automated` : ""}</div></Card>
      </div>
      <Card title={`Cases${q.data ? ` · ${q.data.total}` : ""}`} actions={<><Input placeholder="Filter by user ID" value={user} onChange={(e) => { setUser(e.target.value.replace(/\D/g, "")); setPage(0); }} style={{ width: 180 }} /><Select value={type} onChange={(v) => { setType(v); setPage(0); }} placeholder="All types" options={["warn", "automod", "timeout", "kick", "ban", "unban", "note", "purge"].map((t) => ({ value: t, label: t }))} /></>}>
        {!q.data ? <Skeleton h={200} /> : !q.data.rows.length ? <Empty title="No cases" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Type</th><th>User</th><th>Reason</th><th>Moderator</th><th>When</th></tr></thead><tbody>
            {q.data.rows.map((c) => <tr key={c.id} className="click" onClick={() => { setSel(c); setReason(c.reason ?? ""); }}>
              <td className="mono">{c.caseNumber}</td><td><Chip tone={["ban", "kick"].includes(c.type) ? "crim" : ["warn", "automod", "timeout"].includes(c.type) ? "warn" : undefined}>{c.type}</Chip>{!c.active && <span className="faint small"> void</span>}</td>
              <td>{c.targetTag ?? c.targetId}<div className="small faint mono">{c.targetId}</div></td><td className="small" style={{ maxWidth: 340 }}>{c.reason}</td>
              <td className="small">{c.automated ? <Chip tone="info">auto</Chip> : <span className="mono faint">{c.moderatorId}</span>}</td><td className="small faint nowrap">{timeAgo(c.createdAt)}</td>
            </tr>)}
          </tbody></table></div>
        )}
        {q.data && q.data.total > 50 && <div className="row mt" style={{ justifyContent: "flex-end" }}><Button size="sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={(page + 1) * 50 >= q.data.total} onClick={() => setPage(page + 1)}>Next</Button></div>}
      </Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? `Case #${sel.caseNumber} · ${sel.type}` : ""} footer={sel && <>
        {sel.active && <Button variant="danger" onClick={async () => { await api(`/api/guilds/${guildId}/cases/${sel.caseNumber}`, { method: "PATCH", body: { active: false } }); toast("Case voided"); setSel(null); void q.reload(); }}>Void case</Button>}
        <Button variant="primary" onClick={async () => { await api(`/api/guilds/${guildId}/cases/${sel.caseNumber}`, { method: "PATCH", body: { reason } }); toast("Reason updated"); setSel(null); void q.reload(); }}>Save</Button>
      </>}>
        {sel && <div className="stack">
          <div className="grid g2 small"><div><span className="faint">User</span><div>{sel.targetTag} <span className="mono faint">{sel.targetId}</span></div></div><div><span className="faint">Date</span><div>{fmtDate(sel.createdAt)}</div></div></div>
          {sel.explanation?.summary && <Card className="flat"><div className="field-label">Why MOTH acted</div><div className="small">{sel.explanation.summary}</div><pre className="small faint" style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>{JSON.stringify(sel.explanation, null, 2)}</pre></Card>}
          <Field label="Reason"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>}
      </Modal>
    </div>
  );
}

function QuickAction() {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ type: "warn", userId: "", reason: "", minutes: 60 });
  async function run() {
    if (["ban", "kick"].includes(f.type) && !(await confirm({ title: `${f.type} this user?`, body: `User ${f.userId} will be ${f.type === "ban" ? "banned" : "kicked"}. They'll receive a DM with the reason.`, danger: true, confirm: f.type }))) return;
    try {
      const r = await api<{ caseNumber: number }>(`/api/guilds/${guildId}/moderation/action`, { body: { type: f.type, userId: f.userId, reason: f.reason || undefined, durationMs: f.type === "timeout" ? f.minutes * 60_000 : undefined } });
      toast(`Done — case #${r.caseNumber}`); setOpen(false);
    } catch (e) { toast((e as Error).message, true); }
  }
  return <>
    <Button variant="primary" icon={<I.moderation />} onClick={() => setOpen(true)}>Take action</Button>
    <Modal open={open} onClose={() => setOpen(false)} title="Moderation action" footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant={["ban", "kick"].includes(f.type) ? "danger" : "primary"} onClick={run} disabled={!/^\d{15,22}$/.test(f.userId)}>Execute</Button></>}>
      <div className="stack">
        <Field label="Action"><Select value={f.type} onChange={(v) => setF({ ...f, type: v })} options={["warn", "timeout", "untimeout", "kick", "ban", "unban", "note"].map((t) => ({ value: t, label: t }))} /></Field>
        <Field label="User ID" hint="Right-click a user in Discord → Copy User ID"><Input value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value.trim() })} /></Field>
        {f.type === "timeout" && <Field label="Duration (minutes)"><NumberInput value={f.minutes} min={1} max={40320} onChange={(v) => setF({ ...f, minutes: v })} /></Field>}
        <Field label="Reason"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  </>;
}

type AM = GuildConfig["automod"];
function RuleCard<K extends "spam" | "duplicates" | "mentions" | "links" | "invites" | "words" | "caps" | "zalgo">({ k, title, desc, c, set, children }: { k: K; title: string; desc: string; c: AM; set: (p: Partial<AM>) => void; children?: React.ReactNode }) {
  const r = c[k];
  const upd = (p: Partial<AM[K]>) => set({ [k]: { ...r, ...p } } as Partial<AM>);
  return (
    <Card>
      <ToggleRow title={title} description={desc} checked={r.enabled} onChange={(v) => upd({ enabled: v } as Partial<AM[K]>)} />
      {r.enabled && <div className="stack mt">
        <div className="grid g2"><Field label="Action"><Select value={r.action} onChange={(v) => upd({ action: v } as Partial<AM[K]>)} options={ACTIONS} /></Field>
          {r.action === "timeout" && <Field label="Timeout (minutes)"><NumberInput value={r.timeoutMinutes} min={1} max={40320} onChange={(v) => upd({ timeoutMinutes: v } as Partial<AM[K]>)} /></Field>}</div>
        {children}
      </div>}
    </Card>
  );
}

function Automod({ c, set }: { c: AM; set: (p: Partial<AM>) => void }) {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card accent><ToggleRow title="Auto-moderation" description="Master switch. Staff with Manage Messages are always exempt." checked={c.enabled} onChange={(v) => set({ enabled: v })} />
        <div className="grid g2 mt"><Field label="Exempt roles"><RoleMulti value={c.exemptRoleIds} onChange={(v) => set({ exemptRoleIds: v })} /></Field><Field label="Exempt channels"><ChannelMulti value={c.exemptChannelIds} onChange={(v) => set({ exemptChannelIds: v })} /></Field></div>
      </Card>
      <div className="grid g2">
        <RuleCard k="spam" title="Spam detection" desc="Too many messages in a short window." c={c} set={set}><div className="grid g2"><Field label="Max messages"><NumberInput value={c.spam.maxMessages} min={2} max={50} onChange={(v) => set({ spam: { ...c.spam, maxMessages: v } })} /></Field><Field label="Per seconds"><NumberInput value={c.spam.perSeconds} min={1} max={120} onChange={(v) => set({ spam: { ...c.spam, perSeconds: v } })} /></Field></div></RuleCard>
        <RuleCard k="duplicates" title="Duplicate messages" desc="Repeating the same message." c={c} set={set}><div className="grid g2"><Field label="Max repeats"><NumberInput value={c.duplicates.maxDuplicates} min={2} max={20} onChange={(v) => set({ duplicates: { ...c.duplicates, maxDuplicates: v } })} /></Field><Field label="Within seconds"><NumberInput value={c.duplicates.perSeconds} min={5} max={600} onChange={(v) => set({ duplicates: { ...c.duplicates, perSeconds: v } })} /></Field></div></RuleCard>
        <RuleCard k="mentions" title="Mass-mention protection" desc="Too many user/role mentions in one message." c={c} set={set}><Field label="Max mentions"><NumberInput value={c.mentions.maxMentions} min={1} max={100} onChange={(v) => set({ mentions: { ...c.mentions, maxMentions: v } })} /></Field><ToggleRow title="Block @everyone / @here" description="From members without permission" checked={c.mentions.blockEveryone} onChange={(v) => set({ mentions: { ...c.mentions, blockEveryone: v } })} /></RuleCard>
        <RuleCard k="invites" title="Invite filter" desc="Discord invite links to other servers." c={c} set={set}><ToggleRow title="Allow this server's invites" checked={c.invites.allowOwnGuild} onChange={(v) => set({ invites: { ...c.invites, allowOwnGuild: v } })} /></RuleCard>
        <RuleCard k="links" title="Link filter" desc="Block links or allow only trusted domains." c={c} set={set}>
          <Field label="Mode"><Select value={c.links.mode} onChange={(v) => set({ links: { ...c.links, mode: v as AM["links"]["mode"] } })} options={[{ value: "allow-all", label: "Allow all" }, { value: "whitelist", label: "Allow listed domains only" }, { value: "block-all", label: "Block all links" }]} /></Field>
          {c.links.mode === "whitelist" && <Field label="Allowed domains" hint="One per line"><Textarea value={c.links.allowedDomains.join("\n")} onChange={(e) => set({ links: { ...c.links, allowedDomains: e.target.value.split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean) } })} /></Field>}
        </RuleCard>
        <RuleCard k="words" title="Word filter" desc="Custom blocked words, phrases and patterns." c={c} set={set}>
          <Field label="Blocked words / phrases" hint="One per line"><Textarea value={c.words.words.join("\n")} onChange={(e) => set({ words: { ...c.words, words: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })} /></Field>
          <Field label="Regex patterns" hint="Advanced — one per line, case-insensitive"><Textarea value={c.words.regex.join("\n")} onChange={(e) => set({ words: { ...c.words, regex: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })} className="mono" /></Field>
          <ToggleRow title="Match whole words only" description="Avoids false positives like “class” matching “ass”." checked={c.words.matchWholeWord} onChange={(v) => set({ words: { ...c.words, matchWholeWord: v } })} />
        </RuleCard>
        <RuleCard k="caps" title="Excessive caps" desc="Messages that are mostly capital letters." c={c} set={set}><div className="grid g2"><Field label="Caps %"><NumberInput value={c.caps.percent} min={50} max={100} onChange={(v) => set({ caps: { ...c.caps, percent: v } })} /></Field><Field label="Min length"><NumberInput value={c.caps.minLength} min={5} max={500} onChange={(v) => set({ caps: { ...c.caps, minLength: v } })} /></Field></div></RuleCard>
        <RuleCard k="zalgo" title="Zalgo / corrupted text" desc="Stacked combining characters." c={c} set={set} />
      </div>
      <Card title="AI moderation assist" subtitle="The AI flags harmful messages to the mod log with an explanation. It only acts on its own if you allow it.">
        <ToggleRow title="Enable AI review" checked={c.aiAssist.enabled} onChange={(v) => set({ aiAssist: { ...c.aiAssist, enabled: v } })} />
        {c.aiAssist.enabled && <><ToggleRow title="Allow AI to delete flagged messages" description="Never punishes users — deletion only." checked={c.aiAssist.autoAct} onChange={(v) => set({ aiAssist: { ...c.aiAssist, autoAct: v } })} />
          <Field label={`Confidence threshold · ${Math.round(c.aiAssist.threshold * 100)}%`}><input type="range" min={50} max={99} value={Math.round(c.aiAssist.threshold * 100)} onChange={(e) => set({ aiAssist: { ...c.aiAssist, threshold: Number(e.target.value) / 100 } })} style={{ accentColor: "var(--crimson)" }} /></Field></>}
      </Card>
    </div>
  );
}

function Escalation({ c, set }: { c: GuildConfig["moderation"]; set: (p: Partial<GuildConfig["moderation"]>) => void }) {
  const rules = [...c.escalation].sort((a, b) => a.warnings - b.warnings);
  return (
    <Card title="Escalating punishments" subtitle="When a member reaches a number of active warnings, MOTH applies the matching action automatically.">
      <div className="stack">
        {rules.map((r, i) => <div key={i} className="grid" style={{ gridTemplateColumns: "140px 1fr 160px auto", alignItems: "end" }}>
          <Field label="Warnings"><NumberInput value={r.warnings} min={1} max={100} onChange={(v) => set({ escalation: rules.map((x, j) => (j === i ? { ...x, warnings: v } : x)) })} /></Field>
          <Field label="Action"><Select value={r.action} onChange={(v) => set({ escalation: rules.map((x, j) => (j === i ? { ...x, action: v as "timeout" } : x)) })} options={[{ value: "timeout", label: "Timeout" }, { value: "kick", label: "Kick" }, { value: "ban", label: "Ban" }]} /></Field>
          <Field label="Duration (min)">{r.action === "timeout" ? <NumberInput value={r.durationMinutes ?? 60} min={1} max={40320} onChange={(v) => set({ escalation: rules.map((x, j) => (j === i ? { ...x, durationMinutes: v } : x)) })} /> : <Input disabled value="—" />}</Field>
          <Button variant="ghost" icon={<I.trash />} onClick={() => set({ escalation: rules.filter((_, j) => j !== i) })} />
        </div>)}
        <div><Button icon={<I.plus />} onClick={() => set({ escalation: [...rules, { warnings: (rules.at(-1)?.warnings ?? 0) + 2, action: "timeout", durationMinutes: 60 }] })}>Add rule</Button></div>
        <div className="divider" />
        <Field label="Warnings expire after (days)" hint="0 = never. Expired warnings don't count toward escalation."><NumberInput value={c.warnExpiryDays} min={0} max={3650} onChange={(v) => set({ warnExpiryDays: v })} /></Field>
      </div>
    </Card>
  );
}

function ModSettings({ c, cfg }: { c: GuildConfig; cfg: ReturnType<typeof useGuildConfig> }) {
  const m = c.moderation;
  return (
    <div className="grid g2">
      <Card title="Permissions" subtitle="Who can use moderation commands (in addition to Discord permissions)">
        <div className="stack"><Field label="Moderator roles"><RoleMulti value={m.moderatorRoleIds} onChange={(v) => cfg.update("moderation", { moderatorRoleIds: v })} /></Field><Field label="Admin roles" hint="Can use admin commands like /config and /architect"><RoleMulti value={m.adminRoleIds} onChange={(v) => cfg.update("moderation", { adminRoleIds: v })} /></Field></div>
      </Card>
      <Card title="Behaviour">
        <ToggleRow title="Moderation enabled" checked={m.enabled} onChange={(v) => cfg.update("moderation", { enabled: v })} />
        <ToggleRow title="DM users when actioned" description="Includes the reason and, for automated actions, an explanation." checked={m.dmOnAction} onChange={(v) => cfg.update("moderation", { dmOnAction: v })} />
        <ToggleRow title="Require a reason" checked={m.requireReason} onChange={(v) => cfg.update("moderation", { requireReason: v })} />
      </Card>
      <Card title="Logging"><div className="stack"><Field label="Moderation log channel"><ChannelSelect value={c.general.modLogChannelId} onChange={(v) => cfg.update("general", { modLogChannelId: v })} /></Field></div></Card>
      <Card title="Appeals" subtitle="Banned users get an Appeal button in their ban DM.">
        <ToggleRow title="Enable appeals" checked={m.appeals.enabled} onChange={(v) => cfg.update("moderation", { appeals: { ...m.appeals, enabled: v } })} />
        <div className="grid g2 mt"><Field label="Appeals channel"><ChannelSelect value={m.appeals.channelId} onChange={(v) => cfg.update("moderation", { appeals: { ...m.appeals, channelId: v } })} /></Field><Field label="Cooldown (days)"><NumberInput value={m.appeals.cooldownDays} min={0} max={365} onChange={(v) => cfg.update("moderation", { appeals: { ...m.appeals, cooldownDays: v } })} /></Field></div>
      </Card>
    </div>
  );
}

function Appeals() {
  const { guildId } = useGuild();
  const toast = useToast();
  const q = useApi<Appeal[]>(`/api/guilds/${guildId}/appeals`);
  async function decide(a: Appeal, decision: "accepted" | "denied") {
    try { await api(`/api/guilds/${guildId}/appeals/${a.id}`, { body: { decision } }); toast(`Appeal ${decision}`); void q.reload(); } catch (e) { toast((e as Error).message, true); }
  }
  if (!q.data) return <Skeleton h={200} />;
  if (!q.data.length) return <Card><Empty title="No appeals yet">Banned users can appeal from the DM they receive when banned.</Empty></Card>;
  return <div className="stack">{q.data.map((a) => <Card key={a.id} title={<>Appeal #{a.id} · {a.userTag ?? a.userId}</>} subtitle={fmtDate(a.createdAt)} actions={a.status === "pending" ? <><Button size="sm" variant="danger" onClick={() => decide(a, "denied")}>Deny</Button><Button size="sm" variant="primary" onClick={() => decide(a, "accepted")}>Accept & unban</Button></> : <Chip tone={a.status === "accepted" ? "ok" : "crim"}>{a.status}</Chip>}><div style={{ whiteSpace: "pre-wrap" }}>{a.content}</div></Card>)}</div>;
}
