import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeIntervals, type Interval } from '../src/intervals';

// Read the spec in src/intervals/mergeIntervals.ts, then check your progress
// with `npm run mutants:intervals`.
//
// Label every property with its pattern, on the line above its `it(`:
//   // Pattern: invariant. The output is sorted.
// (invariant, algebraic, metamorphic, differential, or conditional)

// Checkpoint 1: the first generator paired two unrelated integers, so it often
// produced intervals like [1, 0] where start > end. Those break the
// precondition and mergeIntervals throws a RangeError. The property was fine;
// the generator was wrong. The fix builds every interval as a start plus a
// non-negative length, so start <= end holds by construction.
//
// Endpoints come mostly from a small range so that intervals often overlap,
// touch (share an endpoint) or sit exactly one apart. The small range still
// crosses zero and the 9/10 boundary, so numeric order and string order
// differ. A few intervals use a wide range to cover large and negative values.
const smallInterval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -20, max: 20 }), fc.nat({ max: 8 }))
  .map(([start, length]): Interval => [start, start + length]);

const wideInterval: fc.Arbitrary<Interval> = fc
  .tuple(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.nat({ max: 1_000_000 }))
  .map(([start, length]): Interval => [start, start + length]);

const interval: fc.Arbitrary<Interval> = fc.oneof(
  { arbitrary: smallInterval, weight: 9 },
  { arbitrary: wideInterval, weight: 1 },
);
const intervalList = fc.array(interval, { maxLength: 12 });

// Targeted generator for the conditional property: intervals that neither
// overlap nor touch. Each interval starts at least one unit after the previous
// one ends (gap of 1 to 4), so result[i][1] < result[i + 1][0] holds by
// construction. A gap of exactly 1 (for example [1, 2] and [3, 4]) is common.
// The list is then shuffled, because the input may come in any order.
const disjointSortedList: fc.Arbitrary<Interval[]> = fc
  .tuple(
    fc.integer({ min: -30, max: 30 }),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 4 }), fc.nat({ max: 5 })), { maxLength: 10 }),
  )
  .map(([first, steps]) => {
    const out: Interval[] = [];
    let nextStart = first;
    for (const [gap, length] of steps) {
      const start = nextStart;
      const end = start + length;
      out.push([start, end]);
      nextStart = end + gap;
    }
    return out;
  });

const shuffledDisjointList = disjointSortedList.chain(sorted =>
  fc
    .shuffledSubarray(sorted, { minLength: sorted.length, maxLength: sorted.length })
    .map(shuffled => ({ sorted, shuffled })),
);

// A list together with a random reordering of the same intervals.
const listAndPermutation = intervalList.chain(xs =>
  fc
    .shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length })
    .map(permuted => ({ xs, permuted })),
);

// Small helper oracle: is the real number p inside some interval of the list?
const covers = (list: readonly Interval[], p: number): boolean =>
  list.some(([start, end]) => start <= p && p <= end);

// Points worth checking: every endpoint, plus the points half a unit on either
// side of it. Half points sit inside the gap between [1, 2] and [3, 4], so they
// show whether such a gap is kept. Between two consecutive probe points the
// coverage of both lists is constant, so these points are enough.
const probePoints = (lists: readonly (readonly Interval[])[]): number[] => {
  const points = new Set<number>();
  for (const list of lists) {
    for (const [start, end] of list) {
      for (const e of [start, end]) {
        points.add(e - 0.5);
        points.add(e);
        points.add(e + 0.5);
      }
    }
  }
  return [...points];
};

const deepCopy = (xs: readonly Interval[]): Interval[] => xs.map(([s, e]): Interval => [s, e]);

describe('mergeIntervals', () => {
  // Pattern: invariant. Every input interval lies inside some output interval.
  it('every input interval lies inside some output interval', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        const uncovered = xs.filter(([s, e]) => out.some(([a, b]) => a <= s && e <= b) === false);
        expect(uncovered).toEqual([]);
      }),
    );
  });

  // Pattern: invariant. The output is sorted by start, every output interval is valid (integer endpoints, start <= end), consecutive output intervals neither overlap nor touch, and the input is left unmodified.
  it('returns sorted, disjoint, valid intervals and leaves the input unchanged', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const before = deepCopy(xs);
        const out = mergeIntervals(xs);
        for (const [start, end] of out) {
          expect(Number.isInteger(start) && Number.isInteger(end)).toBe(true);
          expect(start).toBeLessThanOrEqual(end);
        }
        for (let i = 0; i + 1 < out.length; i++) {
          expect(out[i][1]).toBeLessThan(out[i + 1][0]);
        }
        // The input array and its intervals are not modified, and the output
        // does not reuse the caller's interval objects.
        expect(xs).toEqual(before);
        for (const o of out) {
          expect(xs.includes(o)).toBe(false);
        }
      }),
    );
  });

  // Pattern: differential. For every point p of the number line, p is covered by the output exactly when it is covered by the input (checked at every endpoint and half a unit on each side of it).
  it('covers exactly the same points as the input', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const out = mergeIntervals(xs);
        for (const p of probePoints([xs, out])) {
          expect({ p, covered: covers(out, p) }).toEqual({ p, covered: covers(xs, p) });
        }
      }),
    );
  });

  // Pattern: metamorphic. Reordering the input intervals does not change the output.
  it('gives the same output for any order of the input', () => {
    fc.assert(
      fc.property(listAndPermutation, ({ xs, permuted }) => {
        expect(mergeIntervals(permuted)).toEqual(mergeIntervals(xs));
      }),
    );
  });

  // Pattern: algebraic. Merging is idempotent: merging an already merged list gives the same list back.
  it('merging twice is the same as merging once', () => {
    fc.assert(
      fc.property(intervalList, xs => {
        const once = mergeIntervals(xs);
        expect(mergeIntervals(once)).toEqual(once);
      }),
    );
  });

  // Pattern: conditional. If no two input intervals overlap or touch, the output is exactly the input intervals sorted by start.
  it('returns already-disjoint input unchanged apart from sorting', () => {
    fc.assert(
      fc.property(shuffledDisjointList, ({ sorted, shuffled }) => {
        expect(mergeIntervals(shuffled)).toEqual(sorted);
      }),
    );
  });

});
