"use client";
import type { AutomationAction, AutomationCondition, AutomationDefinition, AutomationStep, AutomationTrigger, MessageTemplate } from "@moth/core/shared";
import { ACTION_LABELS, CONDITION_LABELS, TRIGGER_LABELS } from "@moth/core/shared";
import { Button, Field, Input, NumberInput, Select, Switch } from "@/components/ui";
import { ChannelMulti, ChannelSelect, RoleSelect } from "@/components/pickers";
import { MessageEditor } from "@/components/embed-editor";
import { I } from "@/components/icons";

const uid = () => Math.random().toString(36).slice(2, 10);
const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ value, label }));

export const defaultTrigger = (type: AutomationTrigger["type"]): AutomationTrigger => {
  switch (type) {
    case "message": return { type, match: "contains", pattern: "", channelIds: [], ignoreBots: true };
    case "reaction_add": return { type, emoji: "", channelIds: [] };
    case "role_added": case "role_removed": return { type, roleId: "" };
    case "voice_join": case "voice_leave": return { type, channelIds: [] };
    case "schedule": return { type, cron: "0 12 * * *", timezone: "UTC" };
    case "level_up": return { type };
    default: return { type } as AutomationTrigger;
  }
};
const defaultAction = (type: AutomationAction["type"]): AutomationAction => {
  const msg: MessageTemplate = { content: "Hello {user}!" };
  switch (type) {
    case "send_message": return { type, message: msg }; case "send_dm": return { type, message: msg }; case "reply": return { type, message: msg };
    case "add_role": case "remove_role": return { type, roleId: "" }; case "react": return { type, emoji: "👋" };
    case "timeout": return { type, minutes: 10, reason: "Automation" }; case "set_nickname": return { type, nickname: "{user.name}" };
    case "create_thread": return { type, name: "Discussion" }; case "log": return { type, message: "{user} triggered an automation" };
    case "set_channel_name": return { type, channelId: "", name: "Members: {server.members}" };
    case "add_xp": case "add_currency": return { type, amount: 10 };
    default: return { type } as AutomationAction;
  }
};
const defaultCondition = (type: AutomationCondition["type"]): AutomationCondition => {
  switch (type) {
    case "has_role": case "missing_role": return { type, roleId: "" }; case "in_channel": return { type, channelIds: [] };
    case "account_age_days": return { type, op: "gt", days: 7 }; case "message_matches": return { type, regex: "" };
    case "chance": return { type, percent: 50 }; case "is_bot": return { type, value: false };
    case "member_count": return { type, op: "gt", value: 100 }; case "level_at_least": return { type, level: 5 };
  }
};

function TriggerForm({ t, set }: { t: AutomationTrigger; set: (t: AutomationTrigger) => void }) {
  return <div className="stack" style={{ gap: 10 }}>
    <Field label="When…"><Select value={t.type} onChange={(v) => set(defaultTrigger(v as AutomationTrigger["type"]))} options={opts(TRIGGER_LABELS)} /></Field>
    {t.type === "message" && <><div className="grid g2"><Field label="Match"><Select value={t.match} onChange={(v) => set({ ...t, match: v as "any" })} options={opts({ any: "Any message", contains: "Contains", starts_with: "Starts with", exact: "Exactly", regex: "Regex" })} /></Field>{t.match !== "any" && <Field label="Text"><Input value={t.pattern} onChange={(e) => set({ ...t, pattern: e.target.value })} /></Field>}</div><Field label="Only in channels" hint="Empty = everywhere"><ChannelMulti value={t.channelIds} onChange={(v) => set({ ...t, channelIds: v })} /></Field></>}
    {t.type === "reaction_add" && <div className="grid g2"><Field label="Emoji" hint="Empty = any"><Input value={t.emoji} onChange={(e) => set({ ...t, emoji: e.target.value })} /></Field><Field label="Message ID (optional)"><Input value={t.messageId ?? ""} onChange={(e) => set({ ...t, messageId: e.target.value || undefined })} /></Field></div>}
    {(t.type === "role_added" || t.type === "role_removed") && <Field label="Role"><RoleSelect value={t.roleId} onChange={(v) => set({ ...t, roleId: v ?? "" })} /></Field>}
    {(t.type === "voice_join" || t.type === "voice_leave") && <Field label="Voice channels" hint="Empty = any"><ChannelMulti value={t.channelIds} onChange={(v) => set({ ...t, channelIds: v })} /></Field>}
    {t.type === "schedule" && <div className="grid g2"><Field label="Cron expression" hint="min hour day month weekday — e.g. 0 18 * * 5 = Fridays 18:00"><Input className="mono" value={t.cron} onChange={(e) => set({ ...t, cron: e.target.value })} /></Field><Field label="Timezone"><Input value={t.timezone} onChange={(e) => set({ ...t, timezone: e.target.value })} /></Field></div>}
    {t.type === "level_up" && <Field label="Specific level" hint="Empty = any level"><Input type="number" value={t.level ?? ""} onChange={(e) => set({ ...t, level: e.target.value ? Number(e.target.value) : undefined })} /></Field>}
  </div>;
}

function ConditionForm({ c, set }: { c: AutomationCondition; set: (c: AutomationCondition) => void }) {
  return <div className="stack" style={{ gap: 10 }}>
    <Field label="Only if…"><Select value={c.type} onChange={(v) => set(defaultCondition(v as AutomationCondition["type"]))} options={opts(CONDITION_LABELS)} /></Field>
    {(c.type === "has_role" || c.type === "missing_role") && <Field label="Role"><RoleSelect value={c.roleId} onChange={(v) => set({ ...c, roleId: v ?? "" })} /></Field>}
    {c.type === "in_channel" && <Field label="Channels"><ChannelMulti value={c.channelIds} onChange={(v) => set({ ...c, channelIds: v })} /></Field>}
    {c.type === "account_age_days" && <div className="grid g2"><Select value={c.op} onChange={(v) => set({ ...c, op: v as "gt" })} options={opts({ gt: "Older than", lt: "Younger than" })} /><NumberInput value={c.days} onChange={(v) => set({ ...c, days: v })} /></div>}
    {c.type === "message_matches" && <Field label="Regex"><Input className="mono" value={c.regex} onChange={(e) => set({ ...c, regex: e.target.value })} /></Field>}
    {c.type === "chance" && <Field label="Percent"><NumberInput value={c.percent} min={0} max={100} onChange={(v) => set({ ...c, percent: v })} /></Field>}
    {c.type === "is_bot" && <div className="row"><Switch checked={c.value} onChange={(v) => set({ ...c, value: v })} /> <span className="small">{c.value ? "is a bot" : "is not a bot"}</span></div>}
    {c.type === "member_count" && <div className="grid g2"><Select value={c.op} onChange={(v) => set({ ...c, op: v as "gt" })} options={opts({ gt: "More than", lt: "Fewer than" })} /><NumberInput value={c.value} onChange={(v) => set({ ...c, value: v })} /></div>}
    {c.type === "level_at_least" && <NumberInput value={c.level} min={0} onChange={(v) => set({ ...c, level: v })} />}
  </div>;
}

export function ActionForm({ a, set }: { a: AutomationAction; set: (a: AutomationAction) => void }) {
  return <div className="stack" style={{ gap: 10 }}>
    <Field label="Do…"><Select value={a.type} onChange={(v) => set(defaultAction(v as AutomationAction["type"]))} options={opts(ACTION_LABELS)} /></Field>
    {a.type === "send_message" && <Field label="Channel" hint="Empty = the channel that triggered it"><ChannelSelect value={a.channelId} onChange={(v) => set({ ...a, channelId: v ?? undefined })} placeholder="Trigger channel" /></Field>}
    {(a.type === "send_message" || a.type === "send_dm" || a.type === "reply") && <MessageEditor value={a.message} onChange={(m) => set({ ...a, message: m })} />}
    {(a.type === "add_role" || a.type === "remove_role") && <Field label="Role"><RoleSelect value={a.roleId} onChange={(v) => set({ ...a, roleId: v ?? "" })} /></Field>}
    {a.type === "react" && <Field label="Emoji"><Input value={a.emoji} onChange={(e) => set({ ...a, emoji: e.target.value })} /></Field>}
    {a.type === "timeout" && <div className="grid g2"><Field label="Minutes"><NumberInput value={a.minutes} min={1} max={40320} onChange={(v) => set({ ...a, minutes: v })} /></Field><Field label="Reason"><Input value={a.reason} onChange={(e) => set({ ...a, reason: e.target.value })} /></Field></div>}
    {a.type === "set_nickname" && <Field label="Nickname"><Input value={a.nickname} maxLength={32} onChange={(e) => set({ ...a, nickname: e.target.value })} /></Field>}
    {a.type === "create_thread" && <Field label="Thread name"><Input value={a.name} onChange={(e) => set({ ...a, name: e.target.value })} /></Field>}
    {a.type === "log" && <Field label="Log message"><Input value={a.message} onChange={(e) => set({ ...a, message: e.target.value })} /></Field>}
    {a.type === "set_channel_name" && <div className="grid g2"><Field label="Channel"><ChannelSelect kind="any" value={a.channelId} onChange={(v) => set({ ...a, channelId: v ?? "" })} /></Field><Field label="New name" hint="{server.members} supported"><Input value={a.name} onChange={(e) => set({ ...a, name: e.target.value })} /></Field></div>}
    {(a.type === "add_xp" || a.type === "add_currency") && <Field label="Amount"><NumberInput value={a.amount} onChange={(v) => set({ ...a, amount: v })} /></Field>}
  </div>;
}

/** Visual workflow builder: trigger → ordered condition/action/delay nodes. */
export function WorkflowBuilder({ def, onChange }: { def: AutomationDefinition; onChange: (d: AutomationDefinition) => void }) {
  const setStep = (i: number, s: AutomationStep) => onChange({ ...def, steps: def.steps.map((x, j) => (j === i ? s : x)) });
  const insert = (i: number, s: AutomationStep) => { const steps = [...def.steps]; steps.splice(i, 0, s); onChange({ ...def, steps }); };
  const move = (i: number, d: number) => { const steps = [...def.steps]; const [x] = steps.splice(i, 1); steps.splice(i + d, 0, x); onChange({ ...def, steps }); };
  const Adder = ({ at }: { at: number }) => <div className="flow-add">
    <Button size="sm" variant="ghost" onClick={() => insert(at, { kind: "condition", id: uid(), condition: defaultCondition("has_role"), negate: false })}>+ Condition</Button>
    <Button size="sm" variant="ghost" onClick={() => insert(at, { kind: "action", id: uid(), action: defaultAction("send_message") })}>+ Action</Button>
    <Button size="sm" variant="ghost" onClick={() => insert(at, { kind: "delay", id: uid(), seconds: 60 })}>+ Delay</Button>
  </div>;
  return (
    <div className="flow">
      <div className="flow-node trigger"><div className="row between mb"><b>⚡ Trigger</b><span className="small faint">Cooldown <input type="number" min={0} value={def.cooldownSeconds} onChange={(e) => onChange({ ...def, cooldownSeconds: Math.max(0, Number(e.target.value)) })} className="input" style={{ width: 80, display: "inline-block", padding: "4px 8px", marginLeft: 6 }} />s</span></div><TriggerForm t={def.trigger} set={(t) => onChange({ ...def, trigger: t })} /></div>
      {def.steps.map((s, i) => (
        <div key={s.id}>
          <div className="flow-link" /><Adder at={i} />
          <div className={`flow-node ${s.kind}`}>
            <div className="row between mb">
              <b>{s.kind === "condition" ? "🔀 Condition" : s.kind === "delay" ? "⏱ Delay" : "▶ Action"}</b>
              <div className="row" style={{ gap: 2 }}>
                {s.kind === "condition" && <label className="row small faint" style={{ marginRight: 8 }}><input type="checkbox" checked={s.negate} onChange={(e) => setStep(i, { ...s, negate: e.target.checked })} />NOT</label>}
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} icon={<I.arrowUp />} />
                <Button size="sm" variant="ghost" disabled={i === def.steps.length - 1} onClick={() => move(i, 1)} icon={<I.arrowDown />} />
                <Button size="sm" variant="ghost" onClick={() => onChange({ ...def, steps: def.steps.filter((_, j) => j !== i) })} icon={<I.trash />} />
              </div>
            </div>
            {s.kind === "condition" && <ConditionForm c={s.condition} set={(c) => setStep(i, { ...s, condition: c })} />}
            {s.kind === "action" && <ActionForm a={s.action} set={(a) => setStep(i, { ...s, action: a })} />}
            {s.kind === "delay" && <Field label="Wait (seconds)" hint="Max 15 minutes inside a run"><NumberInput value={s.seconds} min={1} max={86400} onChange={(v) => setStep(i, { ...s, seconds: v })} /></Field>}
          </div>
        </div>
      ))}
      <div className="flow-link" /><Adder at={def.steps.length} />
    </div>
  );
}
