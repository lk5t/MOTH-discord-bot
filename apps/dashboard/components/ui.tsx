"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I } from "./icons";

export function Card({ title, subtitle, actions, children, className = "", accent }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; accent?: boolean }) {
  return (
    <section className={`card ${accent ? "accent" : ""} ${className}`}>
      {(title || actions) && <div className="card-head"><div>{title && <h3>{title}</h3>}{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="row">{actions}</div>}</div>}
      {children}
    </section>
  );
}

export function Stat({ label, value, delta, icon }: { label: string; value: ReactNode; delta?: ReactNode; icon?: ReactNode }) {
  return <div className="card stat"><div className="row between"><div className="label">{label}</div>{icon && <span className="faint">{icon}</span>}</div><div className="value">{value}</div>{delta && <div className="delta">{delta}</div>}</div>;
}

export function PageHead({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-head"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="row wrap">{actions}</div>}</div>;
}

export function Button({ children, variant, size, loading, icon, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost"; size?: "sm"; loading?: boolean; icon?: ReactNode }) {
  return <button {...p} className={`btn ${variant ?? ""} ${size ?? ""} ${p.className ?? ""}`} disabled={p.disabled || loading}>{loading ? <I.refresh className="spin" /> : icon}{children}</button>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? "on" : ""}`} onClick={() => onChange(!checked)} />;
}

export function ToggleRow({ title, description, checked, onChange, disabled }: { title: string; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <div className="toggle-row"><div><div className="t">{title}</div>{description && <div className="d">{description}</div>}</div><Switch checked={checked} onChange={onChange} disabled={disabled} label={title} /></div>;
}

export function Field({ label, hint, children, className = "" }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return <div className={`field ${className}`}>{label && <label>{label}</label>}{children}{hint && <div className="hint">{hint}</div>}</div>;
}

export function Input(p: React.InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={`input ${p.className ?? ""}`} />; }
export function Textarea(p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea {...p} className={`textarea ${p.className ?? ""}`} />; }
export function Select({ options, value, onChange, placeholder, disabled }: { options: { value: string; label: string }[]; value: string | null | undefined; onChange: (v: string) => void; placeholder?: string; disabled?: boolean }) {
  return <select className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}>{placeholder !== undefined && <option value="">{placeholder}</option>}{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
}
export function NumberInput({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return <input type="number" className="input" value={Number.isFinite(value) ? value : ""} min={min} max={max} step={step} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(max !== undefined ? Math.min(max, Math.max(min ?? -Infinity, n)) : n); }} />;
}

export function Seg<T extends string>({ value, options, onChange, crimson }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; crimson?: boolean }) {
  return <div className="seg">{options.map((o) => <button type="button" key={o.value} className={`${value === o.value ? "on" : ""} ${crimson ? "crim" : ""}`} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.value} role="tab" aria-selected={value === t.value} className={value === t.value ? "on" : ""} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function Chip({ children, tone, onRemove }: { children: ReactNode; tone?: "crim" | "ok" | "warn" | "info"; onRemove?: () => void }) {
  return <span className={`chip ${tone ?? ""}`}>{children}{onRemove && <I.x className="x" width={12} height={12} onClick={onRemove} />}</span>;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty">{icon}<div style={{ color: "var(--text-2)", fontWeight: 500 }}>{title}</div>{children && <div className="small" style={{ marginTop: 6 }}>{children}</div>}</div>;
}

export function Skeleton({ h = 18, w = "100%" }: { h?: number; w?: number | string }) { return <div className="skeleton" style={{ height: h, width: w }} />; }

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal><h2>{title}</h2>{children}{footer && <div className="modal-foot">{footer}</div>}</div></div>;
}

// ─── Confirm dialog (for destructive operations) ───
type ConfirmOpts = { title: string; body: ReactNode; confirm?: string; danger?: boolean; typeToConfirm?: string };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

// ─── Toasts ───
type Toast = { id: number; msg: string; error?: boolean };
const ToastCtx = createContext<(msg: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Providers({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toast = useCallback((msg: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3500);
  }, []);
  const [pending, setPending] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [typed, setTyped] = useState("");
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => { setTyped(""); setPending({ ...o, resolve }); }), []);
  const close = (v: boolean) => { pending?.resolve(v); setPending(null); };
  return (
    <ToastCtx.Provider value={toast}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <Modal open={!!pending} onClose={() => close(false)} title={pending?.title ?? ""} footer={<>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant={pending?.danger ? "danger" : "primary"} disabled={!!pending?.typeToConfirm && typed !== pending.typeToConfirm} onClick={() => close(true)}>{pending?.confirm ?? "Confirm"}</Button>
        </>}>
          <div className="muted">{pending?.body}</div>
          {pending?.typeToConfirm && <Field className="mt" label={<>Type <span className="kbd">{pending.typeToConfirm}</span> to confirm</>}><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus /></Field>}
        </Modal>
        <div className="toasts" aria-live="polite">{toasts.map((t) => <div key={t.id} className={`toast ${t.error ? "error" : ""}`}>{t.msg}</div>)}</div>
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  );
}

export function SaveBar({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return <div className="savebar"><div className="row"><span className="dot warn pulse" /> <span>You have unsaved changes</span></div><div className="row"><Button variant="ghost" onClick={onReset}>Reset</Button><Button variant="primary" loading={saving} onClick={onSave} icon={<I.check />}>Save changes</Button></div></div>;
}

/** Tag-style multi-select with search. */
export function MultiPicker({ options, value, onChange, placeholder, renderOption }: { options: { value: string; label: string; color?: string; hint?: string }[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; renderOption?: (o: { value: string; label: string; color?: string }) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, []);
  const byId = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const filtered = options.filter((o) => !value.includes(o.value) && o.label.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  return (
    <div className="multi" ref={ref}>
      <div className="multi-box" onClick={() => setOpen(true)}>
        {value.map((v) => { const o = byId.get(v); return <Chip key={v} onRemove={() => onChange(value.filter((x) => x !== v))}>{o?.color && <i style={{ width: 8, height: 8, borderRadius: 9, background: o.color, display: "inline-block" }} />}{o?.label ?? `Unknown (${v.slice(-4)})`}</Chip>; })}
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} placeholder={value.length ? "" : placeholder ?? "Select…"} onKeyDown={(e) => { if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1)); if (e.key === "Enter" && filtered[0]) { e.preventDefault(); onChange([...value, filtered[0].value]); setQ(""); } }} />
      </div>
      {open && filtered.length > 0 && <div className="dropdown">{filtered.map((o) => <div key={o.value} className="opt" onMouseDown={(e) => { e.preventDefault(); onChange([...value, o.value]); setQ(""); }}>{renderOption ? renderOption(o) : <>{o.color && <i style={{ width: 9, height: 9, borderRadius: 9, background: o.color }} />}{o.label}{o.hint && <span className="faint small">{o.hint}</span>}</>}</div>)}</div>}
    </div>
  );
}

export function Progress({ value }: { value: number }) { return <div className="progress"><div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>; }
