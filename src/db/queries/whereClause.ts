import type { CursorPosition } from "../../domain/cursor.ts";
import type { LogFilters } from "../../domain/query.ts";

/**
 * Builds the WHERE clause for log queries.
 *
 * The `param` helper is the safety mechanism: it pushes a value onto the
 * parameter array and returns only its positional placeholder. A caller
 * physically cannot interpolate a user value into the SQL text — the helper
 * hands back `$3`, never the value itself.
 *
 * The spec treats SQL injection as disqualifying, so this is the single file
 * where dynamic SQL is constructed, making it auditable in one place.
 */

export interface WhereClause {
  readonly sql: string;
  readonly values: unknown[];
}

/** Escapes LIKE wildcards so a user's % or _ is matched literally. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function buildWhereClause(
  filters: LogFilters,
  cursor?: CursorPosition,
): WhereClause {
  const conditions: string[] = [];
  const values: unknown[] = [];

  const param = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.service !== undefined) {
    conditions.push(`service = ${param(filters.service)}`);
  }

  if (filters.level !== undefined) {
    conditions.push(`level = ${param(filters.level)}`);
  }

  if (filters.since !== undefined) {
    conditions.push(`"timestamp" >= ${param(filters.since)}`);
  }

  if (filters.until !== undefined) {
    conditions.push(`"timestamp" < ${param(filters.until)}`);
  }

  const attributeKeys = Object.keys(filters.attributes);

  if (attributeKeys.length > 0) {
    conditions.push(`attributes @> ${param(JSON.stringify(filters.attributes))}`);
  }

  if (filters.q !== undefined) {
    const pattern = `%${escapeLikePattern(filters.q)}%`;
    conditions.push(`message ILIKE ${param(pattern)} ESCAPE '\\'`);
  }

  if (cursor !== undefined) {
    conditions.push(
      `("timestamp", id) < (${param(cursor.timestamp)}, ${param(cursor.id)})`,
    );
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return { sql, values };
}
