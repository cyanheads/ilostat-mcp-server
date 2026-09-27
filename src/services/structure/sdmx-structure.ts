/**
 * @fileoverview Reads an ILOSTAT SDMX-JSON dataflow structure into what describe
 * needs. Breakdown slots come from the dimension order — dimensions after
 * `MEASURE`, in position order and excluding `SEX`, become `classif1` then
 * `classif2`, because the ToC's classification names do not always match the
 * codes (`QTL` datasets use `DCL_*`). Codes in use come from the content
 * constraint; a dimension the constraint omits falls back to the partial
 * codelist, which `detail=referencepartial` already limits to codes in use.
 * Classification group headers — codes that are another code's `parent` — are
 * dropped, while parentless leaves (deciles) stay. The default slice takes, per
 * dimension ID, the first code the dataflow's `DEFAULT` annotation lists that is
 * a total; that annotation is keyed by dimension ID, not dimension order. Covered
 * areas keep only plain SDMX codes, since each may become a probe-key segment. Pure.
 * @module services/structure/sdmx-structure
 */

import { z } from '@cyanheads/mcp-ts-core';
import { toIsoTimestamp } from '@/services/catalog/text.js';

const AnnotationSchema = z.object({
  title: z.string().optional(),
  type: z.string().optional(),
});

const CodeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  parent: z.string().optional(),
  annotations: z.array(AnnotationSchema).optional(),
});

const ComponentSchema = z.object({
  id: z.string(),
  position: z.number().optional(),
  localRepresentation: z.object({ enumeration: z.string().optional() }).optional(),
});

const StructureDocumentSchema = z.object({
  data: z.object({
    dataflows: z
      .array(z.object({ version: z.string(), annotations: z.array(AnnotationSchema).optional() }))
      .min(1),
    dataStructures: z
      .array(
        z.object({
          dataStructureComponents: z.object({
            dimensionList: z.object({ dimensions: z.array(ComponentSchema) }),
            attributeList: z.object({ attributes: z.array(ComponentSchema) }).optional(),
          }),
        }),
      )
      .min(1),
    codelists: z
      .array(z.object({ id: z.string(), codes: z.array(CodeSchema).optional() }))
      .optional(),
    contentConstraints: z
      .array(
        z.object({
          cubeRegions: z
            .array(
              z.object({
                isIncluded: z.boolean().optional(),
                keyValues: z
                  .array(z.object({ id: z.string(), values: z.array(z.string()).optional() }))
                  .optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
});

type SdmxCode = z.infer<typeof CodeSchema>;
type SdmxComponent = z.infer<typeof ComponentSchema>;

export interface BreakdownCode {
  code: string;
  isTotal: boolean;
}

export interface BreakdownDimension {
  codes: BreakdownCode[];
  /** SDMX dimension ID (`AGE`, `INS`, `DCL`) — the classification type. */
  id: string;
}

/** Code → name maps for the three unit attributes. */
export interface UnitCodelists {
  measure: Map<string, string>;
  multiplier: Map<string, string>;
  type: Map<string, string>;
}

export interface IndicatorStructure {
  classif1?: BreakdownDimension;
  classif2?: BreakdownDimension;
  /** Total codes the dataflow's default view uses, per slot. */
  defaultSlice: { classif1?: string; classif2?: string; sex?: string };
  /** Dimension IDs in key order (time excluded), for building a series key. */
  keyDimensions: string[];
  /** `LAST_UPDATE` annotation, ISO 8601 without zone. */
  lastUpdate?: string;
  /** Reference areas with data, from the content constraint; only codes matching `[A-Z0-9_]+`. */
  refAreas: string[];
  /** Sex codes in use; absent when the dataflow has no `SEX` dimension. */
  sexCodes?: string[];
  unitCodelists: UnitCodelists;
  /** Dataflow version, for data-probe URLs. */
  version: string;
}

/** Decoded unit attributes of one dataset. Values are already in the multiplier's scale. */
export interface UnitInfo {
  measure: string;
  measureLabel?: string;
  multiplier: number;
  multiplierLabel?: string;
  type: string;
  typeLabel?: string;
}

const NON_BREAKDOWN_DIMENSIONS = new Set(['REF_AREA', 'FREQ', 'MEASURE', 'SEX']);

/** An area code a probe key may carry; anything else is left out of `refAreas`. */
const AREA_CODE = /^[A-Z0-9_]+$/;

function annotation(annotations: z.infer<typeof AnnotationSchema>[] | undefined, type: string) {
  return annotations?.find((entry) => entry.type === type)?.title;
}

const isTotalCode = (code: SdmxCode | undefined): boolean =>
  annotation(code?.annotations, 'IS_TOTAL') === 'Y';

/** `urn:…Codelist=ILO:CL_AGE(1.0)` → `CL_AGE`. */
function codelistId(enumeration: string | undefined): string | undefined {
  return enumeration ? /Codelist=[^:]+:([^()]+)\(/.exec(enumeration)?.[1] : undefined;
}

/** `FREQ=A,endPeriod=…,AGE=A+B,SEX=SEX_T` → dimension ID → listed codes. */
function parseDefault(title: string | undefined): Map<string, string[]> {
  const defaults = new Map<string, string[]>();
  for (const part of (title ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    defaults.set(
      part.slice(0, eq).trim(),
      part
        .slice(eq + 1)
        .split('+')
        .map((code) => code.trim()),
    );
  }
  return defaults;
}

/**
 * The structure an SDMX-JSON dataflow document describes.
 *
 * @throws ZodError when the document lacks the parts read here.
 */
export function parseStructure(document: unknown): IndicatorStructure {
  const { data } = StructureDocumentSchema.parse(document);
  const [dataflow] = data.dataflows;
  const [dsd] = data.dataStructures;
  if (!dataflow || !dsd) throw new Error('Structure document holds no dataflow or data structure.');

  const codelists = new Map((data.codelists ?? []).map((list) => [list.id, list.codes ?? []]));
  const constraint = new Map<string, string[]>();
  for (const cc of data.contentConstraints ?? []) {
    for (const region of cc.cubeRegions ?? []) {
      if (region.isIncluded === false) continue;
      for (const keyValue of region.keyValues ?? []) {
        constraint.set(keyValue.id, keyValue.values ?? []);
      }
    }
  }

  const dimensions = dsd.dataStructureComponents.dimensionList.dimensions.toSorted(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  /** The codelist a dimension or attribute enumerates; empty when it names none. */
  const codesOf = (component: SdmxComponent | undefined): SdmxCode[] =>
    codelists.get(codelistId(component?.localRepresentation?.enumeration) ?? '') ?? [];

  /** Codes in use for a dimension, group headers dropped, in constraint (else codelist) order. */
  const usedCodes = (dimension: SdmxComponent): { byId: Map<string, SdmxCode>; ids: string[] } => {
    const codes = codesOf(dimension);
    const byId = new Map(codes.map((code) => [code.id, code]));
    const headers = new Set(codes.flatMap((code) => (code.parent ? [code.parent] : [])));
    const ids = (constraint.get(dimension.id) ?? codes.map((code) => code.id)).filter(
      (id) => !headers.has(id),
    );
    return { byId, ids };
  };

  const defaults = parseDefault(annotation(dataflow.annotations, 'DEFAULT'));
  const defaultTotal = (dimensionId: string, inUse: string[], byId: Map<string, SdmxCode>) =>
    defaults.get(dimensionId)?.find((code) => inUse.includes(code) && isTotalCode(byId.get(code)));

  const breakdowns: BreakdownDimension[] = [];
  const defaultSlice: IndicatorStructure['defaultSlice'] = {};
  let sexCodes: string[] | undefined;
  for (const dimension of dimensions) {
    if (dimension.id === 'SEX') {
      const { byId, ids } = usedCodes(dimension);
      sexCodes = ids;
      const total = defaultTotal('SEX', ids, byId);
      if (total) defaultSlice.sex = total;
      continue;
    }
    if (NON_BREAKDOWN_DIMENSIONS.has(dimension.id) || breakdowns.length >= 2) continue;
    const { byId, ids } = usedCodes(dimension);
    const slot = breakdowns.length === 0 ? 'classif1' : 'classif2';
    breakdowns.push({
      id: dimension.id,
      codes: ids.map((id) => ({ code: id, isTotal: isTotalCode(byId.get(id)) })),
    });
    const total = defaultTotal(dimension.id, ids, byId);
    if (total) defaultSlice[slot] = total;
  }

  const refAreas = (
    constraint.get('REF_AREA') ??
    codesOf(dimensions.find((dimension) => dimension.id === 'REF_AREA')).map((code) => code.id)
  ).filter((area) => AREA_CODE.test(area));

  const attributes = dsd.dataStructureComponents.attributeList?.attributes ?? [];
  const attributeCodes = (id: string): Map<string, string> => {
    const codes = codesOf(attributes.find((entry) => entry.id === id));
    return new Map(codes.map((code) => [code.id, code.name ?? code.id]));
  };

  const lastUpdate = annotation(dataflow.annotations, 'LAST_UPDATE');
  const [classif1, classif2] = breakdowns;
  return {
    version: dataflow.version,
    ...(lastUpdate ? { lastUpdate: toIsoTimestamp(lastUpdate) } : {}),
    keyDimensions: dimensions.map((dimension) => dimension.id),
    ...(sexCodes ? { sexCodes } : {}),
    ...(classif1 ? { classif1 } : {}),
    ...(classif2 ? { classif2 } : {}),
    defaultSlice,
    refAreas,
    unitCodelists: {
      type: attributeCodes('UNIT_MEASURE_TYPE'),
      measure: attributeCodes('UNIT_MEASURE'),
      multiplier: attributeCodes('UNIT_MULT'),
    },
  };
}

/** Series key selecting one area with every other dimension wildcarded (`USA....`). */
export function probeKey(structure: IndicatorStructure, area: string): string {
  return structure.keyDimensions.map((id) => (id === 'REF_AREA' ? area : '')).join('.');
}

/** Unit attributes from a probed SDMX-CSV series row; `undefined` when the row carries none. */
export function unitFromRow(
  row: Record<string, string>,
  codelists: UnitCodelists,
): UnitInfo | undefined {
  const type = row.UNIT_MEASURE_TYPE?.trim();
  const measure = row.UNIT_MEASURE?.trim();
  const multiplierCode = row.UNIT_MULT?.trim();
  if (!type || !measure || !multiplierCode || !/^\d+$/.test(multiplierCode)) return;
  const typeLabel = codelists.type.get(type);
  const measureLabel = codelists.measure.get(measure);
  const multiplierLabel = codelists.multiplier.get(multiplierCode);
  return {
    measure,
    ...(measureLabel ? { measureLabel } : {}),
    type,
    ...(typeLabel ? { typeLabel } : {}),
    multiplier: Number(multiplierCode),
    ...(multiplierLabel ? { multiplierLabel } : {}),
  };
}
