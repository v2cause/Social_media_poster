import type { Platform } from '@smp/platform-rules';

// How a series looks in the charts of the analytics views (guide step 5.5): a color, a dash
// pattern and a marker, so a series is told apart without its color as well. The colors are the
// theme tokens --chart-1 to --chart-4, with at least 3:1 against the card in both themes. A
// platform keeps its look in every chart.

export type Marker = 'circle' | 'square' | 'triangle' | 'diamond';

export interface SeriesStyle {
  /** A CSS color. */
  color: string;
  /** The stroke-dasharray of the line; undefined for a solid one. */
  dash: string | undefined;
  marker: Marker;
  /** The Tailwind class of the color, for bars. */
  fill: string;
}

const STYLES = [
  { color: 'var(--chart-1)', dash: undefined, marker: 'circle', fill: 'bg-chart-1' },
  { color: 'var(--chart-2)', dash: '7 4', marker: 'square', fill: 'bg-chart-2' },
  { color: 'var(--chart-3)', dash: '2 3', marker: 'triangle', fill: 'bg-chart-3' },
  { color: 'var(--chart-4)', dash: '10 3 2 3', marker: 'diamond', fill: 'bg-chart-4' },
] as const satisfies readonly SeriesStyle[];

const PLATFORM_STYLES: Readonly<Record<Platform, SeriesStyle>> = {
  LINKEDIN: STYLES[0],
  INSTAGRAM: STYLES[1],
  FACEBOOK: STYLES[2],
  X: STYLES[3],
};

export const platformStyle = (platform: Platform): SeriesStyle => PLATFORM_STYLES[platform];

/** The style of the n-th series without a platform, for example of a metric. */
export const seriesStyle = (index: number): SeriesStyle => STYLES[index % STYLES.length] ?? STYLES[0];

/** A closed SVG path through the corners. */
const polygon = (corners: readonly (readonly [number, number])[]): string =>
  `${corners.map(([x, y], at) => `${at === 0 ? 'M' : 'L'}${String(x)} ${String(y)}`).join(' ')} Z`;

/** The marker of a series at a point; a ring in the card color keeps it apart from the line. */
export function MarkerShape(props: { style: SeriesStyle; x: number; y: number; size?: number }) {
  const { x, y } = props;
  const r = props.size ?? 3.5;
  const paint = { fill: props.style.color, stroke: 'var(--card)', strokeWidth: 1.5 };
  switch (props.style.marker) {
    case 'circle':
      return <circle cx={x} cy={y} r={r} {...paint} />;
    case 'square':
      return <rect x={x - r} y={y - r} width={2 * r} height={2 * r} {...paint} />;
    case 'triangle': {
      const t = r * 1.25;
      return (
        <path
          d={polygon([
            [x, y - t],
            [x + t, y + r],
            [x - t, y + r],
          ])}
          {...paint}
        />
      );
    }
    case 'diamond': {
      const d = r * 1.35;
      return (
        <path
          d={polygon([
            [x, y - d],
            [x + d, y],
            [x, y + d],
            [x - d, y],
          ])}
          {...paint}
        />
      );
    }
  }
}

/** The sample of a series in a legend: its line with its dash pattern and its marker. */
export function LegendSwatch(props: { style: SeriesStyle }) {
  return (
    <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="6"
        x2="27"
        y2="6"
        stroke={props.style.color}
        strokeWidth="2"
        strokeDasharray={props.style.dash}
      />
      <MarkerShape style={props.style} x={14} y={6} />
    </svg>
  );
}
