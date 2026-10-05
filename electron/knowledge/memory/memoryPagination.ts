import type Database from 'better-sqlite3';
import { MEMORY_CONSTANTS } from './memoryConstants';
import type { MemoryPage, MemoryPageQuery } from './memoryTypes';

/** Only service-owned SQL enters this helper; renderer input is limited to bounded page numbers. */
export function readMemoryPage<Row, Item>(database: Database.Database, query: MemoryPageQuery,
  sql: { table: string; select: string; where: string; parameters: unknown[]; orderBy: string },
  map: (row: Row) => Item): MemoryPage<Item> {
  const requestedSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize)
    ? Math.trunc(query.pageSize) : MEMORY_CONSTANTS.management.listDefaultLimit;
  const pageSize = Math.max(1, Math.min(MEMORY_CONSTANTS.management.listMaxLimit, requestedSize));
  const requestedPage = typeof query.page === 'number' && Number.isSafeInteger(query.page) && query.page > 0 ? query.page : 1;
  // COUNT and the selected page share a read snapshot; no full record array is loaded or sliced.
  return database.transaction(() => {
    const { total } = database.prepare(`SELECT COUNT(*) AS total FROM ${sql.table} WHERE ${sql.where}`)
      .get(...sql.parameters) as { total: number };
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = database.prepare(`SELECT ${sql.select} FROM ${sql.table} WHERE ${sql.where}
      ORDER BY ${sql.orderBy} LIMIT ? OFFSET ?`).all(...sql.parameters, pageSize, (page - 1) * pageSize) as Row[];
    return { items: rows.map(map), total, page, pageSize, totalPages };
  })();
}
