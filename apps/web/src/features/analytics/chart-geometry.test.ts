import { describe, expect, it } from 'vitest';

import {
  extentOf,
  labelIndexes,
  nearestIndex,
  niceScale,
  pathOf,
  positionOf,
  segmentsOf,
  sparklineOf,
  xOf,
} from './chart-geometry';

describe('niceScale', () => {
  it('rounds the axis to steps of 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceScale(0, 870, { fromZero: true })).toEqual({
      min: 0,
      max: 1_000,
      ticks: [0, 250, 500, 750, 1_000],
    });
    expect(niceScale(1_843, 2_344)).toEqual({ min: 1_800, max: 2_400, ticks: [1_800, 2_000, 2_200, 2_400] });
  });

  it('handles rates without floating point noise', () => {
    const scale = niceScale(0.012, 0.061, { fromZero: true });
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(0.08);
    expect(scale.ticks).toEqual([0, 0.02, 0.04, 0.06, 0.08]);
  });

  it('gives a flat series room and an empty one the range 0 to 1', () => {
    expect(niceScale(0, 0, { fromZero: true })).toMatchObject({ min: 0, max: 1 });
    const flat = niceScale(500, 500);
    expect(flat.min).toBeLessThan(500);
    expect(flat.max).toBeGreaterThan(500);
    expect(flat.min).toBeGreaterThanOrEqual(0);
    expect(niceScale(-5, 20, { fromZero: true }).min).toBeLessThanOrEqual(-5);
  });
});

describe('positions', () => {
  it('maps values and indexes into the drawing area', () => {
    const y = positionOf({ min: 0, max: 100 }, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(25)).toBe(150);
    expect(positionOf({ min: 5, max: 5 }, 200, 0)(5)).toBe(100);

    expect(xOf(0, 5, 40, 400)).toBe(40);
    expect(xOf(4, 5, 40, 400)).toBe(440);
    expect(xOf(0, 1, 40, 400)).toBe(240);
  });

  it('finds the point closest to the pointer', () => {
    expect(nearestIndex(40, 5, 40, 400)).toBe(0);
    expect(nearestIndex(180, 5, 40, 400)).toBe(1);
    expect(nearestIndex(200, 5, 40, 400)).toBe(2);
    expect(nearestIndex(900, 5, 40, 400)).toBe(4);
    expect(nearestIndex(-10, 5, 40, 400)).toBe(0);
    expect(nearestIndex(100, 1, 40, 400)).toBe(0);
  });
});

describe('segmentsOf', () => {
  it('breaks the line where a value is missing instead of drawing it as 0', () => {
    const segments = segmentsOf(
      [1, 2, null, 4, null, null, 7],
      (index) => index * 10,
      (value) => value,
    );
    expect(segments.map((segment) => segment.map((point) => point.index))).toEqual([[0, 1], [3], [6]]);
    expect(pathOf(segments[0] ?? [])).toBe('M0 1 L10 2');
    expect(
      segmentsOf(
        [null, null],
        (index) => index,
        (value) => value,
      ),
    ).toEqual([]);
  });

  it('rounds the path to hundredths', () => {
    expect(pathOf([{ x: 1 / 3, y: 2 / 3, index: 0 }])).toBe('M0.33 0.67');
  });
});

describe('labelIndexes', () => {
  it('labels every point while they fit and evenly spaced ones beyond', () => {
    expect(labelIndexes(4, 6)).toEqual([0, 1, 2, 3]);
    expect(labelIndexes(30, 6)).toEqual([0, 6, 12, 18, 24]);
    expect(labelIndexes(0, 6)).toEqual([]);
  });
});

describe('sparklines', () => {
  it('fills the box between the smallest and the largest value', () => {
    expect(extentOf([null, 4, 2, null, 9])).toEqual({ min: 2, max: 9 });
    expect(extentOf([null])).toBeNull();
    const [segment] = sparklineOf([2, 9], 100, 20);
    expect(segment?.map((point) => [point.x, point.y])).toEqual([
      [2, 18],
      [98, 2],
    ]);
    expect(sparklineOf([null, null], 100, 20)).toEqual([]);
  });
});
