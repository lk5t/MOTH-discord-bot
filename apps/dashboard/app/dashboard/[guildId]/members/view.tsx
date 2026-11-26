"use client";
import { useState } from "react";
import { ACHIEVEMENTS, levelFromXp } from "@moth/core/shared";
import { useGuild } from "@/components/guild";
import { api, fmtDate, fmtNum, timeAgo, useApi, useDebounced } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, Modal, NumberInput, PageHead, Progress, Select, Skeleton, Tabs, useConfirm, useToast } from "@/components/ui";
import { RoleMulti } from "@/components/pickers";

type Member = { id: string; username: string; displayName: string; avatar: string; bot: boolean; joinedAt: string | null; createdAt: string; roles: { id: string; name: string; color: string }[]; timedOutUntil: string | null };
type Detail = { live: { inGuild: boolean; banned: boolean; user: { id: string; username: string; avatar: string; createdAt: string } | null; displayName?: string; joinedAt?: string; roles?: string[]; timedOutUntil?: string | null } | null; cases: { id: number; caseNumber: number; type: string; reason: string | null; active: boolean; createdAt: string }[]; levels: { xp: number; level: number; messages: number; voiceMinutes: number } | null; economy: { balance: number; streak: number } | null; achievements: { key: string; unlockedAt: string }[] };

export function MembersView() {
  const [tab, setTab] = useState<"members" | "leaderboard">("members");
  return <><PageHead title="Members" description="Search members, review history, manage roles and take action." /><Tabs value={tab} onChange={setTab} tabs={[{ value: "members", label: "Members" }, { value: "leaderboard", label: "Leaderboards" }]} />{tab === "members" ? <List /> : <Leaderboard />}</>;
}

function List() {
  const { guildId } = useGuild();
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 350);
  const list = useApi<Member[]>(`/api/guilds/${guildId}/members?q=${encodeURIComponent(dq)}`);
  const [sel, setSel] = useState<string | null>(null);
  return (
    <>
      <Card title="Members" actions={<Input placeholder="Search by name…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />}>
        {list.error ? <Empty title="Bot unreachable">{list.error}</Empty> : !list.data ? <Skeleton h={300} /> : !list.data.length ? <Empty title="No members found" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Member</th><th>Roles</th><th>Joined</th><th>Account age</th><th /></tr></thead><tbody>
            {list.data.map((m) => <tr key={m.id} className="click" onClick={() => setSel(m.id)}>
              <td><div className="row"><img className="avatar" src={m.avatar} alt="" /><div><div>{m.displayName}{m.bot && <Chip tone="info">bot</Chip>}</div><div className="small faint">@{m.username}</div></div></div></td>
              <td><div className="row wrap" style={{ gap: 4 }}>{m.roles.slice(0, 4).map((r) => <span key={r.id} className="role-pill"><i style={{ background: r.color === "#000000" ? "#99aab5" : r.color }} />{r.name}</span>)}{m.roles.length > 4 && <span className="small faint">+{m.roles.length - 4}</span>}</div></td>
              <td className="small faint nowrap">{timeAgo(m.joinedAt)}</td><td className="small faint nowrap">{timeAgo(m.createdAt)}</td>
              <td>{m.timedOutUntil && new Date(m.timedOutUntil) > new Date() && <Chip tone="warn">timed out</Chip>}</td>
            </tr>)}
          </tbody></table></div>
        )}
      </Card>
      {sel && <MemberModal userId={sel} onClose={() => setSel(null)} />}
    </>
  );
}

function MemberModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { guildId, can, roles } = useGuild();
  const toast = useToast(); const confirm = useConfirm();
  const q = useApi<Detail>(`/api/guilds/${guildId}/members/${userId}`);
  const [roleDraft, setRoleDraft] = useState<string[] | null>(null);
  const [action, setAction] = useState({ type: "warn", reason: "", minutes: 60 });
  const d = q.data; const live = d?.live;
  const lv = d?.levels ? levelFromXp(d.levels.xp) : null;
  async function saveRoles() {
    const cur = new Set(live?.roles ?? []); const next = new Set(roleDraft ?? []);
    try { await api(`/api/guilds/${guildId}/members/${userId}/roles`, { body: { add: [...next].filter((r) => !cur.has(r)), remove: [...cur].filter((r) => !next.has(r) && roles.find((x) => x.id === r && !x.managed && !x.everyone)) } }); toast("Roles updated"); setRoleDraft(null); void q.reload(); }
    catch (e) { toast((e as Error).message, true); }
  }
  async function act() {
    if (["ban", "kick"].includes(action.type) && !(await confirm({ title: `${action.type} ${live?.user?.username}?`, body: "This takes effect immediately and is logged as a case.", danger: true, confirm: action.type }))) return;
    try { const r = await api<{ caseNumber: number }>(`/api/guilds/${guildId}/moderation/action`, { body: { type: action.type, userId, reason: action.reason || undefined, durationMs: action.type === "timeout" ? action.minutes * 60_000 : undefined } }); toast(`Case #${r.caseNumber} created`); void q.reload(); }
    catch (e) { toast((e as Error).message, true); }
  }
  return (
    <Modal open onClose={onClose} wide title={live?.user ? (live.displayName ?? live.user.username) : "Member"}>
      {!d ? <Skeleton h={300} /> : <div className="stack" style={{ gap: 16 }}>
        <div className="row" style={{ gap: 16 }}>
          {live?.user && <img className="avatar lg" src={live.user.avatar} alt="" />}
          <div className="grow"><div className="mono small faint">{userId}</div><div className="small muted">Account created {fmtDate(live?.user?.createdAt)} · joined {fmtDate(live?.joinedAt)}</div>
            <div className="row mt">{live?.banned && <Chip tone="crim">banned</Chip>}{!live?.inGuild && !live?.banned && <Chip>not in server</Chip>}{live?.timedOutUntil && new Date(live.timedOutUntil) > new Date() && <Chip tone="warn">timed out until {fmtDate(live.timedOutUntil)}</Chip>}</div></div>
        </div>
        <div className="grid g4">
          <Card className="flat"><div className="small faint">Level</div><div style={{ fontSize: 22, fontWeight: 600 }}>{lv?.level ?? 0}</div>{lv && <Progress value={(lv.current / lv.needed) * 100} />}</Card>
          <Card className="flat"><div className="small faint">Messages</div><div style={{ fontSize: 22, fontWeight: 600 }}>{fmtNum(d.levels?.messages)}</div></Card>
          <Card className="flat"><div className="small faint">Balance</div><div style={{ fontSize: 22, fontWeight: 600 }}>{fmtNum(d.economy?.balance)}</div><div className="small faint">🔥 {d.economy?.streak ?? 0} streak</div></Card>
          <Card className="flat"><div className="small faint">Cases</div><div style={{ fontSize: 22, fontWeight: 600 }}>{d.cases.length}</div><div className="small faint">{d.cases.filter((c) => c.active && ["warn", "automod"].includes(c.type)).length} active warnings</div></Card>
        </div>
        {!!d.achievements.length && <div className="row wrap">{d.achievements.map((a) => { const def = ACHIEVEMENTS.find((x) => x.key === a.key); return <Chip key={a.key}>{def?.icon} {def?.name ?? a.key}</Chip>; })}</div>}
        {live?.inGuild && can("admin") && <Card className="flat" title="Roles" actions={roleDraft && <Button size="sm" variant="primary" onClick={saveRoles}>Save roles</Button>}><RoleMulti value={roleDraft ?? live.roles ?? []} onChange={setRoleDraft} /></Card>}
        {can("moderator") && <Card className="flat" title="Take action"><div className="grid" style={{ gridTemplateColumns: "150px 1fr auto", alignItems: "end" }}>
          <Field label="Action"><Select value={action.type} onChange={(v) => setAction({ ...action, type: v })} options={(live?.banned ? ["unban", "note"] : ["warn", "timeout", "untimeout", "kick", "ban", "note"]).map((t) => ({ value: t, label: t }))} /></Field>
          <Field label="Reason">{action.type === "timeout" ? <div className="row"><NumberInput value={action.minutes} min={1} max={40320} onChange={(v) => setAction({ ...action, minutes: v })} /><span className="small faint">min</span><Input value={action.reason} onChange={(e) => setAction({ ...action, reason: e.target.value })} /></div> : <Input value={action.reason} onChange={(e) => setAction({ ...action, reason: e.target.value })} />}</Field>
          <Button variant={["ban", "kick"].includes(action.type) ? "danger" : "primary"} onClick={act}>Execute</Button>
        </div></Card>}
        <Card className="flat" title="Moderation history">{!d.cases.length ? <Empty title="Clean record ✨" /> : d.cases.map((c) => <div key={c.id} className="list-item"><Chip tone={["ban", "kick"].includes(c.type) ? "crim" : "warn"}>{c.type}</Chip><div className="grow small">#{c.caseNumber} — {c.reason}{!c.active && <span className="faint"> (void)</span>}</div><span className="small faint">{timeAgo(c.createdAt)}</span></div>)}</Card>
      </div>}
    </Modal>
  );
}

function Leaderboard() {
  const { guildId } = useGuild();
  const q = useApi<{ levels: { userId: string; xp: number; messages: number }[]; economy: { userId: string; balance: number }[] }>(`/api/guilds/${guildId}/leaderboard`);
  const medal = (i: number) => ["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`;
  return (
    <div className="grid g2">
      <Card title="Levels">{!q.data ? <Skeleton h={300} /> : !q.data.levels.length ? <Empty title="No XP yet" /> : q.data.levels.map((r, i) => { const l = levelFromXp(r.xp); return <div key={r.userId} className="list-item"><span style={{ width: 28 }}>{medal(i)}</span><span className="grow mono small">{r.userId}</span><span className="small">Lvl <b>{l.level}</b> · {fmtNum(r.xp)} XP</span></div>; })}</Card>
      <Card title="Economy">{!q.data ? <Skeleton h={300} /> : !q.data.economy.length ? <Empty title="No balances yet" /> : q.data.economy.map((r, i) => <div key={r.userId} className="list-item"><span style={{ width: 28 }}>{medal(i)}</span><span className="grow mono small">{r.userId}</span><b>{fmtNum(r.balance)}</b></div>)}</Card>
    </div>
  );
}
