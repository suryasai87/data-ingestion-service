# Data Ingestion Service: UI/UX design language

The service is a self-service front door to Lakeflow Connect. Its users are business data owners, analysts and
engineers who want a table in Foundation; they should never need to know what a gateway, a publication or a cursor
column is unless they want to. The design follows from that.

## Principles

1. **One decision at a time.** Each wizard step asks one thing. Advanced settings (SCD type, retries, table prefix)
   sit behind a "More options" disclosure with safe defaults.
2. **The forecast is always visible.** While a request is being shaped, a sticky rail shows predicted monthly cost,
   time to first data, freshness and SLA attainment, recalculated on every change (numbers tween to their new value).
   Every number says what it is based on ("based on 46 Salesforce pipelines, 365 days").
3. **Same controls for every channel.** The guided form and the assistant produce the same configuration; both go
   through the same validation and the same approval. The UI shows this with the same review panel in both.
4. **Calm, not empty.** Dark plum-tinted surfaces, one accent (brand violet), hairline borders, generous whitespace.
   Large titles are light weight (300); numbers are mono and tabular. Colour never carries meaning alone: every
   status also has a word.
5. **Never a broken page.** Every page shows a source pill (Live · Lakebase, Live · Workspace, Lakehouse, Synthetic).
   Loading = skeletons; errors = an inline card with Retry; empty = a sentence that says what to do next.
6. **Motion has a job.** Entrances fade up 12 px in 0.45 s (`fadeUp` in `components/ui.tsx`); anything the user touches
   uses a spring (stiffness 500-550, damping 30-34); state changes cross-fade. No looping animation outside the
   How it works diagram and the live status dot.

## Tokens (frontend/src/index.css)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--background` | plum-black `hsl(264 30% 5.5%)` | stone `#EAE6DD` | canvas |
| `--card` / `--elevated` | `hsl(263 24% 8.5%)` / `11.5%` | warm white | panels / inputs |
| `--primary` | violet `hsl(262 72% 72%)` | violet `hsl(262 58% 46%)` | links, active, accents |
| `--primary-solid` | violet `#7B4FD0` | plum `#3F2C58` | primary buttons |
| `--plum` | `#3F2C58` | | hero aurora, avatar |
| `--lavender` | `#EDE9FC` | | soft highlights |
| `--mark` | logo red `#DB3241` | | logo + critical only |
| `--lava` | Databricks lava | | "Powered by" chip only |

Type scale tokens `--text-ui-xs … --text-ui-hero` grow at 1600 / 1920 / 2560 px. Use them (`text-[length:var(--text-ui-sm)]`),
never raw pixel sizes.

## Brand pack

`branding/<key>/brand.json` (served by `GET /api/brand`) sets the company name, logo, hero copy, destination label
("Foundation") and the brand hue. `DIS_BRAND=databricks` (default) gives a neutral build; add `branding/<key>/` for a customer pack.

## Components (frontend/src/components/ui.tsx)

`Card`, `PageHeader`, `Button` (primary / secondary / outline / ghost / danger), `Badge`, `StatusBadge`, `SourcePill`,
`Field`, `Input`, `Textarea`, `Select` (native), `Segmented`, `Toggle`, `Skeleton`, `EmptyState`, `ErrorState`, `Stat`,
`AnimatedNumber`, `CheckRow`, `Stepper`, `Drawer`, `Modal`, `Code`, `fadeUp`, `cx`. Reuse them; don't restyle per page.

## Page anatomy

```
PageHeader (eyebrow · light title · one-line subtitle · actions + SourcePill)
  └ content grid: 12 cols, gap 20-24 px; cards rounded-lg, padding 20-24 px
```

Accessibility: native `<select>`/`<button>`, visible focus rings (`--ring`), muted text ≥ 70 % lightness in dark mode,
`aria-label` on icon-only buttons, tables with `<th scope>`.
