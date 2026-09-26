/**
 * @fileoverview Cursor paging over an in-memory list. The page size is the caller's
 * `limit` on every call; the cursor carries only the offset. Decoding is separate
 * from slicing so a tool rejects a bad cursor before it waits on the catalog: a
 * cursor that does not decode is rewrapped as `invalid_cursor` with the calling
 * tool's own recovery, which names this server's `next_cursor` field.
 * @module services/catalog/paging
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { invalidParams } from '@cyanheads/mcp-ts-core/errors';
import { decodeCursor, encodeCursor } from '@cyanheads/mcp-ts-core/utils';

export interface Page<T> {
  items: T[];
  /** Present while more items remain. */
  nextCursor?: string;
}

/** The offset `cursor` carries, 0 without one; throws `invalid_cursor` when it does not decode. */
export function cursorOffset(cursor: string | undefined, ctx: Context): number {
  if (!cursor) return 0;
  try {
    return decodeCursor(cursor, ctx).offset;
  } catch (error) {
    throw invalidParams(
      'cursor is not a continuation token this server issued.',
      { reason: 'invalid_cursor', ...ctx.recoveryFor('invalid_cursor') },
      { cause: error },
    );
  }
}

/** Slices `items` at `offset`, `limit` items long. */
export function pageOf<T>(items: T[], offset: number, limit: number): Page<T> {
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    ...(end < items.length ? { nextCursor: encodeCursor({ offset: end, limit }) } : {}),
  };
}
