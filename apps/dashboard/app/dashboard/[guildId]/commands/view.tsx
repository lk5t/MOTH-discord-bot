"use client";
import { useRef, useState } from "react";
import type { AutomationAction, CustomCommandDefinition, MessageTemplate } from "@moth/core/shared";
import { useGuild } from "@/components/guild";
import { api, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, Select, Skeleton, Switch, Tabs, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, RoleMulti, RoleSelect } from "@/components/pickers";
import { DiscordPreview, MessageEditor } from "@/components/embed-editor";
import { ActionForm } from "../automation/builder";
import { I } from "@/components/icons";

type Cmd = { id?: string; name: string; enabled: boolean; uses?: number; definition: CustomCommandDefinition };
const blank = (): Cmd => ({ name: "hello", enabled: true, definition: { type: "slash", description: "Say hello", options: [], trigger: { match: "exact", pattern: "", caseSensitive: false, channelIds: [] }, response: { content: "Hello {user}! 👋" }, ephemeral: false, branches: [], actions: [], allowedRoleIds: [], deniedRoleIds: [], allowedChannelIds: [], cooldownSeconds: 0, deleteTrigger: false } });

export function CommandsView() {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<{ rows: Cmd[]; reserved: string[] }>(`/api/guilds/${guildId}/commands`);
  const [edit, setEdit] = useState<Cmd | null>(null);
  const [prompt, setPrompt] = useState(""); const [gen, setGen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  async function generate() {
    setGen(true);
    try { const r = await api<{ name: string; definition: CustomCommandDefinition }>(`/api/guilds/${guildId}/commands/generate`, { body: { prompt } }); setEdit({ ...r, enabled: true }); setPrompt(""); }
    catch (e) { toast((e as Error).message, true); } finally { setGen(false); }
  }
  async function exportAll() {
    const data = await api(`/api/guilds/${guildId}/commands/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "moth-commands.json" }).click();
    URL.revokeObjectURL(url);
  }
  async function importFile(f: File) {
    try {
      const data = JSON.parse(await f.text());
      const overwrite = await confirm({ title: "Overwrite existing commands?", body: "Commands with the same name will be replaced. Choose Cancel to only add new ones.", confirm: "Overwrite" });
      const r = await api<{ imported: number; skipped: number }>(`/api/guilds/${guildId}/commands/import`, { body: { data, overwrite } });
      toast(`Imported ${r.imported}, skipped ${r.skipped}`); void q.reload();
    } catch (e) { toast(`Import failed: ${(e as Error).message}`, true); }
  }
  return (
    <>
      <PageHead title="Commands" description="Custom slash commands and trigger responses with embeds, variables, conditions, permissions and cooldowns."
        actions={<><Button icon={<I.upload />} onClick={() => file.current?.click()}>Import</Button><Button icon={<I.download />} onClick={exportAll}>Export</Button><Button icon={<I.refresh />} onClick={async () => { try { const r = await api<{ registered: number }>(`/api/guilds/${guildId}/commands/sync`, { body: {} }); toast(`Registered ${r.registered} commands with Discord`); } catch (e) { toast((e as Error).message, true); } }}>Sync to Discord</Button><Button variant="primary" icon={<I.plus />} onClick={() => setEdit(blank())}>New command</Button></>} />
      <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
      <Card accent title="Create with AI" subtitle="e.g. “a /coinflip command that randomly says heads or tails” or “reply with the server IP when someone says ‘ip’”" className="mb">
        <div className="row"><Input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the command…" onKeyDown={(e) => e.key === "Enter" && prompt.length > 3 && generate()} /><Button variant="primary" loading={gen} disabled={prompt.length < 4} onClick={generate} icon={<I.sparkles />}>Generate</Button></div>
      </Card>
      {!q.data ? <Skeleton h={200} /> : !q.data.rows.length ? <Card><Empty icon={<I.commands />} title="No custom commands yet" /></Card> : (
        <Card><div className="table-wrap"><table className="t"><thead><tr><th>Command</th><th>Type</th><th>Description</th><th>Uses</th><th>Enabled</th><th /></tr></thead><tbody>
          {q.data.rows.map((c) => <tr key={c.id}>
            <td className="mono">{c.definition.type === "slash" ? `/${c.name}` : c.name}</td><td><Chip tone={c.definition.type === "slash" ? "crim" : "info"}>{c.definition.type}</Chip></td>
            <td className="small muted">{c.definition.type === "slash" ? c.definition.description : `${c.definition.trigger.match}: “${c.definition.trigger.pattern}”`}</td><td className="mono small">{c.uses ?? 0}</td>
            <td><Switch checked={c.enabled} onChange={async (v) => { await api(`/api/guilds/${guildId}/commands/${c.id}`, { method: "PATCH", body: { enabled: v } }); void q.reload(); }} /></td>
            <td className="right nowrap"><Button size="sm" variant="ghost" icon={<I.edit />} onClick={() => setEdit(c)} /><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: `Delete ${c.name}?`, body: "It will be removed from Discord within a few seconds.", danger: true, confirm: "Delete" })) { await api(`/api/guilds/${guildId}/commands/${c.id}`, { method: "DELETE" }); void q.reload(); } }} /></td>
          </tr>)}
        </tbody></table></div></Card>
      )}
      {edit && <Editor cmd={edit} reserved={q.data?.reserved ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void q.reload(); }} />}
    </>
  );
}

function Editor({ cmd, reserved, onClose, onSaved }: { cmd: Cmd; reserved: string[]; onClose: () => void; onSaved: () => void }) {
  const { guildId } = useGuild();
  const toast = useToast();
  const [c, setC] = useState(cmd);
  const [tab, setTab] = useState<"response" | "options" | "logic" | "access" | "test">("response");
  const [saving, setSaving] = useState(false);
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<MessageTemplate | null>(null);
  const d = c.definition;
  const set = (p: Partial<CustomCommandDefinition>) => setC({ ...c, definition: { ...d, ...p } });
  const nameErr = !/^[a-z0-9_-]{1,32}$/.test(c.name) ? "Lowercase letters, numbers, - and _ (max 32)" : reserved.includes(c.name) && d.type === "slash" ? `/${c.name} is a built-in MOTH command` : null;
  async function save() {
    setSaving(true);
    try { await api(c.id ? `/api/guilds/${guildId}/commands/${c.id}` : `/api/guilds/${guildId}/commands`, { method: c.id ? "PATCH" : "POST", body: { name: c.name, enabled: c.enabled, definition: d } }); toast("Saved — Discord updates within seconds"); onSaved(); }
    catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  }
  async function runTest() {
    try { setPreview(await api<MessageTemplate>(`/api/guilds/${guildId}/preview/message`, { body: { message: d.response, args: testArgs } })); } catch (e) { toast((e as Error).message, true); }
  }
  return (
    <Modal open onClose={onClose} wide title={c.id ? `Edit ${c.name}` : "New command"} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={!!nameErr} icon={<I.check />}>Save</Button></>}>
      <div className="grid g3">
        <Field label="Type"><Select value={d.type} onChange={(v) => set({ type: v as "slash" })} options={[{ value: "slash", label: "Slash command" }, { value: "trigger", label: "Message trigger" }]} /></Field>
        <Field label={d.type === "slash" ? "Name (/name)" : "Name (internal)"} hint={nameErr ?? undefined}><Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value.toLowerCase().replace(/\s+/g, "-") })} /></Field>
        {d.type === "slash" ? <Field label="Description"><Input value={d.description} maxLength={100} onChange={(e) => set({ description: e.target.value })} /></Field>
          : <div className="grid g2"><Field label="Match"><Select value={d.trigger.match} onChange={(v) => set({ trigger: { ...d.trigger, match: v as "exact" } })} options={[{ value: "exact", label: "Exact" }, { value: "contains", label: "Contains" }, { value: "starts_with", label: "Starts with" }, { value: "regex", label: "Regex" }]} /></Field><Field label="Pattern"><Input value={d.trigger.pattern} onChange={(e) => set({ trigger: { ...d.trigger, pattern: e.target.value } })} /></Field></div>}
      </div>
      <div className="mt"><Tabs value={tab} onChange={setTab} tabs={[{ value: "response", label: "Response" }, ...(d.type === "slash" ? [{ value: "options" as const, label: `Options (${d.options.length})` }] : []), { value: "logic", label: "Conditions & actions" }, { value: "access", label: "Permissions & cooldown" }, { value: "test", label: "Test" }]} /></div>
      {tab === "response" && <><MessageEditor value={d.response} onChange={(m) => set({ response: m })} />{d.type === "slash" && <ToggleRow title="Only visible to the user (ephemeral)" checked={d.ephemeral} onChange={(v) => set({ ephemeral: v })} />}{d.type === "trigger" && <><ToggleRow title="Delete the triggering message" checked={d.deleteTrigger} onChange={(v) => set({ deleteTrigger: v })} /><ToggleRow title="Case sensitive" checked={d.trigger.caseSensitive} onChange={(v) => set({ trigger: { ...d.trigger, caseSensitive: v } })} /><Field label="Only in channels"><ChannelMulti value={d.trigger.channelIds} onChange={(v) => set({ trigger: { ...d.trigger, channelIds: v } })} /></Field></>}</>}
      {tab === "options" && <div className="stack">
        <div className="small faint">Use option values in responses with <code>{"{args.name}"}</code>.</div>
        {d.options.map((o, i) => <div key={i} className="grid" style={{ gridTemplateColumns: "1fr 1.4fr 130px auto auto", alignItems: "center" }}>
          <Input value={o.name} placeholder="name" onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") } : x)) })} />
          <Input value={o.description} placeholder="Description" onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })} />
          <Select value={o.type} onChange={(v) => set({ options: d.options.map((x, j) => (j === i ? { ...x, type: v as "string" } : x)) })} options={["string", "integer", "number", "boolean", "user", "channel", "role"].map((t) => ({ value: t, label: t }))} />
          <label className="row small faint"><input type="checkbox" checked={o.required} onChange={(e) => set({ options: d.options.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)) })} />required</label>
          <Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => set({ options: d.options.filter((_, j) => j !== i) })} />
        </div>)}
        <div><Button size="sm" icon={<I.plus />} disabled={d.options.length >= 10} onClick={() => set({ options: [...d.options, { name: `option${d.options.length + 1}`, description: "An option", type: "string", required: false }] })}>Add option</Button></div>
      </div>}
      {tab === "logic" && <div className="stack">
        <div className="field-label">Conditional responses</div><div className="small faint">The first branch whose conditions all pass replaces the default response.</div>
        {d.branches.map((b, i) => <Card key={i} className="flat">
          <div className="row between mb"><b className="small">Branch {i + 1}</b><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => set({ branches: d.branches.filter((_, j) => j !== i) })} /></div>
          {b.conditions.map((cond, k) => <div key={k} className="row mb">
            <Select value={cond.type} onChange={(v) => set({ branches: d.branches.map((x, j) => (j === i ? { ...x, conditions: x.conditions.map((y, m) => (m === k ? (v === "chance" ? { type: "chance", percent: 50 } : { type: v as "has_role", roleId: "" }) : y)) } : x)) })} options={[{ value: "has_role", label: "User has role" }, { value: "missing_role", label: "User lacks role" }, { value: "chance", label: "Random chance" }]} />
            {cond.type === "chance" ? <NumberInput value={cond.percent} min={0} max={100} onChange={(v) => set({ branches: d.branches.map((x, j) => (j === i ? { ...x, conditions: x.conditions.map((y, m) => (m === k ? { ...cond, percent: v } : y)) } : x)) })} />
              : "roleId" in cond && <RoleSelect value={cond.roleId} onChange={(v) => set({ branches: d.branches.map((x, j) => (j === i ? { ...x, conditions: x.conditions.map((y, m) => (m === k ? { ...cond, roleId: v ?? "" } : y)) } : x)) })} />}
          </div>)}
          <MessageEditor value={b.response} onChange={(m) => set({ branches: d.branches.map((x, j) => (j === i ? { ...x, response: m } : x)) })} />
        </Card>)}
        <div><Button size="sm" icon={<I.plus />} onClick={() => set({ branches: [...d.branches, { conditions: [{ type: "has_role", roleId: "" }], response: { content: "Hi VIP {user}!" } }] })}>Add branch</Button></div>
        <div className="divider" /><div className="field-label">Actions after responding</div>
        {d.actions.map((a, i) => <Card key={i} className="flat"><div className="row between mb"><b className="small">Action {i + 1}</b><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })} /></div><ActionForm a={a} set={(na: AutomationAction) => set({ actions: d.actions.map((x, j) => (j === i ? na : x)) })} /></Card>)}
        <div><Button size="sm" icon={<I.plus />} disabled={d.actions.length >= 10} onClick={() => set({ actions: [...d.actions, { type: "add_role", roleId: "" }] })}>Add action</Button></div>
      </div>}
      {tab === "access" && <div className="grid g2">
        <Field label="Allowed roles" hint="Empty = everyone"><RoleMulti value={d.allowedRoleIds} onChange={(v) => set({ allowedRoleIds: v })} /></Field>
        <Field label="Denied roles"><RoleMulti value={d.deniedRoleIds} onChange={(v) => set({ deniedRoleIds: v })} /></Field>
        <Field label="Allowed channels" hint="Empty = all channels"><ChannelMulti value={d.allowedChannelIds} onChange={(v) => set({ allowedChannelIds: v })} /></Field>
        <Field label="Cooldown per user (seconds)"><NumberInput value={d.cooldownSeconds} min={0} max={86400} onChange={(v) => set({ cooldownSeconds: v })} /></Field>
        <ToggleRow title="Enabled" checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} />
      </div>}
      {tab === "test" && <div className="stack">
        <div className="small faint">Renders the default response with you as the user and sample values. Conditional branches and actions run only in Discord.</div>
        {d.options.map((o) => <Field key={o.name} label={`args.${o.name}`}><Input value={testArgs[o.name] ?? ""} onChange={(e) => setTestArgs({ ...testArgs, [o.name]: e.target.value })} /></Field>)}
        <div><Button onClick={runTest} icon={<I.play />}>Run test</Button></div>
        {preview && <DiscordPreview message={preview} />}
      </div>}
    </Modal>
  );
}
