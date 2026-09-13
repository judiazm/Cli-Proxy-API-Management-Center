/**
 * Colours for the stacked series in the timeline.
 *
 * The theme exposes semantic colours (success, failure, warning) and one brand
 * colour. None of that is a categorical scale, and the timeline needs one: a
 * device is not "good" or "bad", it is just a different device. So the hues are
 * fixed here, spaced around the wheel and picked to stay legible on both the
 * light and the dark surface at a single saturation and lightness.
 *
 * Assignment is by position in the series list, which is ordered by size, so
 * the same device keeps the same colour for as long as it stays the heaviest.
 * Past the end of the ramp the hues repeat with a lightness shift rather than
 * wrapping exactly, so two series are never given an identical swatch.
 */

const HUES = [212, 158, 32, 276, 344, 190, 94, 258, 14, 132] as const;

export const usageSeriesColor = (index: number): string => {
  if (index < 0) return 'hsl(212 12% 55%)';
  const hue = HUES[index % HUES.length];
  const cycle = Math.floor(index / HUES.length);
  const lightness = 54 - Math.min(cycle, 2) * 11;
  return `hsl(${hue} 58% ${lightness}%)`;
};

/**
 * A round number at or above `peak`, divisible into `steps` clean ticks.
 *
 * Borrowed in spirit from the dashboard's throughput chart: an axis that tops
 * out at 13,417 gives the reader arithmetic to do before they can compare two
 * bars.
 */
export const usageAxisMax = (peak: number, steps: number): number => {
  if (!Number.isFinite(peak) || peak <= 0) return steps;

  const rough = peak / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const niceStep =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;

  return niceStep * magnitude * steps;
};
