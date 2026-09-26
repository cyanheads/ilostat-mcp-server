/**
 * @fileoverview Tests for `ilostat_get_country_profile` against the recorded
 * catalog and `/data/ref_area` JSON captures (rplumber fetch seam): the two
 * parallel calls for a country and the single modelled call for an aggregate, the
 * exact URLs (bare indicator codes, the frequency riding on `id`, `timeto` at the
 * cutoff on the modelled call), the local sex slice served from one cached
 * response, the reported-missing notice and its no-model tail, headlines whose
 * dataset left the catalog (one, and all of them), a failed reported call failing the profile, modelled
 * rows past the cutoff excluded, every declared error reason, and both
 * consumption paths (`structuredContent` and `content[]`).
 * @module tests/tools/get-country-profile.tool.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockRoute,
  getEnrichment,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { getCountryProfileTool } from '@/mcp-server/tools/definitions/get-country-profile.tool.js';
import { disposeIlostatServices } from '@/services/ilostat-services.js';
import {
  CATALOG_UNAVAILABLE_RECOVERY,
  type CatalogFixture,
  callUrls,
  isRefAreaData,
  isRplumber,
  observationCatalogFixture,
  type RawRow,
  refAreaRows,
  rplumberBody,
  tooManyRequests,
  type WireOptions,
  wireServices,
} from '../helpers/ilostat-upstream.js';
import { guardNetwork } from '../helpers/network-guard.js';

guardNetwork();

afterEach(() => {
  disposeIlostatServices();
});

type Args = Parameters<typeof getCountryProfileTool.input.parse>[0];
type Output = Awaited<ReturnType<typeof getCountryProfileTool.handler>>;
type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

const ATTRIBUTION =
  'Source: ILOSTAT, International Labour Organization (CC BY 4.0) — https://ilostat.ilo.org';
const UPSTREAM_BUSY_RECOVERY =
  'The ILOSTAT API is throttling this server; wait the retry-after interval in the error data, then call again with the same arguments.';
const UNKNOWN_AREA_RECOVERY =
  'Call ilostat_list_reference with topic ref_areas and a name filter to find the ISO3 or X-coded area code.';

const REPORTED_CODES = [
  'EAP_DWAP_SEX_AGE_RT',
  'EMP_DWAP_SEX_AGE_RT',
  'UNE_DEAP_SEX_AGE_RT',
  'EIP_NEET_SEX_RT',
  'EMP_NIFL_SEX_RT',
  'EMP_TEMP_SEX_AGE_NB',
];
const MODELLED_CODES = [
  'EAP_2WAP_SEX_AGE_RT',
  'EMP_2WAP_SEX_AGE_RT',
  'UNE_2EAP_SEX_AGE_RT',
  'EIP_2EET_SEX_RT',
  'EMP_2IFL_SEX_RT',
  'EMP_2EMP_SEX_AGE_NB',
  'LAP_2GDP_NOC_RT',
  'SDG_0111_SEX_AGE_RT',
];
const ALL_KEYS = [
  'labour_force_participation_rate',
  'employment_to_population_ratio',
  'unemployment_rate',
  'youth_unemployment_rate',
  'youth_neet_rate',
  'informal_employment_rate',
  'employment',
  'labour_income_share',
  'working_poverty_rate',
];

type Body = RawRow[] | (() => Response | Promise<Response>);

/**
 * `/data/ref_area`: the modelled call (the one carrying `timeto`) and the reported
 * call answered from their own bodies. A call with no body configured fails the test.
 */
function refAreaRoute(bodies: { modelled: Body; reported?: Body }): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => isRefAreaData(request),
    respond: (request) => {
      const body = new URL(request.url).searchParams.has('timeto')
        ? bodies.modelled
        : bodies.reported;
      if (body === undefined) throw new Error(`Unexpected /data/ref_area call: ${request.url}`);
      return typeof body === 'function' ? body() : rplumberBody(body);
    },
  };
}

/** KEN's recorded reported and modelled captures. */
const KEN_ROUTE = refAreaRoute({
  reported: refAreaRows('kenReported'),
  modelled: refAreaRows('kenModelled'),
});

function wire(options: WireOptions = {}) {
  return wireServices({
    ...options,
    fixture: options.fixture ?? observationCatalogFixture(),
    routes: options.routes ?? [KEN_ROUTE],
  });
}

async function profile(args: Args) {
  const ctx = createMockContext({ errors: getCountryProfileTool.errors });
  const result = await getCountryProfileTool.handler(getCountryProfileTool.input.parse(args), ctx);
  return { result, enrichment: getEnrichment(ctx) };
}

async function failure(args: Args): Promise<McpError> {
  try {
    await getCountryProfileTool.handler(
      getCountryProfileTool.input.parse(args),
      createMockContext({ errors: getCountryProfileTool.errors }),
    );
  } catch (error) {
    return error as McpError;
  }
  throw new Error('expected the handler to fail');
}

function render(result: Output): string {
  return (getCountryProfileTool.format?.(result) ?? [])
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
}

function contentText(result: ContractResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/** The `/data/ref_area` calls sent, as their query parameters. */
const refAreaCalls = (wired: ReturnType<typeof wire>) =>
  callUrls(wired.http, isRefAreaData).map((url) => Object.fromEntries(url.searchParams));

const R1_3513 = { code: 'R1:3513', label: 'Repository: ILO-STATISTICS - Micro data processing' };

function reported(dataset_id: string, value: number, period = '2021') {
  return {
    dataset_id,
    period,
    value,
    source: 'BX:3465',
    source_label: 'HS - Continuous household survey',
    notes: [R1_3513],
  };
}

function modelled(dataset_id: string, value: number, status: Record<string, string> = {}) {
  return {
    dataset_id,
    period: '2024',
    value,
    basis: 'modelled_estimate',
    ...status,
    edition: 'Nov. 2025',
  };
}

const KEN_AREA = {
  code: 'KEN',
  label: 'Kenya',
  kind: 'country',
  income_group: { code: 'X03', label: 'Lower-middle income' },
  region: { code: 'X06', label: 'Africa' },
  subregion: { code: 'X13', label: 'Sub-Saharan Africa' },
};

const REPORTED_MISSING_NOTICE =
  'No reported value exists for labour_income_share, working_poverty_rate; the modelled estimates shown for them are ILO model output, not national observations.';

describe('country', () => {
  it('pairs the latest reported and modelled value per headline, never filling one from the other', async () => {
    const wired = wire();
    const { result, enrichment } = await profile({ ref_area: 'KEN' });
    expect(result).toEqual({
      ref_area: KEN_AREA,
      sex: 'SEX_T',
      indicators: [
        {
          key: 'labour_force_participation_rate',
          label: 'Labour force participation rate, 15+',
          unit: '%',
          reported: reported('EAP_DWAP_SEX_AGE_RT_A', 68.698),
          modelled: modelled('EAP_2WAP_SEX_AGE_RT_A', 67.385),
        },
        {
          key: 'employment_to_population_ratio',
          label: 'Employment-to-population ratio, 15+',
          unit: '%',
          reported: reported('EMP_DWAP_SEX_AGE_RT_A', 64.861),
          modelled: modelled('EMP_2WAP_SEX_AGE_RT_A', 63.713),
        },
        {
          key: 'unemployment_rate',
          label: 'Unemployment rate, 15+',
          unit: '%',
          // the 25+ rows in the same captures are never picked
          reported: reported('UNE_DEAP_SEX_AGE_RT_A', 5.585),
          modelled: modelled('UNE_2EAP_SEX_AGE_RT_A', 5.449),
        },
        {
          key: 'youth_unemployment_rate',
          label: 'Unemployment rate, 15–24',
          unit: '%',
          reported: reported('UNE_DEAP_SEX_AGE_RT_A', 12.335),
          modelled: modelled('UNE_2EAP_SEX_AGE_RT_A', 15.246),
        },
        {
          key: 'youth_neet_rate',
          label: 'Youth NEET rate',
          unit: '%',
          reported: reported('EIP_NEET_SEX_RT_A', 18.503),
          modelled: modelled('EIP_2EET_SEX_RT_A', 19.54),
        },
        {
          key: 'informal_employment_rate',
          label: 'Informal employment rate',
          unit: '%',
          // no modelled informality estimate exists for KEN
          reported: reported('EMP_NIFL_SEX_RT_A', 86.489, '2019'),
        },
        {
          key: 'employment',
          label: 'Employment, 15+',
          unit: 'thousands',
          reported: reported('EMP_TEMP_SEX_AGE_NB_A', 19575.268),
          modelled: modelled('EMP_2EMP_SEX_AGE_NB_A', 23365.248),
        },
        {
          key: 'labour_income_share',
          label: 'Labour income share of GDP',
          unit: '%',
          modelled: modelled('LAP_2GDP_NOC_RT_A', 33.276, {
            obs_status: 'M',
            obs_status_label: 'Model-based extrapolation',
          }),
        },
        {
          key: 'working_poverty_rate',
          label: 'Working poverty rate, 15+',
          unit: '%',
          modelled: modelled('SDG_0111_SEX_AGE_RT_A', 33.058, {
            obs_status: 'A',
            obs_status_label: 'Adjusted',
          }),
        },
      ],
      reported_missing: ['labour_income_share', 'working_poverty_rate'],
      modelled_cutoff_year: 2024,
      catalog_as_of: '2026-09-26T12:00:00.000Z',
      attribution: ATTRIBUTION,
    });
    expect(enrichment).toEqual({ notice: REPORTED_MISSING_NOTICE });
    expect(refAreaCalls(wired)).toHaveLength(2);
  });

  it('sends bare indicator codes, the frequency on id, and timeto at the cutoff on the modelled call only', async () => {
    const wired = wire();
    await profile({ ref_area: 'ken' });
    const calls = refAreaCalls(wired);
    const reportedCall = calls.find((params) => !('timeto' in params));
    const modelledCall = calls.find((params) => 'timeto' in params);
    expect(reportedCall).toEqual({
      id: 'KEN_A',
      indicator: REPORTED_CODES.join('+'),
      latestyear: 'TRUE',
      format: '.json',
    });
    expect(modelledCall).toEqual({
      id: 'KEN_A',
      indicator: MODELLED_CODES.join('+'),
      timeto: '2024',
      latestyear: 'TRUE',
      format: '.json',
    });
    // upstream answers a suffixed dataset ID with an empty array, so none is ever sent
    for (const params of calls) {
      for (const code of params.indicator?.split('+') ?? []) {
        expect(code).not.toMatch(/_[AQM]$/);
      }
    }
  });

  it('sends the reported and modelled calls in parallel', async () => {
    let arrived = 0;
    let releaseBoth: () => void = () => undefined;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const barrier: FetchMockRoute = {
      method: 'GET',
      match: (request) => isRefAreaData(request),
      respond: async (request) => {
        arrived += 1;
        if (arrived === 2) releaseBoth();
        // a sequential pair would hold the first call here until the header timeout
        await both;
        return rplumberBody(
          refAreaRows(
            new URL(request.url).searchParams.has('timeto') ? 'kenModelled' : 'kenReported',
          ),
        );
      },
    };
    wire({ routes: [barrier] });
    const { result } = await profile({ ref_area: 'KEN' });
    expect(arrived).toBe(2);
    expect(result.reported_missing).toEqual(['labour_income_share', 'working_poverty_rate']);
  });

  it('slices sex locally: one cached response pair serves SEX_M and SEX_F, sexless rows unaffected', async () => {
    const wired = wire();
    await profile({ ref_area: 'KEN' });
    const male = await profile({ ref_area: 'KEN', sex: 'm' });
    const female = await profile({ ref_area: 'KEN', sex: 'female' });
    expect(refAreaCalls(wired)).toHaveLength(2);

    const valuesOf = (result: Output, key: string) => {
      const entry = result.indicators.find((indicator) => indicator.key === key);
      return [entry?.reported?.value, entry?.modelled?.value];
    };
    expect(male.result.sex).toBe('SEX_M');
    expect(valuesOf(male.result, 'unemployment_rate')).toEqual([3.831, 4.284]);
    expect(valuesOf(female.result, 'unemployment_rate')).toEqual([7.405, 6.743]);
    expect(valuesOf(male.result, 'labour_income_share')).toEqual([undefined, 33.276]);
    // World and KEN working poverty is published for SEX_T only
    expect(valuesOf(male.result, 'working_poverty_rate')).toEqual([undefined, undefined]);
    expect(male.enrichment.notice).toBe(
      `${REPORTED_MISSING_NOTICE} working_poverty_rate has no modelled estimate either.`,
    );
  });

  it('reads a blank or omitted sex as SEX_T', async () => {
    wire();
    for (const sex of ['', '   ', undefined]) {
      const { result } = await profile({ ref_area: 'KEN', ...(sex === undefined ? {} : { sex }) });
      expect(result.sex).toBe('SEX_T');
    }
  });

  it('excludes modelled rows past the cutoff, leaving the modelled slot empty', async () => {
    wire({
      routes: [
        refAreaRoute({
          reported: refAreaRows('kenReported'),
          // the verbatim capture: every modelled row is 2025, a projection under Nov. 2025
          modelled: refAreaRows('kenModelled2025'),
        }),
      ],
    });
    const { result, enrichment } = await profile({ ref_area: 'KEN' });
    expect(result.indicators.every((entry) => entry.modelled === undefined)).toBe(true);
    expect(result.indicators.find((entry) => entry.key === 'unemployment_rate')?.reported).toEqual(
      reported('UNE_DEAP_SEX_AGE_RT_A', 5.585),
    );
    expect(enrichment.notice).toBe(
      `${REPORTED_MISSING_NOTICE} labour_income_share, working_poverty_rate have no modelled estimate either.`,
    );
  });

  it('drops a headline whose dataset left the catalog, from the output and from both calls', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    fixture.indicatorToc = fixture.indicatorToc.filter((row) => row.id !== 'EMP_2IFL_SEX_RT_A');
    const wired = wire({ fixture });
    const { result } = await profile({ ref_area: 'KEN' });
    const keys = result.indicators.map((entry) => entry.key);
    expect(keys).toEqual(ALL_KEYS.filter((key) => key !== 'informal_employment_rate'));
    const codes = refAreaCalls(wired).flatMap((params) => params.indicator?.split('+') ?? []);
    expect(codes).not.toContain('EMP_2IFL_SEX_RT');
    expect(codes).not.toContain('EMP_NIFL_SEX_RT');
    expect(codes).toContain('UNE_DEAP_SEX_AGE_RT');
  });

  it('fails ServiceUnavailable before any data call when every headline dataset left the catalog', async () => {
    const fixture: CatalogFixture = observationCatalogFixture();
    fixture.indicatorToc = fixture.indicatorToc.filter(
      (row) => !MODELLED_CODES.some((code) => row.id === `${code}_A`),
    );
    const wired = wire({ fixture });
    const message =
      "None of the country profile's headline datasets is in the current ILOSTAT catalog, so no profile can be built.";
    const hint =
      'Find labour-market datasets with ilostat_search_indicators and read the area from them with ilostat_query_indicator.';
    const error = await failure({ ref_area: 'KEN' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(message);
    expect(error.data).toMatchObject({ recovery: { hint } });
    expect(refAreaCalls(wired)).toHaveLength(0);

    const result = await runToolContract(getCountryProfileTool, { ref_area: 'KEN' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, message },
    });
    const text = contentText(result);
    expect(text).toContain(message);
    expect(text).toContain(`Recovery: ${hint}`);
    expect(refAreaCalls(wired)).toHaveLength(0);
  });

  it('fails the whole profile when the reported call fails, rather than reporting every key missing', async () => {
    wire({
      routes: [
        refAreaRoute({
          reported: () => new Response('unavailable', { status: 503 }),
          modelled: refAreaRows('kenModelled'),
        }),
      ],
    });
    const error = await failure({ ref_area: 'KEN' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('fails upstream_busy when only the reported call is throttled', async () => {
    wire({
      routes: [
        refAreaRoute({
          reported: () => tooManyRequests('20'),
          modelled: refAreaRows('kenModelled'),
        }),
      ],
    });
    const error = await failure({ ref_area: 'KEN' });
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'upstream_busy',
      retryable: true,
      retryAfter: 20,
      recovery: { hint: UPSTREAM_BUSY_RECOVERY },
    });
  });
});

describe('aggregate', () => {
  it('skips the reported call: modelled values only, every key reported_missing', async () => {
    const wired = wire({ routes: [refAreaRoute({ modelled: refAreaRows('x01Modelled') })] });
    const { result, enrichment } = await profile({ ref_area: 'ilo_geo_x01' });
    expect(refAreaCalls(wired)).toEqual([
      {
        id: 'X01_A',
        indicator: MODELLED_CODES.join('+'),
        timeto: '2024',
        latestyear: 'TRUE',
        format: '.json',
      },
    ]);
    expect(result.ref_area).toEqual({ code: 'X01', label: 'World', kind: 'aggregate' });
    expect(result.reported_missing).toEqual(ALL_KEYS);
    const withModel = result.indicators.filter((entry) => entry.modelled);
    expect(withModel.map((entry) => [entry.key, entry.modelled])).toEqual([
      [
        'unemployment_rate',
        { ...modelled('UNE_2EAP_SEX_AGE_RT_A', 4.869), dataset_id: 'UNE_2EAP_SEX_AGE_RT_A' },
      ],
      ['youth_unemployment_rate', modelled('UNE_2EAP_SEX_AGE_RT_A', 12.38)],
      ['labour_income_share', modelled('LAP_2GDP_NOC_RT_A', 52.7)],
    ]);
    expect(result.indicators.every((entry) => entry.reported === undefined)).toBe(true);
    expect(enrichment.notice).toBe(
      `No reported value exists for ${ALL_KEYS.join(', ')}; the modelled estimates shown for them are ILO model output, not national observations. labour_force_participation_rate, employment_to_population_ratio, youth_neet_rate, informal_employment_rate, employment, working_poverty_rate have no modelled estimate either.`,
    );
  });
});

describe('errors', () => {
  it('logs an unknown area at notice, outages at error', () => {
    const severities = Object.fromEntries(
      (getCountryProfileTool.errors ?? []).map((entry: { reason: string; severity?: string }) => [
        entry.reason,
        entry.severity ?? 'error',
      ]),
    );
    expect(severities).toEqual({
      unknown_area: 'notice',
      upstream_busy: 'error',
      catalog_unavailable: 'error',
    });
  });

  it.each([
    ['a well-formed code the catalog lacks', 'ZZZ'],
    ['an area only the dictionary knows, with no annual data', 'ANT'],
  ])('unknown_area: %s, before any data call', async (_label, code) => {
    const wired = wire();
    const error = await failure({ ref_area: code });
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'unknown_area',
      refArea: code,
      recovery: { hint: UNKNOWN_AREA_RECOVERY },
    });
    expect(error.message).toBe(`${code} is not an ILOSTAT reference area with annual data.`);
    expect(refAreaCalls(wired)).toHaveLength(0);
  });

  it('upstream_busy: the data calls are throttled', async () => {
    wire({
      routes: [
        refAreaRoute({ reported: () => tooManyRequests(), modelled: () => tooManyRequests() }),
      ],
    });
    const error = await failure({ ref_area: 'KEN' });
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'upstream_busy',
      retryable: true,
      recovery: { hint: UPSTREAM_BUSY_RECOVERY },
    });
  });

  it('catalog_unavailable: the catalog could not be loaded', async () => {
    const wired = wire({
      routes: [
        {
          match: (request) => isRplumber(request, '/metadata/toc/indicator'),
          respond: () => new Response('unavailable', { status: 503 }),
        },
        KEN_ROUTE,
      ],
    });
    const error = await failure({ ref_area: 'KEN' });
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      reason: 'catalog_unavailable',
      retryable: true,
      recovery: { hint: CATALOG_UNAVAILABLE_RECOVERY },
    });
    expect(refAreaCalls(wired)).toHaveLength(0);
  });

  it.each([
    ['a country name', { ref_area: 'KENYA' }],
    ['a code with a line break', { ref_area: 'K\nE' }],
    ['a missing ref_area', { ref_area: undefined }],
    ['the other sex, which headlines never carry', { ref_area: 'KEN', sex: 'other' }],
    ['an unknown sex alias', { ref_area: 'KEN', sex: 'X' }],
  ])('invalid_arguments: %s fails the schema before any request', async (_label, args) => {
    const wired = wire();
    const result = await runToolContract(getCountryProfileTool, args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
    });
    expect(wired.http.calls).toHaveLength(0);
  });
});

describe('format()', () => {
  it('renders the area header, the value table, sources and notes, and the missing line', async () => {
    wire();
    const lines = render((await profile({ ref_area: 'KEN' })).result).split('\n');
    for (const line of [
      '## Kenya (KEN)',
      'Kind: country · Sex: SEX_T · Income group: Lower-middle income (X03) · Region: Africa (X06) · Subregion: Sub-Saharan Africa (X13)',
      'Modelled values through 2024 (later years are projections and are excluded).',
      '| indicator | reported | modelled | unit |',
      '| Unemployment rate, 15+ (unemployment_rate) | 5.585 (2021) | 5.449 (2024, modelled_estimate) | % |',
      '| Informal employment rate (informal_employment_rate) | 86.489 (2019) | — | % |',
      '| Employment, 15+ (employment) | 19575.268 (2021) | 23365.248 (2024, modelled_estimate) | thousands |',
      '| Labour income share of GDP (labour_income_share) | — | 33.276 (2024, modelled_estimate, M Model-based extrapolation) | % |',
      '**Sources and notes:**',
      '- unemployment_rate: reported UNE_DEAP_SEX_AGE_RT_A from BX:3465 (HS - Continuous household survey) · note R1:3513: Repository: ILO-STATISTICS - Micro data processing · modelled UNE_2EAP_SEX_AGE_RT_A (Nov. 2025 edition)',
      '- labour_income_share: modelled LAP_2GDP_NOC_RT_A (Nov. 2025 edition)',
      '**No reported value:** labour_income_share, working_poverty_rate',
      'Catalog as of 2026-09-26T12:00:00.000Z',
      ATTRIBUTION,
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('marks an indicator with neither value', async () => {
    wire({ routes: [refAreaRoute({ modelled: refAreaRows('x01Modelled') })] });
    const lines = render((await profile({ ref_area: 'X01' })).result).split('\n');
    expect(lines).toContain('## World (X01)');
    expect(lines).toContain('Kind: aggregate · Sex: SEX_T');
    expect(lines).toContain('| Employment, 15+ (employment) | — | — | thousands |');
    expect(lines).toContain('- employment: no values');
  });

  it('flattens CR/LF in the area and note labels so none escapes its line', async () => {
    const fixture = observationCatalogFixture();
    for (const row of fixture.refAreaToc) {
      if (row.ref_area === 'KEN') row['ref_area.label'] = 'Kenya\r\n# injected';
    }
    const note = fixture.dictionaries.note_source?.find((row) => row.note_source === 'R1:3513');
    if (note) note['note_source.label'] = 'Repository\n## injected';
    wire({ fixture });
    const { result } = await profile({ ref_area: 'KEN' });
    expect(result.ref_area.label).toBe('Kenya\r\n# injected');
    const lines = render(result).split('\n');
    expect(lines).toContain('## Kenya # injected (KEN)');
    expect(lines.some((line) => line.includes('note R1:3513: Repository ## injected'))).toBe(true);
    expect(lines.some((line) => line.startsWith('#') && !line.startsWith('## Kenya'))).toBe(false);
  });

  it('flattens line breaks in upstream codes, verbatim in structuredContent', async () => {
    const fixture = observationCatalogFixture();
    for (const row of fixture.refAreaToc) {
      if (row.ref_area === 'KEN') row.ilo_region = 'X06\n## r|s';
    }
    const reportedRows = refAreaRows('kenReported').map((row) =>
      row.indicator === 'UNE_DEAP_SEX_AGE_RT'
        ? { ...row, source: 'BX:3465\n## o|p', note_source: 'R1:3513\n## n|m' }
        : row,
    );
    wire({
      fixture,
      routes: [refAreaRoute({ reported: reportedRows, modelled: refAreaRows('kenModelled') })],
    });
    const result = await runToolContract(getCountryProfileTool, { ref_area: 'KEN' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output;
    expect(structured.ref_area.region?.code).toBe('X06\n## R|S');
    expect(
      structured.indicators.find((entry) => entry.key === 'unemployment_rate')?.reported,
    ).toMatchObject({ source: 'BX:3465\n## o|p', notes: [{ code: 'R1:3513\n## n|m' }] });
    const lines = contentText(result).split('\n');
    expect(lines.some((line) => line.includes('Region: Africa (X06 ## R|S)'))).toBe(true);
    expect(
      lines.some((line) =>
        line.startsWith(
          '- unemployment_rate: reported UNE_DEAP_SEX_AGE_RT_A from BX:3465 ## o|p · note R1:3513 ## n|m',
        ),
      ),
    ).toBe(true);
    expect(lines.filter((line) => /^## [a-zA-Z]\|/.test(line))).toEqual([]);
  });
});

describe('contract envelope (runToolContract)', () => {
  it('a country page validates and carries the same values on both surfaces', async () => {
    wire();
    const result = await runToolContract(getCountryProfileTool, { ref_area: 'KEN', sex: 'F' });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Output & { notice?: string };
    expect(structured.sex).toBe('SEX_F');
    expect(structured.notice).toBe(
      `${REPORTED_MISSING_NOTICE} working_poverty_rate has no modelled estimate either.`,
    );
    const text = contentText(result);
    for (const entry of structured.indicators) {
      if (entry.reported) {
        expect(text).toContain(`${entry.reported.value} (${entry.reported.period})`);
        expect(text).toContain(
          `reported ${entry.reported.dataset_id} from ${entry.reported.source}`,
        );
      }
      if (entry.modelled) {
        expect(text).toContain(
          `${entry.modelled.value} (${entry.modelled.period}, modelled_estimate`,
        );
      }
    }
    expect(text).toContain(structured.notice ?? '');
  });

  it('an aggregate page validates with no reported values', async () => {
    wire({ routes: [refAreaRoute({ modelled: refAreaRows('x01Modelled') })] });
    const result = await runToolContract(getCountryProfileTool, { ref_area: 'X01' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ref_area: { code: 'X01', kind: 'aggregate' },
      reported_missing: ALL_KEYS,
    });
    expect(contentText(result)).toContain(`**No reported value:** ${ALL_KEYS.join(', ')}`);
  });

  it('unknown_area reaches both surfaces with its reason and recovery', async () => {
    wire();
    const result = await runToolContract(getCountryProfileTool, { ref_area: 'ZZZ' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'unknown_area', recovery: { hint: UNKNOWN_AREA_RECOVERY } },
      },
    });
    const text = contentText(result);
    expect(text).toContain('ZZZ is not an ILOSTAT reference area with annual data.');
    expect(text).toContain(`Recovery: ${UNKNOWN_AREA_RECOVERY}`);
    expect(text).toContain('reason unknown_area');
  });
});
