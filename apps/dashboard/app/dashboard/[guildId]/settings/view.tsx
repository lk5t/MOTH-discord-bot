"use client";
import { useState } from "react";
import { ACHIEVEMENTS } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtDate, timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, NumberInput, PageHead, Progress, SaveBar, Select, Skeleton, Tabs, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleMulti, RoleSelect, useNames } from "@/components/pickers";
import { I } from "@/components/icons";

export function SettingsView() {
  const [tab, setTab] = useState<"general" | "community" | "backups" | "members" | "access" | "history">("general");
  return (
    <>
      <PageHead title="Server Settings" description="Complete configuration management, backups, dashboard access and change history." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "general", label: "General & logging" }, { value: "community", label: "Community features" }, { value: "backups", label: "Backups" }, { value: "members", label: "Member backup" }, { value: "access", label: "Dashboard access" }, { value: "history", label: "Change history" }]} />
      {tab === "general" && <General />}{tab === "community" && <Community />}{tab === "backups" && <Backups />}{tab === "members" && <MemberBackup />}{tab === "access" && <Access />}{tab === "history" && <History />}
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

type PullStatus = { running: boolean; sourceGuildId: string; total: number; added: number; already: number; failed: number; revoked: number; startedAt: string; finishedAt?: string; error?: string };
type MB = { here: { total: number; active: number }; canPull: boolean; sources: { id: string; name: string; active: boolean; total: number; restorable: number; last: string | null }[]; status: PullStatus | null };
function MemberBackup() {
  const { guildId, level } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const cfg = useGuildConfig();
  const q = useApi<MB>(`/api/guilds/${guildId}/member-backup`, { refreshMs: 5_000 });
  const [busy, setBusy] = useState(false);
  const oauth = cfg.config?.verification.enabled && cfg.config.verification.mode === "oauth";
  async function pull(src: MB["sources"][number]) {
    if (!(await confirm({ title: `Restore members from ${src.name}?`, confirm: "Start restore", body: <>MOTH will add up to <b>{src.restorable}</b> backed-up members to <b>this</b> server{src.id === guildId ? " (members who are already here are skipped)" : ""}. They get the verified role here automatically. This can take a while — about 4 members per second.</> }))) return;
    setBusy(true);
    try { await api(`/api/guilds/${guildId}/member-backup/pull`, { body: { sourceGuildId: src.id } }); toast("Restore started"); void q.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const st = q.data?.status;
  return <><PullByInvite sources={q.data?.sources ?? []} canPull={!!q.data?.canPull} />
  <div className="grid g2">
    <Card accent title="Member backup" subtitle="When members verify with Discord sign-in they allow MOTH to “join servers for you”. If this server is ever nuked, deleted or you move, you can pull them into the new server in one click.">
      {!q.data ? <Skeleton h={120} /> : <div className="stack">
        <div className="row between"><span className="muted">Members backed up here</span><b style={{ fontSize: 22 }}>{q.data.here.active.toLocaleString()}</b></div>
        {q.data.here.total > q.data.here.active && <div className="small faint">{q.data.here.total - q.data.here.active} member(s) removed MOTH's access and can't be restored.</div>}
        {!oauth ? <div className="small" style={{ color: "#f59e0b" }}>Backups only happen when verification mode is <b>Verify with Discord</b>. Turn it on under Security → Verification (or Quick Setup → Verification gate), then re-post the verification panel.</div>
          : <div className="small" style={{ color: "var(--ok)" }}>✓ Verify with Discord is on — every new verification is backed up.</div>}
        <div className="small faint">Members can withdraw at any time in Discord → User Settings → Authorized Apps. Keep your MOTH server online and your <code>.env</code> backed up — the backup lives in MOTH&apos;s database.</div>
        {level === "owner" && q.data.here.total > 0 && <div><Button size="sm" variant="ghost" icon={<I.trash />} onClick={async () => { if (await confirm({ title: "Delete all member backups for this server?", danger: true, confirm: "Delete", body: "You won't be able to restore these members later." })) { await api(`/api/guilds/${guildId}/member-backup`, { method: "DELETE" }); void q.reload(); } }}>Delete backups</Button></div>}
      </div>}
    </Card>
    <Card title="Restore members into this server" subtitle="Pick the server whose members you want to bring here. Servers you own are listed — even ones that were deleted.">
      {!q.data ? <Skeleton h={120} /> : <>
        {st && <div className="card flat mb"><div className="row between"><b>{st.running ? "Restoring…" : st.error ? "Restore stopped" : "Last restore"}</b><span className="small faint">{timeAgo(st.finishedAt ?? st.startedAt)}</span></div>
          <div className="row wrap mt"><Chip tone="ok">{st.added} added</Chip><Chip>{st.already} already here</Chip>{!!st.revoked && <Chip tone="warn">{st.revoked} revoked</Chip>}{!!st.failed && <Chip tone="crim">{st.failed} failed</Chip>}<span className="small faint">of {st.total}</span></div>
          {st.error && <div className="small mt" style={{ color: "#ff6b85" }}>{st.error}</div>}</div>}
        {!q.data.canPull ? <Empty title="Only the server owner can restore members" /> : !q.data.sources.filter((x) => x.total > 0).length ? <Empty title="No backed-up members yet">Members appear here after they verify with Discord sign-in.</Empty>
          : q.data.sources.filter((x) => x.total > 0).map((src) => <div key={src.id} className="list-item">
            <div className="grow"><div><b>{src.name}</b> {src.id === guildId ? <Chip tone="info">this server</Chip> : !src.active ? <Chip tone="crim">gone</Chip> : null}</div><div className="small faint">{src.restorable.toLocaleString()} restorable members</div></div>
            <Button size="sm" variant="primary" loading={busy} disabled={!!st?.running} onClick={() => pull(src)}>Restore here</Button>
          </div>)}
      </>}
    </Card>
  </div></>;
}

type Resolved = { guild: { id: string; name: string; iconUrl: string | null; memberCount: number | null }; botPresent: boolean; canManage: boolean; addBotUrl: string };
function PullByInvite({ sources, canPull }: { sources: MB["sources"]; canPull: boolean }) {
  const { guildId } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const [invite, setInvite] = useState("");
  const [found, setFound] = useState<Resolved | null>(null);
  const [source, setSource] = useState<string>("");
  const [busy, setBusy] = useState<"look" | "pull" | null>(null);
  const restorable = sources.filter((x) => x.restorable > 0);
  const src = restorable.find((x) => x.id === source) ?? restorable[0];
  const status = useApi<{ status: PullStatus | null }>(found?.botPresent && found.canManage ? `/api/guilds/${guildId}/member-backup/pull-status?target=${found.guild.id}` : null, { refreshMs: 3_000 });
  async function lookUp() {
    setBusy("look");
    try { setFound(await api<Resolved>(`/api/guilds/${guildId}/member-backup/resolve-invite`, { body: { invite } })); }
    catch (e) { setFound(null); toast((e as Error).message, true); } finally { setBusy(null); }
  }
  async function pull() {
    if (!found || !src) return;
    if (!(await confirm({ title: `Pull members into ${found.guild.name}?`, confirm: "Pull members", body: <>MOTH adds up to <b>{src.restorable.toLocaleString()}</b> members backed up from <b>{src.name}</b> to <b>{found.guild.name}</b>. Members already there are skipped. It runs in the background at about 4 members per second.</> }))) return;
    setBusy("pull");
    try { await api(`/api/guilds/${guildId}/member-backup/pull-to`, { body: { targetGuildId: found.guild.id, sourceGuildId: src.id } }); toast("Pull started"); void status.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  }
  const st = status.data?.status;
  const pct = st && st.total ? Math.round(((st.added + st.already + st.failed + st.revoked) / st.total) * 100) : 0;
  return <Card accent className="mb" title="Pull members into a server" subtitle="Paste an invite link to any server — a brand-new one after a nuke, or this one — and MOTH brings your backed-up members there.">
    {!canPull ? <Empty title="Only the server owner can pull members" /> : !restorable.length ? <Empty title="No backed-up members yet">Turn on Verify with Discord (Security → Verification) — members are backed up as they verify.</Empty> : <div className="stack">
      <div className="row wrap"><div className="grow" style={{ minWidth: 240 }}><Input placeholder="https://discord.gg/your-invite" value={invite} onChange={(e) => { setInvite(e.target.value); setFound(null); }} onKeyDown={(e) => e.key === "Enter" && invite.trim() && lookUp()} /></div>
        <Button onClick={lookUp} loading={busy === "look"} disabled={!invite.trim()}>Find server</Button></div>
      {found && <div className="card flat">
        <div className="row">
          {found.guild.iconUrl ? <img src={found.guild.iconUrl} alt="" width={40} height={40} style={{ borderRadius: 10 }} /> : <div className="brand-mark" style={{ width: 40, height: 40 }} />}
          <div className="grow"><b>{found.guild.name}</b><div className="small faint">{found.guild.memberCount != null ? `${found.guild.memberCount.toLocaleString()} members` : ""}</div></div>
          {found.botPresent ? <Chip tone="ok">MOTH is here</Chip> : <Chip tone="warn">MOTH not added yet</Chip>}
        </div>
        {!found.botPresent ? <div className="row mt wrap"><span className="small muted grow">Step 1: add MOTH to {found.guild.name} (it needs to be in the server to pull members in).</span>
          <a className="btn primary sm" href={found.addBotUrl} target="_blank" rel="noreferrer">Add MOTH to {found.guild.name}</a><Button size="sm" onClick={lookUp} loading={busy === "look"}>I've added it — check again</Button></div>
        : !found.canManage ? <div className="small mt" style={{ color: "#f59e0b" }}>You need Manage Server in {found.guild.name} to pull members into it.</div>
        : <div className="stack mt">
          <div className="row wrap"><span className="small muted">Pull members backed up from</span>
            <select className="select" style={{ width: "auto" }} value={src?.id ?? ""} onChange={(e) => setSource(e.target.value)}>{restorable.map((x) => <option key={x.id} value={x.id}>{x.name}{!x.active ? " (gone)" : ""} — {x.restorable.toLocaleString()} members</option>)}</select>
            <Button variant="primary" onClick={pull} loading={busy === "pull"} disabled={!!st?.running}>Pull members</Button></div>
          {st && <div>
            <div className="row between small"><b>{st.running ? "Pulling members…" : st.error ? "Stopped" : "Finished"}</b><span className="faint">{st.running ? `${pct}%` : timeAgo(st.finishedAt ?? st.startedAt)}</span></div>
            <div className="mt"><Progress value={st.running ? pct : 100} /></div>
            <div className="row wrap mt"><Chip tone="ok">{st.added} added</Chip><Chip>{st.already} already there</Chip>{!!st.revoked && <Chip tone="warn">{st.revoked} withdrew access</Chip>}{!!st.failed && <Chip tone="crim">{st.failed} failed</Chip>}<span className="small faint">of {st.total}</span></div>
            {st.error && <div className="small mt" style={{ color: "#ff6b85" }}>{st.error}</div>}
          </div>}
        </div>}
      </div>}
    </div>}
  </Card>;
}
