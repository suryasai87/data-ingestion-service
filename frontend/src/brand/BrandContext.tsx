import { createContext, ReactNode, useContext, useEffect } from "react";
import { useApi } from "@/lib/api";
import type { Brand, Me } from "@/lib/types";

const FALLBACK_BRAND: Brand = {
  key: "databricks",
  company: "Databricks",
  product: "Data Ingestion Service",
  hero_title: "Welcome to Data Ingestion Service",
  hero_subtitle: "Request governed, CDC-based ingestion into Foundation in minutes. Every pipeline is configured, validated, approved and monitored the same way.",
  destination_label: "Foundation",
  logo_url: null,
  powered_by: "Powered by Databricks Lakeflow Connect",
  palette: { brand_h: 262, brand_s: "58%" },
};

interface Ctx { brand: Brand; me: Me | null; reloadMe: () => void }
const BrandCtx = createContext<Ctx>({ brand: FALLBACK_BRAND, me: null, reloadMe: () => {} });

export function BrandProvider({ children }: { children: ReactNode }) {
  const { data: brand } = useApi<Brand>("/api/brand");
  const { data: me, reload } = useApi<Me>("/api/me");
  const b = brand ?? FALLBACK_BRAND;
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty("--brand-h", String(b.palette.brand_h));
    r.setProperty("--brand-s", b.palette.brand_s);
    document.title = b.product;
  }, [b]);
  return <BrandCtx.Provider value={{ brand: b, me, reloadMe: reload }}>{children}</BrandCtx.Provider>;
}

export const useBrand = () => useContext(BrandCtx);
