import { Waves } from "lucide-react";
import type { Brand } from "@/lib/types";

// The company logo comes from the brand pack: a neutral product glyph + the company name.
export function CompanyLogo({ brand, className }: { brand: Brand | null; className?: string }) {
  return (
    <span className={["inline-flex items-center gap-2 font-semibold tracking-tight", className].filter(Boolean).join(" ")} aria-label={brand?.company ?? "Data Ingestion Service"}>
      <Waves size={18} className="text-primary" /> {brand?.company ?? "Databricks"}
    </span>
  );
}
