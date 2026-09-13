/**
 * What the page shows when the gateway answers 503.
 *
 * The store being off is a one-line config change, so the panel says the line
 * rather than only that something is unavailable. The snippet is the block from
 * the proxy's own documentation, verbatim, and the button goes to the page
 * where it is edited.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconSidebarConfig } from '@/components/ui/icons';
import styles from '../UsagePage.module.scss';

const CONFIG_SNIPPET = `usage-store:
  enabled: true
  path: "~/.cli-proxy-api/usage.db"
  retention-days: 0`;

export function UsageDisabledPanel() {
  const { t } = useTranslation();

  return (
    <section className={styles.disabledPanel} role="status">
      <h2 className={styles.disabledTitle}>{t('usage.disabled_title')}</h2>
      <p className={styles.disabledBody}>{t('usage.disabled_body')}</p>
      <pre className={styles.disabledSnippet}>
        <code>{CONFIG_SNIPPET}</code>
      </pre>
      <p className={styles.disabledBody}>{t('usage.disabled_hint')}</p>
      <div className={styles.disabledActions}>
        <Link to="/config" className={styles.primaryAction}>
          <IconSidebarConfig size={15} aria-hidden="true" />
          {t('usage.disabled_open_config')}
        </Link>
      </div>
    </section>
  );
}
