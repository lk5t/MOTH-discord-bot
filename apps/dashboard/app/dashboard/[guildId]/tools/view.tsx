"use client";
import { useState } from "react";
import type { GuildConfig } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, Field, Input, NumberInput, PageHead, SaveBar, Skeleton, Switch, Tabs, ToggleRow } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleMulti, useNames } from "@/components/pickers";
import { MessageEditor } from "@/components/embed-editor";
import { I } from "@/components/icons";

type Tab = "logging" | "voice" | "suggestions" | "starboard" | "rules" | "sticky" | "stats" | "invites";
type Summary = {
  suggestions: { id: number; number: number; authorId: string; content: string; status: string; upvotes: number; downvotes: number; createdAt: string }[];
  suggestionStats: { total: number; open: number; approved: number };
  inviters: { inviterId: string; total: number; active: number }[];
  inviteStats: { tracked: number; unknown: number };
  starboard: { messageId: string; channelId: string; authorId: string; stars: number; createdAt: string }[];
  activeVoiceRooms: number;
  stats: Record<string, number> | null;
};

export function ToolsView() {
  const [tab, setTab] = useState<Tab>("logging");
  const cfg = useGuildConfig();
  return (
    <>
      <PageHead title="Server Tools" description="Logging, join-to-create voice, suggestions, starboard, channel rules, sticky messages, live stats and invite tracking." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "logging", label: "Server logs" }, { value: "voice", label: "Voice rooms" }, { value: "suggestions", label: "Suggestions" }, { value: "starboard", label: "Starboard" },
        { value: "rules", label: "Channel rules" }, { value: "sticky", label: "Sticky messages" }, { value: "stats", label: "Stats channels" }, { value: "invites", label: "Invites" },
      ]} />
      {!cfg.config ? <Skeleton h={300} /> : <>
        {tab === "logging" && <Logging c={cfg.config} cfg={cfg} />}
        {tab === "voice" && <Voice c={cfg.config} cfg={cfg} />}
        {tab === "suggestions" && <Suggestions c={cfg.config} cfg={cfg} />}
        {tab === "starboard" && <Starboard c={cfg.config} cfg={cfg} />}
        {tab === "rules" && <Rules c={cfg.config} cfg={cfg} />}
        {tab === "sticky" && <Sticky c={cfg.config} cfg={cfg} />}
        {tab === "stats" && <Stats c={cfg.config} cfg={cfg} />}
        {tab === "invites" && <Invites c={cfg.config} cfg={cfg} />}
        {tab !== "invites" && <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />}
      </>}
    </>
  );
}

type P = { c: GuildConfig; cfg: ReturnType<typeof useGuildConfig> };
const useSummary = () => { const { guildId } = useGuild(); return useApi<Summary>(`/api/guilds/${guildId}/tools/summary`, { refreshMs: 30_000 }); };

const LOG_EVENTS: { key: keyof GuildConfig["logging"]["events"]; label: string; group: string }[] = [
  { key: "messageDelete", label: "Deleted messages", group: "Messages" }, { key: "messageEdit", label: "Edited messages", group: "Messages" }, { key: "bulkDelete", label: "Bulk deletes / purges", group: "Messages" },
  { key: "memberJoin", label: "Joins (with account age & invite)", group: "Members" }, { key: "memberLeave", label: "Leaves & kicks", group: "Members" }, { key: "memberRoles", label: "Role changes", group: "Members" },
  { key: "nickname", label: "Nickname changes", group: "Members" }, { key: "bans", label: "Bans & unbans", group: "Members" },
  { key: "channels", label: "Channels created / edited / deleted", group: "Server" }, { key: "roles", label: "Roles created / edited / deleted", group: "Server" }, { key: "invites", label: "Invites created", group: "Server" },
  { key: "voice", label: "Voice joins, leaves & moves", group: "Voice" },
];

function Logging({ c, cfg }: P) {
  const L = c.logging;
  const set = (p: Partial<typeof L>) => cfg.update("logging", p);
  return <div className="grid g2">
    <Card title="Server logs" subtitle="Everything that happens in your server, with who did it (from the audit log)." actions={<Switch checked={L.enabled} onChange={(v) => set({ enabled: v })} />}>
      <div className="stack">
        <Field label="Message log" hint="Edits & deletes"><ChannelSelect value={L.messageChannelId} onChange={(v) => set({ messageChannelId: v })} placeholder="Use the general log" /></Field>
        <Field label="Member log" hint="Joins, leaves, roles, bans"><ChannelSelect value={L.memberChannelId} onChange={(v) => set({ memberChannelId: v })} placeholder="Use the general log" /></Field>
        <Field label="Server log" hint="Channels, roles, invites"><ChannelSelect value={L.serverChannelId} onChange={(v) => set({ serverChannelId: v })} placeholder="Use the general log" /></Field>
        <Field label="Voice log"><ChannelSelect value={L.voiceChannelId} onChange={(v) => set({ voiceChannelId: v })} placeholder="Use the general log" /></Field>
        {!c.general.logChannelId && !L.messageChannelId && <div className="small" style={{ color: "#f59e0b" }}>No channels chosen and no general log channel set — use Quick Setup to create them.</div>}
        <Field label="Ignored channels"><ChannelMulti value={L.ignoredChannelIds} onChange={(v) => set({ ignoredChannelIds: v })} /></Field>
        <ToggleRow title="Ignore bots" description="Don't log messages deleted from other bots" checked={L.ignoreBots} onChange={(v) => set({ ignoreBots: v })} />
        <ToggleRow title="Invite tracking" description="Record which invite (and inviter) each member joined with. Needs Manage Server." checked={L.inviteTracking} onChange={(v) => set({ inviteTracking: v })} />
      </div>
    </Card>
    <Card title="What to log">
      {["Messages", "Members", "Server", "Voice"].map((g) => <div key={g} className="mb"><div className="field-label">{g}</div>
        {LOG_EVENTS.filter((e) => e.group === g).map((e) => <ToggleRow key={e.key} title={e.label} checked={L.events[e.key]} onChange={(v) => set({ events: { ...L.events, [e.key]: v } })} />)}</div>)}
    </Card>
  </div>;
}

function Voice({ c, cfg }: P) {
  const T = c.tempVoice;
  const set = (p: Partial<typeof T>) => cfg.update("tempVoice", p);
  const s = useSummary();
  return <div className="grid g2">
    <Card title="Join-to-create voice" subtitle="Joining a hub channel creates a private room for that member. Empty rooms are deleted automatically." actions={<Switch checked={T.enabled} onChange={(v) => set({ enabled: v })} />}>
      <div className="stack">
        <Field label="Hub channels" hint="Voice channels members join to create a room"><ChannelMulti kind="voice" value={T.hubChannelIds} onChange={(v) => set({ hubChannelIds: v })} placeholder="Add voice channels…" /></Field>
        <Field label="Create rooms in" hint="Defaults to the hub's category"><ChannelSelect kind="category" value={T.categoryId} onChange={(v) => set({ categoryId: v })} placeholder="Same category as the hub" /></Field>
        <Field label="Room name" hint="{user} = member's name"><Input value={T.nameTemplate} maxLength={100} onChange={(e) => set({ nameTemplate: e.target.value })} /></Field>
        <Field label="Default user limit" hint="0 = no limit"><NumberInput value={T.defaultLimit} min={0} max={99} onChange={(v) => set({ defaultLimit: v })} /></Field>
        <ToggleRow title="Control panel" description="Post Lock / Hide / Rename / Limit / Claim buttons in the room's chat" checked={T.controlPanel} onChange={(v) => set({ controlPanel: v })} />
      </div>
    </Card>
    <Card title="Right now"><div className="row between"><span className="muted">Active rooms</span><b>{s.data?.activeVoiceRooms ?? "—"}</b></div>
      <div className="small faint mt">Room owners control their room with the buttons in its text chat. If the owner leaves, anyone inside can press <b>Claim</b>. Members with Manage Channels can always manage rooms.</div></Card>
  </div>;
}

const STATUS_TONE: Record<string, "ok" | "crim" | "warn" | "info" | undefined> = { approved: "ok", implemented: "info", denied: "crim", considering: "warn" };
function Suggestions({ c, cfg }: P) {
  const S = c.suggestions;
  const set = (p: Partial<typeof S>) => cfg.update("suggestions", p);
  const s = useSummary();
  return <div className="grid g2">
    <Card title="Suggestions" subtitle="Members post ideas, everyone votes with buttons, staff approve or deny with a reason." actions={<Switch checked={S.enabled} onChange={(v) => set({ enabled: v })} />}>
      <div className="stack">
        <Field label="Suggestion channel"><ChannelSelect value={S.channelId} onChange={(v) => set({ channelId: v })} /></Field>
        <ToggleRow title="Turn messages into suggestions" description="Anything typed in the channel becomes a suggestion (otherwise use /suggest)" checked={S.convertMessages} onChange={(v) => set({ convertMessages: v })} />
        <ToggleRow title="Discussion thread for each suggestion" checked={S.autoThread} onChange={(v) => set({ autoThread: v })} />
        <ToggleRow title="Anonymous" description="Hide who posted the suggestion" checked={S.anonymous} onChange={(v) => set({ anonymous: v })} />
        <ToggleRow title="DM the author when reviewed" checked={S.dmAuthor} onChange={(v) => set({ dmAuthor: v })} />
        <Field label="Reviewer roles" hint="Members with Manage Server can always review"><RoleMulti value={S.staffRoleIds} onChange={(v) => set({ staffRoleIds: v })} /></Field>
        <Field label="Post reviewed suggestions in" hint="Optional"><ChannelSelect value={S.reviewedChannelId} onChange={(v) => set({ reviewedChannelId: v })} placeholder="Don't repost" /></Field>
      </div>
    </Card>
    <Card title="Recent suggestions" subtitle={s.data ? `${s.data.suggestionStats.total} total · ${s.data.suggestionStats.open} open · ${s.data.suggestionStats.approved} approved` : undefined}>
      {!s.data ? <Skeleton h={200} /> : !s.data.suggestions.length ? <Empty title="No suggestions yet" /> : s.data.suggestions.map((x) => <div key={x.id} className="list-item">
        <b className="mono small">#{x.number}</b><div className="grow small">{x.content.slice(0, 140)}</div>
        <span className="small nowrap">👍 {x.upvotes} · 👎 {x.downvotes}</span><Chip tone={STATUS_TONE[x.status]}>{x.status}</Chip><span className="small faint nowrap">{timeAgo(x.createdAt)}</span>
      </div>)}
    </Card>
  </div>;
}

function Starboard({ c, cfg }: P) {
  const S = c.starboard;
  const set = (p: Partial<typeof S>) => cfg.update("starboard", p);
  const s = useSummary();
  const names = useNames();
  return <div className="grid g2">
    <Card title="Starboard" subtitle="Messages that collect enough reactions are reposted to a highlight channel." actions={<Switch checked={S.enabled} onChange={(v) => set({ enabled: v })} />}>
      <div className="stack">
        <Field label="Starboard channel"><ChannelSelect value={S.channelId} onChange={(v) => set({ channelId: v })} /></Field>
        <div className="grid g2"><Field label="Emoji"><Input value={S.emoji} onChange={(e) => set({ emoji: e.target.value.trim() })} /></Field><Field label="Reactions needed"><NumberInput value={S.threshold} min={1} max={100} onChange={(v) => set({ threshold: v })} /></Field></div>
        <Field label="Ignored channels"><ChannelMulti value={S.ignoredChannelIds} onChange={(v) => set({ ignoredChannelIds: v })} /></Field>
        <ToggleRow title="Count the author's own reaction" checked={S.allowSelfStar} onChange={(v) => set({ allowSelfStar: v })} />
      </div>
    </Card>
    <Card title="Top starred">{!s.data ? <Skeleton h={160} /> : !s.data.starboard.length ? <Empty title="Nothing starred yet" /> : s.data.starboard.map((x) => <div key={x.messageId} className="list-item"><b>{S.emoji} {x.stars}</b><span className="grow small">{names.channel(x.channelId)}</span><span className="small faint mono">{x.authorId}</span><span className="small faint">{timeAgo(x.createdAt)}</span></div>)}</Card>
  </div>;
}

function Rules({ c, cfg }: P) {
  const rules = c.channelRules;
  const names = useNames();
  const put = (i: number, p: Partial<(typeof rules)[number]>) => cfg.set("channelRules", rules.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const [add, setAdd] = useState<string | null>(null);
  return <div className="stack" style={{ gap: 16 }}>
    <Card title="Channel rules" subtitle="Give specific channels special behaviour: media-only galleries, auto-threads for discussion, auto-publishing announcements, timed deletion and posting limits.">
      <div className="row"><div className="grow"><ChannelSelect value={add} onChange={setAdd} placeholder="Choose a channel to add rules to…" /></div>
        <Button variant="primary" icon={<I.plus />} disabled={!add || rules.some((r) => r.channelId === add)} onClick={() => { cfg.set("channelRules", [...rules, { channelId: add!, mediaOnly: false, autoThread: false, threadName: "{user.name}'s thread", autoPublish: false, autoReact: [], deleteAfterSeconds: 0, oneMessagePerMinutes: 0 }]); setAdd(null); }}>Add channel</Button></div>
    </Card>
    {!rules.length ? <Card><Empty title="No channel rules yet">Popular: a media-only #showcase with 🔥 reactions and auto-threads, or a #self-promo with one post per day.</Empty></Card> : <div className="grid g2">{rules.map((r, i) => <Card key={r.channelId} title={names.channel(r.channelId)} actions={<Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => cfg.set("channelRules", rules.filter((_, j) => j !== i))} />}>
      <ToggleRow title="Media only" description="Delete messages without an image, video or link (staff exempt)" checked={r.mediaOnly} onChange={(v) => put(i, { mediaOnly: v })} />
      <ToggleRow title="Auto-thread" description="Open a thread on every new message" checked={r.autoThread} onChange={(v) => put(i, { autoThread: v })} />
      {r.autoThread && <Field label="Thread name" hint="{user.name} supported"><Input value={r.threadName} onChange={(e) => put(i, { threadName: e.target.value })} /></Field>}
      <ToggleRow title="Auto-publish" description="Publish to following servers (announcement channels)" checked={r.autoPublish} onChange={(v) => put(i, { autoPublish: v })} />
      <div className="grid g3 mt">
        <Field label="Auto-react" hint="Emojis, space separated"><Input value={r.autoReact.join(" ")} onChange={(e) => put(i, { autoReact: e.target.value.split(/\s+/).filter(Boolean).slice(0, 5) })} placeholder="👍 🔥" /></Field>
        <Field label="Delete after (s)" hint="0 = keep"><NumberInput value={r.deleteAfterSeconds} min={0} max={86400} onChange={(v) => put(i, { deleteAfterSeconds: v })} /></Field>
        <Field label="1 post per (min)" hint="0 = off"><NumberInput value={r.oneMessagePerMinutes} min={0} max={10080} onChange={(v) => put(i, { oneMessagePerMinutes: v })} /></Field>
      </div>
    </Card>)}</div>}
  </div>;
}

function Sticky({ c, cfg }: P) {
  const list = c.sticky;
  const names = useNames();
  const [add, setAdd] = useState<string | null>(null);
  const put = (i: number, p: Partial<(typeof list)[number]>) => cfg.set("sticky", list.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return <div className="stack" style={{ gap: 16 }}>
    <Card title="Sticky messages" subtitle="A message that always stays at the bottom of a channel — perfect for rules, formats or links. MOTH re-posts it after new messages.">
      <div className="row"><div className="grow"><ChannelSelect value={add} onChange={setAdd} placeholder="Choose a channel…" /></div>
        <Button variant="primary" icon={<I.plus />} disabled={!add || list.some((r) => r.channelId === add)} onClick={() => { cfg.set("sticky", [...list, { channelId: add!, every: 4, message: { embed: { title: "📌 Channel rules", description: "Keep it on topic and be kind.", color: "#DC143C" } } }]); setAdd(null); }}>Add sticky</Button></div>
    </Card>
    {!list.length ? <Card><Empty title="No sticky messages" /></Card> : list.map((s, i) => <Card key={s.channelId} title={names.channel(s.channelId)} actions={<Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => cfg.set("sticky", list.filter((_, j) => j !== i))} />}>
      <Field label="Re-post after this many new messages"><NumberInput value={s.every} min={1} max={50} onChange={(v) => put(i, { every: v })} /></Field>
      <div className="mt"><MessageEditor value={s.message} onChange={(m) => put(i, { message: m })} /></div>
    </Card>)}
  </div>;
}

const STAT_KEYS = ["members", "humans", "bots", "boosts", "online", "channels", "roles"];
function Stats({ c, cfg }: P) {
  const list = c.statsChannels;
  const s = useSummary();
  const [add, setAdd] = useState<string | null>(null);
  const render = (t: string) => t.replace(/\{(\w+)\}/g, (m, k: string) => (s.data?.stats && k in s.data.stats ? s.data.stats[k].toLocaleString() : m));
  return <div className="stack" style={{ gap: 16 }}>
    <Card title="Stats channels" subtitle={<>Channel names that show live numbers, refreshed every 10 minutes. Placeholders: {STAT_KEYS.map((k) => <code key={k} className="mono">{`{${k}}`} </code>)}. Tip: Quick Setup → Live server stats creates locked voice channels for this.</>}>
      <div className="row"><div className="grow"><ChannelSelect kind="any" value={add} onChange={setAdd} placeholder="Choose a channel to turn into a counter…" /></div>
        <Button variant="primary" icon={<I.plus />} disabled={!add || list.some((r) => r.channelId === add) || list.length >= 10} onClick={() => { cfg.set("statsChannels", [...list, { channelId: add!, template: "👥 Members: {members}" }]); setAdd(null); }}>Add counter</Button></div>
    </Card>
    {!list.length ? <Card><Empty title="No stats channels" /></Card> : <Card>{list.map((x, i) => <div key={x.channelId} className="grid mt" style={{ gridTemplateColumns: "1fr 1fr 1fr auto", alignItems: "center" }}>
      <ChannelSelect kind="any" value={x.channelId} allowNone={false} onChange={(v) => v && cfg.set("statsChannels", list.map((r, j) => (j === i ? { ...r, channelId: v } : r)))} />
      <Input value={x.template} maxLength={100} onChange={(e) => cfg.set("statsChannels", list.map((r, j) => (j === i ? { ...r, template: e.target.value } : r)))} />
      <span className="small muted">→ {render(x.template)}</span>
      <Button size="sm" variant="ghost" icon={<I.trash />} onClick={() => cfg.set("statsChannels", list.filter((_, j) => j !== i))} />
    </div>)}</Card>}
  </div>;
}

function Invites({ c }: P) {
  const s = useSummary();
  return <div className="grid g2">
    <Card title="Top inviters" subtitle="Members still in the server vs. everyone they brought in.">
      {!c.logging.inviteTracking && <div className="small mb" style={{ color: "#f59e0b" }}>Invite tracking is off — enable it under Server logs.</div>}
      {!s.data ? <Skeleton h={200} /> : !s.data.inviters.length ? <Empty title="No tracked invites yet">New joins are tracked from now on.</Empty> : s.data.inviters.map((x, n) => <div key={x.inviterId} className="list-item"><b>{n + 1}.</b><span className="grow mono small">{x.inviterId}</span><Chip tone="ok">{x.active} here</Chip><span className="small faint">{x.total} total</span></div>)}
    </Card>
    <Card title="Tracking"><div className="stack" style={{ gap: 8 }}>
      <div className="row between"><span className="muted">Joins tracked</span><b>{s.data?.inviteStats.tracked ?? "—"}</b></div>
      <div className="row between"><span className="muted">Invite unknown</span><b>{s.data?.inviteStats.unknown ?? "—"}</b></div>
      <div className="small faint">Use <code>/invites leaderboard</code> and <code>/invites who</code> in Discord. Use the “Role for a specific invite” automation recipe to reward partner links.</div>
    </div></Card>
  </div>;
}
