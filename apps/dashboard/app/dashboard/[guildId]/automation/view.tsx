"use client";
import { useState } from "react";
import type { AutomationDefinition, EmbedData } from "@moth/core/shared";
import { RECIPES, RECIPE_CATEGORIES, TRIGGER_LABELS, type Recipe } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, SaveBar, Select, Skeleton, Switch, Tabs, Textarea, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelSelect, RoleMulti, RoleSelect, useNames } from "@/components/pickers";
import { MessageEditor } from "@/components/embed-editor";
import { I } from "@/components/icons";
import { WorkflowBuilder } from "./builder";

type Auto = { id?: string; name: string; description?: string | null; enabled: boolean; definition: AutomationDefinition; runCount?: number; failCount?: number; lastRunAt?: string | null };
type Run = { id: number; automationId: string; status: string; trigger: string; durationMs: number; error: string | null; createdAt: string };
type Menu = { id?: string; name: string; channelId: string | null; messageId?: string | null; style: "reactions" | "buttons" | "select"; mode: "toggle" | "unique" | "add-only" | "remove-only"; embed: EmbedData; options: { roleId: string; label: string; emoji?: string; description?: string }[]; maxSelections?: number | null; requiredRoleIds: string[] };

export function AutomationView() {
  const [tab, setTab] = useState<"recipes" | "workflows" | "welcome" | "menus" | "runs">("recipes");
  return (
    <>
      <PageHead title="Automation" description="Event-driven workflows, schedules, welcome flows and role menus — build visually or describe them to MOTH AI." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "recipes", label: "Recipes" }, { value: "workflows", label: "My workflows" }, { value: "welcome", label: "Welcome & auto-roles" }, { value: "menus", label: "Role menus" }, { value: "runs", label: "Run log" }]} />
      {tab === "recipes" && <Recipes onDone={() => setTab("workflows")} />}{tab === "workflows" && <Workflows />}{tab === "welcome" && <Welcome />}{tab === "menus" && <Menus />}{tab === "runs" && <Runs />}
    </>
  );
}

const blank = (): Auto => ({ name: "New automation", enabled: true, definition: { trigger: { type: "member_join" }, steps: [{ kind: "action", id: "a1", action: { type: "send_dm", message: { content: "Welcome to {server}, {user.name}!" } } }], cooldownSeconds: 0 } });

function Workflows() {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<{ rows: Auto[]; runs: Run[] }>(`/api/guilds/${guildId}/automations`);
  const [edit, setEdit] = useState<Auto | null>(null);
  const [prompt, setPrompt] = useState(""); const [gen, setGen] = useState(false); const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ status: string; log: string[] } | null>(null);
  async function generate() {
    setGen(true);
    try { const r = await api<{ name: string; description: string; definition: AutomationDefinition }>(`/api/guilds/${guildId}/automations/generate`, { body: { prompt } }); setEdit({ ...r, enabled: true }); setPrompt(""); }
    catch (e) { toast((e as Error).message, true); } finally { setGen(false); }
  }
  async function save() {
    if (!edit) return; setSaving(true);
    try { const { id, runCount, failCount, lastRunAt, ...body } = edit; void runCount; void failCount; void lastRunAt; await api(id ? `/api/guilds/${guildId}/automations/${id}` : `/api/guilds/${guildId}/automations`, { method: id ? "PATCH" : "POST", body }); toast("Automation saved — active immediately"); setEdit(null); void q.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  }
  async function toggle(a: Auto, enabled: boolean) { await api(`/api/guilds/${guildId}/automations/${a.id}`, { method: "PATCH", body: { enabled } }); void q.reload(); }
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card accent title="Describe an automation" subtitle="e.g. “Every Friday at 6pm post a game night reminder in #events and ping the Events role” or “Give the Verified role to anyone who reacts ✅ on the rules message”.">
        <div className="row"><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should happen, and when?" onKeyDown={(e) => e.key === "Enter" && prompt.length > 3 && generate()} /><Button variant="primary" onClick={generate} loading={gen} disabled={prompt.length < 4} icon={<I.sparkles />}>Generate</Button><Button onClick={() => setEdit(blank())} icon={<I.plus />}>Blank</Button></div>
        <div className="small faint mt">Generated workflows open in the builder for review — nothing runs until you save.</div>
      </Card>
      {!q.data ? <Skeleton h={200} /> : !q.data.rows.length ? <Card><Empty icon={<I.automation />} title="No automations yet" /></Card> : (
        <div className="grid g2">{q.data.rows.map((a) => <Card key={a.id} title={a.name} subtitle={a.description ?? `${TRIGGER_LABELS[a.definition.trigger.type]} → ${a.definition.steps.length} step(s)`} actions={<Switch checked={a.enabled} onChange={(v) => toggle(a, v)} />}>
          <div className="row wrap small faint"><Chip tone="crim">{TRIGGER_LABELS[a.definition.trigger.type]}</Chip><span>{a.runCount ?? 0} runs</span>{!!a.failCount && <span style={{ color: "#ff6b85" }}>{a.failCount} failed</span>}<span>last {timeAgo(a.lastRunAt)}</span></div>
          <div className="row mt"><Button size="sm" onClick={() => setEdit(a)} icon={<I.edit />}>Edit</Button>
            <Button size="sm" onClick={async () => { try { setTest(await api(`/api/guilds/${guildId}/automations/${a.id}/test`, { body: { live: false } })); } catch (e) { toast((e as Error).message, true); } }} icon={<I.play />}>Dry run</Button>
            <Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: `Delete "${a.name}"?`, body: "This automation will stop running immediately.", danger: true, confirm: "Delete" })) { await api(`/api/guilds/${guildId}/automations/${a.id}`, { method: "DELETE" }); void q.reload(); } }} /></div>
        </Card>)}</div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={edit?.id ? "Edit automation" : "New automation"} footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} icon={<I.check />}>Save</Button></>}>
        {edit && <div className="stack">
          <div className="grid g2"><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Description"><Input value={edit.description ?? ""} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
          <WorkflowBuilder def={edit.definition} onChange={(d) => setEdit({ ...edit, definition: d })} />
        </div>}
      </Modal>
      <Modal open={!!test} onClose={() => setTest(null)} title={`Dry run · ${test?.status}`}><div className="small faint mb">Simulated with you as the member — no messages or roles were changed.</div><pre className="card flat small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{test?.log.join("\n")}</pre></Modal>
    </div>
  );
}

function Recipes({ onDone }: { onDone: () => void }) {
  const { guildId } = useGuild();
  const toast = useToast();
  const [open, setOpen] = useState<Recipe | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const start = (r: Recipe) => { setOpen(r); setVals(Object.fromEntries(r.params.map((p) => [p.key, p.default !== undefined ? String(p.default) : ""]))); };
  const missing = open?.params.filter((p) => !p.optional && !vals[p.key]?.trim()) ?? [];
  async function create() {
    if (!open) return; setBusy(true);
    try { const rows = await api<unknown[]>(`/api/guilds/${guildId}/automations/recipes`, { body: { key: open.key, params: vals } }); toast(`${rows.length > 1 ? `${rows.length} automations` : "Automation"} created and running`); setOpen(null); onDone(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  return <>
    <div className="small faint mb">Pick a recipe, fill in a couple of fields and it starts working immediately. Every recipe becomes a normal workflow you can tweak later.</div>
    {RECIPE_CATEGORIES.map((cat) => <div key={cat} className="mb">
      <div className="field-label">{cat}</div>
      <div className="grid g3">{RECIPES.filter((r) => r.category === cat).map((r) => <Card key={r.key} title={<span>{r.icon} {r.name}</span>} subtitle={r.description}>
        <Button size="sm" variant="primary" icon={<I.plus />} onClick={() => start(r)}>Use recipe</Button>
      </Card>)}</div>
    </div>)}
    <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `${open.icon} ${open.name}` : ""} footer={<><Button onClick={() => setOpen(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={!!missing.length} onClick={create} icon={<I.check />}>Create</Button></>}>
      {open && <div className="stack">
        <div className="small muted">{open.description}</div>
        {open.params.map((p) => <Field key={p.key} label={`${p.label}${p.optional ? " (optional)" : ""}`} hint={p.hint}>
          {p.kind === "channel" ? <ChannelSelect value={vals[p.key] || null} onChange={(v) => setVals({ ...vals, [p.key]: v ?? "" })} />
            : p.kind === "voice" ? <ChannelSelect kind="voice" value={vals[p.key] || null} onChange={(v) => setVals({ ...vals, [p.key]: v ?? "" })} />
            : p.kind === "role" ? <RoleSelect value={vals[p.key] || null} onChange={(v) => setVals({ ...vals, [p.key]: v ?? "" })} />
            : p.kind === "longtext" ? <Textarea value={vals[p.key] ?? ""} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })} />
            : <Input type={p.kind === "number" ? "number" : "text"} value={vals[p.key] ?? ""} onChange={(e) => setVals({ ...vals, [p.key]: e.target.value })} />}
        </Field>)}
      </div>}
    </Modal>
  </>;
}

function Welcome() {
  const cfg = useGuildConfig();
  if (!cfg.config) return <Skeleton h={300} />;
  const c = cfg.config;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="Welcome message" actions={<Switch checked={c.welcome.enabled} onChange={(v) => cfg.update("welcome", { enabled: v })} />}>
        <Field label="Channel"><ChannelSelect value={c.welcome.channelId} onChange={(v) => cfg.update("welcome", { channelId: v })} /></Field>
        <div className="mt"><MessageEditor value={c.welcome.message} onChange={(m) => cfg.update("welcome", { message: m })} /></div>
        <div className="divider" />
        <ToggleRow title="Also send a DM" checked={c.welcome.dm.enabled} onChange={(v) => cfg.update("welcome", { dm: { ...c.welcome.dm, enabled: v } })} />
        {c.welcome.dm.enabled && <MessageEditor value={c.welcome.dm.message} onChange={(m) => cfg.update("welcome", { dm: { ...c.welcome.dm, message: m } })} />}
      </Card>
      <Card title="Goodbye message" actions={<Switch checked={c.goodbye.enabled} onChange={(v) => cfg.update("goodbye", { enabled: v })} />}>
        <Field label="Channel"><ChannelSelect value={c.goodbye.channelId} onChange={(v) => cfg.update("goodbye", { channelId: v })} /></Field>
        <div className="mt"><MessageEditor value={c.goodbye.message} onChange={(m) => cfg.update("goodbye", { message: m })} /></div>
      </Card>
      <div className="grid g2">
        <Card title="Automatic roles" actions={<Switch checked={c.autorole.enabled} onChange={(v) => cfg.update("autorole", { enabled: v })} />}>
          <div className="stack"><Field label="Roles for new members"><RoleMulti value={c.autorole.roleIds} onChange={(v) => cfg.update("autorole", { roleIds: v })} /></Field><Field label="Roles for bots"><RoleMulti value={c.autorole.botRoleIds} onChange={(v) => cfg.update("autorole", { botRoleIds: v })} /></Field><Field label="Delay (seconds)" hint="Useful with Discord's membership screening"><NumberInput value={c.autorole.delaySeconds} min={0} max={3600} onChange={(v) => cfg.update("autorole", { delaySeconds: v })} /></Field></div>
        </Card>
        <Card title="Member milestones" actions={<Switch checked={c.community.milestones.enabled} onChange={(v) => cfg.update("community", { milestones: { ...c.community.milestones, enabled: v } })} />}>
          <div className="stack"><Field label="Announce every N members"><NumberInput value={c.community.milestones.every} min={10} onChange={(v) => cfg.update("community", { milestones: { ...c.community.milestones, every: v } })} /></Field><Field label="Channel"><ChannelSelect value={c.community.milestones.channelId} onChange={(v) => cfg.update("community", { milestones: { ...c.community.milestones, channelId: v } })} /></Field><Field label="Message"><Textarea value={c.community.milestones.message} onChange={(e) => cfg.update("community", { milestones: { ...c.community.milestones, message: e.target.value } })} /></Field></div>
        </Card>
      </div>
      <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
    </div>
  );
}

const blankMenu = (): Menu => ({ name: "Notification roles", channelId: null, style: "buttons", mode: "toggle", embed: { title: "🔔 Pick your roles", description: "Click a button to toggle a role.", color: "#DC143C" }, options: [], requiredRoleIds: [] });

function Menus() {
  const { guildId } = useGuild();
  const names = useNames();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<Menu[]>(`/api/guilds/${guildId}/role-menus`);
  const [edit, setEdit] = useState<Menu | null>(null);
  async function save(publish: boolean) {
    if (!edit) return;
    try { const { id, messageId, ...body } = edit; void messageId; const row = await api<Menu>(id ? `/api/guilds/${guildId}/role-menus/${id}` : `/api/guilds/${guildId}/role-menus`, { method: id ? "PATCH" : "POST", body }); if (publish) await api(`/api/guilds/${guildId}/role-menus/${row.id}/publish`, { body: {} }); toast(publish ? "Saved & published" : "Saved"); setEdit(null); void q.reload(); }
    catch (e) { toast((e as Error).message, true); }
  }
  return (
    <>
      <div className="row mb" style={{ justifyContent: "flex-end" }}><Button variant="primary" icon={<I.plus />} onClick={() => setEdit(blankMenu())}>New role menu</Button></div>
      {!q.data ? <Skeleton h={160} /> : !q.data.length ? <Card><Empty title="No role menus">Create reaction roles, button menus or dropdowns for self-assignable roles.</Empty></Card> : <div className="grid g2">{q.data.map((m) => <Card key={m.id} title={m.name} subtitle={`${names.channel(m.channelId)} · ${m.style} · ${m.mode}`} actions={m.messageId ? <Chip tone="ok">published</Chip> : <Chip tone="warn">draft</Chip>}>
        <div className="row wrap">{m.options.map((o) => <Chip key={o.roleId}>{o.emoji} {o.label}</Chip>)}</div>
        <div className="row mt"><Button size="sm" icon={<I.edit />} onClick={() => setEdit(m)}>Edit</Button><Button size="sm" icon={<I.send />} onClick={async () => { try { await api(`/api/guilds/${guildId}/role-menus/${m.id}/publish`, { body: {} }); toast("Published"); void q.reload(); } catch (e) { toast((e as Error).message, true); } }}>Publish</Button><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: "Delete role menu?", body: "Buttons on the published message will stop working.", danger: true })) { await api(`/api/guilds/${guildId}/role-menus/${m.id}`, { method: "DELETE" }); void q.reload(); } }} /></div>
      </Card>)}</div>}
      <Modal open={!!edit} onClose={() => setEdit(null)} wide title="Role menu" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save(false)} disabled={!edit?.options.length}>Save</Button><Button variant="primary" onClick={() => save(true)} disabled={!edit?.channelId || !edit?.options.length}>Save & publish</Button></>}>
        {edit && <div className="stack">
          <div className="grid g2"><Field label="Name"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Channel"><ChannelSelect value={edit.channelId} onChange={(v) => setEdit({ ...edit, channelId: v })} /></Field></div>
          <div className="grid g3"><Field label="Style"><Select value={edit.style} onChange={(v) => setEdit({ ...edit, style: v as Menu["style"] })} options={[{ value: "buttons", label: "Buttons" }, { value: "select", label: "Dropdown" }, { value: "reactions", label: "Reactions" }]} /></Field><Field label="Mode"><Select value={edit.mode} onChange={(v) => setEdit({ ...edit, mode: v as Menu["mode"] })} options={[{ value: "toggle", label: "Toggle" }, { value: "unique", label: "Only one" }, { value: "add-only", label: "Add only" }, { value: "remove-only", label: "Remove only" }]} /></Field><Field label="Required roles" hint="Who may use it"><RoleMulti value={edit.requiredRoleIds} onChange={(v) => setEdit({ ...edit, requiredRoleIds: v })} /></Field></div>
          <MessageEditor value={{ embed: edit.embed }} onChange={(m) => setEdit({ ...edit, embed: m.embed ?? {} })} allowContent={false} />
          <div className="row between"><div className="field-label">Roles</div><Button size="sm" icon={<I.plus />} onClick={() => setEdit({ ...edit, options: [...edit.options, { roleId: "", label: "Role" }] })}>Add role</Button></div>
          {edit.options.map((o, i) => <div key={i} className="grid" style={{ gridTemplateColumns: "80px 1fr 1fr 1.2fr auto", alignItems: "center" }}>
            <Input placeholder="Emoji" value={o.emoji ?? ""} onChange={(e) => setEdit({ ...edit, options: edit.options.map((x, j) => (j === i ? { ...x, emoji: e.target.value || undefined } : x)) })} />
            <RoleSelect value={o.roleId} onChange={(v) => setEdit({ ...edit, options: edit.options.map((x, j) => (j === i ? { ...x, roleId: v ?? "" } : x)) })} />
            <Input placeholder="Label" value={o.label} onChange={(e) => setEdit({ ...edit, options: edit.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
            <Input placeholder="Description" value={o.description ?? ""} onChange={(e) => setEdit({ ...edit, options: edit.options.map((x, j) => (j === i ? { ...x, description: e.target.value || undefined } : x)) })} />
            <Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setEdit({ ...edit, options: edit.options.filter((_, j) => j !== i) })} />
          </div>)}
        </div>}
      </Modal>
    </>
  );
}

function Runs() {
  const { guildId } = useGuild();
  const q = useApi<{ rows: Auto[]; runs: Run[] }>(`/api/guilds/${guildId}/automations`, { refreshMs: 15_000 });
  const name = (id: string) => q.data?.rows.find((a) => a.id === id)?.name ?? "deleted";
  return <Card>{!q.data ? <Skeleton h={200} /> : !q.data.runs.length ? <Empty title="No runs yet" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Automation</th><th>Status</th><th>Trigger</th><th>Duration</th><th>Error</th><th>When</th></tr></thead><tbody>{q.data.runs.map((r) => <tr key={r.id}><td>{name(r.automationId)}</td><td><Chip tone={r.status === "success" ? "ok" : r.status === "failed" ? "crim" : undefined}>{r.status}</Chip></td><td className="small">{r.trigger}</td><td className="small mono">{r.durationMs}ms</td><td className="small faint">{r.error ?? "—"}</td><td className="small faint nowrap">{timeAgo(r.createdAt)}</td></tr>)}</tbody></table></div>}</Card>;
}
