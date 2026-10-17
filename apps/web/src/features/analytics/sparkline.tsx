import { pathOf, sparklineOf } from './chart-geometry';

// The sparkline of a KPI tile (guide step 5.5): the course of the period at a glance, with gaps
// where a day has no value. It only repeats the number of its tile, so it stays hidden from
// screen readers.

const WIDTH = 96;
const HEIGHT = 28;

export function Sparkline(props: { values: readonly (number | null)[] }) {
  const segments = sparklineOf(props.values, WIDTH, HEIGHT);
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      aria-hidden="true"
      className="shrink-0 text-chart-1"
    >
      {segments.map((segment) =>
        segment.length === 1 ? (
          <circle key={segment[0]?.index} cx={segment[0]?.x} cy={segment[0]?.y} r={1.5} fill="currentColor" />
        ) : (
          <path
            key={segment[0]?.index}
            d={pathOf(segment)}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ),
      )}
    </svg>
  );
}
