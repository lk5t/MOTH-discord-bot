"use client";
import { useState } from "react";
import type { GuildConfig } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, fmtDate, timeAgo, useApi, useLive } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Modal, NumberInput, PageHead, SaveBar, Select, Seg, Skeleton, Tabs, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleMulti, RoleSelect } from "@/components/pickers";
import { BarList } from "@/components/charts";
import { I } from "@/components/icons";

type Ev = { id: number; type: string; severity: string; summary: string; userId: string | null; details: Record<string, unknown> | null; actionTaken: string | null; createdAt: string };
type SecData = { events: Ev[]; state: { raidMode: boolean; raidModeUntil: string | null; lockdown: boolean } | null; byType: { type: string; n: number }[] };

const SENS = [
  { value: "low", label: "Low", desc: "Very few interventions. Large join spikes only; suspicious accounts are only flagged." },
  { value: "medium", label: "Medium", desc: "Balanced defaults for most communities." },
  { value: "high", label: "High", desc: "Reacts to smaller spikes and flags more accounts. Good for public / partnered servers." },
  { value: "paranoid", label: "Paranoid", desc: "Maximum protection. Expect occasional false positives; review the security log." },
] as const;

export function SecurityView() {
  const { guildId, can } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const [tab, setTab] = useState<"status" | "protection" | "log">("status");
  const q = useApi<SecData>(`/api/guilds/${guildId}/security`);
  useLive(guildId, ["security.event"], () => void q.reload());
  const cfg = useGuildConfig();
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Ev | null>(null);

  async function lockdown(enable: boolean) {
    if (enable && !(await confirm({ title: "Lock down the server?", danger: true, confirm: "Lock down", body: "Every public channel will be locked (no sending, reacting, threads or voice). Exact permissions are saved and restored when you lift the lockdown." }))) return;
    setBusy(true);
    try { const r = await api<{ channels: number }>(`/api/guilds/${guildId}/security/lockdown`, { body: { enable } }); toast(enable ? `Locked ${r.channels} channels` : `Restored ${r.channels} channels`); void q.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  async function raid(enable: boolean) {
    setBusy(true);
    try { await api(`/api/guilds/${guildId}/security/raid-mode`, { body: { enable } }); toast(enable ? "Raid mode enabled" : "Raid mode ended"); void q.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const st = q.data?.state;
  const sev = (s: string) => (["high", "critical"].includes(s) ? "crim" : s === "medium" ? "warn" : s === "info" ? "ok" : "info") as "crim";
  return (
    <>
      <PageHead title="Security" description="Anti-raid, suspicious-account detection, anti-nuke and emergency lockdown." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "status", label: "Status" }, ...(can("admin") ? [{ value: "protection" as const, label: "Protection settings" }] : []), { value: "log", label: "Security log" }]} />
      {tab === "status" && <div className="stack" style={{ gap: 16 }}>
        <div className="grid g3">
          <Card accent={!!st?.lockdown} title="Lockdown" subtitle={st?.lockdown ? "Public channels are locked" : "Server is open"} actions={<span className={`dot ${st?.lockdown ? "bad pulse" : "ok"}`} />}>
            {can("admin") && (st?.lockdown ? <Button onClick={() => lockdown(false)} loading={busy} icon={<I.unlock />}>Lift lockdown & restore</Button> : <Button variant="danger" onClick={() => lockdown(true)} loading={busy} icon={<I.lock />}>Emergency lockdown</Button>)}
          </Card>
          <Card accent={!!st?.raidMode} title="Raid mode" subtitle={st?.raidMode ? `Active${st.raidModeUntil ? ` · auto-recovers ${timeAgo(st.raidModeUntil).replace(" ago", "")}` : ""}` : "Not active"} actions={<span className={`dot ${st?.raidMode ? "bad pulse" : "ok"}`} />}>
            {can("admin") && (st?.raidMode ? <Button onClick={() => raid(false)} loading={busy}>End raid mode</Button> : <Button onClick={() => raid(true)} loading={busy} variant="danger">Enable raid mode</Button>)}
          </Card>
          <Card title="Protection level" subtitle={cfg.config ? (cfg.config.security.enabled ? `Sensitivity: ${cfg.config.security.sensitivity}` : "Disabled") : ""}>
            <div className="small faint">{cfg.config && SENS.find((s) => s.value === cfg.config!.security.sensitivity)?.desc}</div>
          </Card>
        </div>
        <div className="grid g3">
          <Card title="Events · 30 days"><BarList items={(q.data?.byType ?? []).map((t) => ({ label: t.type.replace(/_/g, " "), value: Number(t.n) }))} /></Card>
          <Card className="span2" title="Recent events">{!q.data ? <Skeleton h={160} /> : !q.data.events.length ? <Empty title="No security events" /> : q.data.events.slice(0, 8).map((e) => <div key={e.id} className="list-item" style={{ cursor: "pointer" }} onClick={() => setDetail(e)}><Chip tone={sev(e.severity)}>{e.severity}</Chip><div className="grow small">{e.summary}<div className="faint">{e.type}{e.actionTaken ? ` · ${e.actionTaken}` : ""}</div></div><span className="small faint nowrap">{timeAgo(e.createdAt)}</span></div>)}</Card>
        </div>
      </div>}
      {tab === "protection" && (cfg.config ? <Protection c={cfg.config} cfg={cfg} /> : <Skeleton h={300} />)}
      {tab === "log" && <Card>{!q.data ? <Skeleton h={300} /> : <div className="table-wrap"><table className="t"><thead><tr><th>Severity</th><th>Event</th><th>Summary</th><th>Action</th><th>When</th></tr></thead><tbody>{q.data.events.map((e) => <tr key={e.id} className="click" onClick={() => setDetail(e)}><td><Chip tone={sev(e.severity)}>{e.severity}</Chip></td><td className="small">{e.type}</td><td className="small">{e.summary}</td><td className="small faint">{e.actionTaken ?? "—"}</td><td className="small faint nowrap">{fmtDate(e.createdAt)}</td></tr>)}</tbody></table></div>}</Card>}
      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.type.replace(/_/g, " ") ?? ""} wide>{detail && <div className="stack"><div>{detail.summary}</div><div className="small faint">{fmtDate(detail.createdAt)} · action: {detail.actionTaken ?? "none"}</div>{detail.details && <pre className="card flat small" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(detail.details, null, 2)}</pre>}</div>}</Modal>
      {cfg.config && <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />}
    </>
  );
}

function Protection({ c, cfg }: { c: GuildConfig; cfg: ReturnType<typeof useGuildConfig> }) {
  const s = c.security;
  const set = (p: Partial<GuildConfig["security"]>) => cfg.update("security", p);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card accent>
        <ToggleRow title="Security engine" description="Join-spike detection, suspicious accounts, raid mode and anti-nuke." checked={s.enabled} onChange={(v) => set({ enabled: v })} />
        <div className="mt"><div className="field-label mb">How aggressively should MOTH protect this server?</div><Seg value={s.sensitivity} onChange={(v) => set({ sensitivity: v })} options={SENS.map((x) => ({ value: x.value, label: x.label }))} crimson /><div className="small faint mt">{SENS.find((x) => x.value === s.sensitivity)?.desc}</div></div>
      </Card>
      <div className="grid g2">
        <Card title="Join-spike detection" subtitle="Base thresholds — scaled by sensitivity">
          <div className="grid g2"><Field label="Joins"><NumberInput value={s.joinSpike.joins} min={3} max={500} onChange={(v) => set({ joinSpike: { ...s.joinSpike, joins: v } })} /></Field><Field label="Within seconds"><NumberInput value={s.joinSpike.perSeconds} min={5} max={600} onChange={(v) => set({ joinSpike: { ...s.joinSpike, perSeconds: v } })} /></Field></div>
          <div className="grid g2 mt">
            <Field label="Raid response"><Select value={s.raidAction} onChange={(v) => set({ raidAction: v as typeof s.raidAction })} options={[{ value: "alert", label: "Alert staff only" }, { value: "lockdown", label: "Lock down server" }, { value: "kick-new", label: "Kick new joiners" }, { value: "ban-new", label: "Ban new joiners" }]} /></Field>
            <Field label="Raid mode lasts (minutes)"><NumberInput value={s.raidModeMinutes} min={1} max={1440} onChange={(v) => set({ raidModeMinutes: v })} /></Field>
          </div>
          <ToggleRow title="Automatic recovery" description="End raid mode and restore permissions once joins return to normal." checked={s.autoRecover} onChange={(v) => set({ autoRecover: v })} />
          <ToggleRow title="Raise verification level during raids" checked={s.raiseVerificationOnRaid} onChange={(v) => set({ raiseVerificationOnRaid: v })} />
        </Card>
        <Card title="Suspicious accounts" subtitle="Scored on account age, avatar, name patterns and Discord spam flags. Every decision is explained in the security log.">
          <div className="grid g2"><Field label="Minimum account age (days)"><NumberInput value={s.minAccountAgeDays} min={0} max={365} onChange={(v) => set({ minAccountAgeDays: v })} /></Field>
            <Field label="Action"><Select value={s.suspiciousAction} onChange={(v) => set({ suspiciousAction: v as typeof s.suspiciousAction })} options={[{ value: "none", label: "Ignore" }, { value: "flag", label: "Flag to security log" }, { value: "timeout", label: "Timeout 1h" }, { value: "kick", label: "Kick" }, { value: "ban", label: "Ban" }]} /></Field></div>
          <Field label="Trusted roles" hint="Members with these roles are never flagged."><RoleMulti value={s.trustedRoleIds} onChange={(v) => set({ trustedRoleIds: v })} /></Field>
        </Card>
        <Card title="Anti-nuke" subtitle="Stops a compromised staff account from mass-deleting the server. Offending roles are stripped automatically.">
          <ToggleRow title="Enable anti-nuke" checked={s.antiNuke.enabled} onChange={(v) => set({ antiNuke: { ...s.antiNuke, enabled: v } })} />
          <div className="grid g2 mt"><Field label="Max channel deletes"><NumberInput value={s.antiNuke.maxChannelDeletes} min={1} max={50} onChange={(v) => set({ antiNuke: { ...s.antiNuke, maxChannelDeletes: v } })} /></Field><Field label="Max role deletes"><NumberInput value={s.antiNuke.maxRoleDeletes} min={1} max={50} onChange={(v) => set({ antiNuke: { ...s.antiNuke, maxRoleDeletes: v } })} /></Field><Field label="Max bans"><NumberInput value={s.antiNuke.maxBans} min={1} max={100} onChange={(v) => set({ antiNuke: { ...s.antiNuke, maxBans: v } })} /></Field><Field label="Within seconds"><NumberInput value={s.antiNuke.perSeconds} min={5} max={600} onChange={(v) => set({ antiNuke: { ...s.antiNuke, perSeconds: v } })} /></Field></div>
        </Card>
        <Card title="Alerts & scope">
          <div className="stack"><Field label="Security log channel"><ChannelSelect value={c.general.securityLogChannelId} onChange={(v) => cfg.update("general", { securityLogChannelId: v })} /></Field>
            <Field label="Ping these roles on incidents"><RoleMulti value={s.alertRoleIds} onChange={(v) => set({ alertRoleIds: v })} /></Field>
            <Field label="Lockdown channels" hint="Empty = all public channels"><ChannelMulti value={s.lockdownChannelIds} onChange={(v) => set({ lockdownChannelIds: v })} /></Field></div>
        </Card>
        <Card title="Verification" subtitle="Members must verify to access the server.">
          <ToggleRow title="Enable verification" checked={c.verification.enabled} onChange={(v) => cfg.update("verification", { enabled: v })} />
          <div className="grid g2 mt"><Field label="Mode"><Select value={c.verification.mode} onChange={(v) => cfg.update("verification", { mode: v as "button" })} options={[{ value: "button", label: "Button" }, { value: "captcha", label: "Captcha (maths question)" }]} /></Field><Field label="Channel"><ChannelSelect value={c.verification.channelId} onChange={(v) => cfg.update("verification", { channelId: v })} /></Field></div>
          <VerifyRoles c={c} cfg={cfg} />
        </Card>
      </div>
    </div>
  );
}

function VerifyRoles({ c, cfg }: { c: GuildConfig; cfg: ReturnType<typeof useGuildConfig> }) {
  const { guildId } = useGuild();
  const toast = useToast();
  return <>
    <div className="grid g2 mt"><Field label="Verified role"><RoleSelect value={c.verification.verifiedRoleId} onChange={(v) => cfg.update("verification", { verifiedRoleId: v })} /></Field><Field label="Unverified role (optional)"><RoleSelect value={c.verification.unverifiedRoleId} onChange={(v) => cfg.update("verification", { unverifiedRoleId: v })} /></Field></div>
    <div className="mt"><Button size="sm" onClick={async () => { try { await api(`/api/guilds/${guildId}/verification/publish`, { body: {} }); toast("Verification panel posted"); } catch (e) { toast((e as Error).message, true); } }}>Post verification panel</Button></div>
  </>;
}
