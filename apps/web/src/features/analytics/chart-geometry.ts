// The geometry of the charts of the analytics views (guide step 5.5): an axis with round ticks,
// the points of a series with gaps where a value is missing, their paths, which labels of the
// time axis fit, and which point a pointer is closest to. Plain numbers only, so it is tested
// without a browser; the components draw the result as SVG.

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

export interface Point {
  x: number;
  y: number;
  /** The position of the value in its series. */
  index: number;
}

/** Steps of 1, 2, 2.5 or 5 times a power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10];

/** Drops the noise of floating point: 0.30000000000000004 becomes 0.3. */
const clean = (value: number): number => Number(value.toPrecision(12));

/**
 * An axis from at most `min` to at least `max` with about `count` round steps. Counts start at 0
 * (`fromZero`); a flat series gets room around its value.
 */
export function niceScale(
  min: number,
  max: number,
  options: { count?: number; fromZero?: boolean } = {},
): Scale {
  const count = options.count ?? 4;
  let low = options.fromZero ? Math.min(0, min) : min;
  let high = max;
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return { min: 0, max: 1, ticks: [0, 1] };
  }
  if (low === high) {
    if (high === 0) {
      high = 1;
    } else {
      // A positive value keeps its axis at or above 0.
      const pad = Math.abs(high) * 0.1;
      low = high > 0 ? Math.max(0, low - pad) : low - pad;
      high += pad;
    }
  }
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = (NICE_STEPS.find((candidate) => candidate * power >= raw) ?? 10) * power;
  const first = Math.floor(clean(low / step)) * step;
  const last = Math.ceil(clean(high / step)) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= last + step / 2; tick += step) {
    ticks.push(clean(tick));
  }
  return { min: clean(first), max: clean(last), ticks };
}

/** Maps a value of the scale to a position between `from` and `to`. */
export const positionOf =
  (scale: Pick<Scale, 'min' | 'max'>, from: number, to: number) =>
  (value: number): number =>
    scale.max === scale.min
      ? (from + to) / 2
      : from + ((value - scale.min) / (scale.max - scale.min)) * (to - from);

/** The horizontal position of the point `index` of `count`, spread over the width. */
export const xOf = (index: number, count: number, left: number, width: number): number =>
  count <= 1 ? left + width / 2 : left + (index * width) / (count - 1);

/** The point closest to a horizontal position. */
export function nearestIndex(x: number, count: number, left: number, width: number): number {
  if (count <= 1) {
    return 0;
  }
  const index = Math.round(((x - left) * (count - 1)) / width);
  return Math.min(count - 1, Math.max(0, index));
}

/** The points of a series, split where a value is missing: a gap is not a 0. */
export function segmentsOf(
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): Point[][] {
  const segments: Point[][] = [];
  let current: Point[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      return;
    }
    current.push({ x: x(index), y: y(value), index });
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

const fixed = (value: number): string => String(Math.round(value * 100) / 100);

/** The SVG path through the points of a segment. */
export const pathOf = (points: readonly Point[]): string =>
  points.map((point, at) => `${at === 0 ? 'M' : 'L'}${fixed(point.x)} ${fixed(point.y)}`).join(' ');

/** The positions of the time axis that get a label, at most `max`, evenly apart from the first. */
export function labelIndexes(count: number, max: number): number[] {
  if (count <= 0 || max <= 0) {
    return [];
  }
  if (count <= max) {
    return Array.from({ length: count }, (_, index) => index);
  }
  const step = Math.ceil((count - 1) / Math.max(1, max - 1));
  const indexes: number[] = [];
  for (let index = 0; index < count; index += step) {
    indexes.push(index);
  }
  return indexes;
}

/** The smallest and the largest of the values, ignoring the gaps; null without any value. */
export function extentOf(values: readonly (number | null)[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value !== null) {
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return min <= max ? { min, max } : null;
}

/** The segments of a sparkline in a box of the given size; a flat series runs through the middle. */
export function sparklineOf(values: readonly (number | null)[], width: number, height: number): Point[][] {
  const extent = extentOf(values);
  if (!extent) {
    return [];
  }
  const pad = 2;
  const y = positionOf(extent, height - pad, pad);
  return segmentsOf(values, (index) => xOf(index, values.length, pad, width - 2 * pad), y);
}
