"use client";
import { useState } from "react";
import type { EmbedData } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtDate, fmtDuration, fmtNum, timeAgo, useApi, useLive } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, SaveBar, Select, Skeleton, Stat, Tabs, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelSelect, RoleMulti, useNames } from "@/components/pickers";
import { MessageEditor } from "@/components/embed-editor";
import { BarList } from "@/components/charts";
import { I } from "@/components/icons";

type Ticket = { id: string; number: number; categoryLabel: string | null; channelId: string | null; openerId: string; openerTag: string | null; claimedById: string | null; priority: "low" | "normal" | "high" | "urgent"; status: string; subject: string | null; answers: { question: string; answer: string }[] | null; createdAt: string; closedAt: string | null; closeReason: string | null };
type Cat = { id: string; label: string; emoji?: string; description?: string; staffRoleIds: string[]; parentCategoryId?: string | null; openMessage?: string; defaultPriority?: Ticket["priority"]; questions?: { label: string; placeholder?: string; required?: boolean; long?: boolean }[] };
type Panel = { id?: string; name: string; channelId: string | null; messageId?: string | null; style: "buttons" | "select"; embed: EmbedData; staffRoleIds: string[]; parentCategoryId: string | null; enabled: boolean; categories: Cat[] };
const PRI = { low: "🟢", normal: "🔵", high: "🟠", urgent: "🔴" };

export function TicketsView() {
  const { can } = useGuild();
  const [tab, setTab] = useState<"queue" | "panels" | "settings">("queue");
  return (
    <>
      <PageHead title="Tickets" description="Private support channels with claiming, priorities, forms and transcripts." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "queue", label: "Tickets" }, ...(can("admin") ? [{ value: "panels" as const, label: "Panels" }, { value: "settings" as const, label: "Settings" }] : [])]} />
      {tab === "queue" && <Queue />}{tab === "panels" && <Panels />}{tab === "settings" && <Settings />}
    </>
  );
}

function Queue() {
  const { guildId } = useGuild();
  const toast = useToast();
  const [status, setStatus] = useState("open");
  const q = useApi<{ rows: Ticket[]; stats: Record<string, number>; byCategory: { label: string | null; n: number }[] }>(`/api/guilds/${guildId}/tickets${status ? `?status=${status}` : ""}`);
  useLive(guildId, ["ticket.updated"], () => void q.reload());
  const [open, setOpen] = useState<string | null>(null);
  const detail = useApi<{ ticket: Ticket; transcript: { html: string; messageCount: number } | null }>(open ? `/api/guilds/${guildId}/tickets/${open}` : null);
  const s = q.data?.stats;
  async function act(path: string, body: unknown = {}, method = "POST") { try { await api(`/api/guilds/${guildId}/tickets/${open}${path}`, { method, body }); toast("Done"); void q.reload(); void detail.reload(); } catch (e) { toast((e as Error).message, true); } }
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat label="Open" value={fmtNum(s?.open)} delta={`${fmtNum(s?.urgent)} high/urgent`} />
        <Stat label="This week" value={fmtNum(s?.week)} delta={`${fmtNum(s?.total)} all time`} />
        <Stat label="First response" value={fmtDuration(Number(s?.avgFirst ?? 0))} delta="average" />
        <Stat label="Resolution" value={fmtDuration(Number(s?.avgResolve ?? 0))} delta="average" />
      </div>
      <div className="grid g3">
        <Card className="span2" title="Tickets" actions={<Select value={status} onChange={setStatus} options={[{ value: "open", label: "Open" }, { value: "closed", label: "Closed" }, { value: "archived", label: "Archived" }, { value: "", label: "All" }]} />}>
          {!q.data ? <Skeleton h={220} /> : !q.data.rows.length ? <Empty icon={<I.tickets />} title="No tickets here" /> : <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>Category</th><th>Opened by</th><th>Priority</th><th>Claimed</th><th>Opened</th></tr></thead><tbody>
            {q.data.rows.map((t) => <tr key={t.id} className="click" onClick={() => setOpen(t.id)}><td className="mono">{t.number}</td><td>{t.categoryLabel}<div className="small faint">{t.subject?.slice(0, 60)}</div></td><td className="small">{t.openerTag ?? t.openerId}</td><td>{PRI[t.priority]} <span className="small">{t.priority}</span></td><td className="small">{t.claimedById ? <Chip tone="ok">claimed</Chip> : <span className="faint">—</span>}</td><td className="small faint nowrap">{timeAgo(t.createdAt)}</td></tr>)}
          </tbody></table></div>}
        </Card>
        <Card title="By category"><BarList items={(q.data?.byCategory ?? []).map((c) => ({ label: c.label ?? "—", value: Number(c.n) }))} /></Card>
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} wide title={detail.data ? `Ticket #${detail.data.ticket.number} · ${detail.data.ticket.categoryLabel}` : "Ticket"} footer={detail.data && <>
        <Select value={detail.data.ticket.priority} onChange={(v) => act("", { priority: v }, "PATCH")} options={Object.keys(PRI).map((p) => ({ value: p, label: `${PRI[p as keyof typeof PRI]} ${p}` }))} />
        {detail.data.ticket.status === "open" ? <Button variant="danger" onClick={() => act("/close", { reason: "Closed from dashboard" })}>Close ticket</Button> : <Button onClick={() => act("/reopen")}>Reopen</Button>}
      </>}>
        {!detail.data ? <Skeleton h={200} /> : <div className="stack">
          <div className="grid g3 small"><div><span className="faint">Opened by</span><div>{detail.data.ticket.openerTag}</div></div><div><span className="faint">Opened</span><div>{fmtDate(detail.data.ticket.createdAt)}</div></div><div><span className="faint">Status</span><div>{detail.data.ticket.status}{detail.data.ticket.closeReason ? ` — ${detail.data.ticket.closeReason}` : ""}</div></div></div>
          {detail.data.ticket.answers?.map((a, i) => <div key={i}><div className="field-label">{a.question}</div><div>{a.answer}</div></div>)}
          {detail.data.transcript ? <><div className="field-label">Transcript · {detail.data.transcript.messageCount} messages</div><iframe title="Transcript" srcDoc={detail.data.transcript.html} sandbox="" style={{ width: "100%", height: 420, border: "1px solid var(--line-2)", borderRadius: 10, background: "#0a0a0a" }} /></> : <div className="small faint">Transcript is generated when the ticket is closed.</div>}
        </div>}
      </Modal>
    </div>
  );
}

const blankPanel = (): Panel => ({ name: "Support", channelId: null, style: "buttons", embed: { title: "🎫 Need help?", description: "Choose a category below to open a private ticket with our team.", color: "#DC143C" }, staffRoleIds: [], parentCategoryId: null, enabled: true, categories: [{ id: "c1", label: "General Support", emoji: "🛟", staffRoleIds: [] }] });

function Panels() {
  const { guildId } = useGuild();
  const names = useNames();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<Panel[]>(`/api/guilds/${guildId}/ticket-panels`);
  const [edit, setEdit] = useState<Panel | null>(null);
  const [saving, setSaving] = useState(false);
  async function save(publish: boolean) {
    if (!edit) return;
    setSaving(true);
    try {
      const { id, messageId, ...body } = edit; void messageId;
      const row = await api<Panel>(id ? `/api/guilds/${guildId}/ticket-panels/${id}` : `/api/guilds/${guildId}/ticket-panels`, { method: id ? "PATCH" : "POST", body });
      if (publish) await api(`/api/guilds/${guildId}/ticket-panels/${row.id}/publish`, { body: {} });
      toast(publish ? "Panel saved and published to Discord" : "Panel saved"); setEdit(null); void q.reload();
    } catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  }
  const setCat = (i: number, p: Partial<Cat>) => edit && setEdit({ ...edit, categories: edit.categories.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  return (
    <>
      <div className="row mb" style={{ justifyContent: "flex-end" }}><Button variant="primary" icon={<I.plus />} onClick={() => setEdit(blankPanel())}>New panel</Button></div>
      {!q.data ? <Skeleton h={200} /> : !q.data.length ? <Card><Empty icon={<I.tickets />} title="No ticket panels">Create a panel, choose a channel, and publish it to Discord.</Empty></Card> : (
        <div className="grid g2">{q.data.map((p) => <Card key={p.id} title={p.name} subtitle={`${names.channel(p.channelId)} · ${p.categories.length} categories · ${p.style}`} actions={<>{!p.enabled && <Chip>disabled</Chip>}{p.messageId ? <Chip tone="ok">published</Chip> : <Chip tone="warn">not published</Chip>}</>}>
          <div className="row wrap">{p.categories.map((c) => <Chip key={c.id}>{c.emoji} {c.label}</Chip>)}</div>
          <div className="row mt"><Button size="sm" onClick={() => setEdit(p)} icon={<I.edit />}>Edit</Button><Button size="sm" onClick={async () => { try { await api(`/api/guilds/${guildId}/ticket-panels/${p.id}/publish`, { body: {} }); toast("Published"); void q.reload(); } catch (e) { toast((e as Error).message, true); } }} icon={<I.send />}>Publish</Button>
            <Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: `Delete panel "${p.name}"?`, body: "Existing tickets are kept. The panel message in Discord will stop working.", danger: true, confirm: "Delete" })) { await api(`/api/guilds/${guildId}/ticket-panels/${p.id}`, { method: "DELETE" }); void q.reload(); } }} /></div>
        </Card>)}</div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? "Edit ticket panel" : "New ticket panel"} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save(false)} loading={saving}>Save</Button><Button variant="primary" onClick={() => save(true)} loading={saving} disabled={!edit?.channelId} icon={<I.send />}>Save & publish</Button></>}>
        {edit && <div className="stack">
          <div className="grid g3"><Field label="Panel name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Post in channel"><ChannelSelect value={edit.channelId} onChange={(v) => setEdit({ ...edit, channelId: v })} /></Field><Field label="Style"><Select value={edit.style} onChange={(v) => setEdit({ ...edit, style: v as "buttons" })} options={[{ value: "buttons", label: "Buttons (≤5 categories)" }, { value: "select", label: "Dropdown menu" }]} /></Field></div>
          <div className="grid g2"><Field label="Staff roles (all categories)"><RoleMulti value={edit.staffRoleIds} onChange={(v) => setEdit({ ...edit, staffRoleIds: v })} /></Field><Field label="Create tickets in category"><ChannelSelect kind="category" value={edit.parentCategoryId} onChange={(v) => setEdit({ ...edit, parentCategoryId: v })} placeholder="No category" /></Field></div>
          <ToggleRow title="Panel enabled" checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} />
          <div className="field-label">Panel message</div>
          <MessageEditor value={{ embed: edit.embed }} onChange={(m) => setEdit({ ...edit, embed: m.embed ?? {} })} allowContent={false} />
          <div className="divider" />
          <div className="row between"><div className="field-label">Categories</div><Button size="sm" icon={<I.plus />} disabled={edit.categories.length >= 25} onClick={() => setEdit({ ...edit, categories: [...edit.categories, { id: `c${Date.now().toString(36)}`, label: "New category", staffRoleIds: [] }] })}>Add category</Button></div>
          {edit.categories.map((c, i) => <Card key={c.id} className="flat">
            <div className="grid" style={{ gridTemplateColumns: "80px 1fr 1.4fr 130px auto", alignItems: "end" }}>
              <Field label="Emoji"><Input value={c.emoji ?? ""} onChange={(e) => setCat(i, { emoji: e.target.value || undefined })} /></Field>
              <Field label="Label"><Input value={c.label} onChange={(e) => setCat(i, { label: e.target.value })} /></Field>
              <Field label="Description"><Input value={c.description ?? ""} onChange={(e) => setCat(i, { description: e.target.value || undefined })} /></Field>
              <Field label="Priority"><Select value={c.defaultPriority ?? "normal"} onChange={(v) => setCat(i, { defaultPriority: v as Ticket["priority"] })} options={Object.keys(PRI).map((p) => ({ value: p, label: p }))} /></Field>
              <Button variant="ghost" icon={<I.trash />} disabled={edit.categories.length === 1} onClick={() => setEdit({ ...edit, categories: edit.categories.filter((_, j) => j !== i) })} />
            </div>
            <div className="grid g2 mt"><Field label="Extra staff roles"><RoleMulti value={c.staffRoleIds} onChange={(v) => setCat(i, { staffRoleIds: v })} /></Field><Field label="Opening message" hint="{user} mentions the opener"><Input value={c.openMessage ?? ""} onChange={(e) => setCat(i, { openMessage: e.target.value || undefined })} /></Field></div>
            <div className="mt"><div className="row between"><span className="small faint">Form questions (shown before the ticket opens, max 5)</span><Button size="sm" variant="ghost" icon={<I.plus />} disabled={(c.questions?.length ?? 0) >= 5} onClick={() => setCat(i, { questions: [...(c.questions ?? []), { label: "Describe your issue", long: true, required: true }] })}>Question</Button></div>
              {c.questions?.map((qq, k) => <div key={k} className="grid mt" style={{ gridTemplateColumns: "1fr auto auto auto", alignItems: "center" }}><Input value={qq.label} maxLength={45} onChange={(e) => setCat(i, { questions: c.questions!.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} /><label className="row small faint"><input type="checkbox" checked={!!qq.long} onChange={(e) => setCat(i, { questions: c.questions!.map((x, j) => (j === k ? { ...x, long: e.target.checked } : x)) })} />long</label><label className="row small faint"><input type="checkbox" checked={qq.required !== false} onChange={(e) => setCat(i, { questions: c.questions!.map((x, j) => (j === k ? { ...x, required: e.target.checked } : x)) })} />required</label><Button size="sm" variant="ghost" icon={<I.x />} onClick={() => setCat(i, { questions: c.questions!.filter((_, j) => j !== k) })} /></div>)}
            </div>
          </Card>)}
        </div>}
      </Modal>
    </>
  );
}

function Settings() {
  const cfg = useGuildConfig();
  if (!cfg.config) return <Skeleton h={300} />;
  const t = cfg.config.tickets;
  const set = (p: Partial<typeof t>) => cfg.update("tickets", p);
  return (
    <>
      <div className="grid g2">
        <Card title="General">
          <ToggleRow title="Ticket system enabled" checked={t.enabled} onChange={(v) => set({ enabled: v })} />
          <div className="grid g2 mt"><Field label="Max open tickets per user"><NumberInput value={t.maxOpenPerUser} min={1} max={20} onChange={(v) => set({ maxOpenPerUser: v })} /></Field><Field label="Channel naming" hint="{number} {user} {category}"><Input value={t.namingPattern} onChange={(e) => set({ namingPattern: e.target.value })} /></Field></div>
          <Field label="Auto-close inactive tickets after (hours)" hint="0 = never" className="mt"><NumberInput value={t.autoCloseHours} min={0} max={720} onChange={(v) => set({ autoCloseHours: v })} /></Field>
        </Card>
        <Card title="Closing & archiving">
          <Field label="Transcript channel"><ChannelSelect value={t.transcriptChannelId} onChange={(v) => set({ transcriptChannelId: v })} /></Field>
          <ToggleRow title="DM transcript to the user" checked={t.dmTranscript} onChange={(v) => set({ dmTranscript: v })} />
          <ToggleRow title="Delete channel when closed" description="Otherwise it's moved to the archive category." checked={t.deleteOnClose} onChange={(v) => set({ deleteOnClose: v })} />
          {t.deleteOnClose ? <Field label="Delete after (seconds)"><NumberInput value={t.deleteDelaySeconds} min={0} max={86400} onChange={(v) => set({ deleteDelaySeconds: v })} /></Field> : <Field label="Archive category"><ChannelSelect kind="category" value={t.archiveCategoryId} onChange={(v) => set({ archiveCategoryId: v })} placeholder="Keep in place" /></Field>}
        </Card>
        <Card title="AI support" subtitle="Requires an AI provider."><ToggleRow title="Automated first response" description="Posts an AI-drafted reply based on the ticket form. Clearly labelled; staff still follow up." checked={t.aiFirstResponse} onChange={(v) => set({ aiFirstResponse: v })} /></Card>
      </div>
      <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
    </>
  );
}
