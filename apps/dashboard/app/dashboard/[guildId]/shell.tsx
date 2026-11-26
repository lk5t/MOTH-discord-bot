"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { I, MothMark } from "@/components/icons";
import { GuildProvider, type Level } from "@/components/guild";
import { useApi, useLive } from "@/components/hooks";
import { Button, Chip } from "@/components/ui";

type Nav = { key: string; label: string };
const GROUPS: { label: string; keys: string[] }[] = [
  { label: "Server", keys: ["overview", "setup", "architect", "analytics"] },
  { label: "Protection", keys: ["moderation", "security"] },
  { label: "Engage", keys: ["tools", "tickets", "automation", "commands", "members"] },
  { label: "Configure", keys: ["ai", "settings", "system"] },
];

export function Shell({ guild, user, level, nav, children }: { guild: { id: string; name: string; icon: string | null }; user: { id: string; username: string; globalName: string | null; avatar: string | null }; level: Level; nav: Nav[]; children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const guildsQ = useApi<{ guilds: { id: string; name: string; inGuild: boolean; level: string }[] }>("/api/me");
  const section = path.split("/")[3] ?? "overview";
  useEffect(() => setOpen(false), [path]);
  useLive(guild.id, "*", (e) => { if (e.type !== "analytics.tick") { setLive(e.type); setTimeout(() => setLive(null), 2500); } });
  const allowed = new Set(nav.map((n) => n.key));
  return (
    <GuildProvider guildId={guild.id} level={level}>
      <div className="shell">
        <aside className={`sidebar ${open ? "open" : ""}`}>
          <Link href="/dashboard" className="brand"><span className="brand-mark"><MothMark /></span>MOTH</Link>
          <div className="field" style={{ padding: "0 4px 6px" }}>
            <select className="select" value={guild.id} onChange={(e) => router.push(`/dashboard/${e.target.value}/${section}`)} aria-label="Switch server">
              <option value={guild.id}>{guild.name}</option>
              {(guildsQ.data?.guilds ?? []).filter((g) => g.inGuild && g.id !== guild.id && g.level !== "none").map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          {GROUPS.map((grp) => {
            const items = grp.keys.filter((k) => allowed.has(k));
            if (!items.length) return null;
            return <div key={grp.label}><div className="nav-label">{grp.label}</div>{items.map((k) => { const n = nav.find((x) => x.key === k)!; const Icon = I[k as keyof typeof I] ?? I.overview; return <Link key={k} href={`/dashboard/${guild.id}/${k === "overview" ? "" : k}`} className={`nav-item ${section === k || (k === "overview" && !path.split("/")[3]) ? "active" : ""}`}><Icon />{n.label}</Link>; })}</div>;
          })}
          <div style={{ marginTop: "auto", paddingTop: 16 }}>
            <div className="row" style={{ padding: "10px", borderTop: "1px solid var(--line)" }}>
              <img className="avatar" src={user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : `https://cdn.discordapp.com/embed/avatars/0.png`} alt="" />
              <div className="grow"><div style={{ fontWeight: 500, fontSize: 13 }}>{user.globalName ?? user.username}</div><div className="small faint">{level}</div></div>
              <form action="/api/auth/logout" method="post"><button className="btn ghost sm" title="Sign out" aria-label="Sign out"><I.logout /></button></form>
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="row">
              <Button className="menu-btn" variant="ghost" size="sm" onClick={() => setOpen(!open)} icon={<I.menu />} aria-label="Menu" />
              <span className="muted">{guild.name}</span>
            </div>
            <div className="row">
              {live && <Chip tone="info"><span className="dot ok pulse" /> synced: {live}</Chip>}
              <Chip><span className="dot ok" /> Live</Chip>
            </div>
          </header>
          <div className="content" key={path}>{children}</div>
        </div>
      </div>
    </GuildProvider>
  );
}
