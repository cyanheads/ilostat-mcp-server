/**
 * @fileoverview Tests for `ilostat_list_reference` against the recorded catalog
 * served through `RplumberClient`'s fetch seam: every topic's entry shape, the
 * word-prefix filter, exact code lookup with misses, the topic-scoped parameters,
 * cursor paging past the first page, blank form-client inputs, both consumption
 * paths (`structuredContent` and `content[]`), and every declared error reason.
 * @module tests/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  INVALID_CURSOR_RECOVERY,
  isRplumber,
  loadCatalogFixture,
  wireServices,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  disposeIlostatServices();
});

type Args = Parameters<typeof listReferenceTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof listReferenceTool.handler>>;

async function list(args: Args) {
  const ctx = createMockContext({ errors: listReferenceTool.errors });
  const result = await listReferenceTool.handler(listReferenceTool.input.parse(args), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(args: Args): Promise<McpError> {
  const ctx = createMockContext({ errors: listReferenceTool.errors });
  try {
    await listReferenceTool.handler(listReferenceTool.input.parse(args), ctx);
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (listReferenceTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

/** The `content[]` text a format()-only client reads. */
function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

const nextCursorOf = (result: ContractResult) =>
  (result.structuredContent as { next_cursor?: string } | undefined)?.next_cursor;

const codes = (result: Output) => result.entries.map((entry) => entry.code);

describe('topics', () => {
  it('ref_areas: countries with income group and ILO regions as X codes, aggregates bare', async () => {
    wireServices();
    const { result } = await list({ topic: 'ref_areas' });
    expect(codes(result)).toEqual(['ABW', 'ANT', 'JOR', 'KEN', 'USA', 'X01', 'X02', 'X06', 'X36']);
    expect(result.total).toBe(9);
    expect(result.entries.find((entry) => entry.code === 'KEN')).toEqual({
      code: 'KEN',
      label: 'Kenya',
      kind: 'country',
      frequencies: ['A', 'Q'],
      data_start: 1969,
      data_end: 2030,
      dataset_count: 1536,
      income_group: 'X03',
      income_group_label: 'Lower-middle income',
      ilo_region: 'X06',
      ilo_region_label: 'Africa',
      ilo_subregion_broad: 'X13',
      ilo_subregion_broad_label: 'Sub-Saharan Africa',
      ilo_subregion_detailed: 'X18',
      ilo_subregion_detailed_label: 'Eastern Africa',
    });
    expect(result.entries.find((entry) => entry.code === 'X01')).toEqual({
      code: 'X01',
      label: 'World',
      kind: 'aggregate',
      frequencies: ['A'],
      data_start: 1990,
      data_end: 2030,
      dataset_count: 106,
    });
    // an area only the dictionary knows still decodes, with no coverage it cannot state
    expect(result.entries.find((entry) => entry.code === 'ANT')).toEqual({
      code: 'ANT',
      label: 'Netherlands Antilles',
      kind: 'country',
      frequencies: [],
    });
  });

  it('area_groups: every group level a code serves, with member counts', async () => {
    wireServices();
    const { result } = await list({ topic: 'area_groups' });
    expect(result.entries.find((entry) => entry.code === 'X01')).toEqual({
      code: 'X01',
      label: 'World',
      group_types: ['world'],
      member_count: 4,
    });
    expect(result.entries.find((entry) => entry.code === 'X36')).toEqual({
      code: 'X36',
      label: 'Arab States',
      group_types: ['region', 'subregion_broad', 'subregion_detailed'],
      member_count: 1,
    });
    expect(result.entries.find((entry) => entry.code === 'X05')).toMatchObject({
      group_types: ['income_group'],
      member_count: 2,
    });
  });

  it.each([
    [
      'databases',
      'ILOSECTOR',
      { label: 'Sectoral employment statistics (ILOSECTOR)', dataset_count: 1 },
    ],
    ['databases', 'CHILD', { dataset_count: 0 }],
    ['subjects', 'LUU', { label: 'Unemployment and labour underutilization', dataset_count: 5 }],
    ['frequencies', 'Q', { label: 'Quarterly', dataset_count: 2 }],
    ['sexes', 'SEX_O', { label: 'Other' }],
    ['classifications', 'DSB_STATUS_TOTAL', { slot: 'both', classification_type: 'DSB' }],
    ['classifications', 'GEO_COV_NAT', { slot: 'classif2', classification_type: 'GEO' }],
    ['classification_types', 'QTL', { label: 'No label published in the ILOSTAT dictionary' }],
    [
      'sources',
      'BA:453',
      { label: 'LFS - Current Population Survey', source_type: 'LFS', ref_area: 'USA' },
    ],
    ['obs_status', 'R', { label: 'Real value' }],
    ['notes', 'R1:3513', { note_type: 'note_source' }],
  ] as const)('%s lists %s with its topic fields', async (topic, code, fields) => {
    wireServices();
    const { result } = await list({ topic, codes: [code] });
    expect(result.entries).toEqual([expect.objectContaining({ code, ...fields })]);
  });

  it('obs_status skips the dictionary row for the blank status', async () => {
    wireServices();
    const { result } = await list({ topic: 'obs_status' });
    expect(codes(result)).toEqual(['A', 'B', 'I', 'M', 'R', 'U']);
  });

  const byCode = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));

  it.each([
    'ref_areas',
    'area_groups',
    'databases',
    'subjects',
    'classifications',
    'classification_types',
    'sources',
    'obs_status',
    'notes',
  ] as const)('%s entries are ordered by code, as the output schema declares', async (topic) => {
    wireServices();
    const listed = codes((await list({ topic, limit: 500 })).result);
    expect(listed).toEqual(byCode(listed));
  });

  it('sexes keep the dictionary order, SEX_T first, as the output schema declares', async () => {
    wireServices();
    expect(codes((await list({ topic: 'sexes' })).result)).toEqual([
      'SEX_T',
      'SEX_M',
      'SEX_F',
      'SEX_O',
    ]);
  });

  it('frequencies run annual, quarterly, monthly, as the output schema declares', async () => {
    wireServices();
    expect(codes((await list({ topic: 'frequencies' })).result)).toEqual(['A', 'Q', 'M']);
  });
});

describe('filter', () => {
  it('keeps entries where every term is a word or word prefix of the code or label', async () => {
    wireServices();
    expect(codes((await list({ topic: 'ref_areas', filter: 'united sta' })).result)).toEqual([
      'USA',
    ]);
    expect(codes((await list({ topic: 'ref_areas', filter: 'x0' })).result)).toEqual([
      'X01',
      'X02',
      'X06',
    ]);
    expect(codes((await list({ topic: 'ref_areas', filter: 'ARAB' })).result)).toEqual(['X36']);
  });

  it('ignores case, accents, and punctuation, and matches labor to labour', async () => {
    wireServices();
    expect(codes((await list({ topic: 'subjects', filter: 'Labor-Förce' })).result)).toEqual([
      'EAP',
    ]);
  });

  it('returns the zero-hit shape with a notice that echoes the filter on one line', async () => {
    wireServices();
    const { result, enrichment } = await list({ topic: 'ref_areas', filter: 'united\r\nkingdom' });
    expect(result).toMatchObject({ entries: [], total: 0 });
    expect(result.next_cursor).toBeUndefined();
    expect(enrichment).toEqual({
      truncated: false,
      shown: 0,
      cap: 50,
      notice:
        'No ref_areas entry matched "united kingdom". Every filter term must appear in the code or label; try one distinctive word, or omit filter to page the full list.',
    });
  });

  it('blames the filter only when it removed the last entries, not a scope that left none', async () => {
    wireServices();
    const typeNotice =
      'No classification code has type ZZZ; ilostat_list_reference topic classification_types lists the types.';
    const byTypeArgs = {
      topic: 'classifications',
      classification_type: 'ZZZ',
      filter: 'youth',
    } as const;
    const byType = await list(byTypeArgs);
    expect(byType.result).toMatchObject({ entries: [], total: 0 });
    expect(byType.enrichment.notice).toBe(typeNotice);
    expect(contentText(await runToolContract(listReferenceTool, byTypeArgs))).toContain(
      `> ${typeNotice}`,
    );
    const byCodes = await list({ topic: 'ref_areas', codes: ['ZZZ'], filter: 'kenya' });
    expect(byCodes.result).toMatchObject({ entries: [], total: 0, not_found: ['ZZZ'] });
    expect(byCodes.enrichment).toEqual({ truncated: false, shown: 0, cap: 50 });
    const byArea = await list({ topic: 'sources', ref_area: 'X06', filter: 'labour' });
    expect(byArea.enrichment.notice).toBe('X06 has no sources in the dictionary.');
  });

  it('lists the topic unfiltered when the filter holds no searchable word, and says so', async () => {
    wireServices();
    const { result, enrichment } = await list({ topic: 'ref_areas', filter: '--- ?' });
    expect(result.total).toBe(9);
    expect(enrichment).toEqual({
      truncated: false,
      shown: 9,
      cap: 50,
      notice: 'filter held no searchable word (letters or digits), so it was not applied.',
    });
    const scoped = await list({
      topic: 'classifications',
      classification_type: 'ZZZ',
      filter: '!',
    });
    expect(scoped.enrichment.notice).toBe(
      'filter held no searchable word (letters or digits), so it was not applied. No classification code has type ZZZ; ilostat_list_reference topic classification_types lists the types.',
    );
  });
});

describe('codes lookup', () => {
  it('looks codes up case-insensitively, normalizing ILO_GEO_ forms, and lists misses', async () => {
    wireServices();
    const { result } = await list({ topic: 'ref_areas', codes: ['usa', 'ILO_GEO_X06', 'zzz'] });
    expect(codes(result)).toEqual(['USA', 'X06']);
    expect(result.not_found).toEqual(['ZZZ']);
    expect(result.total).toBe(2);
  });

  it('area_groups by exact code: lists each group’s member countries with labels', async () => {
    wireServices();
    const { result } = await list({ topic: 'area_groups', codes: ['x36', 'ILO_GEO_X01', 'X99'] });
    expect(result.entries).toEqual([
      {
        code: 'X01',
        label: 'World',
        group_types: ['world'],
        member_count: 4,
        members: [
          { code: 'ABW', label: 'Aruba' },
          { code: 'JOR', label: 'Jordan' },
          { code: 'KEN', label: 'Kenya' },
          { code: 'USA', label: 'United States of America' },
        ],
      },
      {
        code: 'X36',
        label: 'Arab States',
        group_types: ['region', 'subregion_broad', 'subregion_detailed'],
        member_count: 1,
        members: [{ code: 'JOR', label: 'Jordan' }],
      },
    ]);
    expect(result.not_found).toEqual(['X99']);
  });

  it('area_groups without exact codes keeps member_count only, even when filtered', async () => {
    wireServices();
    const { result } = await list({ topic: 'area_groups', filter: 'arab' });
    expect(codes(result)).toEqual(['X36']);
    expect(result.entries[0]).not.toHaveProperty('members');
  });

  it('combines with the filter, and reports no not_found when every code hit', async () => {
    wireServices();
    const { result } = await list({
      topic: 'sources',
      codes: ['ba:453', 'BA:7008'],
      filter: 'current',
    });
    expect(codes(result)).toEqual(['BA:453']);
    expect(result.not_found).toBeUndefined();
  });
});

describe('topic-scoped parameters', () => {
  it('ref_area lists one area’s sources, accepting the ILO_GEO_ form', async () => {
    wireServices();
    expect(codes((await list({ topic: 'sources', ref_area: 'ken' })).result)).toEqual([
      'AA:1311',
      'BA:7008',
    ]);
    const { result, enrichment } = await list({ topic: 'sources', ref_area: 'ILO_GEO_X06' });
    expect(result.total).toBe(0);
    expect(enrichment.notice).toBe('X06 has no sources in the dictionary.');
  });

  it('classification_type keeps one classification type, case-insensitively', async () => {
    wireServices();
    const { result } = await list({ topic: 'classifications', classification_type: 'dsb' });
    expect(codes(result)).toEqual([
      'DSB_STATUS_DIS',
      'DSB_STATUS_NODIS',
      'DSB_STATUS_TOTAL',
      'DSB_STATUS_X',
    ]);
    const none = await list({ topic: 'classifications', classification_type: 'ZZZ' });
    expect(none.enrichment.notice).toBe(
      'No classification code has type ZZZ; ilostat_list_reference topic classification_types lists the types.',
    );
  });

  it('echoes an unmatched classification_type on one line in the notice, on both surfaces', async () => {
    wireServices();
    const { enrichment } = await list({
      topic: 'classifications',
      classification_type: 'age\r\n## injected',
    });
    expect(enrichment.notice).toBe(
      'No classification code has type AGE ## INJECTED; ilostat_list_reference topic classification_types lists the types.',
    );
    const result = await runToolContract(listReferenceTool, {
      topic: 'classifications',
      classification_type: 'age\n## injected',
    });
    const text = contentText(result);
    expect(text).toContain('> No classification code has type AGE ## INJECTED;');
    expect(text.split('\n').some((line) => line.startsWith('## INJECTED'))).toBe(false);
  });
});

describe('paging', () => {
  it('walks every page with next_cursor, covering the topic once and in order', async () => {
    wireServices();
    const all = codes((await list({ topic: 'ref_areas' })).result);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { result, enrichment } = await list({
        topic: 'ref_areas',
        limit: 4,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      seen.push(...codes(result));
      expect(result.total).toBe(9);
      cursor = result.next_cursor;
      if (cursor) {
        expect(enrichment).toEqual({
          truncated: true,
          shown: 4,
          cap: 4,
          notice: `Showing 4 of 9 ref_areas entries; pass next_cursor as cursor for the next page.`,
        });
      } else {
        expect(enrichment).toEqual({ truncated: false, shown: 1, cap: 4 });
      }
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(all);
  });

  it('returns an empty page, with the total, for an offset past the end', async () => {
    wireServices();
    const { result, enrichment } = await list({
      topic: 'ref_areas',
      cursor: encodeCursor({ offset: 40, limit: 4 }),
    });
    expect(result.entries).toEqual([]);
    expect(result.total).toBe(9);
    expect(result.next_cursor).toBeUndefined();
    expect(enrichment).toMatchObject({ truncated: false, shown: 0 });
  });

  it('rejects a cursor it did not issue as invalid_cursor, with this tool’s recovery', async () => {
    wireServices();
    const error = await failure({ topic: 'ref_areas', cursor: 'not-a-cursor' });
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({
      reason: 'invalid_cursor',
      recovery: { hint: INVALID_CURSOR_RECOVERY },
    });
  });

  it('rejects a bad cursor before waiting on the catalog, so an outage never masks it', async () => {
    const { http } = wireServices({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ topic: 'ref_areas', cursor: 'not-a-cursor' });
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
    const result = await runToolContract(listReferenceTool, {
      topic: 'ref_areas',
      cursor: 'not-a-cursor',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_cursor' } },
    });
    expect(contentText(result)).toContain(`Recovery: ${INVALID_CURSOR_RECOVERY}`);
    expect(http.calls).toHaveLength(0);
  });

  it('bounds limit to 1–500', () => {
    expect(() => listReferenceTool.input.parse({ topic: 'sexes', limit: 0 })).toThrow();
    expect(() => listReferenceTool.input.parse({ topic: 'sexes', limit: 501 })).toThrow();
    expect(listReferenceTool.input.parse({ topic: 'sexes', limit: 500 }).limit).toBe(500);
    expect(listReferenceTool.input.parse({ topic: 'sexes' }).limit).toBe(50);
  });
});

describe('form-client inputs', () => {
  it('reads blank optional strings and blank code elements as unset', async () => {
    const { http } = wireServices();
    const { result, enrichment } = await list({
      topic: 'sexes',
      filter: '',
      ref_area: '   ',
      classification_type: '',
      cursor: '',
      codes: ['', '  '],
    });
    expect(codes(result).sort()).toEqual(['SEX_F', 'SEX_M', 'SEX_O', 'SEX_T']);
    expect(result.not_found).toBeUndefined();
    expect(enrichment).toEqual({ truncated: false, shown: 4, cap: 50 });
    expect(http.calls).toHaveLength(15);
  });

  it('rejects malformed constrained inputs', () => {
    expect(() => listReferenceTool.input.parse({ topic: 'countries' })).toThrow();
    expect(() =>
      listReferenceTool.input.parse({ topic: 'ref_areas', codes: Array(101).fill('USA') }),
    ).toThrow();
  });
});

describe('errors', () => {
  it('logs the reasons a caller’s input causes at notice, the catalog outage at error', () => {
    const severities = Object.fromEntries(
      (listReferenceTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      unknown_code: 'notice',
      param_not_for_topic: 'notice',
      invalid_cursor: 'notice',
      catalog_unavailable: 'error',
    });
  });

  it('unknown_code: ref_area names no reference area — after the catalog, before any other request', async () => {
    const { http } = wireServices();
    const error = await failure({ topic: 'sources', ref_area: 'zzz' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_code',
      field: 'ref_area',
      recovery: {
        hint: 'Call ilostat_list_reference with topic ref_areas and a name filter to find the area code.',
      },
    });
    expect(error.message).toBe('ZZZ is not an ILOSTAT reference area.');
    expect(http.calls).toHaveLength(15);
  });

  it('a malformed ref_area (CR/LF) fails the schema as invalid_arguments, before any request', async () => {
    const { http } = wireServices();
    const result = await runToolContract(listReferenceTool, { topic: 'sources', ref_area: 'U\nS' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(http.calls).toHaveLength(0);
  });

  it.each([
    [{ topic: 'ref_areas', ref_area: 'KEN' }, 'ref_area applies to topic sources, not ref_areas.'],
    [
      { topic: 'sexes', classification_type: 'AGE' },
      'classification_type applies to topic classifications, not sexes.',
    ],
  ] as const)('param_not_for_topic: %o, before the catalog loads', async (args, message) => {
    const { http } = wireServices();
    const error = await failure(args);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'param_not_for_topic',
      recovery: {
        hint: 'Pass ref_area only with topic sources and classification_type only with topic classifications, or drop it.',
      },
    });
    expect(error.message).toBe(message);
    expect(http.calls).toHaveLength(0);
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    wireServices({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ topic: 'sexes' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
  });
});

describe('format()', () => {
  it('renders every entry with its topic fields on one line each', async () => {
    wireServices();
    const areas = render((await list({ topic: 'ref_areas', codes: ['KEN', 'X01', 'ANT'] })).result);
    expect(areas).toContain('## ref_areas — 3 entries');
    expect(areas).toContain('Catalog as of 2026-09-26T12:00:00.000Z');
    expect(areas).toContain(
      '- **KEN** — Kenya · country · frequencies A/Q · 1969–2030 · 1536 datasets · income X03 Lower-middle income · region X06 Africa · subregion X13 Sub-Saharan Africa · detailed subregion X18 Eastern Africa',
    );
    expect(areas).toContain(
      '- **X01** — World · aggregate · frequencies A · 1990–2030 · 106 datasets',
    );
    expect(areas).toContain('- **ANT** — Netherlands Antilles · country');
    expect(areas).not.toContain('?–?');

    const groups = render((await list({ topic: 'area_groups', codes: ['X36'] })).result);
    expect(groups).toContain(
      '- **X36** — Arab States · group region, subregion_broad, subregion_detailed · 1 members',
    );
    const classifications = render(
      (await list({ topic: 'classifications', codes: ['DSB_STATUS_TOTAL'] })).result,
    );
    expect(classifications).toContain(
      '- **DSB_STATUS_TOTAL** — Disability status: Total · slot both · type DSB',
    );
    const sources = render((await list({ topic: 'sources', codes: ['BA:7008'] })).result);
    expect(sources).toContain(
      '- **BA:7008** — LFS - Labour Force Survey · area KEN · source type LFS',
    );
    const notes = render((await list({ topic: 'notes', codes: ['I20:4077'] })).result);
    expect(notes).toContain(
      '- **I20:4077** — Employment definition: Excluding own-use production workers · note_indicator',
    );
  });

  it('renders not_found and next_cursor', async () => {
    wireServices();
    const missed = render((await list({ topic: 'sexes', codes: ['SEX_T', 'nope'] })).result);
    expect(missed).toContain('**Not found:** NOPE');
    const paged = await list({ topic: 'ref_areas', limit: 2 });
    expect(render(paged.result)).toContain(`**next_cursor:** ${paged.result.next_cursor}`);
  });

  it('flattens CR/LF in ILO-published labels while structuredContent keeps them verbatim', async () => {
    const fixture = loadCatalogFixture();
    const note = fixture.dictionaries.note_source?.find((row) => row.note_source === 'R1:2383');
    if (note) note['note_source.label'] = 'Repository: Eurostat\r\n## injected heading';
    wireServices({ fixture });
    const { result } = await list({ topic: 'notes', codes: ['R1:2383'] });
    expect(result.entries[0]?.label).toBe('Repository: Eurostat\r\n## injected heading');
    const text = render(result);
    expect(text).toContain(
      '- **R1:2383** — Repository: Eurostat ## injected heading · note_source',
    );
    expect(text.split('\n').some((line) => line.startsWith('## injected'))).toBe(false);
  });
});

describe('contract envelope (runToolContract)', () => {
  it('zero-result page: validates the enrichment and carries the notice on both surfaces', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, {
      topic: 'ref_areas',
      filter: 'atlantis',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      topic: 'ref_areas',
      entries: [],
      total: 0,
      truncated: false,
      shown: 0,
      cap: 50,
      notice: expect.stringContaining('No ref_areas entry matched "atlantis"'),
    });
    const text = contentText(result);
    expect(text).toContain('## ref_areas — 0 entries');
    expect(text).toContain('> No ref_areas entry matched "atlantis".');
  });

  it('area_groups by exact code: members reach both surfaces', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, {
      topic: 'area_groups',
      codes: ['X36'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      entries: [{ code: 'X36', member_count: 1, members: [{ code: 'JOR', label: 'Jordan' }] }],
    });
    expect(contentText(result)).toContain(
      '- **X36** — Arab States · group region, subregion_broad, subregion_detailed · 1 members\n  - members: JOR Jordan',
    );
  });

  it('under-cap partial page: every entry, truncated false, no cursor', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, { topic: 'sexes' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 4,
      truncated: false,
      shown: 4,
      cap: 50,
    });
    expect(result.structuredContent).not.toHaveProperty('next_cursor');
    const text = contentText(result);
    for (const code of ['SEX_T', 'SEX_M', 'SEX_F', 'SEX_O']) expect(text).toContain(`**${code}**`);
  });

  it('capped page, then the last partial page through its cursor', async () => {
    wireServices();
    const first = await runToolContract(listReferenceTool, { topic: 'ref_areas', limit: 8 });
    expect(first.structuredContent).toMatchObject({ truncated: true, shown: 8, cap: 8, total: 9 });
    const cursor = nextCursorOf(first);
    expect(cursor).toBeDefined();
    expect(contentText(first)).toContain(`**next_cursor:** ${cursor}`);
    const last = await runToolContract(listReferenceTool, {
      topic: 'ref_areas',
      limit: 8,
      ...(cursor ? { cursor } : {}),
    });
    expect(last.isError).toBeFalsy();
    expect(last.structuredContent).toMatchObject({ truncated: false, shown: 1, cap: 8, total: 9 });
  });

  it('a paged listing under a filter with no searchable word carries both notices on both surfaces', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, {
      topic: 'ref_areas',
      filter: '***',
      limit: 4,
    });
    expect(result.isError).toBeFalsy();
    const notice =
      'filter held no searchable word (letters or digits), so it was not applied. Showing 4 of 9 ref_areas entries; pass next_cursor as cursor for the next page.';
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 4,
      cap: 4,
      total: 9,
      notice,
    });
    expect(nextCursorOf(result)).toBeDefined();
    expect(contentText(result)).toContain(`> ${notice}`);
  });

  it('declared failures reach both surfaces with their reason and recovery', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, { topic: 'sources', ref_area: 'ZZZ' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'unknown_code' } },
    });
    const text = contentText(result);
    expect(text).toContain('ZZZ is not an ILOSTAT reference area.');
    expect(text).toContain('Recovery: Call ilostat_list_reference with topic ref_areas');
    expect(text).toContain('reason unknown_code');
  });

  it('rejects arguments the schema refuses as InvalidParams', async () => {
    wireServices();
    const result = await runToolContract(listReferenceTool, { topic: 'countries' } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
});
