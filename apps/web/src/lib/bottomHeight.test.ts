import { afterEach, describe, expect, it } from 'vitest';
import { BOTTOM_HEIGHT_KEYS, MIN_BOTTOM_PX, MIN_CHART_PX, clampBottomHeight, readBottomHeight, writeBottomHeight } from './bottomHeight';

describe('bottom panel height', () => {
  afterEach(() => localStorage.clear());

  it('keeps the panel and the chart readable', () => {
    expect(clampBottomHeight(10, 800)).toBe(MIN_BOTTOM_PX);
    expect(clampBottomHeight(2000, 800)).toBe(800 - MIN_CHART_PX);
    expect(clampBottomHeight(345.6, 800)).toBe(346);
    // a column too short for both: the panel keeps its minimum
    expect(clampBottomHeight(500, 200)).toBe(MIN_BOTTOM_PX);
  });

  it('remembers each size apart and forgets it on reset', () => {
    expect(readBottomHeight('normal')).toBeNull();
    writeBottomHeight('normal', 420);
    writeBottomHeight('tall', 600);
    expect(readBottomHeight('normal')).toBe(420);
    expect(readBottomHeight('tall')).toBe(600);
    writeBottomHeight('normal', null);
    expect(readBottomHeight('normal')).toBeNull();
    expect(readBottomHeight('tall')).toBe(600);
  });

  it('ignores a stored value that is not a usable height', () => {
    localStorage.setItem(BOTTOM_HEIGHT_KEYS.normal, 'abc');
    expect(readBottomHeight('normal')).toBeNull();
    localStorage.setItem(BOTTOM_HEIGHT_KEYS.normal, '5');
    expect(readBottomHeight('normal')).toBeNull();
  });
});
