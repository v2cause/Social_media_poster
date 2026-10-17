'use client';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@smp/ui';
import { useTranslations } from 'next-intl';
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';

import {
  extentOf,
  labelIndexes,
  nearestIndex,
  niceScale,
  pathOf,
  positionOf,
  segmentsOf,
  xOf,
} from './chart-geometry';
import { LegendSwatch, MarkerShape, type SeriesStyle } from './series-style';
import { useElementWidth } from './use-element-width';

// The line chart of the analytics views (guide step 5.5): one line per series with its own dash
// pattern and marker, a legend, and a gap where a value is missing instead of a drop to 0.
// Pointer and arrow keys pick a point; its values show next to it and are announced. The same
// numbers are available as a table, which is the text alternative of the chart.

export interface LineSeries {
  key: string;
  label: string;
  style: SeriesStyle;
  values: readonly (number | null)[];
}

const MARGIN = { top: 12, right: 16, bottom: 28, left: 56 };
/** Markers sit on every point while they do not crowd the lines. */
const MAX_MARKED_POINTS = 31;
const TOOLTIP_HALF_WIDTH = 90;

export function LineChart(props: {
  /** The accessible name of the chart and the caption of its table. */
  title: string;
  /** The label of each point of the time axis. */
  labels: readonly string[];
  series: readonly LineSeries[];
  /** A value in the tooltip and the table; null reads "n. v.". */
  formatValue: (value: number | null) => string;
  /** A label of the value axis. */
  formatTick: (value: number) => string;
  /** Counts start at 0; follower numbers start near their smallest value. */
  fromZero?: boolean;
  height?: number;
}) {
  const t = useTranslations('analytics.chart');
  const id = useId();
  const [ref, width] = useElementWidth(640);
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 240;
  const count = props.labels.length;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = height - MARGIN.top - MARGIN.bottom;
  const extent = extentOf(props.series.flatMap((series) => series.values));
  const scale = niceScale(extent?.min ?? 0, extent?.max ?? 0, { fromZero: props.fromZero ?? true });
  const y = positionOf(scale, MARGIN.top + innerHeight, MARGIN.top);
  const x = (index: number) => xOf(index, count, MARGIN.left, innerWidth);
  const labeled = labelIndexes(count, Math.max(2, Math.floor(innerWidth / 90)));
  const marked = count <= MAX_MARKED_POINTS;

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(event.clientX - box.left, count, MARGIN.left, innerWidth));
  };
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = (active ?? count) - 1;
        break;
      case 'ArrowRight':
        next = (active ?? -1) + 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Escape':
        setActive(null);
        return;
      default:
        return;
    }
    event.preventDefault();
    setActive(Math.min(count - 1, Math.max(0, next)));
  };
  const describe = (index: number): string =>
    `${props.labels[index] ?? ''}: ${props.series
      .map((series) => `${series.label} ${props.formatValue(series.values[index] ?? null)}`)
      .join(', ')}`;

  return (
    <figure className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('legend')}>
        {props.series.map((series) => (
          <li key={series.key} className="flex items-center gap-2">
            <LegendSwatch style={series.style} />
            {series.label}
          </li>
        ))}
      </ul>
      <div
        ref={ref}
        role="group"
        tabIndex={count > 0 ? 0 : -1}
        aria-label={`${props.title}. ${t('keyboardHint')}`}
        className="relative w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={step}
        onBlur={() => {
          setActive(null);
        }}
      >
        <svg
          width={width}
          height={height}
          role="img"
          aria-labelledby={`${id}-title`}
          className="block max-w-full touch-pan-y select-none"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => {
            setActive(null);
          }}
        >
          <title id={`${id}-title`}>{props.title}</title>
          {scale.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={MARGIN.left}
                x2={MARGIN.left + innerWidth}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={MARGIN.left - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {props.formatTick(tick)}
              </text>
            </g>
          ))}
          {labeled.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={height - 8}
              textAnchor={
                count > 1 && index === 0 ? 'start' : index === count - 1 && count > 1 ? 'end' : 'middle'
              }
              className="fill-muted-foreground text-[11px]"
            >
              {props.labels[index]}
            </text>
          ))}
          {props.series.map((series) => {
            const segments = segmentsOf(series.values, x, y);
            return (
              <g key={series.key}>
                {segments.map((segment) => (
                  <path
                    key={segment[0]?.index ?? 0}
                    d={pathOf(segment)}
                    fill="none"
                    stroke={series.style.color}
                    strokeWidth={2}
                    strokeDasharray={series.style.dash}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {segments
                  .filter((segment) => marked || segment.length === 1)
                  .flat()
                  .map((point) => (
                    <MarkerShape key={point.index} style={series.style} x={point.x} y={point.y} />
                  ))}
              </g>
            );
          })}
          {active !== null ? (
            <g>
              <line
                x1={x(active)}
                x2={x(active)}
                y1={MARGIN.top}
                y2={MARGIN.top + innerHeight}
                stroke="var(--muted-foreground)"
                strokeDasharray="3 3"
              />
              {props.series.map((series) => {
                const value = series.values[active] ?? null;
                return value === null ? null : (
                  <MarkerShape key={series.key} style={series.style} x={x(active)} y={y(value)} size={5} />
                );
              })}
            </g>
          ) : null}
        </svg>
        {active !== null ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-10 w-44 rounded-md border border-border bg-card p-2 text-xs shadow-md"
            style={{
              left: Math.min(Math.max(x(active), TOOLTIP_HALF_WIDTH), width - TOOLTIP_HALF_WIDTH),
              transform: 'translateX(-50%)',
            }}
          >
            <p className="mb-1 font-medium">{props.labels[active]}</p>
            <ul className="flex flex-col gap-1">
              {props.series.map((series) => (
                <li key={series.key} className="flex items-center gap-2">
                  <LegendSwatch style={series.style} />
                  <span className="truncate">{series.label}</span>
                  <span className="ml-auto tabular-nums">
                    {props.formatValue(series.values[active] ?? null)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p aria-live="polite" className="sr-only">
        {active !== null ? describe(active) : ''}
      </p>
      <details className="text-sm">
        <summary className="w-fit cursor-pointer rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('showTable')}
        </summary>
        <div className="mt-2 max-h-80 overflow-auto">
          <Table>
            <caption className="sr-only">{props.title}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>{t('date')}</TableHead>
                {props.series.map((series) => (
                  <TableHead key={series.key} className="text-right">
                    {series.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.labels.map((label, index) => (
                <TableRow key={index}>
                  <TableCell>{label}</TableCell>
                  {props.series.map((series) => (
                    <TableCell key={series.key} className="text-right tabular-nums">
                      {props.formatValue(series.values[index] ?? null)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </figure>
  );
}
