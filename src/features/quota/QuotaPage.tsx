/**
 * 额度查询页：家族汇总条 + 提供商 tabs + 紧凑凭证表 + 窗口时间线。
 *
 * 保留的行为契约（重设计不改）：
 * - 现有提供商保持点击加载；Devin 首次可见时主动查询一次，不轮询；
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 *
 * 布局契约（本次重设计新增）：
 * - 每个家族一套固定列，由该家族*全部*凭证（不只本页）的窗口并集决定，
 *   所以翻页不会让同一个窗口换列；
 * - 汇总条与表格共享排序后的顺序，微条第 n 根就是表格第 n 行。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import {
  buildQuotaColumns,
  buildQuotaFamilySummary,
  buildQuotaRowModel,
  displayCredentialLabel,
  type QuotaColumn,
  type QuotaCredentialRowModel,
  type QuotaFamilyMember,
  type QuotaFamilySummary,
} from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { ProviderTabs } from '@/features/authFiles/components/ProviderTabs';
import { QuotaHeader } from './components/QuotaHeader';
import { QuotaCredentialRow } from './components/QuotaCredentialRow';
import { QuotaSummaryStrip } from './components/QuotaSummaryStrip';
import { QuotaTimeline } from './components/QuotaTimeline';
import {
  QUOTA_PAGE_SIZE,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  type QuotaSortMode,
  type QuotaTabId,
} from './constants';
import {
  buildTabCounts,
  canRefreshQuotaAfterList,
  classifyQuotaFiles,
  filterEntriesByTab,
  paginate,
  sortQuotaEntries,
  type QuotaFileEntry,
} from './logic';
import { nextRecoveryMs } from './resetSchedule';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useDevinQuotaAutoLoad } from './providers/devin/useDevinQuotaAutoLoad';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import {
  readQuotaShowEmails,
  readQuotaUiState,
  writeQuotaShowEmails,
  writeQuotaUiState,
} from './uiState';
import styles from './QuotaPage.module.scss';

const TAB_IDS: string[] = ['all', ...QUOTA_TAB_ORDER];
const SKELETON_ROW_COUNT = 5;

const entryKey = (entry: QuotaFileEntry) =>
  `${entry.type}:${getQuotaCacheKey(entry.file)}`;

/**
 * Grid template for one family's rows: identity, one track per window, actions.
 *
 * Built here rather than in the row so every row in a section is handed the
 * same string — that identity is what makes a column scannable. At least one
 * track always exists so the idle/error block has somewhere to sit.
 *
 * The action track is a fixed width, not `auto`: `auto` is resolved per grid
 * container, so a credential with no Reset button would size that track to one
 * pill instead of two and push every cell in *its* row out of the column the
 * rows above and below use.
 */
const ACTIONS_TRACK = '248px';

const rowColumnsTemplate = (columnCount: number): string =>
  `minmax(200px, 1.4fr) repeat(${Math.max(1, columnCount)}, minmax(124px, 1fr)) ${ACTIONS_TRACK}`;

interface QuotaFamilySection {
  type: QuotaProviderType;
  entries: QuotaFileEntry[];
  columns: QuotaColumn[];
}

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<QuotaTabId>(() => readQuotaUiState()?.tab ?? 'all');
  const [sortMode, setSortMode] = useState<QuotaSortMode>(
    () => readQuotaUiState()?.sortMode ?? 'default'
  );
  const [showEmails, setShowEmails] = useState<boolean>(() => readQuotaShowEmails());
  const [page, setPage] = useState(1);
  // 页头 + tabs 的入场级联（标题 → meta → 动作 → tabs，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ----------
   * 排在归类/排序之前：「最快恢复优先」要读它算排序键。 */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [antigravityQuota, claudeQuota, codexQuota, devinQuota, kimiQuota, metaQuota, xaiQuota]
  );

  const getQuota = useCallback(
    (entry: QuotaFileEntry): QuotaCardState | undefined =>
      quotaByType[entry.type][getQuotaCacheKey(entry.file)],
    [quotaByType]
  );

  /* ---------- 归类 / 过滤 / 排序 / 分页 ---------- */

  // 倒计时与「最快恢复优先」共用同一个分钟时钟；默认序下 sortNow 固定为 0，
  // 排序键不随分钟churn（时钟只驱动渲染中的相对时间）。
  const now = useNow();
  const sortNow = sortMode === 'default' ? 0 : now;

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const tabCounts = useMemo(() => buildTabCounts(entries), [entries]);
  const filteredEntries = useMemo(() => filterEntriesByTab(entries, tab), [entries, tab]);

  const resolveNextRecovery = useCallback(
    (entry: QuotaFileEntry) => nextRecoveryMs(entry.type, getQuota(entry), sortNow),
    [getQuota, sortNow]
  );
  // 排序在分页之前：否则「最快恢复」只在当前页内成立。
  const sortedEntries = useMemo(
    () => sortQuotaEntries(filteredEntries, sortMode, resolveNextRecovery),
    [filteredEntries, sortMode, resolveNextRecovery]
  );

  const { pageItems, currentPage, totalPages } = useMemo(
    () => paginate(sortedEntries, page, QUOTA_PAGE_SIZE),
    [sortedEntries, page]
  );

  /* ---------- 行模型 / 家族列 / 汇总 ---------- */

  const modelByKey = useMemo(() => {
    const map = new Map<string, QuotaCredentialRowModel | null>();
    for (const entry of sortedEntries) {
      map.set(entryKey(entry), buildQuotaRowModel(entry.type, getQuota(entry)));
    }
    return map;
  }, [sortedEntries, getQuota]);

  /**
   * 列并集按*全部*已过滤凭证算，不是按本页算 —— 否则翻一页同一个窗口可能换列，
   * 而「一列可以竖着扫」正是这次重设计要买的东西。
   */
  const familyMembers = useMemo(() => {
    const map = new Map<QuotaProviderType, QuotaFamilyMember[]>();
    for (const entry of sortedEntries) {
      const bucket = map.get(entry.type) ?? [];
      bucket.push({ key: entryKey(entry), model: modelByKey.get(entryKey(entry)) ?? null });
      map.set(entry.type, bucket);
    }
    return map;
  }, [sortedEntries, modelByKey]);

  const familyColumns = useMemo(() => {
    const map = new Map<QuotaProviderType, QuotaColumn[]>();
    for (const [type, members] of familyMembers) {
      map.set(type, buildQuotaColumns(type, members));
    }
    return map;
  }, [familyMembers]);

  const summaries = useMemo<QuotaFamilySummary[]>(
    () =>
      QUOTA_TAB_ORDER.filter((type) => familyMembers.has(type)).map((type) =>
        buildQuotaFamilySummary(type, familyMembers.get(type) ?? [], now)
      ),
    [familyMembers, now]
  );

  /** 本页凭证按家族分段；段内顺序即排序后的顺序。 */
  const sections = useMemo<QuotaFamilySection[]>(() => {
    const byType = new Map<QuotaProviderType, QuotaFileEntry[]>();
    for (const entry of pageItems) {
      const bucket = byType.get(entry.type) ?? [];
      bucket.push(entry);
      byType.set(entry.type, bucket);
    }
    return QUOTA_TAB_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      entries: byType.get(type) ?? [],
      columns: familyColumns.get(type) ?? [],
    }));
  }, [pageItems, familyColumns]);

  const handleTabChange = useCallback((next: string) => {
    setTab(next as QuotaTabId);
    setPage(1);
    writeQuotaUiState({ tab: next as QuotaTabId });
  }, []);

  const handleSortModeChange = useCallback((next: string) => {
    setSortMode(next as QuotaSortMode);
    setPage(1);
    writeQuotaUiState({ sortMode: next as QuotaSortMode });
  }, []);

  const handleToggleEmails = useCallback(() => {
    setShowEmails((current) => {
      const next = !current;
      writeQuotaShowEmails(next);
      return next;
    });
  }, []);

  /** 时间线泳道名 = 表格里的凭证名，两者必须一致（包括掩码状态）。 */
  const displayNameFor = useCallback(
    (name: string) => {
      const entry = entries.find((candidate) => candidate.file.name === name);
      return entry
        ? displayCredentialLabel(getQuotaDisplayName(entry.file), entry.file.note, showEmails)
        : displayCredentialLabel(name, undefined, showEmails);
    },
    [entries, showEmails]
  );

  const sortOptions = useMemo(
    () =>
      QUOTA_SORT_MODES.map((mode) => ({ value: mode, label: t(`quota_management.sort_${mode}`) })),
    [t]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    entries.forEach((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      if (status === 'success') loaded += 1;
      else if (status === 'error') attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [entries, quotaByType]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与操作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再批量拉当前页额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadQuota(pageItems);
    }
  }, [disableControls, error, filesGeneration, loading, loadQuota, pageItems, sessionGeneration]);

  useDevinQuotaAutoLoad(
    pageItems,
    disableControls ||
      loading ||
      batchLoading ||
      Boolean(error) ||
      filesGeneration !== sessionGeneration,
    loadQuota
  );

  const canUseActions = !disableControls && !loading && filesGeneration === sessionGeneration;

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && filteredEntries.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        showEmails={showEmails}
        onToggleEmails={handleToggleEmails}
        onRefreshAll={handleRefreshAll}
      />

      <section className={styles.workbench}>
        {/* tabs + 排序作为一个整体入场（useRevealGroup 会给每个 [data-reveal]
            后代加一级级差，所以排序控件放在同一个节点里而不是做兄弟） */}
        <div className={styles.tabsRow} data-reveal>
          <ProviderTabs
            types={TAB_IDS}
            counts={tabCounts}
            active={tab}
            resolvedTheme={resolvedTheme}
            onChange={handleTabChange}
          />
          <div className={styles.sort}>
            <Select
              value={sortMode}
              options={sortOptions}
              onChange={handleSortModeChange}
              ariaLabel={t('quota_management.sort_label')}
              size="sm"
            />
          </div>
        </div>

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
              <Skeleton key={index} height={68} rounded={12} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={
              tab === 'all'
                ? t('quota_management.empty_title')
                : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_title`)
            }
            description={
              tab === 'all'
                ? t('quota_management.empty_desc')
                : t(`${QUOTA_ADAPTERS[tab].i18nPrefix}.empty_desc`)
            }
            action={
              tab === 'all' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => handleTabChange('all')}>
                  {t('auth_files.filter_all')}
                </Button>
              )
            }
          />
        ) : (
          <>
            <QuotaSummaryStrip summaries={summaries} resolvedTheme={resolvedTheme} nowMs={now} />

            {sections.map((section) => (
              <section key={section.type} className={styles.family}>
                <h2 className={styles.familyHeading}>
                  {getTypeLabel(t, section.type)}
                  <span className={styles.familyCount}>{section.entries.length}</span>
                </h2>
                <ul
                  className={styles.rows}
                  style={
                    {
                      '--quota-row-columns': rowColumnsTemplate(section.columns.length),
                    } as CSSProperties
                  }
                >
                  {section.entries.map((entry) => (
                    <QuotaCredentialRow
                      key={entryKey(entry)}
                      entry={entry}
                      quota={getQuota(entry)}
                      model={modelByKey.get(entryKey(entry)) ?? null}
                      columns={section.columns}
                      resolvedTheme={resolvedTheme}
                      showEmails={showEmails}
                      canRefresh={canUseActions && !entry.file.disabled}
                      resetting={resettingQuotaName === getQuotaCacheKey(entry.file)}
                      nowMs={now}
                      onRefresh={() => void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                      onReset={() => resetQuota(entry.file, QUOTA_ADAPTERS[entry.type])}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </>
        )}

        {!loading && filteredEntries.length > QUOTA_PAGE_SIZE && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filteredEntries.length,
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}

        {/* 时间线只比较当前页凭证，避免大量凭证一次性生成无界泳道。 */}
        <QuotaTimeline
          entries={pageItems}
          quotaFor={getQuota}
          displayNameFor={displayNameFor}
          resolvedTheme={resolvedTheme}
        />
      </section>
    </div>
  );
}
