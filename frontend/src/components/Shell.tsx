import { AnimatePresence, motion } from "framer-motion";
import {
  Activity, Bot, ChevronsLeft, ChevronsRight, FilePlus2, Gauge, Home, Inbox, KeyRound, Menu, Moon, Plug, Route, Shield, Sun, X,
} from "lucide-react";
import { ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { CompanyLogo } from "@/brand/Logo";
import { useBrand } from "@/brand/BrandContext";
import { ApiError, fmt, put, useApi } from "@/lib/api";
import type { PinStatus } from "@/lib/types";
import { Button, ErrorState, Field, Input, Modal, Skeleton, cx } from "./ui";

const PIN_RE = /^\d{6,12}$/;
const RO_TITLE = "Read-only mode";

interface NavItem { to: string; label: string; icon: ReactNode; adminOnly?: boolean; group?: string }

export const NAV: NavItem[] = [
  { to: "/how-it-works", label: "How it works", icon: <Route size={17} />, group: "Overview" },
  { to: "/", label: "Home", icon: <Home size={17} />, group: "Overview" },
  { to: "/new", label: "New request", icon: <FilePlus2 size={17} />, group: "Request" },
  { to: "/assistant", label: "Assistant", icon: <Bot size={17} />, group: "Request" },
  { to: "/requests", label: "Requests", icon: <Inbox size={17} />, group: "Request" },
  { to: "/pipelines", label: "Pipelines", icon: <Activity size={17} />, group: "Operate" },
  { to: "/insights", label: "Forecast model", icon: <Gauge size={17} />, group: "Operate" },
  { to: "/connectors", label: "Connectors", icon: <Plug size={17} />, group: "Operate" },
  { to: "/admin", label: "Administration", icon: <Shield size={17} />, group: "Govern", adminOnly: true },
];

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem("dis.theme") === "light") ? "light" : "dark");
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", theme === "dark");
    el.classList.toggle("light", theme === "light");
    try { localStorage.setItem("dis.theme", theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, setTheme] as const;
}

function SideNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { me } = useBrand();
  const items = NAV.filter((n) => !n.adminOnly || me?.is_admin);
  let lastGroup = "";
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-2.5 py-3">
      {items.map((n) => {
        const header = !collapsed && n.group !== lastGroup ? n.group : null;
        lastGroup = n.group ?? "";
        return (
          <div key={n.to}>
            {header && <div className="px-2.5 pb-1.5 pt-4 text-[10.5px] font-medium uppercase tracking-[0.16em] text-subtle first:pt-1">{header}</div>}
            <NavLink to={n.to} end={n.to === "/"} onClick={onNavigate} title={collapsed ? n.label : undefined}
              className={({ isActive }) => cx(
                "group relative flex h-9 items-center gap-3 rounded-md px-2.5 text-[length:var(--text-ui-base)] transition",
                isActive ? "bg-accent-soft text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                collapsed && "justify-center px-0")}>
              {({ isActive }) => (
                <>
                  {isActive && <motion.span layoutId="nav-active" className="absolute left-0 top-1.5 h-6 w-[3px] rounded-full bg-primary"
                    transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
                  <span className={cx(isActive && "text-primary")}>{n.icon}</span>
                  {!collapsed && <span className="truncate">{n.label}</span>}
                </>
              )}
            </NavLink>
          </div>
        );
      })}
    </nav>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const { brand, me } = useBrand();
  const [theme, setTheme] = useTheme();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("dis.sidebar") === "collapsed"; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => { try { localStorage.setItem("dis.sidebar", collapsed ? "collapsed" : "open"); } catch { /* ignore */ } }, [collapsed]);
  useEffect(() => { setMobileOpen(false); document.getElementById("main")?.scrollTo({ top: 0 }); }, [loc.pathname]);

  const initials = (me?.name || me?.email || "?").split(/[\s.@]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur">
        <button className="rounded-md p-1.5 text-muted-foreground hover:bg-muted md:hidden" aria-label="Open menu" onClick={() => setMobileOpen(true)}>
          <Menu size={18} />
        </button>
        <CompanyLogo brand={brand} className="h-[22px] w-auto text-foreground" />
        <span className="hidden h-5 w-px bg-border sm:block" />
        <span className="hidden truncate text-[length:var(--text-ui-md)] font-medium tracking-tight sm:block">{brand.product}</span>
        {me?.kiosk && <span className="rounded-full bg-warning/12 px-2 py-0.5 text-[length:var(--text-ui-xs)] font-medium text-warning">Read-only</span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[length:var(--text-ui-xs)] text-muted-foreground lg:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-lava" /> {brand.powered_by}
          </span>
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme"
            className="rounded-md p-2 text-muted-foreground transition hover:bg-muted hover:text-foreground">
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <AccountMenu initials={initials || "·"} email={me?.email ?? ""} name={me?.name ?? ""} kiosk={!!me?.kiosk} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className={cx("hidden shrink-0 flex-col border-r bg-sidebar transition-[width] duration-300 md:flex", collapsed ? "w-[60px]" : "w-[232px]")}>
          <div className="scroll-y flex-1"><SideNav collapsed={collapsed} /></div>
          <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="m-2.5 flex h-8 items-center justify-center gap-2 rounded-md text-[length:var(--text-ui-xs)] text-subtle hover:bg-muted hover:text-foreground">
            {collapsed ? <ChevronsRight size={15} /> : <><ChevronsLeft size={15} /> Collapse</>}
          </button>
        </aside>

        <AnimatePresence>
          {mobileOpen && (
            <>
              <motion.div className="fixed inset-0 z-40 bg-black/50 md:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setMobileOpen(false)} />
              <motion.aside className="fixed inset-y-0 left-0 z-50 w-[260px] border-r bg-sidebar md:hidden"
                initial={{ x: -260 }} animate={{ x: 0 }} exit={{ x: -260 }} transition={{ type: "spring", stiffness: 260, damping: 30 }}>
                <div className="flex h-14 items-center justify-between border-b px-4">
                  <span className="font-medium">{brand.product}</span>
                  <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="rounded-md p-1.5 hover:bg-muted"><X size={16} /></button>
                </div>
                <SideNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <main id="main" className="scroll-y min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1480px] px-5 py-7 md:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

/** The initials avatar: who is signed in, and the personal signing PIN for 21 CFR Part 11 e-signatures. */
function AccountMenu({ initials, email, name, kiosk }: { initials: string; email: string; name: string; kiosk: boolean }) {
  const [open, setOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const item = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => item.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, [open]);
  return (
    <div ref={wrap} className="relative">
      <button ref={btn} type="button" aria-label={`Account menu${email ? ` for ${email}` : ""}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} title={email}
        className="grid h-8 w-8 place-items-center rounded-full bg-plum text-[11px] font-semibold text-lavender outline-offset-2 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-[hsl(var(--ring))]">
        {initials}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div role="menu" aria-label="Account" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ type: "spring", stiffness: 520, damping: 32 }}
            className="absolute right-0 top-10 z-40 w-64 rounded-lg border bg-card p-1.5 shadow-2xl">
            <div className="px-2.5 py-2">
              {name && <div className="truncate text-[length:var(--text-ui-sm)] font-medium text-foreground">{name}</div>}
              <div className="truncate text-[length:var(--text-ui-xs)] text-muted-foreground" data-testid="account-email">{email || "Not signed in"}</div>
            </div>
            <div className="my-1 h-px bg-border" />
            <button ref={item} type="button" role="menuitem" onClick={() => { setOpen(false); setPinOpen(true); }}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[length:var(--text-ui-sm)] text-foreground hover:bg-muted focus:bg-muted focus:outline-none">
              <KeyRound size={14} className="text-primary" /> Signing PIN…
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <PinModal open={pinOpen} kiosk={kiosk} onClose={() => { setPinOpen(false); btn.current?.focus(); }} />
    </div>
  );
}

function PinModal({ open, kiosk, onClose }: { open: boolean; kiosk: boolean; onClose: () => void }) {
  const status = useApi<PinStatus>(open ? "/api/gxp/pin" : null, [open]);
  const [current, setCurrent] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (open) return;
    setCurrent(""); setPin(""); setConfirm(""); setError(null); setSaved(false);
  }, [open]);

  const s = status.data;
  const hasPin = !!s?.has_pin;
  const lockedUntil = s?.locked_until && new Date(s.locked_until).getTime() > Date.now() ? s.locked_until : null;
  const pinError = pin && !PIN_RE.test(pin) ? "The PIN must be 6 to 12 digits." : null;
  const confirmError = confirm && confirm !== pin ? "The PINs don't match." : null;
  const currentError = hasPin && current && !PIN_RE.test(current) ? "Your current PIN is 6 to 12 digits." : null;
  const valid = !!s && PIN_RE.test(pin) && confirm === pin && (!hasPin || PIN_RE.test(current));
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 12);
  const close = () => { if (!busy) onClose(); };

  const save = async () => {
    if (!valid) return;
    setBusy(true); setError(null);
    try {
      const next = await put<PinStatus>("/api/gxp/pin", hasPin ? { pin, current_pin: current } : { pin });
      status.setData(next);
      setSaved(true);
      setCurrent(""); setPin(""); setConfirm("");
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
      setCurrent("");
    } finally {
      setBusy(false);
    }
  };

  const title = hasPin ? "Change your signing PIN" : "Set your signing PIN";
  return (
    <Modal open={open} onClose={close} title={saved ? "Signing PIN saved" : title}
      footer={saved ? <Button variant="primary" onClick={close}>Done</Button> : <>
        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!valid || kiosk} title={kiosk ? RO_TITLE : undefined} onClick={save}>Save PIN</Button>
      </>}>
      {!s && status.loading ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-4 w-60" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
      ) : !s && status.error ? (
        <ErrorState error={status.error} onRetry={status.reload} />
      ) : saved ? (
        <p role="status" className="text-success">Your signing PIN is set. Use it with your printed name when you approve or release GxP requests.</p>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}>
          <p>
            Your second signature component for 21 CFR Part 11: only you know it. It is stored as a salted hash; nobody, including administrators,
            can see it. Three wrong attempts lock signing for 15 minutes.
          </p>
          <p className="text-[length:var(--text-ui-xs)] text-subtle" data-testid="pin-status">
            {hasPin ? <>PIN set {fmt.ago(s?.set_at)}.</> : "You haven't set a signing PIN yet."}
            {lockedUntil && <span className="text-warning"> Signing is locked until {new Date(lockedUntil).toISOString().slice(11, 16)} UTC.</span>}
          </p>
          {hasPin && (
            <Field label="Current PIN" error={currentError}>
              <Input autoFocus aria-label="Current PIN" type="password" inputMode="numeric" autoComplete="off" value={current} onChange={(e) => setCurrent(digits(e.target.value))} />
            </Field>
          )}
          <Field label="New PIN" hint="6 to 12 digits." error={pinError}>
            <Input autoFocus={!hasPin} aria-label="New PIN" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} />
          </Field>
          <Field label="Confirm new PIN" error={confirmError}>
            <Input aria-label="Confirm new PIN" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} />
          </Field>
          {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-destructive">{error}</div>}
        </form>
      )}
    </Modal>
  );
}
