// Thin typed fetch wrapper. Reads never throw into a page without an error state: callers use `useApi`, which
// returns {data, error, loading, reload}. Writes throw ApiError with the server's detail so the UI can show it.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function parse(res: Response) {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const d = (body && typeof body === "object" && "detail" in (body as Record<string, unknown>))
      ? (body as { detail: unknown }).detail : body;
    throw new ApiError(res.status, typeof d === "string" ? d : JSON.stringify(d));
  }
  return body;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  return (await parse(await fetch(path, { signal, headers: { accept: "application/json" } }))) as T;
}

export async function send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await parse(res)) as T;
}

export const post = <T,>(path: string, body?: unknown) => send<T>("POST", path, body);
export const put = <T,>(path: string, body?: unknown) => send<T>("PUT", path, body);
export const del = <T,>(path: string, body?: unknown) => send<T>("DELETE", path, body);

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    try {
      const d = await get<T>(path, c.signal);
      if (!c.signal.aborted) { setData(d); setError(null); }
    } catch (e) {
      if (!c.signal.aborted) setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      if (!c.signal.aborted) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => { load(); return () => ctrl.current?.abort(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export const fmt = {
  usd(v: number | null | undefined, digits = 0) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (Math.abs(v) >= 10000) return `$${(v / 1000).toFixed(1)}k`;
    return `$${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
  },
  min(v: number | null | undefined) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (v < 1) return `${Math.max(1, Math.round(v * 60))}s`;
    if (v < 90) return `${Math.round(v)} min`;
    const h = v / 60;
    if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
    return `${(h / 24).toFixed(1)} d`;
  },
  pct(v: number | null | undefined, digits = 1) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    return `${v.toFixed(digits)}%`;
  },
  int(v: number | null | undefined) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
    return v.toLocaleString();
  },
  ago(iso: string | null | undefined) {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  },
};
