/**
 * Every knob on the page, in one bar.
 *
 * The controls are deliberately flat rather than hidden behind a "filters"
 * drawer: this is a page someone opens to answer a specific question, and the
 * cost of a wide control bar is paid once, while the cost of a hidden control
 * is paid every visit. They wrap rather than scroll, so a narrow window gets
 * more rows of controls instead of a table it cannot reach.
 */

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { IconPlus, IconX } from '@/components/ui/icons';
import type { UsageDimensions, UsageGroupColumn, UsageMetrics } from '@/services/api';
import { USAGE_LIST_FILTERS } from '@/services/api';
import {
  USAGE_DIMENSIONS,
  USAGE_FILTER_DIMENSIONS,
  USAGE_METRICS,
  findUsageDimension,
} from '../logic/dimensions';
import {
  fromDateTimeLocalInput,
  toDateTimeLocalInput,
  USAGE_RANGE_PRESETS,
  type UsageRangePreset,
} from '../logic/timeRange';
import {
  removeUsageFilter,
  usageFilterChips,
  type UsageBucketChoice,
  type UsageFilterChip,
  type UsageViewState,
} from '../logic/viewState';
import type { UsageLabeller } from '../hooks/useUsageLabels';
import styles from '../UsagePage.module.scss';

const RANGE_LABEL_KEYS: Record<UsageRangePreset, string> = {
  today: 'usage.range_today',
  '24h': 'usage.range_24h',
  '7d': 'usage.range_7d',
  '30d': 'usage.range_30d',
  '90d': 'usage.range_90d',
  all: 'usage.range_all',
  custom: 'usage.range_custom',
};

const BUCKET_LABEL_KEYS: Record<UsageBucketChoice, string> = {
  auto: 'usage.bucket_auto',
  hour: 'usage.dim_hour',
  day: 'usage.dim_day',
  week: 'usage.dim_week',
  month: 'usage.dim_month',
};

/** Dimensions offered for grouping; the time buckets have their own control. */
const GROUPABLE = USAGE_DIMENSIONS.filter((dimension) => !dimension.isTimeBucket);

export interface UsageControlsProps {
  view: UsageViewState;
  onChange: (patch: Partial<UsageViewState>) => void;
  dimensions: UsageDimensions;
  labeller: UsageLabeller;
  /** The bucket in force, shown next to the picker when it is on `auto`. */
  effectiveBucket: string;
}

export function UsageControls({
  view,
  onChange,
  dimensions,
  labeller,
  effectiveBucket,
}: UsageControlsProps) {
  const { t } = useTranslation();
  const [pendingFilter, setPendingFilter] = useState<UsageGroupColumn>('api_key');

  const dimensionOptions = useMemo(
    () => GROUPABLE.map((dimension) => ({ value: dimension.id, label: t(dimension.labelKey) })),
    [t]
  );

  const secondaryOptions = useMemo(
    () => [
      { value: 'none', label: t('usage.group_none') },
      ...dimensionOptions.filter((option) => option.value !== view.primary),
    ],
    [dimensionOptions, view.primary, t]
  );

  const metricOptions = useMemo(
    () => USAGE_METRICS.map((metric) => ({ value: metric.id, label: t(metric.labelKey) })),
    [t]
  );

  const bucketOptions = useMemo(
    () =>
      (Object.keys(BUCKET_LABEL_KEYS) as UsageBucketChoice[]).map((choice) => ({
        value: choice,
        label:
          choice === 'auto'
            ? t('usage.bucket_auto_with', {
                bucket: t(
                  BUCKET_LABEL_KEYS[effectiveBucket as UsageBucketChoice] ?? 'usage.dim_day'
                ),
              })
            : t(BUCKET_LABEL_KEYS[choice]),
      })),
    [t, effectiveBucket]
  );

  const filterDimensionOptions = useMemo(
    () =>
      USAGE_FILTER_DIMENSIONS.map((dimension) => ({
        value: dimension.id,
        label: t(dimension.labelKey),
      })),
    [t]
  );

  /** Values the store has actually seen, so the menu never offers a dead filter. */
  const pendingValues = useMemo(() => {
    const name = pendingFilter as (typeof USAGE_LIST_FILTERS)[number];
    const values = dimensions[name] ?? [];
    const active = new Set(view.filters[name] ?? []);
    return values
      .filter((value) => !active.has(value))
      .map((value) => ({
        value,
        label: labeller.plainLabel(pendingFilter, value),
      }));
  }, [dimensions, pendingFilter, view.filters, labeller]);

  const chips = useMemo(() => usageFilterChips(view.filters), [view.filters]);

  const chipLabel = (chip: UsageFilterChip): { dimension: string; value: string } => {
    if (chip.name === 'failed') {
      return {
        dimension: t('usage.dim_status'),
        value: t(chip.value === 'true' ? 'usage.status_failed' : 'usage.status_ok'),
      };
    }
    if (chip.name === 'stream') {
      return {
        dimension: t('usage.dim_stream'),
        value: t(chip.value === 'true' ? 'usage.stream_on' : 'usage.stream_off'),
      };
    }
    const definition = findUsageDimension(chip.name);
    return {
      dimension: t(definition?.labelKey ?? chip.name),
      value: labeller.plainLabel(chip.name, chip.value),
    };
  };

  const addFilterValue = (value: string) => {
    if (!value) return;
    const name = pendingFilter as (typeof USAGE_LIST_FILTERS)[number];
    const current = view.filters[name] ?? [];
    if (current.includes(value)) return;
    onChange({ filters: { ...view.filters, [name]: [...current, value] } });
  };

  const setBooleanFilter = (name: 'failed' | 'stream', value: string) => {
    const next = { ...view.filters };
    if (value === 'any') delete next[name];
    else next[name] = value === 'true';
    onChange({ filters: next });
  };

  return (
    <>
      <div className={styles.controls}>
        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>{t('usage.control_range')}</span>
          <div className={styles.controlRow}>
            <div className={styles.segmented} role="group" aria-label={t('usage.control_range')}>
              {USAGE_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`${styles.segment} ${view.range === preset ? styles.segmentActive : ''}`}
                  onClick={() => onChange({ range: preset })}
                  aria-pressed={view.range === preset}
                >
                  {t(RANGE_LABEL_KEYS[preset])}
                </button>
              ))}
            </div>
            {view.range === 'custom' ? (
              <div className={styles.customRange}>
                <input
                  type="datetime-local"
                  className={styles.dateInput}
                  aria-label={t('usage.range_from')}
                  value={view.customFromMs === null ? '' : toDateTimeLocalInput(view.customFromMs)}
                  onChange={(event) =>
                    onChange({ customFromMs: fromDateTimeLocalInput(event.target.value) })
                  }
                />
                <span className={styles.rangeSeparator} aria-hidden="true">
                  →
                </span>
                <input
                  type="datetime-local"
                  className={styles.dateInput}
                  aria-label={t('usage.range_to')}
                  value={view.customToMs === null ? '' : toDateTimeLocalInput(view.customToMs)}
                  onChange={(event) =>
                    onChange({ customToMs: fromDateTimeLocalInput(event.target.value) })
                  }
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>{t('usage.control_group')}</span>
          <div className={styles.controlRow}>
            <Select
              className={styles.selectControl}
              size="sm"
              value={view.primary}
              options={dimensionOptions}
              ariaLabel={t('usage.control_group_primary')}
              onChange={(value) => {
                const next = value as UsageGroupColumn;
                onChange({
                  primary: next,
                  secondary: view.secondary === next ? null : view.secondary,
                });
              }}
            />
            <Select
              className={styles.selectControl}
              size="sm"
              value={view.secondary ?? 'none'}
              options={secondaryOptions}
              ariaLabel={t('usage.control_group_secondary')}
              onChange={(value) =>
                onChange({ secondary: value === 'none' ? null : (value as UsageGroupColumn) })
              }
            />
          </div>
        </div>

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>{t('usage.control_metric')}</span>
          <div className={styles.controlRow}>
            <Select
              className={styles.selectControl}
              size="sm"
              value={view.metric}
              options={metricOptions}
              ariaLabel={t('usage.control_metric')}
              onChange={(value) => onChange({ metric: value as keyof UsageMetrics })}
            />
          </div>
        </div>

        {view.tab === 'timeline' ? (
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>{t('usage.control_bucket')}</span>
            <div className={styles.controlRow}>
              <Select
                className={styles.selectControl}
                size="sm"
                value={view.bucket}
                options={bucketOptions}
                ariaLabel={t('usage.control_bucket')}
                onChange={(value) => onChange({ bucket: value as UsageBucketChoice })}
              />
            </div>
          </div>
        ) : null}

        {view.tab === 'matrix' ? (
          <div className={styles.controlGroup}>
            <span className={styles.controlLabel}>{t('usage.control_axes')}</span>
            <div className={styles.controlRow}>
              <Select
                className={styles.selectControl}
                size="sm"
                value={view.matrixRow}
                options={dimensionOptions}
                ariaLabel={t('usage.control_axis_rows')}
                onChange={(value) => onChange({ matrixRow: value as UsageGroupColumn })}
              />
              <Select
                className={styles.selectControl}
                size="sm"
                value={view.matrixColumn}
                options={dimensionOptions}
                ariaLabel={t('usage.control_axis_columns')}
                onChange={(value) => onChange({ matrixColumn: value as UsageGroupColumn })}
              />
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() =>
                  onChange({ matrixRow: view.matrixColumn, matrixColumn: view.matrixRow })
                }
              >
                {t('usage.swap_axes')}
              </button>
            </div>
          </div>
        ) : null}

        <div className={styles.controlGroup}>
          <span className={styles.controlLabel}>{t('usage.control_add_filter')}</span>
          <div className={styles.filterAdd}>
            <Select
              className={styles.filterAddSelect}
              size="sm"
              value={pendingFilter}
              options={[
                ...filterDimensionOptions,
                { value: 'failed', label: t('usage.dim_status') },
                { value: 'stream', label: t('usage.dim_stream') },
              ]}
              ariaLabel={t('usage.control_add_filter')}
              onChange={(value) => setPendingFilter(value as UsageGroupColumn)}
            />
            {pendingFilter === 'failed' || pendingFilter === 'stream' ? (
              <Select
                className={styles.filterValueSelect}
                size="sm"
                value={
                  view.filters[pendingFilter] === undefined
                    ? 'any'
                    : String(view.filters[pendingFilter])
                }
                options={
                  pendingFilter === 'failed'
                    ? [
                        { value: 'any', label: t('usage.filter_any') },
                        { value: 'false', label: t('usage.status_ok') },
                        { value: 'true', label: t('usage.status_failed') },
                      ]
                    : [
                        { value: 'any', label: t('usage.filter_any') },
                        { value: 'true', label: t('usage.stream_on') },
                        { value: 'false', label: t('usage.stream_off') },
                      ]
                }
                ariaLabel={t('usage.control_filter_value')}
                onChange={(value) => setBooleanFilter(pendingFilter, value)}
              />
            ) : (
              <Select
                className={styles.filterValueSelect}
                size="sm"
                value=""
                placeholder={
                  pendingValues.length > 0 ? t('usage.filter_pick') : t('usage.filter_no_values')
                }
                options={pendingValues}
                disabled={pendingValues.length === 0}
                ariaLabel={t('usage.control_filter_value')}
                onChange={addFilterValue}
              />
            )}
            <IconPlus size={13} aria-hidden="true" className={styles.chipDimension} />
          </div>
        </div>
      </div>

      <div className={styles.filterBar}>
        <span className={styles.filterLabel}>{t('usage.filters')}</span>
        {chips.length === 0 ? (
          <span className={styles.chipsEmpty}>{t('usage.filters_empty')}</span>
        ) : (
          <>
            {chips.map((chip) => {
              const label = chipLabel(chip);
              return (
                <span key={`${chip.name}:${chip.value}`} className={styles.chip}>
                  <span className={styles.chipDimension}>{label.dimension}</span>
                  <span className={styles.chipValue} title={label.value}>
                    {label.value}
                  </span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    onClick={() => onChange({ filters: removeUsageFilter(view.filters, chip) })}
                    aria-label={t('usage.filter_remove', { value: label.value })}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              );
            })}
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => onChange({ filters: {} })}
            >
              {t('usage.filters_clear')}
            </button>
          </>
        )}
      </div>
    </>
  );
}
