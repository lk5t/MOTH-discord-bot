"use client";
import { useState } from "react";
import { ACHIEVEMENTS } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtDate, timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, NumberInput, PageHead, SaveBar, Select, Skeleton, Tabs, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleMulti, RoleSelect, useNames } from "@/components/pickers";
import { I } from "@/components/icons";

export function SettingsView() {
  const [tab, setTab] = useState<"general" | "community" | "backups" | "access" | "history">("general");
  return (
    <>
      <PageHead title="Server Settings" description="Complete configuration management, backups, dashboard access and change history." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "general", label: "General & logging" }, { value: "community", label: "Community features" }, { value: "backups", label: "Backups" }, { value: "access", label: "Dashboard access" }, { value: "history", label: "Change history" }]} />
      {tab === "general" && <General />}{tab === "community" && <Community />}{tab === "backups" && <Backups />}{tab === "access" && <Access />}{tab === "history" && <History />}
    </>
  );
}

function General() {
  const cfg = useGuildConfig();
  if (!cfg.config) return <Skeleton h={300} />;
  const g = cfg.config.general;
  return <>
    <div className="grid g2">
      <Card title="General">
        <div className="stack"><Field label="Accent colour" hint="Used for MOTH embeds"><Input type="color" value={g.accentColor} onChange={(e) => cfg.update("general", { accentColor: e.target.value })} style={{ height: 40, padding: 4 }} /></Field>
          <Field label="Timezone" hint="IANA name, e.g. Europe/London"><Input value={g.timezone} onChange={(e) => cfg.update("general", { timezone: e.target.value })} /></Field>
          <Field label="Language"><Select value={g.locale} onChange={(v) => cfg.update("general", { locale: v })} options={[{ value: "en", label: "English" }]} /></Field></div>
      </Card>
      <Card title="Log channels">
        <div className="stack"><Field label="General log"><ChannelSelect value={g.logChannelId} onChange={(v) => cfg.update("general", { logChannelId: v })} /></Field>
          <Field label="Moderation log"><ChannelSelect value={g.modLogChannelId} onChange={(v) => cfg.update("general", { modLogChannelId: v })} /></Field>
          <Field label="Security log"><ChannelSelect value={g.securityLogChannelId} onChange={(v) => cfg.update("general", { securityLogChannelId: v })} /></Field></div>
      </Card>
      <Card title="Backups"><ToggleRow title="Automatic daily backups" checked={cfg.config.backups.autoDaily} onChange={(v) => cfg.update("backups", { autoDaily: v })} /><Field label="Keep automatic backups" className="mt"><NumberInput value={cfg.config.backups.keep} min={1} max={100} onChange={(v) => cfg.update("backups", { keep: v })} /></Field></Card>
    </div>
    <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
  </>;
}

function Community() {
  const cfg = useGuildConfig();
  if (!cfg.config) return <Skeleton h={300} />;
  const { leveling: lv, economy: eco, achievements: ach, community: com } = cfg.config;
  const setLv = (p: Partial<typeof lv>) => cfg.update("leveling", p);
  const setEco = (p: Partial<typeof eco>) => cfg.update("economy", p);
  return <>
    <div className="grid g2">
      <Card title="XP & leveling" actions={<Chip tone={lv.enabled ? "ok" : undefined}>{lv.enabled ? "on" : "off"}</Chip>}>
        <ToggleRow title="Enable leveling" checked={lv.enabled} onChange={(v) => setLv({ enabled: v })} />
        <div className="grid g3 mt"><Field label="Min XP"><NumberInput value={lv.xpMin} min={0} max={1000} onChange={(v) => setLv({ xpMin: v })} /></Field><Field label="Max XP"><NumberInput value={lv.xpMax} min={0} max={1000} onChange={(v) => setLv({ xpMax: v })} /></Field><Field label="Cooldown (s)"><NumberInput value={lv.cooldownSeconds} min={0} max={3600} onChange={(v) => setLv({ cooldownSeconds: v })} /></Field></div>
        <div className="grid g2 mt"><Field label="Voice XP / minute"><NumberInput value={lv.voiceXpPerMinute} min={0} max={100} onChange={(v) => setLv({ voiceXpPerMinute: v })} /></Field>
          <Field label="Announce level-ups"><Select value={lv.announce} onChange={(v) => setLv({ announce: v as "off" })} options={[{ value: "off", label: "Off" }, { value: "same-channel", label: "Same channel" }, { value: "channel", label: "Specific channel" }, { value: "dm", label: "DM" }]} /></Field></div>
        {lv.announce === "channel" && <Field label="Announcement channel" className="mt"><ChannelSelect value={lv.announceChannelId} onChange={(v) => setLv({ announceChannelId: v })} /></Field>}
        <Field label="Level-up message" hint="{user} {level}" className="mt"><Input value={lv.announceMessage} onChange={(e) => setLv({ announceMessage: e.target.value })} /></Field>
        <div className="grid g2 mt"><Field label="No-XP channels"><ChannelMulti value={lv.noXpChannelIds} onChange={(v) => setLv({ noXpChannelIds: v })} /></Field><Field label="No-XP roles"><RoleMulti value={lv.noXpRoleIds} onChange={(v) => setLv({ noXpRoleIds: v })} /></Field></div>
        <div className="divider" />
        <div className="row between"><div className="field-label">Role rewards</div><Button size="sm" icon={<I.plus />} onClick={() => setLv({ rewards: [...lv.rewards, { level: 10, roleId: "" }] })}>Add</Button></div>
        {lv.rewards.map((r, i) => <div key={i} className="grid mt" style={{ gridTemplateColumns: "110px 1fr auto", alignItems: "center" }}><NumberInput value={r.level} min={1} max={1000} onChange={(v) => setLv({ rewards: lv.rewards.map((x, j) => (j === i ? { ...x, level: v } : x)) })} /><RoleSelect value={r.roleId} onChange={(v) => setLv({ rewards: lv.rewards.map((x, j) => (j === i ? { ...x, roleId: v ?? "" } : x)) })} /><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setLv({ rewards: lv.rewards.filter((_, j) => j !== i) })} /></div>)}
        <ToggleRow title="Keep earlier reward roles" checked={lv.stackRewards} onChange={(v) => setLv({ stackRewards: v })} />
        <div className="divider" />
        <div className="row between"><div className="field-label">XP multipliers</div><Button size="sm" icon={<I.plus />} onClick={() => setLv({ multipliers: [...lv.multipliers, { roleId: "", multiplier: 1.5 }] })}>Add</Button></div>
        {lv.multipliers.map((m, i) => <div key={i} className="grid mt" style={{ gridTemplateColumns: "1fr 110px auto", alignItems: "center" }}><RoleSelect value={m.roleId} onChange={(v) => setLv({ multipliers: lv.multipliers.map((x, j) => (j === i ? { ...x, roleId: v ?? "" } : x)) })} /><NumberInput value={m.multiplier} min={0} max={10} step={0.1} onChange={(v) => setLv({ multipliers: lv.multipliers.map((x, j) => (j === i ? { ...x, multiplier: v } : x)) })} /><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setLv({ multipliers: lv.multipliers.filter((_, j) => j !== i) })} /></div>)}
      </Card>
      <div className="stack" style={{ gap: 16 }}>
        <Card title="Economy & daily rewards">
          <ToggleRow title="Enable economy" checked={eco.enabled} onChange={(v) => setEco({ enabled: v })} />
          <div className="grid g2 mt"><Field label="Currency name"><Input value={eco.currencyName} onChange={(e) => setEco({ currencyName: e.target.value })} /></Field><Field label="Emoji"><Input value={eco.currencyEmoji} onChange={(e) => setEco({ currencyEmoji: e.target.value })} /></Field>
            <Field label="Daily reward"><NumberInput value={eco.dailyAmount} min={0} onChange={(v) => setEco({ dailyAmount: v })} /></Field><Field label="Streak bonus / day"><NumberInput value={eco.streakBonus} min={0} onChange={(v) => setEco({ streakBonus: v })} /></Field>
            <Field label="Max streak days"><NumberInput value={eco.maxStreakBonusDays} min={1} max={365} onChange={(v) => setEco({ maxStreakBonusDays: v })} /></Field><Field label="Per message"><NumberInput value={eco.messageReward} min={0} max={1000} onChange={(v) => setEco({ messageReward: v })} /></Field></div>
          <div className="divider" />
          <div className="row between"><div className="field-label">Shop items</div><Button size="sm" icon={<I.plus />} onClick={() => setEco({ shop: [...eco.shop, { id: `item${eco.shop.length + 1}`, name: "VIP role", price: 1000 }] })}>Add item</Button></div>
          {eco.shop.map((s, i) => <div key={i} className="grid mt" style={{ gridTemplateColumns: "90px 1fr 100px 1fr auto", alignItems: "center" }}><Input value={s.id} onChange={(e) => setEco({ shop: eco.shop.map((x, j) => (j === i ? { ...x, id: e.target.value.replace(/\s/g, "") } : x)) })} /><Input value={s.name} onChange={(e) => setEco({ shop: eco.shop.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} /><NumberInput value={s.price} min={0} onChange={(v) => setEco({ shop: eco.shop.map((x, j) => (j === i ? { ...x, price: v } : x)) })} /><RoleSelect value={s.roleId} onChange={(v) => setEco({ shop: eco.shop.map((x, j) => (j === i ? { ...x, roleId: v ?? undefined } : x)) })} placeholder="No role" /><Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => setEco({ shop: eco.shop.filter((_, j) => j !== i) })} /></div>)}
        </Card>
        <Card title="Achievements & badges">
          <ToggleRow title="Enable achievements" checked={ach.enabled} onChange={(v) => cfg.update("achievements", { enabled: v })} />
          <ToggleRow title="Announce unlocks" checked={ach.announce} onChange={(v) => cfg.update("achievements", { announce: v })} />
          <div className="row wrap mt">{ACHIEVEMENTS.map((a) => { const off = ach.disabledKeys.includes(a.key); return <button key={a.key} className={`chip ${off ? "" : "crim"}`} style={{ cursor: "pointer" }} title={a.description} onClick={() => cfg.update("achievements", { disabledKeys: off ? ach.disabledKeys.filter((k) => k !== a.key) : [...ach.disabledKeys, a.key] })}>{a.icon} {a.name}</button>; })}</div>
        </Card>
        <Card title="Giveaways & polls">
          <ToggleRow title="Giveaways" checked={com.giveawaysEnabled} onChange={(v) => cfg.update("community", { giveawaysEnabled: v })} />
          <ToggleRow title="Polls" checked={com.pollsEnabled} onChange={(v) => cfg.update("community", { pollsEnabled: v })} />
          <Field label="Giveaway manager roles" className="mt"><RoleMulti value={com.giveawayManagerRoleIds} onChange={(v) => cfg.update("community", { giveawayManagerRoleIds: v })} /></Field>
        </Card>
      </div>
    </div>
    <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
  </>;
}

type Backup = { id: string; label: string; kind: string; sizeBytes: number; createdAt: string };
function Backups() {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<Backup[]>(`/api/guilds/${guildId}/backups`);
  const [label, setLabel] = useState(""); const [busy, setBusy] = useState(false);
  async function create() { setBusy(true); try { await api(`/api/guilds/${guildId}/backups`, { body: { label: label || "Manual backup" } }); setLabel(""); toast("Backup created"); void q.reload(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } }
  async function restoreConfig(b: Backup) {
    if (!(await confirm({ title: "Restore MOTH configuration?", danger: true, confirm: "Restore", body: <>Settings, automations, custom commands, ticket panels and role menus will be replaced with the versions from <b>{b.label}</b>. A backup of the current state is taken first.</> }))) return;
    try { await api(`/api/guilds/${guildId}/backups/${b.id}/restore-config`, { body: {} }); toast("Configuration restored"); } catch (e) { toast((e as Error).message, true); }
  }
  async function restoreStructure(b: Backup) {
    try { await api(`/api/guilds/${guildId}/architect/from-backup`, { body: { backupId: b.id } }); toast("Restore plan created — review it in Architect"); window.location.href = `/dashboard/${guildId}/architect`; } catch (e) { toast((e as Error).message, true); }
  }
  return (
    <Card title="Backups" subtitle="Each backup captures roles, channels, permissions and the complete MOTH configuration." actions={<><Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} style={{ width: 200 }} /><Button variant="primary" loading={busy} onClick={create} icon={<I.plus />}>Back up now</Button></>}>
      {!q.data ? <Skeleton h={200} /> : !q.data.length ? <Empty title="No backups yet" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Label</th><th>Type</th><th>Size</th><th>Created</th><th /></tr></thead><tbody>
        {q.data.map((b) => <tr key={b.id}><td>{b.label}</td><td><Chip tone={b.kind === "manual" ? "crim" : b.kind === "pre-architect" ? "info" : undefined}>{b.kind}</Chip></td><td className="small mono">{(b.sizeBytes / 1024).toFixed(0)} KB</td><td className="small faint">{fmtDate(b.createdAt)}</td>
          <td className="right nowrap"><Button size="sm" onClick={() => restoreStructure(b)}>Restore structure…</Button> <Button size="sm" onClick={() => restoreConfig(b)}>Restore config</Button> <a className="btn sm ghost" href={`/api/guilds/${guildId}/backups/${b.id}`} title="Download"><I.download /></a> <Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: "Delete backup?", body: b.label, danger: true })) { await api(`/api/guilds/${guildId}/backups/${b.id}`, { method: "DELETE" }); void q.reload(); } }} /></td></tr>)}
      </tbody></table></div>}
    </Card>
  );
}

type Grant = { id: number; subjectType: "user" | "role"; subjectId: string; level: string; createdAt: string };
function Access() {
  const { guildId, level } = useGuild();
  const names = useNames();
  const toast = useToast();
  const cfg = useGuildConfig();
  const q = useApi<Grant[]>(`/api/guilds/${guildId}/access`);
  const [f, setF] = useState({ subjectType: "user" as "user" | "role", subjectId: "", level: "moderator" });
  async function add() { try { await api(`/api/guilds/${guildId}/access`, { body: f }); setF({ ...f, subjectId: "" }); void q.reload(); toast("Access granted"); } catch (e) { toast((e as Error).message, true); } }
  return <div className="grid g2">
    <Card title="Role-based access" subtitle="Members with Manage Server always have admin access. Grant dashboard access to other roles here.">
      {cfg.config && <div className="stack"><Field label="Moderator access (moderation, tickets, members, security log)"><RoleMulti value={cfg.config.dashboard.moderatorRoleIds} onChange={(v) => cfg.update("dashboard", { moderatorRoleIds: v })} /></Field><Field label="Viewer access (overview, analytics)"><RoleMulti value={cfg.config.dashboard.viewerRoleIds} onChange={(v) => cfg.update("dashboard", { viewerRoleIds: v })} /></Field></div>}
      {cfg.config && <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />}
    </Card>
    <Card title="Individual grants">
      <div className="grid" style={{ gridTemplateColumns: "100px 1fr 130px auto", alignItems: "end" }}>
        <Field label="Type"><Select value={f.subjectType} onChange={(v) => setF({ ...f, subjectType: v as "user", subjectId: "" })} options={[{ value: "user", label: "User" }, { value: "role", label: "Role" }]} /></Field>
        <Field label={f.subjectType === "user" ? "User ID" : "Role"}>{f.subjectType === "user" ? <Input value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value.trim() })} /> : <RoleSelect value={f.subjectId} onChange={(v) => setF({ ...f, subjectId: v ?? "" })} />}</Field>
        <Field label="Level"><Select value={f.level} onChange={(v) => setF({ ...f, level: v })} options={[...(level === "owner" ? [{ value: "admin", label: "Admin" }] : []), { value: "moderator", label: "Moderator" }, { value: "viewer", label: "Viewer" }]} /></Field>
        <Button variant="primary" onClick={add} disabled={!/^\d{15,22}$/.test(f.subjectId)}>Grant</Button>
      </div>
      <div className="mt">{!q.data?.length ? <Empty title="No individual grants" /> : q.data.map((g) => <div key={g.id} className="list-item"><Chip>{g.subjectType}</Chip><span className="grow mono small">{g.subjectType === "role" ? names.role(g.subjectId) : g.subjectId}</span><Chip tone="crim">{g.level}</Chip><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { await api(`/api/guilds/${guildId}/access/${g.id}`, { method: "DELETE" }); void q.reload(); }} /></div>)}</div>
    </Card>
  </div>;
}

type Change = { id: number; actorId: string | null; source: string; action: string; target: string | null; before: unknown; after: unknown; createdAt: string };
function History() {
  const { guildId } = useGuild();
  const q = useApi<Change[]>(`/api/guilds/${guildId}/changelog?limit=200`);
  const [open, setOpen] = useState<number | null>(null);
  return <Card title="Change history" subtitle="Every configuration change from Discord, the dashboard, the Architect and automated systems.">
    {!q.data ? <Skeleton h={300} /> : !q.data.length ? <Empty title="No changes recorded yet" /> : q.data.map((c) => <div key={c.id}>
      <div className="list-item" style={{ cursor: "pointer" }} onClick={() => setOpen(open === c.id ? null : c.id)}><Chip tone={c.source === "dashboard" ? "crim" : c.source === "architect" ? "info" : c.source === "discord" ? "ok" : undefined}>{c.source}</Chip><div className="grow small"><b>{c.action}</b> {c.target && <span className="faint">{c.target}</span>}</div><span className="small faint mono">{c.actorId ?? "system"}</span><span className="small faint nowrap">{timeAgo(c.createdAt)}</span></div>
      {open === c.id && (c.before != null || c.after != null) && <div className="grid g2" style={{ marginBottom: 12 }}><pre className="card flat small" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 300, overflow: "auto" }}>{JSON.stringify(c.before, null, 2) ?? "—"}</pre><pre className="card flat small" style={{ whiteSpace: "pre-wrap", margin: 0, maxHeight: 300, overflow: "auto" }}>{JSON.stringify(c.after, null, 2) ?? "—"}</pre></div>}
    </div>)}
  </Card>;
}
