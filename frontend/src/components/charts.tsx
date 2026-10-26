import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

export type ChartSlice = {
  label: string;
  value: number;
  color: string;
};

/** Formats a rupee amount consistently across chart tooltips/legends. */
function formatCompact(value: number): string {
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(1)}L`;
  if (value >= 1_000) return `₹${(value / 1_000).toFixed(1)}k`;
  return `₹${Math.round(value)}`;
}

const EASE = "ease-out";

/**
 * A flat, minimal ring/donut chart -- solid fills, no gradients or glow, a
 * restrained fade/sweep-in on load. Matches the flat, low-chroma style of a
 * clinical/financial reporting tool rather than a consumer app. Slices with
 * value <= 0 are dropped so a chart with partial real data never renders a
 * misleading full-circle slice for an empty category.
 */
export function DonutChart({
  data,
  size = 160,
  thickness = 22,
  formatValue = formatCompact,
  centerLabel,
  centerValue,
}: {
  data: ChartSlice[];
  size?: number;
  thickness?: number;
  formatValue?: (value: number) => string;
  centerLabel?: string;
  centerValue?: string;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    const t = window.setTimeout(() => setGrown(true), 20);
    return () => window.clearTimeout(t);
  }, [data]);

  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((sum, d) => sum + d.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "24px", flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        {total <= 0 ? (
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eef1f5" strokeWidth={thickness} />
          </svg>
        ) : (
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f1f5f9" strokeWidth={thickness} />
            {slices.map((slice, i) => {
              const pct = slice.value / total;
              const targetDash = pct * circumference;
              const dash = grown ? targetDash : 0;
              const el = (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  className="hosp-chart-arc"
                  style={{ transition: `stroke-dasharray 500ms ${EASE}` }}
                >
                  <title>{`${slice.label}: ${formatValue(slice.value)}`}</title>
                </circle>
              );
              offset += targetDash;
              return el;
            })}
          </svg>
        )}
        {(centerLabel || centerValue) && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            {centerValue && <strong style={{ fontSize: "18px", color: "#0f172a", letterSpacing: "-0.01em" }}>{centerValue}</strong>}
            {centerLabel && <span style={{ fontSize: "10px", color: "#94a3b8", fontWeight: 600, textAlign: "center", textTransform: "uppercase", letterSpacing: "0.05em" }}>{centerLabel}</span>}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "8px", minWidth: "150px" }}>
        {data.map((d) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <div key={d.label} className="hosp-chart-legend-row" style={{ display: "flex", alignItems: "center", gap: "9px", fontSize: "12.5px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: d.color, flexShrink: 0 }} />
              <span style={{ color: "#475569", flex: 1 }}>{d.label}</span>
              <span style={{ fontWeight: 700, color: "#0f172a" }}>{formatValue(d.value)}</span>
              <span style={{ color: "#94a3b8", fontSize: "11.5px", minWidth: "30px", textAlign: "right", fontWeight: 500 }}>{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A flat wedge-based pie chart (no center hole) -- solid fills, thin white
 * separators, a quick fade-in on load. No gradients, no drop shadow, no
 * bounce, matching a clinical/financial reporting tool rather than a
 * consumer app.
 */
export function PieChart({
  data,
  size = 120,
  formatValue = (v: number) => String(Math.round(v)),
  centerLabel,
}: {
  data: ChartSlice[];
  size?: number;
  formatValue?: (value: number) => string;
  centerLabel?: string;
}) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    const t = window.setTimeout(() => setShown(true), 20);
    return () => window.clearTimeout(t);
  }, [data]);

  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((sum, d) => sum + d.value, 0);
  const r = size / 2;
  const cx = r;
  const cy = r;

  let cumulative = 0;
  const wedges = slices.map((slice, i) => {
    const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
    cumulative += slice.value;
    const endAngle = (cumulative / total) * 2 * Math.PI - Math.PI / 2;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
    const isFullCircle = slices.length === 1;
    const d = isFullCircle
      ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.001} ${cy - r} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    return { d, color: slice.color, label: slice.label, value: slice.value, key: i };
  });

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        opacity: shown ? 1 : 0,
        transition: `opacity 350ms ${EASE}`,
      }}
    >
      {total <= 0 ? (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r - 1} fill="#f8fafc" stroke="#e2e8f0" />
        </svg>
      ) : (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {wedges.map((w) => (
            <path key={w.key} d={w.d} fill={w.color} stroke="#ffffff" strokeWidth={1.5} className="hosp-chart-wedge">
              <title>{`${w.label}: ${formatValue(w.value)}`}</title>
            </path>
          ))}
        </svg>
      )}
      {centerLabel && (
        <div style={{ position: "absolute", bottom: -20, left: 0, right: 0, textAlign: "center", fontSize: "10.5px", fontWeight: 600, color: "#94a3b8" }}>
          {centerLabel}
        </div>
      )}
    </div>
  );
}

export type BarPoint = {
  label: string;
  value: number;
};

/**
 * A vertical bar chart -- flat fill, light gridlines, a quick grow-in on
 * load. No gradients, no glow.
 */
export function BarChart({
  data,
  height = 150,
  barColor = "#00828a",
  formatValue = (v: number) => String(Math.round(v)),
}: {
  data: BarPoint[];
  height?: number;
  barColor?: string;
  formatValue?: (value: number) => string;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    const t = window.setTimeout(() => setGrown(true), 20);
    return () => window.clearTimeout(t);
  }, [data]);

  const max = Math.max(1, ...data.map((d) => d.value));
  const gridLines = [0.25, 0.5, 0.75];

  return (
    <div style={{ position: "relative", height, paddingBottom: "10px", borderBottom: "1px solid #e2e8f0" }}>
      <div style={{ position: "absolute", inset: "0 0 10px 0", pointerEvents: "none" }}>
        {gridLines.map((g) => (
          <div key={g} style={{ position: "absolute", left: 0, right: 0, bottom: `${g * 100}%`, borderTop: "1px dashed #eef1f5" }} />
        ))}
      </div>
      <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: "10px", height: "100%" }}>
        {data.map((d, i) => {
          const pct = Math.min(100, Math.max(d.value > 0 ? 3 : 0, (d.value / max) * 100));
          return (
            <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", height: "100%", justifyContent: "flex-end", minWidth: 0 }}>
              <div style={{ fontSize: "10.5px", fontWeight: 700, color: "#334155", marginBottom: "5px" }}>{d.value > 0 ? formatValue(d.value) : ""}</div>
              <div
                className="hosp-chart-bar"
                style={{
                  width: "100%",
                  maxWidth: "26px",
                  height: grown ? `${pct}%` : "0%",
                  borderRadius: "3px 3px 1px 1px",
                  background: barColor,
                  transition: `height 450ms ${EASE}`,
                }}
                title={`${d.label}: ${formatValue(d.value)}`}
              />
              <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "6px", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                {d.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A single labeled horizontal progress/occupancy bar -- flat fill, no glow. */
export function HorizontalBar({
  label,
  value,
  max,
  color = "#00828a",
  valueLabel,
  style,
}: {
  label: string;
  value: number;
  max: number;
  color?: string;
  valueLabel?: string;
  style?: CSSProperties;
}) {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    setGrown(false);
    const t = window.setTimeout(() => setGrown(true), 20);
    return () => window.clearTimeout(t);
  }, [value, max]);

  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={style}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12.5px", marginBottom: "6px" }}>
        <strong style={{ color: "#1e293b" }}>{label}</strong>
        <span style={{ color: "#64748b" }}>{valueLabel ?? `${value}/${max} (${pct}%)`}</span>
      </div>
      <div style={{ height: "7px", background: "#eef1f5", borderRadius: "3px", overflow: "hidden" }}>
        <div
          style={{
            height: "100%",
            width: grown ? `${pct}%` : "0%",
            background: color,
            borderRadius: "3px",
            transition: `width 450ms ${EASE}`,
          }}
        />
      </div>
    </div>
  );
}
