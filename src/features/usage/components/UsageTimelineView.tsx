/**
 * Stacked bars over time, one series per value of the primary dimension.
 *
 * Hand-rolled in the same way the dashboard's throughput chart is: absolutely
 * positioned elements inside a sized box, no chart library. That is not a
 * stylistic preference. The panel ships as a single inlined HTML file under a
 * strict content-security policy, so a runtime that injects style or fetches a
 * worker is not an option, and a charting dependency would be the largest thing
 * in the bundle by some margin.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageGroupColumn, UsageMetrics, UsageTimeBucket } from '@/services/api';
import { findUsageMetric } from '../logic/dimensions';
import { formatBucketLabel, formatUsageMetric } from '../logic/formatUsage';
import { usageAxisMax, usageSeriesColor } from '../logic/series';
import { buildUsageTimeline, visibleTimelinePeak } from '../logic/timeline';
import type { UsageLabeller } from '../hooks/useUsageLabels';
import styles from './UsageViews.module.scss';

/** Ticks on the value axis, including zero. */
const TICK_COUNT = 5;

export interface UsageTimelineViewProps {
  rows: Parameters<typeof buildUsageTimeline>[0];
  bucket: UsageTimeBucket;
  seriesDimension: UsageGroupColumn;
  metric: keyof UsageMetrics;
  labeller: UsageLabeller;
}

export function UsageTimelineView({
  rows,
  bucket,
  seriesDimension,
  metric,
  labeller,
}: UsageTimelineViewProps) {
  const { t, i18n } = useTranslation();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const metricDef = findUsageMetric(metric);
  const unit = metricDef?.unit ?? 'count';

  const timeline = useMemo(
    () =>
      buildUsageTimeline(rows, {
        bucketDimension: bucket,
        seriesDimension,
        metric,
      }),
    [rows, bucket, seriesDimension, metric]
  );

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    timeline.series.forEach((series, index) => {
      map.set(series.key, series.isOther ? 'hsl(215 8% 58%)' : usageSeriesColor(index));
    });
    return map;
  }, [timeline.series]);

  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    timeline.series.forEach((series) => {
      map.set(
        series.key,
        series.isOther ? t('usage.series_other') : labeller.plainLabel(seriesDimension, series.key)
      );
    });
    return map;
  }, [timeline.series, labeller, seriesDimension, t]);

  const peak = useMemo(() => visibleTimelinePeak(timeline, hidden), [timeline, hidden]);
  const scaleMax = useMemo(() => usageAxisMax(peak, TICK_COUNT - 1), [peak]);

  const ticks = useMemo(
    () =>
      Array.from({ length: TICK_COUNT }, (_, index) => {
        const ratio = 1 - index / (TICK_COUNT - 1);
        return { ratio, value: scaleMax * ratio };
      }),
    [scaleMax]
  );

  const xAxisTicks = useMemo(() => {
    const count = timeline.buckets.length;
    if (count === 0) return [];
    const positions = [0, Math.floor((count - 1) / 2), count - 1];
    return Array.from(new Set(positions)).map((index) => ({
      index,
      label: formatBucketLabel(timeline.buckets[index].key, bucket, i18n.language),
    }));
  }, [timeline.buckets, bucket, i18n.language]);

  const toggleSeries = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (timeline.buckets.length === 0) {
    return (
      <section className={styles.panel}>
        <p className={styles.panelNote}>{t('usage.empty_range')}</p>
      </section>
    );
  }

  const activeBucket = activeIndex === null ? null : timeline.buckets[activeIndex];
  const activeEntries = activeBucket
    ? timeline.series
        .filter((series) => !hidden.has(series.key))
        .map((series) => ({
          key: series.key,
          value: activeBucket.values.get(series.key) ?? 0,
        }))
        .filter((entry) => entry.value > 0)
    : [];
  const activeTotal = activeEntries.reduce((sum, entry) => sum + entry.value, 0);

  return (
    <section className={styles.panel}>
      <figure className={styles.chart}>
        <figcaption className={styles.legend}>
          {timeline.series.map((series) => {
            const off = hidden.has(series.key);
            const name = nameOf.get(series.key) ?? series.key;
            return (
              <button
                key={series.key || '__blank__'}
                type="button"
                className={`${styles.legendItem} ${off ? styles.legendOff : ''}`}
                onClick={() => toggleSeries(series.key)}
                aria-pressed={!off}
                title={name}
              >
                <span
                  className={styles.legendSwatch}
                  style={{ background: colorOf.get(series.key) }}
                  aria-hidden="true"
                />
                <span className={styles.legendName}>{name}</span>
                <b className={styles.legendValue}>{formatUsageMetric(series.total, unit)}</b>
              </button>
            );
          })}
        </figcaption>

        <div className={styles.plot}>
          <div className={styles.yAxis} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.yTick}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              >
                {formatUsageMetric(tick.value, unit)}
              </span>
            ))}
          </div>

          <div className={styles.canvas}>
            <div className={styles.gridlines} aria-hidden="true">
              {ticks.map((tick) => (
                <span
                  key={tick.ratio}
                  className={styles.gridline}
                  style={{ top: `${(1 - tick.ratio) * 100}%` }}
                />
              ))}
            </div>

            <div
              className={styles.columns}
              role="img"
              aria-label={t('usage.timeline_summary', {
                buckets: timeline.buckets.length,
                series: timeline.series.length,
                metric: t(metricDef?.labelKey ?? 'usage.metric_total_tokens'),
              })}
              onMouseLeave={() => setActiveIndex(null)}
            >
              {timeline.buckets.map((entry, index) => {
                const delay =
                  timeline.buckets.length > 1
                    ? Math.round((index / (timeline.buckets.length - 1)) * 320)
                    : 0;
                // Painted top-down so the largest series sits at the base of
                // the stack, where a bar is easiest to compare across columns.
                const segments = [...timeline.series]
                  .reverse()
                  .filter((series) => !hidden.has(series.key))
                  .map((series) => ({
                    key: series.key,
                    value: entry.values.get(series.key) ?? 0,
                  }))
                  .filter((segment) => segment.value > 0);
                const visibleTotal = segments.reduce((sum, segment) => sum + segment.value, 0);

                return (
                  <div
                    key={entry.key || index}
                    className={`${styles.column} ${activeIndex === index ? styles.columnActive : ''}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                  >
                    <div
                      className={styles.stack}
                      style={{ '--bar-delay': `${delay}ms` } as React.CSSProperties}
                    >
                      {segments.map((segment) => (
                        <span
                          key={segment.key || '__blank__'}
                          className={styles.segment}
                          style={{
                            height: `${(segment.value / scaleMax) * 100}%`,
                            background: colorOf.get(segment.key),
                          }}
                        />
                      ))}
                      {visibleTotal === 0 && <span className={styles.idleTick} />}
                    </div>
                  </div>
                );
              })}
            </div>

            {peak === 0 && <p className={styles.emptyOverlay}>{t('usage.empty_range')}</p>}

            {activeBucket && (
              <div
                className={styles.tooltip}
                style={{
                  left: `${((activeIndex! + 0.5) / timeline.buckets.length) * 100}%`,
                  transform:
                    activeIndex! < timeline.buckets.length * 0.15
                      ? 'translateX(-12%)'
                      : activeIndex! > timeline.buckets.length * 0.85
                        ? 'translateX(-88%)'
                        : 'translateX(-50%)',
                }}
                role="status"
              >
                <span className={styles.tooltipTime}>
                  {formatBucketLabel(activeBucket.key, bucket, i18n.language)}
                </span>
                {activeEntries.slice(0, 8).map((entry) => (
                  <span key={entry.key || '__blank__'} className={styles.tooltipRow}>
                    <span
                      className={styles.legendSwatch}
                      style={{ background: colorOf.get(entry.key) }}
                      aria-hidden="true"
                    />
                    <span className={styles.tooltipName}>{nameOf.get(entry.key) ?? entry.key}</span>
                    <b>{formatUsageMetric(entry.value, unit)}</b>
                  </span>
                ))}
                <span className={styles.tooltipTotal}>
                  {t('usage.totals')}
                  <b>{formatUsageMetric(activeTotal, unit)}</b>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className={styles.xAxis} aria-hidden="true">
          {xAxisTicks.map((tick) => (
            <span
              key={tick.index}
              className={styles.xTick}
              style={{ left: `${((tick.index + 0.5) / timeline.buckets.length) * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </figure>
    </section>
  );
}
