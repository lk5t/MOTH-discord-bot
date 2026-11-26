"use client";
import Link from "next/link";
import { useGuild } from "@/components/guild";
import { fmtNum, timeAgo, useApi, useLive } from "@/components/hooks";
import { Card, Chip, Empty, PageHead, Skeleton, Stat } from "@/components/ui";
import { LineChart } from "@/components/charts";
import { I } from "@/components/icons";

type Overview = {
  live: { name: string; memberCount: number; boosts: number; premiumTier: number; channels: number; roles: number; botPermissions: Record<string, boolean> } | null;
  week: { messages: number; joins: number; leaves: number; cases: number };
  openTickets: number;
  recentCases: { id: number; caseNumber: number; type: string; targetTag: string | null; targetId: string; reason: string | null; automated: boolean; createdAt: string }[];
  recentSecurity: { id: number; type: string; severity: string; summary: string; createdAt: string }[];
  state: { raidMode: boolean; lockdown: boolean } | null;
  hourly: { hour: string; messages: number; joins: number; activeUsers: number }[];
};

export function OverviewView() {
  const { guildId, can } = useGuild();
  const q = useApi<Overview>(`/api/guilds/${guildId}/overview`, { refreshMs: 60_000 });
  useLive(guildId, ["analytics.tick", "member.joined", "member.left", "case.created", "security.event", "ticket.updated"], () => void q.reload());
  const d = q.data;
  const hourly = d?.hourly ?? [];
  return (
    <>
      <PageHead title={d?.live?.name ?? "Overview"} description="Live server statistics and recent activity." actions={can("admin") && <Link className="btn primary" href={`/dashboard/${guildId}/architect`}><I.sparkles /> Open Architect</Link>} />
      {(d?.state?.raidMode || d?.state?.lockdown) && <Card accent className="mb"><div className="row"><I.alert style={{ color: "var(--crimson)", width: 20 }} /><b>{d.state.raidMode ? "Raid mode is active" : "Server is in lockdown"}</b><span className="muted">— go to Security to review or lift it.</span></div></Card>}
      {d?.live && !d.live.botPermissions.administrator && !(d.live.botPermissions.manageRoles && d.live.botPermissions.manageChannels) && <Card className="mb"><div className="row"><Chip tone="warn">Permissions</Chip><span className="muted">MOTH is missing Manage Roles / Manage Channels. Architect, tickets and lockdown need them.</span></div></Card>}
      {!d ? <div className="grid g4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h={110} />)}</div> : (
        <div className="grid g4">
          <Stat label="Members" value={fmtNum(d.live?.memberCount)} delta={<><span style={{ color: "var(--ok)" }}>+{fmtNum(d.week.joins)}</span> / <span style={{ color: "#ff6b85" }}>−{fmtNum(d.week.leaves)}</span> this week</>} icon={<I.members width={18} />} />
          <Stat label="Messages · 7d" value={fmtNum(d.week.messages)} delta={`${fmtNum(Math.round(Number(d.week.messages) / 7))} per day`} icon={<I.analytics width={18} />} />
          <Stat label="Open tickets" value={fmtNum(d.openTickets)} delta="awaiting staff" icon={<I.tickets width={18} />} />
          <Stat label="Mod cases · 7d" value={fmtNum(d.week.cases)} delta={`${d.live?.boosts ?? 0} boosts · tier ${d.live?.premiumTier ?? 0}`} icon={<I.moderation width={18} />} />
        </div>
      )}
      <div className="grid g3 mt">
        <Card className="span2" title="Activity · last 48h" subtitle="Messages and active members per hour">
          <LineChart labels={hourly.map((h) => new Date(h.hour).toLocaleTimeString([], { hour: "2-digit" }))} series={[{ key: "m", label: "Messages", color: "#dc143c", values: hourly.map((h) => Number(h.messages)) }, { key: "a", label: "Active members", color: "#71717a", values: hourly.map((h) => Number(h.activeUsers)) }]} />
        </Card>
        <Card title="Server">
          {d?.live ? <div className="stack" style={{ gap: 8 }}>
            {[["Channels", d.live.channels], ["Roles", d.live.roles], ["Boost tier", d.live.premiumTier]].map(([k, v]) => <div key={k as string} className="row between"><span className="muted">{k}</span><b>{v as number}</b></div>)}
            <div className="row between"><span className="muted">Bot status</span><Chip tone="ok"><span className="dot ok" /> online</Chip></div>
          </div> : q.loading ? <Skeleton h={120} /> : <Empty title="Bot unreachable">Live data is unavailable while the bot is offline.</Empty>}
        </Card>
      </div>
      <div className="grid g2 mt">
        <Card title="Recent moderation" actions={can("moderator") && <Link className="btn sm ghost" href={`/dashboard/${guildId}/moderation`}>View all</Link>}>
          {!d?.recentCases.length ? <Empty title="No cases yet" /> : d.recentCases.map((c) => <div key={c.id} className="list-item"><Chip tone={["ban", "kick"].includes(c.type) ? "crim" : c.type === "warn" || c.type === "automod" ? "warn" : undefined}>{c.type}</Chip><div className="grow"><div><b>#{c.caseNumber}</b> {c.targetTag ?? c.targetId}{c.automated && <span className="faint small"> · auto</span>}</div><div className="small faint">{c.reason}</div></div><span className="small faint nowrap">{timeAgo(c.createdAt)}</span></div>)}
        </Card>
        <Card title="Security events" actions={can("moderator") && <Link className="btn sm ghost" href={`/dashboard/${guildId}/security`}>View all</Link>}>
          {!d?.recentSecurity.length ? <Empty title="All quiet" /> : d.recentSecurity.map((e) => <div key={e.id} className="list-item"><span className={`dot ${["high", "critical"].includes(e.severity) ? "bad" : e.severity === "medium" ? "warn" : ""}`} /><div className="grow"><div className="small">{e.summary}</div><div className="small faint">{e.type}</div></div><span className="small faint nowrap">{timeAgo(e.createdAt)}</span></div>)}
        </Card>
      </div>
    </>
  );
}
