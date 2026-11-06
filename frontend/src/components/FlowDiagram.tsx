import { motion } from "framer-motion";
import { ReactNode } from "react";

// Animated dots-between-boxes flow diagram (Databricks "Unity AI Gateway" GIF look).
// Nodes = glass cards; edges = bezier lanes with a translucent base stroke, an animated
// dashed "flow" stroke (requires `@keyframes dash-flow { to { stroke-dashoffset:-1000 } }`
// in your CSS), and N dots riding the path via SVG <animateMotion><mpath/>.
// Requires: framer-motion, Tailwind v4 HSL tokens (hsl(var(--primary)), hsl(var(--background))),
// and a `.glass` utility. See the how-it-works-flow skill for page composition.

export interface FlowNode {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  step?: number;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  accent?: string; // css color, e.g. "hsl(var(--primary))"
}

export interface FlowEdge {
  from: string;
  to: string;
  fromSide?: "right" | "bottom" | "top" | "left";
  toSide?: "left" | "top" | "bottom" | "right";
  color?: string;
  dashed?: boolean;
  label?: string;
  dots?: number;
}

const DEFAULT_W = 190;
const DEFAULT_H = 92;

function anchor(n: FlowNode, side: string): [number, number] {
  const w = n.w ?? DEFAULT_W;
  const h = n.h ?? DEFAULT_H;
  switch (side) {
    case "right":
      return [n.x + w, n.y + h / 2];
    case "left":
      return [n.x, n.y + h / 2];
    case "top":
      return [n.x + w / 2, n.y];
    case "bottom":
    default:
      return [n.x + w / 2, n.y + h];
  }
}

function bezier(p1: [number, number], p2: [number, number], vertical: boolean): string {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (vertical) {
    const dy = (y2 - y1) * 0.5;
    return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  }
  const dx = (x2 - x1) * 0.5;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export default function FlowDiagram({
  nodes,
  edges,
  width = 1120,
  height = 600,
}: {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width?: number;
  height?: number;
}) {
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const paths = edges.map((e, i) => {
    const from = byId[e.from];
    const to = byId[e.to];
    const fromSide = e.fromSide ?? "right";
    const toSide = e.toSide ?? "left";
    const p1 = anchor(from, fromSide);
    const p2 = anchor(to, toSide);
    const vertical = fromSide === "bottom" || fromSide === "top" || toSide === "top" || toSide === "bottom";
    const d = bezier(p1, p2, vertical);
    return { id: `${e.from}-${e.to}-${i}`, d, e, mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] as [number, number] };
  });

  return (
    <div className="overflow-x-auto">
      <div className="relative mx-auto" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0" style={{ overflow: "visible" }}>
          <defs>
            {paths.map((p) => (
              <path key={`def-${p.id}`} id={`path-${p.id}`} d={p.d} fill="none" />
            ))}
          </defs>

          {/* base connector strokes + animated flow dashes */}
          {paths.map((p) => {
            const color = p.e.color ?? "hsl(var(--primary))";
            return (
              <g key={`edge-${p.id}`}>
                <path d={p.d} fill="none" stroke={color} strokeOpacity={0.22} strokeWidth={2.5} />
                <path
                  d={p.d}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.9}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray={p.e.dashed ? "2 10" : "10 240"}
                  style={{ animation: "dash-flow 6s linear infinite" }}
                />
                {/* riding dots */}
                {Array.from({ length: p.e.dots ?? 2 }).map((_, di) => (
                  <circle key={di} r={4} fill={color}>
                    <animateMotion
                      dur={`${3.2 + di * 0.6}s`}
                      begin={`${di * 1.2}s`}
                      repeatCount="indefinite"
                      keyPoints="0;1"
                      keyTimes="0;1"
                      calcMode="linear"
                    >
                      <mpath href={`#path-${p.id}`} />
                    </animateMotion>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>

        {/* edge labels */}
        {paths.map(
          (p) =>
            p.e.label && (
              <div
                key={`lbl-${p.id}`}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-semibold text-muted-foreground backdrop-blur"
                style={{ left: p.mid[0], top: p.mid[1] }}
              >
                {p.e.label}
              </div>
            )
        )}

        {/* nodes */}
        {nodes.map((n, i) => {
          const accent = n.accent ?? "hsl(var(--primary))";
          return (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, scale: 0.9, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.07, duration: 0.4, ease: "easeOut" }}
              whileHover={{ y: -3 }}
              className="glass absolute rounded-xl p-3 flex flex-col gap-1 shadow-lg"
              style={{
                left: n.x,
                top: n.y,
                width: n.w ?? DEFAULT_W,
                height: n.h ?? DEFAULT_H,
                borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
              }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="grid place-items-center h-7 w-7 rounded-md shrink-0"
                  style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
                >
                  {n.icon}
                </div>
                <div className="text-[13px] font-bold leading-tight">{n.title}</div>
                {n.step != null && (
                  <div
                    className="ml-auto grid place-items-center h-5 w-5 rounded-full text-[10px] font-extrabold shrink-0"
                    style={{ background: accent, color: "hsl(var(--background))" }}
                  >
                    {n.step}
                  </div>
                )}
              </div>
              {n.subtitle && (
                <div className="text-[10.5px] leading-snug text-muted-foreground font-mono">{n.subtitle}</div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
