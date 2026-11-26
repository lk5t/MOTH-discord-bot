"use client";
import { useEffect, useState } from "react";
import type { MessageTemplate, EmbedData } from "@moth/core/shared";
import { PLACEHOLDER_HELP } from "@moth/core/shared";
import { Button, Field, Input, Textarea, Switch } from "./ui";
import { api, useDebounced } from "./hooks";
import { useGuild } from "./guild";
import { I } from "./icons";

/** Visual message + embed builder with live Discord-style preview (placeholders rendered server-side). */
export function MessageEditor({ value, onChange, allowContent = true }: { value: MessageTemplate; onChange: (v: MessageTemplate) => void; allowContent?: boolean }) {
  const { guildId } = useGuild();
  const embed: EmbedData = value.embed ?? {};
  const hasEmbed = !!value.embed;
  const setEmbed = (p: Partial<EmbedData>) => onChange({ ...value, embed: { ...embed, ...p } });
  const [preview, setPreview] = useState<MessageTemplate | null>(null);
  const debounced = useDebounced(value, 350);
  useEffect(() => { api<MessageTemplate>(`/api/guilds/${guildId}/preview/message`, { body: { message: debounced } }).then(setPreview).catch(() => setPreview(debounced)); }, [debounced, guildId]);
  const fields = embed.fields ?? [];
  return (
    <div className="grid g2">
      <div className="stack">
        {allowContent && <Field label="Message text" hint="Supports placeholders and Discord markdown."><Textarea value={value.content ?? ""} maxLength={2000} onChange={(e) => onChange({ ...value, content: e.target.value || undefined })} /></Field>}
        <div className="row between"><span className="field-label">Embed</span><Switch checked={hasEmbed} onChange={(v) => onChange({ ...value, embed: v ? { color: "#DC143C", title: "", description: "" } : undefined })} label="Use embed" /></div>
        {hasEmbed && <>
          <div className="grid" style={{ gridTemplateColumns: "1fr 110px" }}>
            <Field label="Title"><Input value={embed.title ?? ""} maxLength={256} onChange={(e) => setEmbed({ title: e.target.value || undefined })} /></Field>
            <Field label="Colour"><Input type="color" value={embed.color?.startsWith("#") ? embed.color : `#${embed.color ?? "DC143C"}`} onChange={(e) => setEmbed({ color: e.target.value })} style={{ padding: 4, height: 38 }} /></Field>
          </div>
          <Field label="Description"><Textarea value={embed.description ?? ""} maxLength={4096} rows={5} onChange={(e) => setEmbed({ description: e.target.value || undefined })} /></Field>
          <div className="grid g2">
            <Field label="Thumbnail URL"><Input value={embed.thumbnail ?? ""} placeholder="https://… or {user.avatar}" onChange={(e) => setEmbed({ thumbnail: e.target.value || undefined })} /></Field>
            <Field label="Image URL"><Input value={embed.image ?? ""} placeholder="https://…" onChange={(e) => setEmbed({ image: e.target.value || undefined })} /></Field>
          </div>
          <Field label="Footer"><Input value={embed.footer ?? ""} maxLength={2048} onChange={(e) => setEmbed({ footer: e.target.value || undefined })} /></Field>
          <div className="stack" style={{ gap: 8 }}>
            {fields.map((f, i) => (
              <div key={i} className="grid" style={{ gridTemplateColumns: "1fr 1.4fr auto auto", alignItems: "center" }}>
                <Input placeholder="Field name" value={f.name} onChange={(e) => setEmbed({ fields: fields.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <Input placeholder="Value" value={f.value} onChange={(e) => setEmbed({ fields: fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <label className="row small faint"><input type="checkbox" checked={!!f.inline} onChange={(e) => setEmbed({ fields: fields.map((x, j) => (j === i ? { ...x, inline: e.target.checked } : x)) })} />inline</label>
                <Button size="sm" variant="ghost" onClick={() => setEmbed({ fields: fields.filter((_, j) => j !== i) })} icon={<I.trash />} />
              </div>
            ))}
            {fields.length < 25 && <div><Button size="sm" onClick={() => setEmbed({ fields: [...fields, { name: "", value: "" }] })} icon={<I.plus />}>Add field</Button></div>}
          </div>
        </>}
        <details className="small faint"><summary style={{ cursor: "pointer" }}>Available placeholders</summary><div className="grid g2" style={{ marginTop: 8, gap: 4 }}>{PLACEHOLDER_HELP.map((p) => <div key={p.key}><code>{p.key}</code> — {p.description}</div>)}</div></details>
      </div>
      <div>
        <div className="field-label" style={{ marginBottom: 6 }}>Preview</div>
        <DiscordPreview message={preview ?? value} />
      </div>
    </div>
  );
}

export function DiscordPreview({ message }: { message: MessageTemplate }) {
  const e = message.embed;
  return (
    <div className="discord-preview">
      <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div className="avatar" style={{ background: "linear-gradient(135deg,#dc143c,#7a0b22)", display: "grid", placeItems: "center", width: 40, height: 40 }}>🦋</div>
        <div className="grow">
          <div><b style={{ color: "#fff" }}>MOTH</b> <span style={{ background: "#5865f2", color: "#fff", fontSize: 10, padding: "1px 4px", borderRadius: 3, marginLeft: 4 }}>APP</span> <span style={{ fontSize: 12, color: "#949ba4", marginLeft: 6 }}>Today</span></div>
          {message.content && <div style={{ whiteSpace: "pre-wrap" }}>{message.content}</div>}
          {e && (e.title || e.description || e.fields?.length) && (
            <div className="embed" style={{ borderLeftColor: e.color ?? "#DC143C" }}>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  {e.author && <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{e.author}</div>}
                  {e.title && <div className="et">{e.title}</div>}
                  {e.description && <div className="ed">{e.description}</div>}
                  {!!e.fields?.length && <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>{e.fields.map((f, i) => <div key={i} style={{ gridColumn: f.inline ? "auto" : "1 / -1" }}><div style={{ fontWeight: 600, fontSize: 13, color: "#fff" }}>{f.name}</div><div style={{ fontSize: 13.5, whiteSpace: "pre-wrap" }}>{f.value}</div></div>)}</div>}
                </div>
                {e.thumbnail?.startsWith("http") && <img src={e.thumbnail} alt="" style={{ width: 72, height: 72, borderRadius: 4, objectFit: "cover" }} />}
              </div>
              {e.image?.startsWith("http") && <img src={e.image} alt="" style={{ maxWidth: "100%", borderRadius: 4, marginTop: 10 }} />}
              {e.footer && <div className="ef">{e.footer}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
