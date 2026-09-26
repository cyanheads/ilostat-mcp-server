/**
 * @fileoverview Tests for the catalog text helpers: search/filter normalization,
 * word-prefix term matching, CR/LF flattening for inline markdown slots, the
 * indicator-definition HTML stripper, and the upstream timestamp conversion.
 * @module tests/services/catalog/text.test
 */

import { describe, expect, it } from 'vitest';
import {
  htmlToText,
  inlineText,
  matchesAllTerms,
  normalizeText,
  toIsoTimestamp,
  wordsOf,
} from '@/services/catalog/text.js';
import { guardNetwork } from '../../helpers/network-guard.js';

guardNetwork();

describe('normalizeText', () => {
  it('lowercases, strips diacritics, and turns punctuation into spaces', () => {
    expect(normalizeText('  Côte-d’Ivoire: Employment (15+)  ')).toBe(
      'cote d ivoire employment 15',
    );
  });

  it('spells labor… as labour… so British and American spellings meet', () => {
    expect(normalizeText('Labor force, laborers')).toBe('labour force labourers');
    expect(normalizeText('Labour force')).toBe('labour force');
  });
});

describe('wordsOf', () => {
  it('splits every text into distinct normalized words and skips missing ones', () => {
    expect(wordsOf('Unemployment rate', undefined, 'UNE_DEAP_SEX_AGE_RT', 'rate')).toEqual([
      'unemployment',
      'rate',
      'une',
      'deap',
      'sex',
      'age',
      'rt',
    ]);
  });
});

describe('matchesAllTerms', () => {
  const words = wordsOf('Unemployment rate by sex and age (%)');

  it('matches a term that is a word or a word prefix', () => {
    expect(matchesAllTerms(['unemployment'], words)).toBe(true);
    expect(matchesAllTerms(['unemp', 'rat'], words)).toBe(true);
  });

  it('tolerates a trailing plural s on a term longer than three letters', () => {
    expect(matchesAllTerms(['rates'], words)).toBe(true);
    expect(matchesAllTerms(['ages'], words)).toBe(true);
  });

  it('requires every term to match', () => {
    expect(matchesAllTerms(['unemployment', 'youth'], words)).toBe(false);
  });

  it('does not match a term inside a word', () => {
    expect(matchesAllTerms(['employment'], words)).toBe(false);
  });
});

describe('inlineText', () => {
  it('flattens CR, LF, and CRLF runs to one space', () => {
    expect(inlineText('Line one\r\nLine two\nLine three\rend')).toBe(
      'Line one Line two Line three end',
    );
  });
});

describe('htmlToText', () => {
  it('keeps link text with its URL and drops emphasis and paragraph tags', () => {
    expect(
      htmlToText(
        '<strong>Comparable. </strong>See the <a href = "https://ilostat.ilo.org/x/">LFS description</a>.</p>',
      ),
    ).toBe('Comparable. See the LFS description (https://ilostat.ilo.org/x/).');
  });

  it('decodes entity-escaped anchors before stripping tags', () => {
    expect(
      htmlToText(
        'Refer to the &lt;a href = "https://ilostat.ilo.org/lfs/"&gt;LFS description&lt;/a&gt;.</p>',
      ),
    ).toBe('Refer to the LFS description (https://ilostat.ilo.org/lfs/).');
  });

  it('decodes the entities the dictionary uses and drops line-break tags', () => {
    expect(htmlToText('<p>A&nbsp;&ndash; B<br/>C &amp; D&quot;E&#39;<i>F</i></p>')).toBe(
      'A – B C & D"E\' F',
    );
  });

  it('keeps a bare URL when the anchor has no text', () => {
    expect(htmlToText('<a href="https://ilostat.ilo.org/">  </a>')).toBe(
      'https://ilostat.ilo.org/',
    );
  });
});

describe('toIsoTimestamp', () => {
  it('converts dd/mm/yyyy HH:MM:SS to ISO 8601 without a zone offset', () => {
    expect(toIsoTimestamp('24/09/2026 07:10:19')).toBe('2026-09-24T07:10:19');
  });

  it('returns a value of any other shape unchanged', () => {
    expect(toIsoTimestamp('2026-09-24')).toBe('2026-09-24');
  });
});
