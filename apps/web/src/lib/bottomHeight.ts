/**
 * Height of the bottom panel (the tabs under the chart) the trader dragged it to, in pixels.
 * The campaign tab and the other tabs keep their own height, because the campaign opens taller by default.
 * Nothing stored means the stylesheet's default.
 */
export type BottomSize = 'normal' | 'tall';

export const BOTTOM_HEIGHT_KEYS: Record<BottomSize, string> = {
  normal: 'pegasus.layout.bottomHeight',
  tall: 'pegasus.layout.bottomHeightCampaign',
};

/** The panel keeps its tab bar and a few rows; the chart keeps enough to read. */
export const MIN_BOTTOM_PX = 90;
export const MIN_CHART_PX = 160;

/** Height for the panel within a column of `columnPx`: at least MIN_BOTTOM_PX, leaving the chart MIN_CHART_PX. */
export function clampBottomHeight(px: number, columnPx: number): number {
  const max = Math.max(MIN_BOTTOM_PX, columnPx - MIN_CHART_PX);
  return Math.round(Math.min(max, Math.max(MIN_BOTTOM_PX, px)));
}

export function readBottomHeight(size: BottomSize): number | null {
  try {
    const v = localStorage.getItem(BOTTOM_HEIGHT_KEYS[size]);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= MIN_BOTTOM_PX ? n : null;
  } catch {
    return null;
  }
}

export function writeBottomHeight(size: BottomSize, px: number | null): void {
  try {
    if (px === null) localStorage.removeItem(BOTTOM_HEIGHT_KEYS[size]);
    else localStorage.setItem(BOTTOM_HEIGHT_KEYS[size], String(px));
  } catch {
    // storage unavailable (private mode etc.) – the height still holds for this session
  }
}
