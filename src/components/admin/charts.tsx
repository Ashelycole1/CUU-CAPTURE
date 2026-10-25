/**
 * Tiny server-rendered charts (FR-ADM-5): no chart library, no client JS.
 * - Single series → one hue (brand), no legend; the heading names the series.
 * - Thin bars with rounded data-ends anchored to the baseline, 2px gaps, recessive axis.
 * - Each mark has an SVG <title> (native hover tooltip), and every chart ships a
 *   table alternative in a <details> (screen readers get the table; the SVG is aria-hidden
 *   with a text summary as its accessible description).
 */
import type { ReactNode } from 'react';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui';

export interface Datum {
  key: string;
  label: string;
  value: number;
  /** Optional per-mark class (e.g. status colours for risk bands). */
  className?: string;
}

function TableAlt({ caption, data, colLabel, colValue, format }: { caption: string; data: Datum[]; colLabel: string; colValue: string; format: (n: number) => string }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm font-semibold text-brand-700">{caption}</summary>
      <Table className="mt-2">
        <THead>
          <TR>
            <TH>{colLabel}</TH>
            <TH className="text-right">{colValue}</TH>
          </TR>
        </THead>
        <TBody>
          {data.map((d) => (
            <TR key={d.key}>
              <TD>{d.label}</TD>
              <TD className="text-right font-mono tabular">{format(d.value)}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </details>
  );
}

/** Vertical column chart (e.g. submissions per week). */
export function ColumnChart({
  data,
  summary,
  tableCaption,
  colLabel,
  colValue,
  format = String,
  height = 180,
}: {
  data: Datum[];
  summary: string;
  tableCaption: string;
  colLabel: string;
  colValue: string;
  format?: (n: number) => string;
  height?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const W = 640;
  const padL = 28;
  const padB = 22;
  const plotH = height - padB - 8;
  const slot = (W - padL) / n;
  const barW = Math.max(4, Math.min(28, slot - 2));
  const ticks = [0, Math.ceil(max / 2), max];
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${height}`} className="h-auto w-full" aria-hidden="true">
        {ticks.map((tk) => {
          const y = 8 + plotH - (tk / max) * plotH;
          return (
            <g key={tk}>
              <line x1={padL} x2={W} y1={y} y2={y} className="stroke-line" strokeWidth={1} />
              <text x={padL - 6} y={y + 4} textAnchor="end" className="fill-ink-muted text-[11px]">
                {tk}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.value / max) * plotH;
          const x = padL + i * slot + (slot - barW) / 2;
          const y = 8 + plotH - h;
          const r = Math.min(4, h / 2, barW / 2);
          // Rounded top, square base anchored to the baseline.
          const path = h > 0 ? `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + h} Z` : '';
          return (
            <g key={d.key}>
              <rect x={padL + i * slot} y={8} width={slot} height={plotH} fill="transparent">
                <title>{`${d.label}: ${format(d.value)}`}</title>
              </rect>
              {h > 0 && (
                <path d={path} className={d.className ?? 'fill-brand-500'}>
                  <title>{`${d.label}: ${format(d.value)}`}</title>
                </path>
              )}
              {(i === 0 || i === data.length - 1 || i % Math.ceil(n / 6) === 0) && (
                <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="fill-ink-muted text-[11px]">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="text-sm text-ink-muted">{summary}</figcaption>
      <TableAlt caption={tableCaption} data={data} colLabel={colLabel} colValue={colValue} format={format} />
    </figure>
  );
}

/** Horizontal bar list (categories with long labels): label, bar, value. */
export function BarList({
  data,
  summary,
  tableCaption,
  colLabel,
  colValue,
  format = String,
  icon,
}: {
  data: Datum[];
  summary: string;
  tableCaption: string;
  colLabel: string;
  colValue: string;
  format?: (n: number) => string;
  icon?: (d: Datum) => ReactNode;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure>
      <ul className="space-y-2" aria-hidden="true">
        {data.map((d) => (
          <li key={d.key} className="grid grid-cols-[minmax(8rem,14rem)_1fr_3rem] items-center gap-3 text-sm" title={`${d.label}: ${format(d.value)}`}>
            <span className="flex items-center gap-1.5 truncate">
              {icon?.(d)}
              {d.label}
            </span>
            <span className="h-3 rounded-r-[4px] bg-paper">
              <span className={`block h-3 rounded-r-[4px] ${d.className ?? 'bg-brand-500'}`} style={{ width: `${(d.value / max) * 100}%` }} />
            </span>
            <span className="text-right font-mono tabular">{format(d.value)}</span>
          </li>
        ))}
      </ul>
      <figcaption className="mt-2 text-sm text-ink-muted">{summary}</figcaption>
      <TableAlt caption={tableCaption} data={data} colLabel={colLabel} colValue={colValue} format={format} />
    </figure>
  );
}

/** Headline number (no chart needed). */
export function StatTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-line bg-surface p-5 shadow-1">
      <h2 className="text-base font-semibold text-ink-muted">{label}</h2>
      <p className="mt-1 font-mono text-4xl font-semibold tabular text-ink">{value}</p>
      <p className="mt-2 text-sm text-ink-muted">{detail}</p>
    </div>
  );
}
