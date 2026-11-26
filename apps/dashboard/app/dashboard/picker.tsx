"use client";
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/components/hooks";
import { Button, Chip, Empty, Input, Skeleton } from "@/components/ui";
import { I, MothMark } from "@/components/icons";

type G = { id: string; name: string; icon: string | null; inGuild: boolean; level: string; canInvite: boolean; inviteUrl: string | null; memberCount: number | null };

export function ServerPicker({ user }: { user: { id: string; username: string; globalName: string | null; avatar: string | null } }) {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useApi<{ guilds: G[]; platformOwner: boolean }>(`/api/me${refresh ? "?refresh=1" : ""}`);
  const [q, setQ] = useState("");
  const list = (data?.guilds ?? []).filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  const icon = (g: G) => (g.icon ? <img className="guild-icon" src={`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=96`} alt="" /> : <div className="guild-icon">{g.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 3)}</div>);
  return (
    <main style={{ minHeight: "100vh", background: "radial-gradient(60% 40% at 50% 0%, rgba(220,20,60,.12), transparent 70%), var(--bg)" }}>
      <div className="topbar" style={{ position: "relative" }}>
        <div className="brand" style={{ padding: 0 }}><span className="brand-mark"><MothMark /></span>MOTH</div>
        <div className="row">
          <span className="muted small">{user.globalName ?? user.username}</span>
          <form action="/api/auth/logout" method="post"><Button variant="ghost" size="sm" icon={<I.logout />}>Sign out</Button></form>
        </div>
      </div>
      <div className="content" style={{ maxWidth: 1000, margin: "0 auto" }}>
        <div className="page-head"><div><h1>Choose a server</h1><p>Servers where you can manage MOTH, or invite it to.</p></div>
          <div className="row"><Input placeholder="Search servers…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} /><Button onClick={() => setRefresh((n) => n + 1)} icon={<I.refresh />}>Refresh</Button></div></div>
        {error && <div className="chip crim">{error}</div>}
        {loading && !data ? <div className="grid g2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={82} />)}</div> : (
          list.length === 0 ? <Empty title="No servers found">You need <b>Manage Server</b> permission (or a dashboard role) to manage a server with MOTH.</Empty> : (
            <div className="grid g2">
              {list.map((g) => g.inGuild ? (
                <Link key={g.id} href={`/dashboard/${g.id}`} className="guild-card">{icon(g)}<div className="grow"><div style={{ fontWeight: 600 }}>{g.name}</div><div className="small faint">{g.memberCount ? `${g.memberCount.toLocaleString()} members` : "MOTH active"}</div></div><Chip tone={g.level === "owner" || g.level === "admin" ? "crim" : undefined}>{g.level}</Chip></Link>
              ) : (
                <a key={g.id} href={g.inviteUrl ?? "#"} className="guild-card" style={{ opacity: 0.75 }}>{icon(g)}<div className="grow"><div style={{ fontWeight: 600 }}>{g.name}</div><div className="small faint">MOTH isn&apos;t in this server yet</div></div><span className="btn sm">Invite MOTH</span></a>
              ))}
            </div>
          )
        )}
        <p className="small faint mt">Creating a brand-new server? Create it in Discord first, invite MOTH, then use <b>Architect</b> to build it automatically.</p>
      </div>
    </main>
  );
}
