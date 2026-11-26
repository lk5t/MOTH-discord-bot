"use client";
import { useMemo, useRef, useState } from "react";

export interface Series { key: string; label: string; color: string; values: number[] }

/** Responsive SVG area/line chart with hover tooltip. */
export function LineChart({ labels, series, height = 220, area = true, format = (n: number) => n.toLocaleString() }: { labels: string[]; series: Series[]; height?: number; area?: boolean; format?: (n: number) => string }) {
  const W = 800, H = height, P = { l: 40, r: 12, t: 10, b: 26 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => P.l + (i / n) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - v / top) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * top);
  const step = Math.ceil(labels.length / 8);
  const id = useMemo(() => Math.random().toString(36).slice(2), []);
  if (!labels.length) return <div className="empty small">No data yet — activity appears here as MOTH collects it.</div>;
  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }}
        onMouseMove={(e) => { const r = ref.current!.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(labels.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * n)))); }}
        onMouseLeave={() => setHover(null)}>
        <defs>{series.map((s) => <linearGradient key={s.key} id={`g-${id}-${s.key}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.35} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
        {ticks.map((t) => <g key={t}><line className="grid-line" x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} /><text className="axis" x={P.l - 6} y={y(t) + 3} textAnchor="end">{t >= 1000 ? `${(t / 1000).toFixed(t >= 10000 ? 0 : 1)}k` : Math.round(t)}</text></g>)}
        {labels.map((l, i) => i % step === 0 && <text key={i} className="axis" x={x(i)} y={H - 6} textAnchor="middle">{l}</text>)}
        {series.map((s) => {
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return <g key={s.key}>
            {area && <polygon className="area" fill={`url(#g-${id}-${s.key})`} points={`${x(0)},${y(0)} ${pts} ${x(s.values.length - 1)},${y(0)}`} />}
            <polyline className="line" stroke={s.color} points={pts} vectorEffect="non-scaling-stroke" />
          </g>;
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />}
        {hover !== null && series.map((s) => <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} fill={s.color} stroke="var(--bg)" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {hover !== null && (
        <div style={{ position: "absolute", top: 4, left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > labels.length / 2 ? "-105%" : "5%"})`, background: "var(--bg-3)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 10px", fontSize: 12, pointerEvents: "none", whiteSpace: "nowrap", boxShadow: "0 8px 24px rgba(0,0,0,.4)" }}>
          <div className="faint" style={{ marginBottom: 4 }}>{labels[hover]}</div>
          {series.map((s) => <div key={s.key}><i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />{s.label}: <b>{format(s.values[hover] ?? 0)}</b></div>)}
        </div>
      )}
      {series.length > 1 && <div className="legend" style={{ marginTop: 8 }}>{series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>}
    </div>
  );
}

export function BarList({ items, format = (n: number) => n.toLocaleString() }: { items: { label: string; value: number }[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <div className="empty small">No data</div>;
  return <div>{items.map((i) => <div key={i.label} className="bar-row"><div className="small muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={i.label}>{i.label}</div><div className="bar-track"><div className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} /></div><div className="small right mono">{format(i.value)}</div></div>)}</div>;
}

export function Columns({ labels, values, height = 140, color = "var(--crimson)" }: { labels: string[]; values: number[]; height?: number; color?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height }}>
      {values.map((v, i) => <div key={i} title={`${labels[i]}: ${v}`} style={{ flex: 1, height: `${Math.max(2, (v / max) * 100)}%`, background: color, opacity: 0.35 + 0.65 * (v / max), borderRadius: "3px 3px 0 0", transition: "height .5s var(--ease)" }} />)}
    </div>
  );
}

export function Heatmap({ cells }: { cells: { dow: number; h: number; n: number }[] }) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const c of cells) grid[Number(c.dow)][Number(c.h)] = Number(c.n);
  const max = Math.max(1, ...grid.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (
    <div className="heat">
      <div />{Array.from({ length: 24 }, (_, h) => <div key={h} style={{ textAlign: "center" }}>{h % 6 === 0 ? h : ""}</div>)}
      {grid.map((row, d) => [<div key={`l${d}`}>{days[d]}</div>, ...row.map((v, h) => <div key={`${d}-${h}`} className="c" title={`${days[d]} ${h}:00 UTC — ${v} messages`} style={{ background: v ? `rgba(220,20,60,${0.12 + 0.88 * (v / max)})` : undefined }} />)])}
    </div>
  );
}

export function Donut({ parts, size = 120 }: { parts: { label: string; value: number; color: string }[]; size?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  let acc = 0;
  const stops = parts.map((p) => { const s = (acc / total) * 100; acc += p.value; return `${p.color} ${s}% ${(acc / total) * 100}%`; }).join(", ");
  return (
    <div className="row" style={{ gap: 20 }}>
      <div style={{ width: size, height: size, borderRadius: "50%", background: parts.length ? `conic-gradient(${stops})` : "var(--bg-3)", position: "relative", flex: "none" }}><div style={{ position: "absolute", inset: size * 0.18, borderRadius: "50%", background: "var(--bg-2)", display: "grid", placeItems: "center", fontFamily: "var(--font-display)", fontSize: 20 }}>{parts.reduce((a, p) => a + p.value, 0)}</div></div>
      <div className="legend" style={{ flexDirection: "column", gap: 6 }}>{parts.map((p) => <span key={p.label}><i style={{ background: p.color }} />{p.label} · <b>{p.value}</b></span>)}</div>
    </div>
  );
}
