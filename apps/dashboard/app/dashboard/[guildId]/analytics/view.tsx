"use client";
import { useState } from "react";
import { useGuild } from "@/components/guild";
import { fmtNum, useApi, useLive } from "@/components/hooks";
import { Card, PageHead, Seg, Skeleton, Stat } from "@/components/ui";
import { BarList, Donut, Heatmap, LineChart } from "@/components/charts";
import { useNames } from "@/components/pickers";

type A = {
  days: number; bucket: string;
  series: { t: string; messages: number; joins: number; leaves: number; active: number; voice: number; commands: number; members: number | null }[];
  channels: { channelId: string; n: number }[]; moderation: { t: string; n: number; auto: number }[]; tickets: { t: string; opened: number; closed: number }[];
  security: { severity: string; n: number }[]; automations: { status: string; n: number }[]; ai: { feature: string; n: number; tokens: number }[]; heat: { dow: number; h: number; n: number }[];
};

export function AnalyticsView() {
  const { guildId } = useGuild();
  const names = useNames();
  const [days, setDays] = useState("30");
  const q = useApi<A>(`/api/guilds/${guildId}/analytics?days=${days}`);
  useLive(guildId, ["analytics.tick"], () => void q.reload());
  const d = q.data;
  const label = (t: string) => { const x = new Date(t); return d?.bucket === "hour" ? x.toLocaleTimeString([], { hour: "2-digit" }) : x.toLocaleDateString([], { month: "short", day: "numeric" }); };
  const sum = (k: keyof A["series"][number]) => (d?.series ?? []).reduce((a, r) => a + Number(r[k] ?? 0), 0);
  const members = (d?.series ?? []).map((r) => r.members).filter((m): m is number => m !== null);
  const growth = members.length > 1 ? Number(members.at(-1)) - Number(members[0]) : 0;
  return (
    <>
      <PageHead title="Analytics" description="Growth, activity, engagement, moderation, tickets, security and automation — collected live by MOTH." actions={<Seg value={days} onChange={setDays} options={[{ value: "1", label: "24h" }, { value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }, { value: "365", label: "1y" }]} crimson />} />
      {!d ? <Skeleton h={400} /> : <div className="stack" style={{ gap: 16 }}>
        <div className="grid g4">
          <Stat label="Member growth" value={`${growth >= 0 ? "+" : ""}${fmtNum(growth)}`} delta={`${fmtNum(sum("joins"))} joined · ${fmtNum(sum("leaves"))} left`} />
          <Stat label="Messages" value={fmtNum(sum("messages"))} delta={`${fmtNum(Math.round(sum("messages") / Math.max(1, d.days)))} / day`} />
          <Stat label="Voice hours" value={fmtNum(Math.round(sum("voice") / 60))} />
          <Stat label="Commands used" value={fmtNum(sum("commands"))} />
        </div>
        <Card title="Member count"><LineChart labels={d.series.map((r) => label(r.t))} series={[{ key: "m", label: "Members", color: "#dc143c", values: d.series.map((r) => Number(r.members ?? 0)) }]} /></Card>
        <div className="grid g2">
          <Card title="Message activity"><LineChart labels={d.series.map((r) => label(r.t))} series={[{ key: "m", label: "Messages", color: "#dc143c", values: d.series.map((r) => Number(r.messages)) }, { key: "a", label: "Active members", color: "#71717a", values: d.series.map((r) => Number(r.active)) }]} /></Card>
          <Card title="Joins vs leaves"><LineChart area={false} labels={d.series.map((r) => label(r.t))} series={[{ key: "j", label: "Joins", color: "#22c55e", values: d.series.map((r) => Number(r.joins)) }, { key: "l", label: "Leaves", color: "#dc143c", values: d.series.map((r) => Number(r.leaves)) }]} /></Card>
        </div>
        <div className="grid g3">
          <Card title="Top channels"><BarList items={d.channels.map((c) => ({ label: names.channel(c.channelId), value: Number(c.n) }))} /></Card>
          <Card className="span2" title="When your server is active" subtitle="Messages by weekday and hour (UTC)"><Heatmap cells={d.heat} /></Card>
        </div>
        <div className="grid g2">
          <Card title="Moderation"><LineChart labels={d.moderation.map((r) => label(r.t))} series={[{ key: "n", label: "All cases", color: "#dc143c", values: d.moderation.map((r) => Number(r.n)) }, { key: "a", label: "Automated", color: "#f59e0b", values: d.moderation.map((r) => Number(r.auto)) }]} /></Card>
          <Card title="Tickets"><LineChart area={false} labels={d.tickets.map((r) => label(r.t))} series={[{ key: "o", label: "Opened", color: "#dc143c", values: d.tickets.map((r) => Number(r.opened)) }, { key: "c", label: "Closed", color: "#22c55e", values: d.tickets.map((r) => Number(r.closed)) }]} /></Card>
        </div>
        <div className="grid g3">
          <Card title="Security events"><Donut parts={d.security.map((s) => ({ label: s.severity, value: Number(s.n), color: { critical: "#dc143c", high: "#ef4444", medium: "#f59e0b", low: "#60a5fa", info: "#71717a" }[s.severity] ?? "#a1a1aa" }))} /></Card>
          <Card title="Automation runs"><Donut parts={d.automations.map((s) => ({ label: s.status, value: Number(s.n), color: s.status === "success" ? "#22c55e" : s.status === "failed" ? "#dc143c" : "#71717a" }))} /></Card>
          <Card title="AI usage"><BarList items={d.ai.map((a) => ({ label: a.feature.replace(/_/g, " "), value: Number(a.n) }))} /><div className="small faint mt">{fmtNum(d.ai.reduce((a, x) => a + Number(x.tokens), 0))} tokens</div></Card>
        </div>
      </div>}
    </>
  );
}
