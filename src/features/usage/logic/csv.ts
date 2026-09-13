/**
 * CSV for the rows currently on screen.
 *
 * Export is client-side on purpose. The store has no export endpoint, the rows
 * are already in memory, and what a reader wants out is the view they built:
 * this range, these filters, this grouping, in this order. Re-deriving that
 * server-side would be a second source of truth for the same table.
 *
 * Numbers are written unformatted. A spreadsheet cannot add up "12.4k", and the
 * compact units exist for reading on a screen, not for a second tool.
 */

export type CsvValue = string | number | null | undefined;

/**
 * Quote a field the way RFC 4180 asks.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote first: without
 * it a model id or label beginning with one of those is interpreted as a
 * formula when the file is opened in Excel or Sheets.
 */
export const escapeCsvValue = (value: CsvValue): string => {
  if (value === null || value === undefined) return '';

  const text = typeof value === 'number' ? String(value) : value;
  const guarded = /^[=+\-@]/.test(text) ? `'${text}` : text;

  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
};

export interface CsvTable {
  header: readonly string[];
  rows: readonly (readonly CsvValue[])[];
}

/** CRLF line endings, because that is what Excel expects from a .csv. */
export const serializeCsv = (table: CsvTable): string =>
  [table.header, ...table.rows].map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');

/**
 * A UTF-8 BOM is prepended so Excel reads non-ASCII labels correctly. Without
 * it a Chinese or Cyrillic device label opens as mojibake on Windows.
 */
const UTF8_BOM = String.fromCharCode(0xfeff);

export const csvBlob = (csv: string): Blob =>
  new Blob([UTF8_BOM + csv], { type: 'text/csv;charset=utf-8;' });

/** `usage-2026-09-13-1422.csv`: sortable, and unique enough for one session. */
export const usageCsvFilename = (date: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `usage-${stamp}.csv`;
};
