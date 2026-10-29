/**
 * @fileoverview Reads `content[]` text back the way a CommonMark parse does for
 * inline text outside code spans. Framework-rendered error and trailer lines
 * escape Markdown-active characters (`escapeMarkdownInline`), so a test
 * asserting what a reader sees decodes them rather than matching the escapes.
 * @module tests/helpers/markdown-text
 */

/**
 * CommonMark's inline decoding: a backslash before ASCII punctuation yields that
 * character, and a numeric character reference yields its code point. One pass,
 * so a decoded backslash never starts a second escape.
 */
export function readMarkdown(text: string): string {
  return text.replace(
    /\\([!-/:-@[-`{-~])|&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g,
    (_match, escaped?: string, decimal?: string, hex?: string) =>
      escaped ?? String.fromCodePoint(decimal ? Number(decimal) : Number.parseInt(`${hex}`, 16)),
  );
}
