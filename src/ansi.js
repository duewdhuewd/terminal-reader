'use strict';

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Remove ANSI escape sequences. */
function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

/** Terminal display width of a single code point (CJK and emoji take 2 cells). */
function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (cp >= 0x200b && cp <= 0x200f) return 0; // zero width spaces
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0; // variation selectors
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK radicals / kana / hanzi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extension planes
  ) {
    return 2;
  }
  return 1;
}

function charWidth(ch) {
  return codePointWidth(ch.codePointAt(0));
}

/** Visible width of a string, ignoring ANSI sequences. */
function stringWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const ch of plain) width += codePointWidth(ch.codePointAt(0));
  return width;
}

let segmenter;

function graphemes(text) {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    if (!segmenter) segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }
  return Array.from(text);
}

/**
 * Wrap one logical line to `width` terminal cells.
 * Breaks on spaces when possible, otherwise between graphemes (CJK friendly).
 */
function wrapLine(text, width) {
  const limit = Math.max(1, Math.floor(width));
  const source = String(text ?? '').replace(/\t/g, '    ').replace(/[\r\n]/g, ' ');
  if (source === '') return [''];

  const chars = graphemes(source);
  if (!chars.length) return [''];

  const result = [];
  let start = 0;

  while (start < chars.length) {
    let cells = 0;
    let end = start;
    let lastSpace = -1;

    while (end < chars.length) {
      const w = charWidth(chars[end]);
      if (w === 0) {
        end += 1;
        continue;
      }
      if (cells + w > limit) break;
      if (chars[end] === ' ' || chars[end] === '\u3000') lastSpace = end;
      cells += w;
      end += 1;
    }

    if (end === start) {
      // A single grapheme wider than the terminal.
      result.push(chars[start]);
      start += 1;
      continue;
    }

    if (end < chars.length && lastSpace > start) {
      result.push(chars.slice(start, lastSpace).join('').replace(/\s+$/, ''));
      start = lastSpace + 1;
    } else {
      result.push(chars.slice(start, end).join('').replace(/\s+$/, ''));
      start = end;
    }
  }

  return result.length ? result : [''];
}

/** Cut a plain (or ANSI) string to at most `width` visible cells. */
function truncate(text, width, ellipsis = '…') {
  const limit = Math.max(0, Math.floor(width));
  if (stringWidth(text) <= limit) return text;

  const ellipsisWidth = stringWidth(ellipsis);
  const budget = Math.max(0, limit - ellipsisWidth);
  let out = '';
  let used = 0;
  for (const ch of stripAnsi(text)) {
    const w = codePointWidth(ch.codePointAt(0));
    if (used + w > budget) break;
    used += w;
    out += ch;
  }
  return out + ellipsis;
}

/** Pad with spaces to exactly `width` visible cells (truncating if needed). */
function fitText(text, width) {
  const plain = text == null ? '' : String(text);
  const cut = truncate(plain, width);
  const pad = Math.max(0, Math.floor(width) - stringWidth(cut));
  return cut + ' '.repeat(pad);
}

/** Reverse-video line, exactly one terminal row wide. */
function inverseLine(text, width) {
  return '\x1b[7m' + fitText(text, width) + '\x1b[0m';
}

/**
 * Wrap `query` occurrences in `text` with a highlight background.
 * `base` is the ANSI style of the line and is re-applied after each hit.
 */
function highlightText(text, query, base = '') {
  if (!query) return base + text + '\x1b[0m';

  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  let index = lower.indexOf(needle, from);
  if (index === -1) return base + text + '\x1b[0m';

  let out = base;
  let cursor = 0;
  while (index !== -1) {
    out += text.slice(cursor, index);
    out += '\x1b[0m\x1b[43;30m' + text.slice(index, index + needle.length) + '\x1b[0m' + base;
    cursor = index + needle.length;
    from = cursor;
    index = lower.indexOf(needle, from);
  }
  out += text.slice(cursor);
  return out + '\x1b[0m';
}

module.exports = {
  codePointWidth,
  charWidth,
  stringWidth,
  wrapLine,
  truncate,
  fitText,
  inverseLine,
  highlightText,
  stripAnsi,
  graphemes,
};
