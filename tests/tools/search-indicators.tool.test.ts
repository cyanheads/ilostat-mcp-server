/**
 * @fileoverview Tests for `ilostat_search_indicators` against the recorded catalog
 * served through `RplumberClient`'s fetch seam: the three-tier ranking, term
 * normalization, browse mode, the per-dataset frequency and aggregates filters,
 * code filters validated against the catalog, facets over the fully filtered match
 * set, every zero-hit notice fragment, cursor paging past the first page, blank
 * form-client inputs, both consumption paths, and every declared error reason.
 * @module tests/tools/search-indicators.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { encodeCursor } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { searchIndicatorsTool } from '@/mcp-server/tools/definitions/search-indicators.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  INVALID_CURSOR_RECOVERY,
  isRplumber,
  loadCatalogFixture,
  tocRow,
  wireServices,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  disposeIlostatServices();
});

type Args = Parameters<typeof searchIndicatorsTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof searchIndicatorsTool.handler>>;

async function search(args: Args) {
  const ctx = createMockContext({ errors: searchIndicatorsTool.errors });
  const result = await searchIndicatorsTool.handler(searchIndicatorsTool.input.parse(args), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(args: Args): Promise<McpError> {
  const ctx = createMockContext({ errors: searchIndicatorsTool.errors });
  try {
    await searchIndicatorsTool.handler(searchIndicatorsTool.input.parse(args), ctx);
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (searchIndicatorsTool.format?.(result) ?? [])
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

const indicators = (result: Output) => result.hits.map((hit) => hit.indicator);
const scopes = (result: Output) => result.hits.map((hit) => hit.match_scope);

/** The ranked hits for "labour": three label matches, then five metadata matches. */
const LABOUR_RANKING = [
  'EAP_DWAP_SEX_AGE_RT',
  'LAP_2GDP_NOC_RT',
  'LAP_2LID_QTL_RT',
  'UNE_DEAP_SEX_AGE_RT',
  'UNE_2EAP_SEX_AGE_RT',
  'UNE_DEAP_SEX_EDU_RT',
  'SDG_0552_NOC_RT',
  'EMP_TEMP_SEX_INS_DSB_NB',
];

describe('ranking', () => {
  it('ranks label matches first, then metadata, each by reach (more areas) then code', async () => {
    wireServices();
    const { result } = await search({ query: 'labour', limit: 50 });
    expect(indicators(result)).toEqual(LABOUR_RANKING);
    expect(scopes(result)).toEqual([
      'label',
      'label',
      'label',
      'metadata',
      'metadata',
      'metadata',
      'metadata',
      'metadata',
    ]);
    expect(result.total).toBe(8);
  });

  it('orders a single tier by the widest dataset reach', async () => {
    wireServices();
    const { result } = await search({ query: 'unemployment rate' });
    expect(indicators(result)).toEqual([
      'UNE_DEAP_SEX_AGE_RT',
      'UNE_2EAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_EDU_RT',
    ]);
    expect(scopes(result)).toEqual(['label', 'label', 'label']);
  });

  it('reaches into the definition text only as the third tier', async () => {
    wireServices();
    const { result } = await search({ query: 'women managerial' });
    expect(indicators(result)).toEqual(['SDG_0552_NOC_RT']);
    expect(result.hits[0]?.match_scope).toBe('definition');
  });

  it('matches codes and database codes in the metadata tier', async () => {
    wireServices();
    const byCode = await search({ query: 'LAP_2LID' });
    expect(indicators(byCode.result)).toEqual(['LAP_2LID_QTL_RT']);
    expect(byCode.result.hits[0]?.match_scope).toBe('metadata');
    const byDatabase = await search({ query: 'iloest' });
    expect(indicators(byDatabase.result)).toEqual([
      'POP_2POP_SEX_NB',
      'LAP_2GDP_NOC_RT',
      'LAP_2LID_QTL_RT',
      'UNE_2EAP_SEX_AGE_RT',
    ]);
  });
});

describe('term normalization', () => {
  it('matches labor to labour', async () => {
    wireServices();
    expect(indicators((await search({ query: 'LABOR', limit: 50 })).result)).toEqual(
      LABOUR_RANKING,
    );
  });

  it('tolerates a trailing plural s, word prefixes, case, and accents', async () => {
    wireServices();
    const expected = ['UNE_DEAP_SEX_AGE_RT', 'UNE_2EAP_SEX_AGE_RT', 'UNE_DEAP_SEX_EDU_RT'];
    expect(indicators((await search({ query: 'Unemployment rates' })).result)).toEqual(expected);
    expect(indicators((await search({ query: 'unemp RAT' })).result)).toEqual(expected);
    expect(indicators((await search({ query: 'Unémployment' })).result)).toEqual(expected);
  });

  it('requires every term to match', async () => {
    wireServices();
    const { result } = await search({ query: 'unemployment astronauts' });
    expect(result.total).toBe(0);
  });
});

describe('browse mode', () => {
  it('without a query, lists every indicator by code with no match scope', async () => {
    wireServices();
    const { result, enrichment } = await search({});
    expect(indicators(result)).toEqual([
      'EAP_DWAP_SEX_AGE_RT',
      'EMP_TEMP_SEX_IND_NB',
      'EMP_TEMP_SEX_INS_DSB_NB',
      'LAP_2GDP_NOC_RT',
      'LAP_2LID_QTL_RT',
      'POP_2POP_SEX_NB',
      'SDG_0552_NOC_RT',
      'UNE_2EAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_EDU_RT',
    ]);
    expect(result.hits.every((hit) => hit.match_scope === undefined)).toBe(true);
    expect(enrichment).toEqual({ truncated: false, shown: 10, cap: 10 });
  });

  it('browses the same way on a query with no letter or digit, and says so', async () => {
    wireServices();
    const { result, enrichment } = await search({ query: '?!…', limit: 50 });
    expect(result.total).toBe(10);
    expect(enrichment.notice).toBe(
      'query held no searchable word (letters or digits), so indicators were browsed by filters alone.',
    );
  });

  it('keeps the no-searchable-word notice when the browse spans several pages', async () => {
    wireServices();
    const { enrichment } = await search({ query: '!!!', limit: 3 });
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.notice).toBe(
      'query held no searchable word (letters or digits), so indicators were browsed by filters alone. Showing 3 of 10 matching indicators; pass next_cursor as cursor for the next page.',
    );
  });
});

describe('filters', () => {
  it('frequency narrows each hit to that frequency, dropping indicators with none', async () => {
    wireServices();
    const { result } = await search({ frequency: 'Q' });
    expect(indicators(result)).toEqual(['EMP_TEMP_SEX_INS_DSB_NB', 'UNE_DEAP_SEX_AGE_RT']);
    expect(result.hits.map((hit) => hit.datasets.map((dataset) => dataset.dataset_id))).toEqual([
      ['EMP_TEMP_SEX_INS_DSB_NB_Q'],
      ['UNE_DEAP_SEX_AGE_RT_Q'],
    ]);
    // the quarterly unemployment dataset has no aggregates, though the annual one does
    expect(result.hits[1]?.has_aggregates).toBe(false);
    expect(result.facets.frequencies).toEqual([{ code: 'Q', count: 2 }]);
  });

  it('aggregates_only keeps only datasets with aggregates, per dataset', async () => {
    wireServices();
    const { result } = await search({ aggregates_only: true });
    expect(indicators(result)).toEqual([
      'EAP_DWAP_SEX_AGE_RT',
      'LAP_2GDP_NOC_RT',
      'LAP_2LID_QTL_RT',
      'POP_2POP_SEX_NB',
      'UNE_2EAP_SEX_AGE_RT',
      'UNE_DEAP_SEX_AGE_RT',
    ]);
    const une = result.hits.find((hit) => hit.indicator === 'UNE_DEAP_SEX_AGE_RT');
    expect(une?.datasets.map((dataset) => dataset.dataset_id)).toEqual(['UNE_DEAP_SEX_AGE_RT_A']);
    expect(result.hits.every((hit) => hit.has_aggregates)).toBe(true);
  });

  it('reports has_aggregates over the listed datasets, and per dataset', async () => {
    wireServices();
    const { result } = await search({ query: 'unemployment rate sex age' });
    const une = result.hits.find((hit) => hit.indicator === 'UNE_DEAP_SEX_AGE_RT');
    expect(une?.has_aggregates).toBe(true);
    expect(une?.datasets.map((dataset) => [dataset.frequency, dataset.has_aggregates])).toEqual([
      ['A', true],
      ['Q', false],
      ['M', false],
    ]);
  });

  it.each([
    [{ database: 'ilosector' }, ['EMP_TEMP_SEX_IND_NB']],
    [{ database: 'LFS' }, ['EAP_DWAP_SEX_AGE_RT', 'UNE_DEAP_SEX_AGE_RT']],
    [{ subject: 'luu' }, ['UNE_2EAP_SEX_AGE_RT', 'UNE_DEAP_SEX_AGE_RT', 'UNE_DEAP_SEX_EDU_RT']],
    [{ breakdown: 'qtl' }, ['LAP_2LID_QTL_RT']],
    [{ breakdown: 'AGE' }, ['EAP_DWAP_SEX_AGE_RT', 'UNE_2EAP_SEX_AGE_RT', 'UNE_DEAP_SEX_AGE_RT']],
    [{ breakdown: 'INS', frequency: 'A' }, ['EMP_TEMP_SEX_INS_DSB_NB']],
  ] as const)('filters by %o, case-insensitively', async (filters, expected) => {
    wireServices();
    expect(indicators((await search(filters)).result)).toEqual(expected);
  });
});

describe('facets', () => {
  it('count indicators over every page of the fully filtered match set', async () => {
    wireServices();
    const { result } = await search({ query: 'labour', limit: 2 });
    expect(result.hits).toHaveLength(2);
    expect(result.facets).toEqual({
      databases: [
        { code: 'ILOEST', label: 'ILO Modelled Estimates (ILOEST)', count: 3 },
        { code: 'LFS', label: 'Labour Force Statistics (LFS)', count: 2 },
        { code: 'DLMI', label: 'Disability Labour Market Indicators (DLMI)', count: 1 },
        { code: 'EMI', label: 'Education and Mismatch Indicators (EMI)', count: 1 },
        { code: 'ILOSDG', label: 'SDG Labour Market Indicators (ILOSDG)', count: 1 },
      ],
      frequencies: [
        { code: 'A', count: 8 },
        { code: 'Q', count: 2 },
        { code: 'M', count: 1 },
      ],
      subjects: [
        { code: 'LUU', label: 'Unemployment and labour underutilization', count: 3 },
        { code: 'EAR', label: 'Earnings and income', count: 2 },
        { code: 'EMP', label: 'Employment', count: 2 },
        { code: 'EAP', label: 'Labour force', count: 1 },
      ],
    });
  });

  it('narrow with every filter', async () => {
    wireServices();
    const { result } = await search({ query: 'labour', subject: 'EAR' });
    expect(result.facets.subjects).toEqual([
      { code: 'EAR', label: 'Earnings and income', count: 2 },
    ]);
    expect(result.facets.databases).toEqual([
      { code: 'ILOEST', label: 'ILO Modelled Estimates (ILOEST)', count: 2 },
    ]);
  });
});

describe('zero hits', () => {
  it('returns the zero-hit shape when the terms match nothing even unfiltered', async () => {
    wireServices();
    const { result, enrichment } = await search({ query: 'astronaut' });
    expect(result).toMatchObject({
      hits: [],
      total: 0,
      facets: { databases: [], frequencies: [], subjects: [] },
    });
    expect(result.next_cursor).toBeUndefined();
    expect(enrichment).toEqual({
      truncated: false,
      shown: 0,
      cap: 10,
      notice:
        'No indicator matched every term. Use fewer or broader terms (for example "youth unemployment"), or browse subjects with ilostat_list_reference topic subjects and search by subject.',
    });
  });

  it('names each filter whose removal alone would yield hits, with counts', async () => {
    wireServices();
    const plural = await search({ query: 'unemployment', database: 'ILOSDG' });
    expect(plural.enrichment.notice).toBe(
      '3 indicators match without the database filter — drop it or pick another value.',
    );
    const singular = await search({ query: 'managerial', database: 'LFS' });
    expect(singular.enrichment.notice).toBe(
      '1 indicator matches without the database filter — drop it or pick another value.',
    );
    const both = await search({ query: 'unemployment', frequency: 'M', database: 'EMI' });
    expect(both.enrichment.notice).toBe(
      '1 indicator matches without the frequency filter — drop it or pick another value. 1 indicator matches without the database filter — drop it or pick another value.',
    );
  });

  it('says when aggregates_only removed every hit', async () => {
    wireServices();
    const { enrichment } = await search({ query: 'education', aggregates_only: true });
    expect(enrichment.notice).toBe(
      'None of these indicators carries regional aggregates; the ILO modelled estimates (database ILOEST) do.',
    );
  });

  it('falls back to general guidance when no single relaxation helps', async () => {
    wireServices();
    const { enrichment } = await search({
      query: 'unemployment',
      database: 'ILOSDG',
      subject: 'EAR',
    });
    expect(enrichment.notice).toBe(
      'No indicator matches these terms and filters together; drop filters one at a time to widen the search.',
    );
  });
});

describe('paging', () => {
  it('walks every page with next_cursor in ranked order', async () => {
    wireServices();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const { result, enrichment } = await search({
        query: 'labour',
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      seen.push(...indicators(result));
      expect(result.total).toBe(8);
      expect(result.facets.frequencies[0]).toEqual({ code: 'A', count: 8 });
      cursor = result.next_cursor;
      if (cursor) {
        expect(enrichment).toEqual({
          truncated: true,
          shown: 3,
          cap: 3,
          notice:
            'Showing 3 of 8 matching indicators; pass next_cursor as cursor for the next page.',
        });
      } else {
        expect(enrichment).toEqual({ truncated: false, shown: 2, cap: 3 });
      }
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(LABOUR_RANKING);
  });

  it('returns an empty page, with the total, for an offset past the end', async () => {
    wireServices();
    const { result, enrichment } = await search({
      query: 'labour',
      cursor: encodeCursor({ offset: 30, limit: 3 }),
    });
    expect(result.hits).toEqual([]);
    expect(result.total).toBe(8);
    expect(result.next_cursor).toBeUndefined();
    expect(enrichment).toMatchObject({ truncated: false, shown: 0 });
  });

  it('rejects a cursor it did not issue as invalid_cursor, with this tool’s recovery', async () => {
    wireServices();
    const error = await failure({ query: 'labour', cursor: 'eyJub3QiOiJhIGN1cnNvciJ9' });
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
          match: (request) => isRplumber(request, '/metadata/dic'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ query: 'labour', cursor: 'not-a-cursor' });
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toMatchObject({ reason: 'invalid_cursor' });
    const result = await runToolContract(searchIndicatorsTool, {
      query: 'labour',
      cursor: 'not-a-cursor',
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_cursor' } },
    });
    expect(contentText(result)).toContain(`Recovery: ${INVALID_CURSOR_RECOVERY}`);
    expect(http.calls).toHaveLength(0);
  });
});

describe('output', () => {
  it('maps every hit and dataset field, ISO timestamps included', async () => {
    wireServices();
    const { result } = await search({ query: 'unemployment rate sex age' });
    const une = result.hits.find((hit) => hit.indicator === 'UNE_DEAP_SEX_AGE_RT');
    expect(une).toEqual({
      indicator: 'UNE_DEAP_SEX_AGE_RT',
      label: 'Unemployment rate by sex and age (%)',
      subject: { code: 'LUU', label: 'Unemployment and labour underutilization' },
      database: { code: 'LFS', label: 'Labour Force Statistics (LFS)' },
      classification: 'SEX_AGE',
      breakdowns: ['sex', 'age'],
      has_aggregates: true,
      match_scope: 'label',
      datasets: [
        {
          dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
          frequency: 'A',
          data_start: 1947,
          data_end: 2027,
          n_ref_area: 312,
          n_records: 322228,
          last_update: '2026-09-24T07:10:19',
          has_aggregates: true,
        },
        expect.objectContaining({ dataset_id: 'UNE_DEAP_SEX_AGE_RT_Q', has_aggregates: false }),
        expect.objectContaining({ dataset_id: 'UNE_DEAP_SEX_AGE_RT_M', has_aggregates: false }),
      ],
    });
  });

  it('leaves classification absent and breakdowns empty for an indicator without breakdowns', async () => {
    wireServices();
    const { result } = await search({ query: 'managerial' });
    const [sdg] = result.hits;
    expect(sdg?.breakdowns).toEqual([]);
    expect(sdg && 'classification' in sdg).toBe(false);
  });
});

describe('form-client inputs', () => {
  it('reads blank optional strings as unset and browses', async () => {
    wireServices();
    const { result, enrichment } = await search({
      query: '',
      frequency: '' as never,
      database: '  ',
      subject: '',
      breakdown: '',
      cursor: '',
    });
    expect(result.total).toBe(10);
    expect(enrichment).toEqual({ truncated: false, shown: 10, cap: 10 });
  });

  it('rejects malformed constrained inputs', () => {
    expect(() => searchIndicatorsTool.input.parse({ frequency: 'annual' })).toThrow();
    expect(() => searchIndicatorsTool.input.parse({ frequency: 'q' })).toThrow();
    expect(() => searchIndicatorsTool.input.parse({ limit: 0 })).toThrow();
    expect(() => searchIndicatorsTool.input.parse({ limit: 51 })).toThrow();
    expect(() => searchIndicatorsTool.input.parse({ aggregates_only: 'yes' })).toThrow();
    expect(searchIndicatorsTool.input.parse({})).toEqual({ aggregates_only: false, limit: 10 });
  });
});

describe('errors', () => {
  it('logs the reasons a caller’s input causes at notice, the catalog outage at error', () => {
    const severities = Object.fromEntries(
      (searchIndicatorsTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      unknown_filter_code: 'notice',
      invalid_cursor: 'notice',
      catalog_unavailable: 'error',
    });
  });

  it('unknown_filter_code names every filter code the catalog lacks, flattened', async () => {
    const { http } = wireServices();
    const error = await failure({ database: 'no\npe', subject: 'XYZ', breakdown: 'foo' });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_filter_code',
      recovery: {
        hint: 'Call ilostat_list_reference with topic databases, subjects, or classification_types to see the valid codes.',
      },
    });
    expect(error.message).toBe('Not an ILOSTAT code: database NO PE, subject XYZ, breakdown FOO.');
    expect(http.calls).toHaveLength(15);
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    wireServices({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/dic'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure({ query: 'unemployment' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
  });
});

describe('format()', () => {
  it('renders each hit, its datasets, the facets, and the cursor', async () => {
    wireServices();
    const { result } = await search({ query: 'labour', limit: 4 });
    const text = render(result);
    expect(text).toContain('**8 matching indicators** · catalog as of 2026-09-26T12:00:00.000Z');
    expect(text).toContain('### UNE_DEAP_SEX_AGE_RT — Unemployment rate by sex and age (%)');
    expect(text).toContain(
      'Database: Labour Force Statistics (LFS) (LFS) · Subject: Unemployment and labour underutilization (LUU) · Breakdowns: sex, age (SEX_AGE) · Has aggregates: true · Matched on: metadata',
    );
    expect(text).toContain(
      '- UNE_DEAP_SEX_AGE_RT_A · annual · 1947–2027 · 312 areas · 322,228 records · updated 2026-09-24T07:10:19 · has aggregates: true',
    );
    expect(text).toContain('- UNE_DEAP_SEX_AGE_RT_Q · quarterly · 1948–2026 · 122 areas');
    expect(text).toContain('- UNE_DEAP_SEX_AGE_RT_M · monthly · 1948–2026 · 86 areas');
    expect(text).toContain(
      '- Databases: ILOEST (ILO Modelled Estimates (ILOEST)): 3, LFS (Labour Force Statistics (LFS)): 2',
    );
    expect(text).toContain('- Frequencies: A: 8, Q: 2, M: 1');
    expect(text).toContain('- Subjects: LUU (Unemployment and labour underutilization): 3');
    expect(text).toContain(`**next_cursor:** ${result.next_cursor}`);
  });

  it('renders "none" for empty breakdowns and empty facets', async () => {
    wireServices();
    expect(render((await search({ query: 'managerial' })).result)).toContain('Breakdowns: none ·');
    const empty = render((await search({ query: 'astronaut' })).result);
    expect(empty).toContain('**0 matching indicators**');
    expect(empty).toContain('- Databases: none');
    expect(empty).toContain('- Frequencies: none');
    expect(empty).toContain('- Subjects: none');
  });

  it('flattens CR/LF in ILO-published labels; structuredContent keeps them verbatim', async () => {
    const fixture = loadCatalogFixture();
    tocRow(fixture, 'SDG_0552_NOC_RT_A')['indicator.label'] = 'Women in management\n# injected';
    wireServices({ fixture });
    const { result } = await search({ query: 'managerial' });
    expect(result.hits[0]?.label).toBe('Women in management\n# injected');
    const text = render(result);
    expect(text).toContain('### SDG_0552_NOC_RT — Women in management # injected');
    expect(text.split('\n').some((line) => line.startsWith('# injected'))).toBe(false);
  });

  it('flattens CR/LF in the ToC update time and says 1 area for one area; structuredContent keeps both verbatim', async () => {
    const fixture = loadCatalogFixture();
    const row = tocRow(fixture, 'SDG_0552_NOC_RT_A');
    row['last.update'] = '24/09/2026\n## update';
    row['n.ref_area'] = 1;
    wireServices({ fixture });
    const { result } = await search({ query: 'managerial' });
    expect(result.hits[0]?.datasets[0]).toMatchObject({
      dataset_id: 'SDG_0552_NOC_RT_A',
      n_ref_area: 1,
      last_update: '24/09/2026\n## update',
    });
    const lines = render(result).split('\n');
    const datasetLine = lines.find((line) => line.startsWith('- SDG_0552_NOC_RT_A · '));
    expect(datasetLine).toContain(' · 1 area · ');
    expect(datasetLine).toContain(' · updated 24/09/2026 ## update · ');
    expect(lines.some((line) => line.startsWith('## update'))).toBe(false);
  });
});

describe('contract envelope (runToolContract)', () => {
  it('zero-hit page: validates the enrichment and carries the notice on both surfaces', async () => {
    wireServices();
    const result = await runToolContract(searchIndicatorsTool, { query: 'astronaut' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      hits: [],
      total: 0,
      facets: { databases: [], frequencies: [], subjects: [] },
      truncated: false,
      shown: 0,
      cap: 10,
      notice: expect.stringContaining('No indicator matched every term.'),
    });
    const text = contentText(result);
    expect(text).toContain('**0 matching indicators**');
    expect(text).toContain('> No indicator matched every term.');
  });

  it('under-cap partial page: every hit, truncated false, no cursor', async () => {
    wireServices();
    const result = await runToolContract(searchIndicatorsTool, { query: 'unemployment rate' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      total: 3,
      truncated: false,
      shown: 3,
      cap: 10,
    });
    expect(result.structuredContent).not.toHaveProperty('next_cursor');
    const text = contentText(result);
    expect(text).toContain('### UNE_2EAP_SEX_AGE_RT');
  });

  it('capped page, then the last partial page through its cursor', async () => {
    wireServices();
    const first = await runToolContract(searchIndicatorsTool, { query: 'labour', limit: 5 });
    expect(first.structuredContent).toMatchObject({ truncated: true, shown: 5, cap: 5, total: 8 });
    const cursor = nextCursorOf(first);
    expect(cursor).toBeDefined();
    expect(contentText(first)).toContain(
      '> Showing 5 of 8 matching indicators; pass next_cursor as cursor for the next page.',
    );
    const last = await runToolContract(searchIndicatorsTool, {
      query: 'labour',
      limit: 5,
      ...(cursor ? { cursor } : {}),
    });
    expect(last.isError).toBeFalsy();
    expect(last.structuredContent).toMatchObject({ truncated: false, shown: 3, cap: 5, total: 8 });
  });

  it('a paged browse on a query with no searchable word carries both notices on both surfaces', async () => {
    wireServices();
    const result = await runToolContract(searchIndicatorsTool, { query: '!!!', limit: 3 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      shown: 3,
      cap: 3,
      total: 10,
      notice:
        'query held no searchable word (letters or digits), so indicators were browsed by filters alone. Showing 3 of 10 matching indicators; pass next_cursor as cursor for the next page.',
    });
    expect(nextCursorOf(result)).toBeDefined();
    expect(contentText(result)).toContain(
      '> query held no searchable word (letters or digits), so indicators were browsed by filters alone. Showing 3 of 10 matching indicators; pass next_cursor as cursor for the next page.',
    );
  });

  it('declared failures reach both surfaces with their reason and recovery', async () => {
    wireServices();
    const result = await runToolContract(searchIndicatorsTool, { database: 'NOPE' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'unknown_filter_code' } },
    });
    const text = contentText(result);
    expect(text).toContain('Not an ILOSTAT code: database NOPE.');
    expect(text).toContain('Recovery: Call ilostat_list_reference with topic databases');
  });

  it('rejects arguments the schema refuses as InvalidParams', async () => {
    wireServices();
    const result = await runToolContract(searchIndicatorsTool, { limit: 500 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
});
