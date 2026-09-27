/**
 * @fileoverview Text handling for the catalog: the search/filter normalization,
 * word-prefix term matching, the line-break class and inline flattening for
 * markdown slots, the indicator-definition HTML stripper, and the upstream
 * timestamp conversion. Pure functions.
 * @module services/catalog/text
 */

/**
 * Lowercase, diacritics stripped, punctuation to space, `labor…` spelled `labour…`
 * so British and American spellings match alike.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\blabor/g, 'labour')
    .trim();
}

/** Normalized words of `text`, deduplicated. */
export function wordsOf(...texts: (string | undefined)[]): string[] {
  const words = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const word of normalizeText(text).split(' ')) {
      if (word) words.add(word);
    }
  }
  return [...words];
}

/**
 * One line break: CRLF, or a single CR, LF, NEL (U+0085), LS (U+2028), or PS
 * (U+2029). Global, so use it only with `replace` and `split`, which ignore
 * `lastIndex`.
 */
export const LINE_BREAK = /\r\n|[\r\n\u0085\u2028\u2029]/g;

/**
 * ILO-published or caller text for an inline markdown slot (heading, label, list
 * item, table cell, quoted echo): each run of the {@link LINE_BREAK} terminators
 * flattened to one space, so the text cannot open a new block.
 */
export function inlineText(text: string): string {
  return text.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ');
}

/**
 * True when `term` is a word or word prefix of one of `words`. A trailing plural
 * `s` is tolerated, so `workers` still matches the word `worker`.
 */
function termMatches(term: string, words: readonly string[]): boolean {
  const singular = term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : undefined;
  return words.some(
    (word) => word.startsWith(term) || (singular !== undefined && word.startsWith(singular)),
  );
}

/** True when every term matches a word or word prefix of `words`. */
export function matchesAllTerms(terms: readonly string[], words: readonly string[]): boolean {
  return terms.every((term) => termMatches(term, words));
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
};

/**
 * Plain text from an indicator dictionary description. The upstream HTML uses a
 * handful of tags, some of them entity-escaped (`&lt;a href = "…"&gt;`): links
 * become `text (url)`; `<strong>`, `<i>`, `<p>`, and `<br>` are dropped; the
 * remaining entities are decoded.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(
      /<a\s+href\s*=\s*["']([^"']*)["'][^>]*>(.*?)<\/a\s*>/gis,
      (_match, url: string, text: string) => (text.trim() ? `${text.trim()} (${url})` : url),
    )
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(?:strong|i|p)\s*>/gi, ' ')
    .replace(/&(?:nbsp|ndash|amp|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:])/g, '$1')
    .trim();
}

/**
 * Upstream `dd/mm/yyyy HH:MM:SS` as ISO 8601 without a zone offset (upstream
 * publishes none). Returns the input unchanged when it does not have that shape.
 */
export function toIsoTimestamp(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return value;
  const [, day, month, year, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}
