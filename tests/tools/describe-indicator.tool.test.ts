/**
 * @fileoverview Tests for `ilostat_describe_indicator` against the recorded catalog
 * (rplumber fetch seam) and the recorded SDMX structures and unit probes (SDMX
 * fetch seam): dataset-ID and bare-indicator hits, ID normalization, the three
 * basis-rule cutoffs, breakdown codes with totals and group headers, the default
 * slice, units, areas, degradation to `structure_status: 'unavailable'`, the miss
 * shape, both consumption paths, and the declared error reason.
 * @module tests/tools/describe-indicator.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockRoute,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { describeIndicatorTool } from '@/mcp-server/tools/definitions/describe-indicator.tool.js';
import { queryIndicatorTool } from '@/mcp-server/tools/definitions/query-indicator.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  type CatalogFixture,
  callUrls,
  fixtureText,
  INDICATOR_CSV,
  indicatorDataRoute,
  isProbeRequest,
  isRplumber,
  isStructureRequest,
  loadCatalogFixture,
  observationCatalogFixture,
  probeRoute,
  SDMX_404_NO_DATA,
  SDMX_422_SHORT_KEY,
  SDMX_500_ORA,
  sdmxText,
  structureDocument,
  structureResponse,
  structureRoute,
  tocRow,
  tooManyRequests,
  wireServices,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  disposeIlostatServices();
});

type Output = Awaited<ReturnType<typeof describeIndicatorTool.handler>>;

const STRUCTURE_NOTICE =
  "Breakdown codes and units are unavailable from the ILOSTAT structure service; ilostat_list_reference topic classifications lists every breakdown code, and the label's parenthetical — (%) or (thousands) — gives the unit.";

const UNE_DEFINITION =
  'With the aim of promoting international comparability, statistics presented on ILOSTAT are based on standard international definitions wherever feasible and may differ from official national figures. The unemployment rate conveys the number of persons who are unemployed as a percent of the labour force. For more information, refer to the Labour Force Statistics (LFS and STLFS) database description (https://ilostat.ilo.org/methods/concepts-and-definitions/description-labour-force-statistics/).';

async function describeId(datasetId: string) {
  const ctx = createMockContext({ errors: describeIndicatorTool.errors });
  const result = await describeIndicatorTool.handler(
    describeIndicatorTool.input.parse({ dataset_id: datasetId }),
    ctx,
  );
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(datasetId: string): Promise<McpError> {
  const ctx = createMockContext({ errors: describeIndicatorTool.errors });
  try {
    await describeIndicatorTool.handler(
      describeIndicatorTool.input.parse({ dataset_id: datasetId }),
      ctx,
    );
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (describeIndicatorTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

/** The `content[]` text a format()-only client reads. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

const sdmxCalls = (wired: ReturnType<typeof wireServices>) =>
  callUrls(wired.http, (request) => isStructureRequest(request) || isProbeRequest(request));

/** A catalog whose labels name no ILO modelled estimates edition. */
function catalogWithoutIloEdition(): CatalogFixture {
  const fixture = loadCatalogFixture();
  fixture.indicatorToc = fixture.indicatorToc.filter(
    (row) => !String(row['indicator.label']).includes('ILO modelled estimates'),
  );
  return fixture;
}

describe('hits', () => {
  it('describes a dataset from the catalog, the SDMX structure, and the unit probe', async () => {
    wireServices();
    const { result, enrichment } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(result).toEqual({
      found: true,
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
      indicator: 'UNE_DEAP_SEX_AGE_RT',
      label: 'Unemployment rate by sex and age (%)',
      definition: UNE_DEFINITION,
      measure: {
        code: 'UNE_DEAP_RT',
        label: 'Unemployment rate (previous ILO definition - ICLS13)',
      },
      database: { code: 'LFS', label: 'Labour Force Statistics (LFS)' },
      subject: { code: 'LUU', label: 'Unemployment and labour underutilization' },
      datasets: [
        {
          dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
          frequency: 'A',
          data_start: 1947,
          data_end: 2027,
          n_ref_area: 312,
          n_records: 322228,
          n_records_all: 365493,
          last_update: '2026-09-24T07:10:19',
          has_aggregates: true,
        },
        expect.objectContaining({ dataset_id: 'UNE_DEAP_SEX_AGE_RT_Q', has_aggregates: false }),
        expect.objectContaining({ dataset_id: 'UNE_DEAP_SEX_AGE_RT_M', has_aggregates: false }),
      ],
      breakdowns: {
        sex: true,
        sex_codes: ['SEX_T', 'SEX_M', 'SEX_F', 'SEX_O'],
        classif1: {
          type: 'AGE',
          type_label: 'Age',
          codes: [
            { code: 'AGE_YTHADULT_YGE15', label: 'Age (Youth, adults): 15+', is_total: true },
            { code: 'AGE_YTHADULT_Y15-64', label: 'Age (Youth, adults): 15-64', is_total: false },
            { code: 'AGE_YTHADULT_Y15-24', label: 'Age (Youth, adults): 15-24', is_total: false },
            { code: 'AGE_YTHADULT_YGE25', label: 'Age (Youth, adults): 25+', is_total: false },
            { code: 'AGE_AGGREGATE_YGE15', label: 'Age (Aggregate bands): 15+', is_total: true },
            {
              code: 'AGE_AGGREGATE_Y15-24',
              label: 'Age (Aggregate bands): 15-24',
              is_total: false,
            },
            // AGE_AGGREGATE_Y25-54 is in the SDMX constraint but not the classif1
            // dictionary, so ilostat_query_indicator would reject it: left out
          ],
        },
      },
      default_slice: { sex: 'SEX_T', classif1: 'AGE_YTHADULT_YGE15' },
      unit: {
        measure: 'PT',
        measure_label: 'Percentage',
        type: 'RT',
        type_label: 'Rate',
        multiplier: 0,
        multiplier_label: 'Units',
      },
      has_aggregates: true,
      ref_areas: { countries: ['ABW', 'KEN', 'USA'], aggregates: ['X01', 'X06'], count: 5 },
      basis_rule: {
        modelled_source_label: 'ILO - Modelled Estimates',
        projection_after_year: 2024,
        projection_rule: 'catalog_edition',
        edition: 'Nov. 2025',
        database_is_modelled: false,
      },
      related_datasets: [
        {
          indicator: 'UNE_DEAP_SEX_EDU_RT',
          label: 'Unemployment rate by sex and education (%)',
          classification: 'SEX_EDU',
        },
      ],
      structure_status: 'complete',
      catalog_as_of: '2026-09-26T12:00:00.000Z',
      attribution:
        'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org',
    });
    expect(enrichment).toEqual({});
  });

  it('sets has_aggregates from the requested dataset: the quarterly variant has none', async () => {
    wireServices();
    const { result } = await describeId('UNE_DEAP_SEX_AGE_RT_Q');
    expect(result.dataset_id).toBe('UNE_DEAP_SEX_AGE_RT_Q');
    expect(result.has_aggregates).toBe(false);
    expect(result.datasets).toHaveLength(3);
  });

  it('describes every frequency of a bare indicator code, with has_aggregates from any', async () => {
    wireServices();
    const { result } = await describeId('UNE_DEAP_SEX_AGE_RT');
    expect(result.found).toBe(true);
    expect(result).not.toHaveProperty('dataset_id');
    expect(result.has_aggregates).toBe(true);
    expect(result.datasets?.map((dataset) => dataset.dataset_id)).toEqual([
      'UNE_DEAP_SEX_AGE_RT_A',
      'UNE_DEAP_SEX_AGE_RT_Q',
      'UNE_DEAP_SEX_AGE_RT_M',
    ]);
  });

  it('normalizes case, whitespace, and the SDMX DF_ prefix', async () => {
    wireServices();
    const { result } = await describeId('  df_une_deap_sex_age_rt_a ');
    expect(result.dataset_id).toBe('UNE_DEAP_SEX_AGE_RT_A');
  });

  it('reads deciles: parentless codes kept, no total, so no default slot and no sex breakdown', async () => {
    wireServices();
    const { result } = await describeId('LAP_2LID_QTL_RT_A');
    expect(result.breakdowns).toEqual({
      sex: false,
      sex_codes: [],
      classif1: {
        type: 'DCL',
        type_label: 'Decile',
        codes: Array.from({ length: 10 }, (_, i) => ({
          code: `DCL_DECILE_${String(i + 1).padStart(2, '0')}`,
          label: `Decile: Decile ${i + 1}`,
          is_total: false,
        })),
      },
    });
    expect(result.default_slice).toEqual({});
    expect(result.ref_areas).toEqual({ countries: ['KEN', 'USA'], aggregates: ['X01'], count: 3 });
    expect(result.unit?.measure).toBe('PT');
  });

  it('reads two breakdowns and a default slice listed out of dimension order', async () => {
    wireServices();
    const { result } = await describeId('EMP_TEMP_SEX_INS_DSB_NB_A');
    expect(result.breakdowns?.classif1?.type).toBe('INS');
    expect(result.breakdowns?.classif1?.type_label).toBe('Public/private sector');
    expect(result.breakdowns?.classif2?.codes).toEqual([
      { code: 'DSB_STATUS_TOTAL', label: 'Disability status: Total', is_total: true },
      {
        code: 'DSB_STATUS_NODIS',
        label: 'Disability status: Persons without disability',
        is_total: false,
      },
      {
        code: 'DSB_STATUS_DIS',
        label: 'Disability status: Persons with disability',
        is_total: false,
      },
      {
        code: 'DSB_STATUS_X',
        label: 'Disability status: Not elsewhere classified',
        is_total: false,
      },
    ]);
    expect(result.default_slice).toEqual({
      sex: 'SEX_T',
      classif1: 'INS_SECTOR_TOTAL',
      classif2: 'DSB_STATUS_TOTAL',
    });
    expect(result.unit).toEqual({
      measure: 'PS',
      measure_label: 'Persons',
      type: 'NB',
      type_label: 'Number',
      multiplier: 3,
      multiplier_label: 'Thousands',
    });
  });

  it('lists a breakdown code only when the dictionary accepts it in that slot', async () => {
    const fixture = loadCatalogFixture();
    // DSB_STATUS_X is left a classif1 code only; SDMX still lists it under the second breakdown
    fixture.dictionaries.classif2 = (fixture.dictionaries.classif2 ?? []).filter(
      (row) => row.classif2 !== 'DSB_STATUS_X',
    );
    wireServices({ fixture });
    const { result } = await describeId('EMP_TEMP_SEX_INS_DSB_NB_A');
    expect(result.breakdowns?.classif2?.codes.map((code) => code.code)).toEqual([
      'DSB_STATUS_TOTAL',
      'DSB_STATUS_NODIS',
      'DSB_STATUS_DIS',
    ]);
    expect(result.breakdowns?.classif1?.codes.map((code) => code.code)).toContain('INS_SECTOR_X');
    expect(render(result)).not.toContain('DSB_STATUS_X');
  });

  it('lists only codes ilostat_query_indicator accepts: a query naming every listed code runs', async () => {
    wireServices({
      fixture: observationCatalogFixture(),
      routes: [indicatorDataRoute(fixtureText(INDICATOR_CSV.uneDeap))],
    });
    const { result } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    const listed = result.breakdowns?.classif1?.codes.map((code) => code.code) ?? [];
    const queried = await queryIndicatorTool.handler(
      queryIndicatorTool.input.parse({
        dataset_ids: ['UNE_DEAP_SEX_AGE_RT_A'],
        ref_areas: ['USA'],
        sex: result.breakdowns?.sex_codes,
        classif1: listed,
      }),
      createMockContext({ errors: queryIndicatorTool.errors }),
    );
    expect(queried.row_count).toBe(18);
    expect(listed).toHaveLength(6);
  });

  it('describes a dataset without breakdowns or related indicators', async () => {
    wireServices();
    const { result } = await describeId('SDG_0552_NOC_RT_A');
    expect(result.breakdowns).toEqual({ sex: false, sex_codes: [] });
    expect(result.default_slice).toEqual({});
    expect(result.related_datasets).toEqual([]);
    expect(result.has_aggregates).toBe(false);
    expect(result.definition).toBe(
      'Data may differ from nationally reported figures and the Global SDG Indicators Database. The female share of employment in managerial positions conveys the number of women in management as a percentage of employment in management.',
    );
  });

  it('caps related_datasets at 20 other indicators sharing the measure', async () => {
    const fixture = loadCatalogFixture();
    const template = tocRow(fixture, 'UNE_DEAP_SEX_EDU_RT_A');
    for (let i = 0; i < 25; i += 1) {
      const indicator = `UNE_DEAP_SEX_X${String(i).padStart(2, '0')}_RT`;
      fixture.indicatorToc.push({ ...template, id: `${indicator}_A`, indicator });
    }
    wireServices({ fixture });
    const { result } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    const related = result.related_datasets?.map((entry) => entry.indicator) ?? [];
    expect(related).toHaveLength(20);
    expect(related).not.toContain('UNE_DEAP_SEX_AGE_RT');
    expect(related[0]).toBe('UNE_DEAP_SEX_EDU_RT');
  });

  it('serves a repeat describe of the indicator, any frequency, from the structure cache', async () => {
    const wired = wireServices();
    await describeId('UNE_DEAP_SEX_AGE_RT_A');
    const first = sdmxCalls(wired).length;
    await describeId('UNE_DEAP_SEX_AGE_RT_M');
    await describeId('une_deap_sex_age_rt');
    expect(sdmxCalls(wired)).toHaveLength(first);
  });

  it('sends Accept-Language en on every catalog and SDMX request', async () => {
    const wired = wireServices();
    await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(wired.http.calls.length).toBeGreaterThan(15);
    for (const call of wired.http.calls) {
      expect(call.request.headers.get('accept-language')).toBe('en');
    }
  });
});

describe('basis rule', () => {
  it.each([
    ['UNE_2EAP_SEX_AGE_RT_A', 2024, 'Nov. 2025', true],
    ['LAP_2LID_QTL_RT_A', 2024, 'Sept. 2025', true],
    ['POP_2POP_SEX_NB_A', 2023, 'July 2024', true],
  ] as const)(
    '%s: the edition its label names → cutoff %i',
    async (id, year, edition, modelled) => {
      wireServices();
      const { result } = await describeId(id);
      expect(result.basis_rule).toEqual({
        modelled_source_label: 'ILO - Modelled Estimates',
        projection_after_year: year,
        projection_rule: 'edition',
        edition,
        database_is_modelled: modelled,
      });
    },
  );

  it("catalog_edition: a label with no edition takes the catalog's latest ILO edition", async () => {
    wireServices();
    const { result } = await describeId('SDG_0552_NOC_RT_A');
    expect(result.basis_rule).toMatchObject({
      projection_after_year: 2024,
      projection_rule: 'catalog_edition',
      edition: 'Nov. 2025',
      database_is_modelled: false,
    });
  });

  it('current_year: with no ILO edition anywhere, the year before now — both sides of New Year', async () => {
    wireServices({
      fixture: catalogWithoutIloEdition(),
      now: () => new Date('2026-12-31T23:59:59Z'),
    });
    const before = (await describeId('UNE_DEAP_SEX_AGE_RT_A')).result.basis_rule;
    expect(before).toEqual({
      modelled_source_label: 'ILO - Modelled Estimates',
      projection_after_year: 2025,
      projection_rule: 'current_year',
      database_is_modelled: false,
    });
    disposeIlostatServices();

    wireServices({
      fixture: catalogWithoutIloEdition(),
      now: () => new Date('2027-01-01T00:00:00Z'),
    });
    const after = (await describeId('UNE_DEAP_SEX_AGE_RT_A')).result.basis_rule;
    expect(after?.projection_after_year).toBe(2026);
    // a non-ILO edition in the label still applies its own rule
    expect((await describeId('POP_2POP_SEX_NB_A')).result.basis_rule?.projection_rule).toBe(
      'edition',
    );
  });
});

describe('misses', () => {
  it('returns found: false with guidance and nothing else for an unknown code, without SDMX', async () => {
    const wired = wireServices();
    const { result, enrichment } = await describeId('NOPE_NOT_REAL_A');
    expect(result).toEqual({
      found: false,
      guidance:
        'No ILOSTAT dataset or indicator has the code NOPE_NOT_REAL_A. Dataset IDs are an indicator code plus _A, _Q, or _M (for example UNE_DEAP_SEX_AGE_RT_A); find one with ilostat_search_indicators.',
      catalog_as_of: '2026-09-26T12:00:00.000Z',
    });
    expect(enrichment).toEqual({});
    expect(sdmxCalls(wired)).toHaveLength(0);
  });

  it.each([
    'UNE_DEAP_SEX_AGE_RT_A+UNE_2EAP_SEX_AGE_RT_A',
    'UNE_DEAP_SEX_AGE_RT_A,UNE_2EAP_SEX_AGE_RT_A',
    'UNE_DEAP_SEX_AGE_RT_A, UNE_2EAP_SEX_AGE_RT_A',
    'UNE_DEAP_SEX_AGE_RT_A + UNE_2EAP_SEX_AGE_RT_A, UNE_DEAP_SEX_AGE_RT_Q',
  ])('treats a joined value (%s) as a miss that says to describe one per call', async (joined) => {
    const wired = wireServices();
    const { result } = await describeId(joined);
    expect(result).toEqual({
      found: false,
      guidance: `${joined} names several codes; describe one dataset per call, for example UNE_DEAP_SEX_AGE_RT_A, and call again for each of the others.`,
      catalog_as_of: '2026-09-26T12:00:00.000Z',
    });
    expect(sdmxCalls(wired)).toHaveLength(0);
  });

  it('answers a comma-space joined value with the one-per-call guidance on both surfaces', async () => {
    const wired = wireServices();
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: ' une_deap_sex_age_rt_a, une_deap_sex_age_rt_q ',
    });
    expect(result.isError).toBeFalsy();
    const guidance =
      'UNE_DEAP_SEX_AGE_RT_A, UNE_DEAP_SEX_AGE_RT_Q names several codes; describe one dataset per call, for example UNE_DEAP_SEX_AGE_RT_A, and call again for each of the others.';
    expect(result.structuredContent).toMatchObject({ found: false, guidance });
    const text = contentText(result);
    expect(text).toContain('**No match.**');
    expect(text).toContain(guidance);
    expect(sdmxCalls(wired)).toHaveLength(0);
  });

  it.each([
    'UNE_DEAP_SEX_AGE_RT_A,\nUNE_2EAP_SEX_AGE_RT_A',
    'UNE_DEAP_SEX_AGE_RT_A, ',
    'UNE_DEAP_SEX_AGE_RT_A UNE_2EAP_SEX_AGE_RT_A',
  ])(
    'still rejects %j at the schema: only spaces around a separator are admitted',
    async (value) => {
      const wired = wireServices();
      const result = await runToolContract(describeIndicatorTool, { dataset_id: value });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(wired.http.calls).toHaveLength(0);
    },
  );

  it('rejects a code carrying CR/LF at the schema, so it is never echoed', async () => {
    const wired = wireServices();
    const result = await runToolContract(describeIndicatorTool, { dataset_id: 'NOPE\r\n## X' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(wired.http.calls).toHaveLength(0);
  });

  it('rejects a blank dataset_id', () => {
    expect(() => describeIndicatorTool.input.parse({ dataset_id: '' })).toThrow();
    expect(() => describeIndicatorTool.input.parse({ dataset_id: '   ' })).toThrow();
    expect(() => describeIndicatorTool.input.parse({})).toThrow();
  });
});

describe('degraded structure', () => {
  const catalogFields = {
    found: true,
    indicator: 'POP_2POP_SEX_NB',
    structure_status: 'unavailable',
  };

  it('SDMX has no dataflow: structure_status unavailable, catalog fields kept, notice', async () => {
    wireServices();
    const { result, enrichment } = await describeId('POP_2POP_SEX_NB_A');
    expect(result).toMatchObject(catalogFields);
    for (const key of ['breakdowns', 'default_slice', 'ref_areas', 'unit']) {
      expect(result).not.toHaveProperty(key);
    }
    expect(result.datasets).toHaveLength(1);
    expect(result.basis_rule?.projection_after_year).toBe(2023);
    expect(enrichment).toEqual({ notice: STRUCTURE_NOTICE });
  });

  it('SDMX unreachable: degrades the same way, and is asked again on the next call', async () => {
    let down = true;
    const unreachable: FetchMockRoute = {
      match: (request) => down && isStructureRequest(request),
      respond: () => Promise.reject(new TypeError('fetch failed')),
    };
    const wired = wireServices({ routes: [unreachable] });
    const degraded = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(degraded.result.structure_status).toBe('unavailable');
    expect(degraded.enrichment.notice).toBe(STRUCTURE_NOTICE);

    down = false;
    const recovered = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(recovered.result.structure_status).toBe('complete');
    expect(recovered.enrichment).toEqual({});
    expect(callUrls(wired.http, (request) => isStructureRequest(request))).toHaveLength(2);
  });

  it('SDMX throttling (429) degrades rather than failing the describe', async () => {
    wireServices({
      routes: [structureRoute('UNE_DEAP_SEX_AGE_RT', () => tooManyRequests('60'))],
    });
    const { result, enrichment } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(result.structure_status).toBe('unavailable');
    expect(enrichment.notice).toBe(STRUCTURE_NOTICE);
  });

  it('unit unresolved after three areas: structure complete, unit absent, notice', async () => {
    const wired = wireServices({
      routes: [
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () => sdmxText(SDMX_404_NO_DATA, 404)),
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'KEN....', () => sdmxText(SDMX_500_ORA, 500)),
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'USA....', () => sdmxText(SDMX_404_NO_DATA, 404)),
      ],
    });
    const { result, enrichment } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(result.structure_status).toBe('complete');
    expect(result.breakdowns?.classif1?.type).toBe('AGE');
    expect(result).not.toHaveProperty('unit');
    expect(enrichment).toEqual({ notice: STRUCTURE_NOTICE });
    expect(callUrls(wired.http, (request) => isProbeRequest(request))).toHaveLength(3);
    expect(render(result)).toContain('Unit: not resolved');
  });

  it("a probe key the SDMX host rejects (422) is this server's bug and fails InternalError", async () => {
    wireServices({
      routes: [
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'ABW....', () => sdmxText(SDMX_422_SHORT_KEY, 422)),
      ],
    });
    const error = await failure('UNE_DEAP_SEX_AGE_RT_A');
    expect(error.code).toBe(JsonRpcErrorCode.InternalError);
  });
});

describe('errors', () => {
  it('declares only the catalog outage, logged at error; a miss is found: false, not an error', () => {
    expect(
      (describeIndicatorTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    ).toEqual([['catalog_unavailable', 'error']]);
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    const wired = wireServices({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/ref_area'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const error = await failure('UNE_DEAP_SEX_AGE_RT_A');
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
    expect(sdmxCalls(wired)).toHaveLength(0);
  });
});

describe('format()', () => {
  it('renders every field a hit carries', async () => {
    wireServices();
    const text = render((await describeId('UNE_DEAP_SEX_AGE_RT_A')).result);
    for (const line of [
      '## UNE_DEAP_SEX_AGE_RT_A — Unemployment rate by sex and age (%)',
      'Indicator: UNE_DEAP_SEX_AGE_RT',
      'Database: Labour Force Statistics (LFS) (LFS)',
      'Subject: Unemployment and labour underutilization (LUU)',
      'Measure: Unemployment rate (previous ILO definition - ICLS13) (UNE_DEAP_RT)',
      'Unit: Percentage (PT) · type Rate (RT) · multiplier 0 (Units)',
      'Has aggregates: true',
      'Basis rule: rows sourced "ILO - Modelled Estimates" are modelled estimates through 2024 and projections after it (rule catalog_edition, edition Nov. 2025); every other source is reported · database is modelled: false',
      'Structure: complete',
      `> ${UNE_DEFINITION}`,
      '### Frequency variants',
      '- UNE_DEAP_SEX_AGE_RT_A · annual · 1947–2027 · 312 areas · 322,228 records (365,493 with secondary sources) · updated 2026-09-24T07:10:19 · has aggregates: true',
      '- UNE_DEAP_SEX_AGE_RT_Q · quarterly · 1948–2026 · 122 areas · 658,738 records (718,417 with secondary sources) · updated 2026-09-24T07:11:06 · has aggregates: false',
      '### Breakdowns',
      'Sex breakdown: true — SEX_T, SEX_M, SEX_F, SEX_O',
      '**classif1** — AGE (Age):',
      '- AGE_YTHADULT_YGE15 — Age (Youth, adults): 15+ · is_total: true',
      '- AGE_AGGREGATE_Y15-24 — Age (Aggregate bands): 15-24',
      'Default slice: sex SEX_T · classif1 AGE_YTHADULT_YGE15',
      '### Reference areas',
      '5 areas: 3 countries, 2 aggregates',
      'Aggregates: X01, X06',
      'Countries: ABW, KEN, USA',
      '### Related indicators (same measure)',
      '- UNE_DEAP_SEX_EDU_RT — Unemployment rate by sex and education (%) (SEX_EDU)',
      'Catalog as of 2026-09-26T12:00:00.000Z · found: true',
      'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org',
    ]) {
      expect(text.split('\n')).toContain(line);
    }
    // in the SDMX constraint, not the classif1 dictionary
    expect(text).not.toContain('AGE_AGGREGATE_Y25-54');
  });

  it('renders a two-breakdown dataset and a no-total default slice', async () => {
    wireServices();
    const emp = render((await describeId('EMP_TEMP_SEX_INS_DSB_NB_A')).result);
    expect(emp).toContain('**classif2** — DSB (Disability status):');
    expect(emp).toContain(
      'Default slice: sex SEX_T · classif1 INS_SECTOR_TOTAL · classif2 DSB_STATUS_TOTAL',
    );
    expect(emp).toContain('Unit: Persons (PS) · type Number (NB) · multiplier 3 (Thousands)');
    const decile = render((await describeId('LAP_2LID_QTL_RT_A')).result);
    expect(decile).toContain('Sex breakdown: false');
    expect(decile).toContain('Default slice: no total codes');
  });

  it('renders a miss as guidance only', async () => {
    wireServices();
    const text = render((await describeId('NOPE_NOT_REAL_A')).result);
    expect(text).toContain('**No match.**');
    expect(text).toContain('No ILOSTAT dataset or indicator has the code NOPE_NOT_REAL_A.');
    expect(text).toContain('found: false');
    expect(text).not.toContain('Unit:');
    expect(text).not.toContain('Source: ILOSTAT');
  });

  it('wraps long area lists at 20 codes a line, classifying uncatalogued codes by their X prefix', async () => {
    const document = structureDocument('UNE_DEAP_SEX_AGE_RT') as {
      data: {
        contentConstraints: { cubeRegions: { keyValues: { id: string; values: string[] }[] }[] }[];
      };
    };
    const countries = Array.from({ length: 44 }, (_, i) => `C${String(i).padStart(2, '0')}`);
    const areaKey = document.data.contentConstraints[0]?.cubeRegions[0]?.keyValues.find(
      (entry) => entry.id === 'REF_AREA',
    );
    if (areaKey) areaKey.values = ['C00', ...countries.slice(1), 'X06', 'X99'];
    wireServices({
      routes: [
        structureRoute('UNE_DEAP_SEX_AGE_RT', () => structureResponse(document)),
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'C00....', () => sdmxText(SDMX_404_NO_DATA, 404)),
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'C01....', () => sdmxText(SDMX_404_NO_DATA, 404)),
        probeRoute('UNE_DEAP_SEX_AGE_RT', 'C02....', () => sdmxText(SDMX_404_NO_DATA, 404)),
      ],
    });
    const { result } = await describeId('UNE_DEAP_SEX_AGE_RT_A');
    expect(result.ref_areas).toEqual({
      countries,
      aggregates: ['X06', 'X99'],
      count: 46,
    });
    const lines = render(result).split('\n');
    const start = lines.indexOf(`Countries: ${countries.slice(0, 20).join(', ')}`);
    expect(start).toBeGreaterThan(-1);
    expect(lines[start + 1]).toBe(countries.slice(20, 40).join(', '));
    expect(lines[start + 2]).toBe(countries.slice(40).join(', '));
  });

  it('keeps a multi-line definition inside its blockquote and flattens labels', async () => {
    const fixture = loadCatalogFixture();
    const entry = fixture.dictionaries.indicator?.find(
      (row) => row.indicator === 'SDG_0552_NOC_RT',
    );
    if (entry) entry['indicator.description'] = 'First line.\n# Not a heading\nThird line.';
    tocRow(fixture, 'SDG_0552_NOC_RT_A')['indicator.label'] = 'Women in management\r\n# injected';
    wireServices({ fixture });
    const { result } = await describeId('SDG_0552_NOC_RT_A');
    expect(result.definition).toBe('First line.\n# Not a heading\nThird line.');
    const lines = render(result).split('\n');
    expect(lines).toContain('## SDG_0552_NOC_RT_A — Women in management # injected');
    expect(lines).toContain('> First line.');
    expect(lines).toContain('> # Not a heading');
    expect(lines).toContain('> Third line.');
    expect(lines.some((line) => line.startsWith('# '))).toBe(false);
  });

  it('flattens CR/LF in the ToC update time and says 1 area for one area; structuredContent keeps both verbatim', async () => {
    const fixture = loadCatalogFixture();
    const row = tocRow(fixture, 'SDG_0552_NOC_RT_A');
    row['last.update'] = '24/09/2026\n## update';
    row['n.ref_area'] = 1;
    wireServices({ fixture });
    const { result } = await describeId('SDG_0552_NOC_RT_A');
    expect(result.datasets?.[0]).toMatchObject({
      dataset_id: 'SDG_0552_NOC_RT_A',
      n_ref_area: 1,
      last_update: '24/09/2026\n## update',
    });
    const lines = render(result).split('\n');
    const variantLine = lines.find((line) => line.startsWith('- SDG_0552_NOC_RT_A · '));
    expect(variantLine).toContain(' · 1 area · ');
    expect(variantLine).toContain(' · updated 24/09/2026 ## update · ');
    expect(lines.some((line) => line.startsWith('## update'))).toBe(false);
  });

  it('flattens every line terminator in upstream codes on content[]; structuredContent keeps them verbatim', async () => {
    const fixture = loadCatalogFixture();
    const measure = 'UNE_DEAP_RT\u2029## injected measure';
    for (const row of fixture.indicatorToc) {
      if (row.rep_var === 'UNE_DEAP_RT') row.rep_var = measure;
      if (row.indicator !== 'UNE_DEAP_SEX_AGE_RT') continue;
      row.database = 'LFS\u2028## injected database';
      row.subject = 'LUU\u0085## injected subject';
    }
    tocRow(fixture, 'UNE_DEAP_SEX_AGE_RT_Q').id = 'UNE_DEAP_SEX_AGE_RT_Q\n## injected variant';
    const related = tocRow(fixture, 'UNE_DEAP_SEX_EDU_RT_A');
    related.indicator = 'UNE_DEAP_SEX_EDU_RT\r\n## injected related';
    related.classification = 'SEX_EDU\n## injected classification';
    const document = structureDocument('UNE_DEAP_SEX_AGE_RT') as {
      data: {
        contentConstraints: { cubeRegions: { keyValues: { id: string; values: string[] }[] }[] }[];
      };
    };
    document.data.contentConstraints[0]?.cubeRegions[0]?.keyValues
      .find((entry) => entry.id === 'SEX')
      ?.values.push('SEX_X\u2028## injected sex');
    wireServices({
      fixture,
      routes: [structureRoute('UNE_DEAP_SEX_AGE_RT', () => structureResponse(document))],
    });
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
    });
    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as Output;
    expect(output).toMatchObject({
      measure: { code: measure },
      database: { code: 'LFS\u2028## injected database' },
      subject: { code: 'LUU\u0085## injected subject' },
      related_datasets: [
        {
          indicator: 'UNE_DEAP_SEX_EDU_RT\r\n## injected related',
          classification: 'SEX_EDU\n## injected classification',
        },
      ],
    });
    expect(output.datasets?.map((variant) => variant.dataset_id)).toContain(
      'UNE_DEAP_SEX_AGE_RT_Q\n## injected variant',
    );
    expect(output.breakdowns?.sex_codes).toContain('SEX_X\u2028## injected sex');
    const text = contentText(result);
    expect(text).not.toMatch(/[\u0085\u2028\u2029]/);
    const lines = text.split(/\r\n|[\r\n]/);
    expect(lines.filter((line) => line.startsWith('## injected'))).toEqual([]);
    expect(lines.some((line) => line.includes('SEX_X ## injected sex'))).toBe(true);
  });

  it.each([
    [['ABW'], '1 area: 1 country, 0 aggregates'],
    [['ABW', 'X01'], '2 areas: 1 country, 1 aggregate'],
  ])('counts the areas %j in the singular where one, on both surfaces', async (areas, line) => {
    const document = structureDocument('UNE_DEAP_SEX_AGE_RT') as {
      data: {
        contentConstraints: { cubeRegions: { keyValues: { id: string; values: string[] }[] }[] }[];
      };
    };
    const areaKey = document.data.contentConstraints[0]?.cubeRegions[0]?.keyValues.find(
      (entry) => entry.id === 'REF_AREA',
    );
    if (areaKey) areaKey.values = areas;
    wireServices({
      routes: [structureRoute('UNE_DEAP_SEX_AGE_RT', () => structureResponse(document))],
    });
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ref_areas: {
        countries: ['ABW'],
        aggregates: areas.filter((code) => code.startsWith('X')),
        count: areas.length,
      },
    });
    expect(contentText(result).split('\n')).toContain(line);
  });
});

describe('contract envelope (runToolContract)', () => {
  it('a complete hit validates with no enrichment trailer', async () => {
    wireServices();
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ found: true, structure_status: 'complete' });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(contentText(result)).toContain('## UNE_DEAP_SEX_AGE_RT_A');
  });

  it('a degraded hit carries the notice on both surfaces', async () => {
    wireServices();
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: 'POP_2POP_SEX_NB_A',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      structure_status: 'unavailable',
      notice: STRUCTURE_NOTICE,
    });
    expect(contentText(result)).toContain(`> ${STRUCTURE_NOTICE}`);
  });

  it('a miss validates as found: false', async () => {
    wireServices();
    const result = await runToolContract(describeIndicatorTool, { dataset_id: 'NOPE_A' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      found: false,
      guidance: expect.stringContaining('NOPE_A'),
      catalog_as_of: '2026-09-26T12:00:00.000Z',
    });
  });

  it('catalog_unavailable reaches both surfaces with its reason and recovery', async () => {
    wireServices({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
      ],
    });
    const result = await runToolContract(describeIndicatorTool, {
      dataset_id: 'UNE_DEAP_SEX_AGE_RT_A',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'catalog_unavailable', retryable: true },
      },
    });
    const text = contentText(result);
    expect(text).toContain(`Recovery: ${CATALOG_UNAVAILABLE_RECOVERY}`);
    expect(text).toContain('reason catalog_unavailable · retryable');
  });

  it('rejects a blank dataset_id as InvalidParams', async () => {
    wireServices();
    const result = await runToolContract(describeIndicatorTool, { dataset_id: '  ' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
  });
});
