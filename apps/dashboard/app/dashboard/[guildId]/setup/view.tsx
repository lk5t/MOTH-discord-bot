"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SETUP_PACKS, setupRecommendations } from "@moth/core/shared";
import { useGuild, useGuildConfig } from "@/components/guild";
import { api, timeAgo, useApi } from "@/components/hooks";
import { Button, Card, Chip, Empty, PageHead, SaveBar, Skeleton, Switch, ToggleRow, useConfirm, useToast } from "@/components/ui";
import { I } from "@/components/icons";

type Item = { pack: string; kind: string; name: string; action: "create" | "reuse" | "configure" | "publish" };
type Result = { items: Item[]; notes: string[]; errors: string[]; backupId?: string };

const SEV = { high: "crim", medium: "warn", low: undefined } as const;
const ACTION = { create: { label: "create", tone: "crim" }, reuse: { label: "reuse", tone: "ok" }, configure: { label: "configure", tone: "info" }, publish: { label: "post", tone: "info" } } as const;

export function SetupView() {
  const { guildId, refreshDiscord } = useGuild();
  const cfg = useGuildConfig();
  const toast = useToast(); const confirm = useConfirm();
  const recs = useMemo(() => (cfg.config ? setupRecommendations(cfg.config) : []), [cfg.config]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? [...new Set(recs.filter((r) => r.severity !== "low").map((r) => r.pack))];
  const [preview, setPreview] = useState<Result | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);

  const toggle = (k: string) => { setPreview(null); setResult(null); setPicked(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]); };
  async function run(dry: boolean) {
    setBusy(dry ? "preview" : "apply");
    try {
      const r = await api<Result>(`/api/guilds/${guildId}/setup`, { body: { packs: selected, dry } });
      if (dry) setPreview(r);
      else { setResult(r); setPreview(null); refreshDiscord(); toast(r.errors.length ? "Setup finished with warnings" : "Setup complete"); }
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  }
  async function apply() {
    const creates = (preview?.items ?? []).filter((i) => i.action === "create").length;
    if (!(await confirm({ title: "Apply setup?", confirm: "Apply", body: <>MOTH will {creates ? <>create <b>{creates}</b> channel(s)/role(s), </> : null}reuse what you already have and update the configuration. A backup is taken first, so you can restore it from Server Settings → Backups.</> }))) return;
    await run(false);
  }

  return (
    <>
      <PageHead title="Quick Setup" description="Set up a complete, well-protected server in one click. MOTH reuses your existing channels and roles and only creates what's missing." />
      <Autopilot />
      <Card accent title="Health check" subtitle="What this server is missing, most important first." className="mb">
        {!cfg.config ? <Skeleton h={120} /> : !recs.length ? <Empty icon={<I.check />} title="Everything essential is set up">Fine-tune individual features in Server Tools.</Empty> : (
          <div className="stack" style={{ gap: 4 }}>{recs.map((r) => {
            const pack = SETUP_PACKS.find((p) => p.key === r.pack)!;
            return <div key={r.key} className="list-item">
              <Chip tone={SEV[r.severity]}>{r.severity}</Chip>
              <div className="grow"><div><b>{r.title}</b></div><div className="small faint">{r.detail}</div></div>
              <Button size="sm" variant={selected.includes(r.pack) ? "primary" : undefined} onClick={() => toggle(r.pack)} icon={selected.includes(r.pack) ? <I.check /> : <I.plus />}>{pack.icon} {pack.name}</Button>
            </div>;
          })}</div>
        )}
      </Card>

      <div className="grid g3">
        {SETUP_PACKS.map((p) => {
          const on = selected.includes(p.key);
          return <div key={p.key} className={`card pack ${on ? "on" : ""}`} role="button" tabIndex={0} onClick={() => toggle(p.key)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggle(p.key))} style={{ cursor: "pointer", borderColor: on ? "var(--crimson)" : undefined }}>
            <div className="row between"><div className="row"><span style={{ fontSize: 22 }}>{p.icon}</span><b>{p.name}</b></div><input type="checkbox" readOnly checked={on} aria-label={p.name} /></div>
            <div className="small muted mt">{p.description}</div>
            <ul className="small faint" style={{ margin: "10px 0 0", paddingLeft: 18 }}>{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
          </div>;
        })}
      </div>

      <div className="row mt wrap" style={{ justifyContent: "flex-end", position: "sticky", bottom: 12, zIndex: 5, background: "var(--bg-2)", border: "1px solid var(--line-2)", borderRadius: "var(--radius-lg)", padding: "10px 12px", boxShadow: "var(--shadow)" }}>
        <span className="small faint grow">{selected.length ? `${selected.length} pack(s) selected` : "Select at least one pack"}</span>
        <Button onClick={() => run(true)} loading={busy === "preview"} disabled={!selected.length || !!busy}>Preview changes</Button>
        <Button variant="primary" onClick={preview ? apply : () => run(true)} loading={busy === "apply"} disabled={!selected.length || !!busy} icon={<I.setup />}>{preview ? "Apply setup" : "Preview & apply"}</Button>
      </div>

      {(preview || result) && <Card className="mt" title={result ? (result.errors.length ? "Setup finished with warnings" : "✅ Setup complete") : "Preview"} subtitle={result ? "Everything below is live in Discord now." : "Nothing has changed yet — review and press Apply setup."}
        actions={result && <Link className="btn sm" href={`/dashboard/${guildId}/tools`}><I.tools /> Fine-tune in Server Tools</Link>}>
        {SETUP_PACKS.filter((p) => (result ?? preview)!.items.some((i) => i.pack === p.key)).map((p) => <div key={p.key} className="mb">
          <div className="field-label">{p.icon} {p.name}</div>
          <div className="row wrap">{(result ?? preview)!.items.filter((i) => i.pack === p.key).map((i, n) => <Chip key={n} tone={ACTION[i.action].tone}>{ACTION[i.action].label}: {i.name}</Chip>)}</div>
        </div>)}
        {[...new Set((result ?? preview)!.notes)].map((n) => <div key={n} className="small muted mt">ℹ️ {n}</div>)}
        {(result ?? preview)!.errors.map((e) => <div key={e} className="small mt" style={{ color: "#ff6b85" }}>⚠️ {e}</div>)}
      </Card>}
    </>
  );
}

type Report = { at: string; reason: string; actions: string[] };
function Autopilot() {
  const { guildId } = useGuild();
  const cfg = useGuildConfig();
  const toast = useToast();
  const q = useApi<{ last: Report | null }>(`/api/guilds/${guildId}/autopilot`, { refreshMs: 30_000 });
  const [busy, setBusy] = useState(false);
  if (!cfg.config) return <Skeleton h={160} />;
  const a = cfg.config.autopilot;
  const set = (p: Partial<typeof a>) => cfg.update("autopilot", p);
  async function runNow() {
    setBusy(true);
    try { const r = await api<Report>(`/api/guilds/${guildId}/autopilot/run`, { body: {} }); toast(r.actions.length ? `Autopilot made ${r.actions.length} fix(es)` : "Everything already in order"); void q.reload(); }
    catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }
  const last = q.data?.last;
  return <Card className="mb" title="🤖 Autopilot" subtitle="Keeps your server organised, locked and repaired on its own — a few seconds after anything changes, and every 30 minutes." actions={<><Button size="sm" onClick={runNow} loading={busy}>Run now</Button><Switch checked={a.enabled} onChange={(v) => set({ enabled: v })} /></>}>
    <div className="grid g2">
      <div>
        <ToggleRow title="Keep the layout organised" description="Start Here first, staff and archive last; welcome → rules → info → roles at the top of each category — also for channels added later" checked={a.organiseLayout} onChange={(v) => set({ organiseLayout: v })} disabled={!a.enabled} />
        <ToggleRow title="Lock new channels behind verification" description="When verification is on, every new channel is hidden from unverified members" checked={a.gateNewChannels} onChange={(v) => set({ gateNewChannels: v })} disabled={!a.enabled} />
        <ToggleRow title="Self-repair" description="Re-post deleted verification, ticket and role-menu panels; recreate deleted log channels; clean up settings for deleted channels" checked={a.repair} onChange={(v) => set({ repair: v })} disabled={!a.enabled} />
      </div>
      <div>
        <ToggleRow title="Give roles back on rejoin" description="Members who leave and come back within 30 days get their roles back (never admin or moderator roles)" checked={a.restoreRoles} onChange={(v) => set({ restoreRoles: v })} disabled={!a.enabled} />
        <ToggleRow title="Dehoist names" description="Remove symbols people put in front of their name to sit at the top of the member list" checked={a.dehoist} onChange={(v) => set({ dehoist: v })} disabled={!a.enabled} />
        <div className="small faint mt">{last ? <>Last check {timeAgo(last.at)} ({last.reason}): {last.actions.length ? last.actions.join(" · ") : "nothing needed fixing"}</> : "No checks yet."}</div>
      </div>
    </div>
    <SaveBar dirty={cfg.dirty} saving={cfg.saving} onSave={cfg.save} onReset={cfg.reset} />
  </Card>;
}
