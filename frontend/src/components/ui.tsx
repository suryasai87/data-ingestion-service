import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { AlertTriangle, CheckCircle2, Circle, Database, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { ButtonHTMLAttributes, ReactNode, useEffect, useId, useRef } from "react";
import type { CheckResult, RequestStatus, Tier } from "@/lib/types";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({ children, className, as: As = "div", ...rest }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" } & Record<string, unknown>) {
  return <As className={cx("rounded-lg border bg-card text-card-foreground", className)} {...rest}>{children}</As>;
}

export function PageHeader({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-6">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.14em] text-primary">{eyebrow}</div>}
        <h1 className="text-[length:var(--text-ui-2xl)] font-light leading-tight tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-[length:var(--text-ui-base)] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
export function Button({ variant = "secondary", size = "md", loading, icon, children, className, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  const v: Record<Variant, string> = {
    primary: "bg-primary-solid text-primary-foreground hover:brightness-110 shadow-[0_8px_24px_-12px_hsl(var(--primary-solid))]",
    secondary: "bg-elevated text-foreground border hover:border-border-strong",
    outline: "border border-primary/60 text-primary hover:bg-accent-soft",
    ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
    danger: "bg-destructive/15 text-destructive border border-destructive/40 hover:bg-destructive/25",
  };
  const s = { sm: "h-8 px-3 text-[length:var(--text-ui-sm)]", md: "h-9 px-4 text-[length:var(--text-ui-base)]", lg: "h-11 px-5 text-[length:var(--text-ui-md)]" }[size];
  return (
    <button {...rest} disabled={rest.disabled || loading}
      className={cx("inline-flex items-center justify-center gap-2 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50", v[variant], s, className)}>
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

const TONES = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-accent-soft text-primary",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-destructive/12 text-destructive",
  info: "bg-info/12 text-info",
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[length:var(--text-ui-xs)] font-medium", TONES[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export const STATUS_META: Record<RequestStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Awaiting approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  rejected: { label: "Rejected", tone: "danger" },
  deploying: { label: "Deploying", tone: "primary" },
  live: { label: "Live", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  const m = STATUS_META[status] ?? { label: status, tone: "neutral" as Tone };
  return <Badge tone={m.tone} dot>{m.label}</Badge>;
}

const TIER_META: Record<Tier, { label: string; tone: Tone; hint: string }> = {
  lakebase: { label: "Live · Lakebase", tone: "success", hint: "Served from the service's Lakebase store" },
  workspace: { label: "Live · Workspace", tone: "success", hint: "Read live from the Databricks workspace APIs" },
  warehouse: { label: "Lakehouse", tone: "info", hint: "Served from Unity Catalog through the SQL warehouse (Lakebase unavailable)" },
  synthetic: { label: "Synthetic", tone: "warning", hint: "Built-in labelled sample data: live sources are unavailable" },
};

export function SourcePill({ source, reason }: { source?: Tier | null; reason?: string | null }) {
  if (!source) return null;
  const m = TIER_META[source];
  return (
    <span title={reason ? `${m.hint}: ${reason}` : m.hint} data-testid="source-pill"
      className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[length:var(--text-ui-xs)] font-medium", TONES[m.tone])}>
      <Database size={11} /> {m.label}
    </span>
  );
}

export function Field({ label, hint, children, error, group }: { label: string; hint?: ReactNode; children: ReactNode; error?: string | null; group?: boolean }) {
  // Inputs: the control sits inside <label>, so it is labelled implicitly. Segmented controls / button rows: pass
  // `group`, because buttons inside a <label> would take the whole label text as their accessible name.
  const id = useId();
  const foot = error ? <span className="mt-1 block text-[length:var(--text-ui-xs)] text-destructive">{error}</span>
    : hint ? <span className="mt-1 block text-[length:var(--text-ui-xs)] text-subtle">{hint}</span> : null;
  if (group) {
    return (
      <div role="group" aria-labelledby={id} className="block">
        <span id={id} className="mb-1.5 block text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">{label}</span>
        <div>{children}</div>
        {foot}
      </div>
    );
  }
  return (
    <label className="block">
      <span className="mb-1.5 block text-[length:var(--text-ui-sm)] font-medium text-muted-foreground">{label}</span>
      <span className="block [&>*]:w-full">{children}</span>
      {foot}
    </label>
  );
}

const inputCls = "h-10 rounded-md border bg-elevated px-3 text-[length:var(--text-ui-base)] text-foreground placeholder:text-subtle transition hover:border-border-strong focus:border-primary/70 focus:outline-none";
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, "h-auto min-h-[84px] py-2", props.className)} />;
}
export function Select({ options, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string; disabled?: boolean }[] }) {
  return (
    <select {...props} className={cx(inputCls, "appearance-none bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-9", props.className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%23999' stroke-width='1.5'/%3E%3C/svg%3E\")" }}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md", ariaLabel }:
  { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; disabled?: boolean }[]; size?: "sm" | "md"; ariaLabel?: string }) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-md border bg-elevated p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} role="radio" aria-checked={active} disabled={o.disabled} type="button" onClick={() => onChange(o.value)}
            className={cx("relative rounded-[6px] font-medium transition disabled:opacity-40",
              size === "sm" ? "h-7 px-2.5 text-[length:var(--text-ui-xs)]" : "h-8 px-3 text-[length:var(--text-ui-sm)]",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
            {active && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-[6px] bg-muted" transition={{ type: "spring", stiffness: 520, damping: 34 }} />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40", checked ? "bg-primary-solid" : "bg-muted")}>
      <motion.span layout transition={{ type: "spring", stiffness: 550, damping: 30 }}
        className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow", checked ? "right-0.5" : "left-0.5")} />
    </button>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <div className="text-[length:var(--text-ui-md)] font-medium">{title}</div>
      {body && <div className="mt-1 max-w-md text-[length:var(--text-ui-sm)] text-muted-foreground">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/8 p-4 text-[length:var(--text-ui-sm)]">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground">Couldn't load this</div>
        <div className="mt-0.5 break-words text-muted-foreground">{error}</div>
      </div>
      {onRetry && <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export function Stat({ label, value, sub, accent, testId }: { label: string; value: ReactNode; sub?: ReactNode; accent?: boolean; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0">
      <div className="text-[length:var(--text-ui-xs)] font-medium uppercase tracking-[0.12em] text-subtle">{label}</div>
      <div className={cx("num mt-1.5 truncate text-[length:var(--text-ui-xl)] font-medium", accent && "text-primary")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-[length:var(--text-ui-xs)] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Number that tweens to its new value (forecast rail): reads as "the model recalculated". */
export function AnimatedNumber({ value, format }: { value: number; format: (v: number) => string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    const c = animate(mv, value, { duration: 0.6, ease: "easeOut" });
    return () => c.stop();
  }, [value, mv]);
  return <motion.span className="num">{text}</motion.span>;
}

export function CheckRow({ c }: { c: CheckResult }) {
  const icon = c.status === "pass" ? <CheckCircle2 size={15} className="text-success" />
    : c.status === "warn" ? <AlertTriangle size={15} className="text-warning" /> : <XCircle size={15} className="text-destructive" />;
  return (
    <div className="flex items-start gap-2.5 py-1.5" data-testid={`check-${c.key}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-[length:var(--text-ui-sm)] font-medium">{c.label}</div>
        {c.detail && <div className="text-[length:var(--text-ui-xs)] text-muted-foreground">{c.detail}</div>}
      </div>
    </div>
  );
}

export function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex items-center gap-0" aria-label="Progress">
      {steps.map((s, i) => {
        const done = i < current, active = i === current;
        return (
          <li key={s} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <span className={cx("grid h-6 w-6 place-items-center rounded-full border text-[11px] transition",
                done ? "border-primary-solid bg-primary-solid text-white" : active ? "border-primary text-primary" : "text-subtle")}>
                {done ? <CheckCircle2 size={13} /> : active ? <Circle size={8} fill="currentColor" /> : i + 1}
              </span>
              <span className={cx("text-[length:var(--text-ui-xs)]", active ? "text-foreground" : "text-subtle")}>{s}</span>
            </div>
            {i < steps.length - 1 && <span className={cx("mx-2 mb-5 h-px flex-1", done ? "bg-primary-solid" : "bg-border")} />}
          </li>
        );
      })}
    </ol>
  );
}

/** Esc closes; focus moves into the dialog once when it opens (not on every re-render, so multi-field dialogs keep focus). */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => {
      if (ref.current?.contains(document.activeElement)) return; // an autoFocus field (or the user) already placed focus inside
      const el = ref.current?.querySelector<HTMLElement>("textarea, input, select, button:not([aria-label='Close'])");
      el?.focus();
    }, 30);
    return () => { window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open]);
  return ref;
}

export function Drawer({ open, onClose, title, children, width = 560 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number }) {
  const ref = useDialog(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Details"}
            className="fixed right-0 top-0 z-50 flex h-full flex-col border-l bg-card shadow-2xl" style={{ width: `min(${width}px, 100vw)` }}
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 260, damping: 30 }}>
            <div className="flex items-center justify-between border-b px-5 py-3.5">
              <div className="text-[length:var(--text-ui-md)] font-medium">{title}</div>
              <button onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={16} /></button>
            </div>
            <div className="scroll-y flex-1 p-5">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export function Modal({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useDialog(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div ref={ref} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-lg border bg-card p-5 shadow-2xl"
            initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}>
            <div className="mb-3 text-[length:var(--text-ui-md)] font-medium">{title}</div>
            <div className="text-[length:var(--text-ui-sm)] text-muted-foreground">{children}</div>
            {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Code({ children, className }: { children: string; className?: string }) {
  return <pre className={cx("scroll-y max-h-[520px] overflow-x-auto rounded-md border bg-background p-3 text-[12px] leading-relaxed text-muted-foreground num", className)}>{children}</pre>;
}

export const fadeUp = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.45, ease: "easeOut" as const } };
