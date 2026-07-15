"use client";

import { useState } from "react";

export interface BarChartPoint {
  label: string;
  a: number;
  b: number;
}

/**
 * Grouped two-series bar chart (inline SVG, no dependencies).
 * Series colors come from --chart-1/--chart-2 (validated for CVD
 * separation and contrast on both light and dark surfaces); text uses
 * ink/muted tokens, never the series hue. Hover shows a per-group
 * tooltip; the legend is always rendered (two series).
 */
export function BarChart({
  data,
  seriesA,
  seriesB,
  format,
}: {
  data: BarChartPoint[];
  seriesA: string;
  seriesB: string;
  format: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const PAD = { top: 14, right: 8, bottom: 24, left: 8 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const max = Math.max(1, ...data.flatMap((d) => [d.a, d.b]));
  const groupW = plotW / Math.max(1, data.length);
  const barW = Math.min(26, (groupW - 18) / 2);
  const y = (v: number): number => plotH * (1 - v / max);

  const gridLines = [0.25, 0.5, 0.75, 1];

  return (
    <div style={{ position: "relative" }}>
      <div
        style={{
          display: "flex",
          gap: 16,
          fontSize: "0.8rem",
          marginBottom: 4,
        }}
      >
        <span>
          <span className="swatch" style={{ background: "var(--chart-1)" }} />
          {seriesA}
        </span>
        <span>
          <span className="swatch" style={{ background: "var(--chart-2)" }} />
          {seriesB}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label={`${seriesA} vs ${seriesB} by month`}
      >
        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {gridLines.map((f) => (
            <line
              key={f}
              x1={0}
              x2={plotW}
              y1={y(max * f)}
              y2={y(max * f)}
              stroke="var(--line)"
              strokeWidth={1}
            />
          ))}
          <line
            x1={0}
            x2={plotW}
            y1={plotH}
            y2={plotH}
            stroke="var(--muted)"
            strokeWidth={1}
          />
          {data.map((d, i) => {
            const cx = i * groupW + groupW / 2;
            const active = hover === i;
            return (
              <g key={d.label}>
                {active && (
                  <rect
                    x={i * groupW + 2}
                    y={0}
                    width={groupW - 4}
                    height={plotH}
                    fill="var(--muted)"
                    opacity={0.08}
                  />
                )}
                {d.a > 0 && (
                  <rect
                    x={cx - barW - 1}
                    y={y(d.a)}
                    width={barW}
                    height={plotH - y(d.a)}
                    fill="var(--chart-1)"
                    rx={4}
                  />
                )}
                {d.b > 0 && (
                  <rect
                    x={cx + 1}
                    y={y(d.b)}
                    width={barW}
                    height={plotH - y(d.b)}
                    fill="var(--chart-2)"
                    rx={4}
                  />
                )}
                <text
                  x={cx}
                  y={plotH + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--muted)"
                >
                  {d.label}
                </text>
                <rect
                  x={i * groupW}
                  y={0}
                  width={groupW}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </g>
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="chart-tip"
          style={{
            left: `${((hover + 0.5) / data.length) * 100}%`,
          }}
        >
          <strong>{data[hover].label}</strong>
          <div>
            {seriesA}: {format(data[hover].a)}
          </div>
          <div>
            {seriesB}: {format(data[hover].b)}
          </div>
        </div>
      )}
    </div>
  );
}
