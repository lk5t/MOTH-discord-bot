"use client";
import { useGuild } from "./guild";
import { MultiPicker } from "./ui";

export function ChannelSelect({ value, onChange, kind = "text", placeholder = "Select a channel", allowNone = true }: { value: string | null | undefined; onChange: (v: string | null) => void; kind?: "text" | "category" | "voice" | "any"; placeholder?: string; allowNone?: boolean }) {
  const { channels } = useGuild();
  const list = channels.filter((c) => kind === "any" || (kind === "text" ? c.text && c.type !== "GuildCategory" && c.type !== "GuildVoice" : kind === "category" ? c.type === "GuildCategory" : c.type === "GuildVoice" || c.type === "GuildStageVoice"));
  const cats = new Map(channels.filter((c) => c.type === "GuildCategory").map((c) => [c.id, c.name]));
  const sorted = [...list].sort((a, b) => (cats.get(a.parentId ?? "") ?? "").localeCompare(cats.get(b.parentId ?? "") ?? "") || a.position - b.position);
  const known = !value || list.some((c) => c.id === value);
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">{placeholder}</option>}
      {!known && <option value={value!}>Unknown channel ({value})</option>}
      {sorted.map((c) => <option key={c.id} value={c.id}>{kind === "category" ? c.name : `${c.type === "GuildVoice" ? "🔊" : "#"} ${c.name}${c.parentId && cats.get(c.parentId) ? `  ·  ${cats.get(c.parentId)}` : ""}`}</option>)}
    </select>
  );
}

export function ChannelMulti({ value, onChange, placeholder, kind }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; kind?: "voice" | "text" }) {
  const { channels } = useGuild();
  const isVoice = (t: string) => t === "GuildVoice" || t === "GuildStageVoice";
  return <MultiPicker value={value} onChange={onChange} placeholder={placeholder ?? "Add channels…"} options={channels.filter((c) => c.type !== "GuildCategory" && (!kind || (kind === "voice" ? isVoice(c.type) : !isVoice(c.type)))).map((c) => ({ value: c.id, label: `${c.type === "GuildVoice" ? "🔊 " : "#"}${c.name}` }))} />;
}

export function RoleSelect({ value, onChange, placeholder = "Select a role", allowNone = true }: { value: string | null | undefined; onChange: (v: string | null) => void; placeholder?: string; allowNone?: boolean }) {
  const { roles } = useGuild();
  return (
    <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">{placeholder}</option>}
      {roles.filter((r) => !r.everyone && !r.managed).map((r) => <option key={r.id} value={r.id}>@{r.name}{r.editable ? "" : " (above MOTH)"}</option>)}
    </select>
  );
}

export function RoleMulti({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const { roles } = useGuild();
  return <MultiPicker value={value} onChange={onChange} placeholder={placeholder ?? "Add roles…"} options={roles.filter((r) => !r.everyone && !r.managed).map((r) => ({ value: r.id, label: r.name, color: r.color === "#000000" ? "#99aab5" : r.color }))} />;
}

export function useNames() {
  const { channels, roles } = useGuild();
  return {
    channel: (id: string | null | undefined) => (id ? `#${channels.find((c) => c.id === id)?.name ?? id}` : "—"),
    role: (id: string | null | undefined) => (id ? `@${roles.find((r) => r.id === id)?.name ?? id}` : "—"),
  };
}
