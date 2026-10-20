'use strict';

const { wrapLine } = require('./ansi');

const DEFAULT_CHAPTER_PATTERN =
  '^\\s*(?:第\\s*[0-9零一二三四五六七八九十百千万两〇]+\\s*[章节回卷篇部集]|(?:Chapter|CHAPTER)\\s+[0-9IVXLCDM]+|序章|楔子|前言|后记|尾声|终章|番外)';

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Try to decode a buffer, falling back to GB18030 for Chinese txt files. */
function decodeBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return decodeWith(buffer.subarray(2), 'utf-16le') ?? buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return decodeWith(buffer.subarray(2), 'utf-16be') ?? buffer.toString('utf8');
  }

  const utf8 = buffer.toString('utf8');
  const replacements = countReplacements(utf8);
  if (replacements > 0) {
    const gb = decodeWith(buffer, 'gb18030');
    if (gb && countReplacements(gb) < replacements) return gb;
  }
  return utf8;
}

function decodeWith(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return undefined;
  }
}

function countReplacements(text) {
  let count = 0;
  for (const ch of text) if (ch === '\uFFFD') count += 1;
  return count;
}

function compilePattern(pattern) {
  try {
    return new RegExp(pattern || DEFAULT_CHAPTER_PATTERN);
  } catch {
    return new RegExp(DEFAULT_CHAPTER_PATTERN);
  }
}

function stripControl(text) {
  return text.replace(CONTROL_RE, '');
}

function normalizeRaw(text) {
  const withoutAnsi = String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  return stripControl(withoutAnsi.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
}

function mdInline(input) {
  let text = String(input ?? '');
  const codeSpans = [];

  text = text.replace(/`([^`]*)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => (alt ? `[图] ${alt}` : '[图片]'))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,，。！？!?:：;；]|$)/g, '$1$2')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');

  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)] ?? '');

  return text.replace(/[ \t]+$/, '');
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function renderTableRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body
    .split('|')
    .map((cell) => mdInline(cell.trim()))
    .join('  │  ');
}

function parseMarkdown(rawLines, chapters) {
  const lines = [];
  let start = 0;

  // YAML front matter is metadata, not reading material.
  if (rawLines[0] && rawLines[0].trim() === '---') {
    let closed = -1;
    let hasKey = false;
    for (let i = 1; i < Math.min(rawLines.length, 120); i += 1) {
      const value = rawLines[i].trim();
      if (value === '---' || value === '...') {
        closed = i;
        break;
      }
      if (/^[\w-]+\s*:/.test(rawLines[i])) hasKey = true;
    }
    if (closed > 0 && hasKey) start = closed + 1;
  }

  let inFence = false;

  for (let i = start; i < rawLines.length; i += 1) {
    const raw = rawLines[i].replace(/\t/g, '    ');
    const fence = /^\s*(```+|~~~+)/.exec(raw);

    if (fence) {
      inFence = !inFence;
      lines.push({ text: '', kind: 'blank' });
      continue;
    }

    if (inFence) {
      lines.push({ text: raw.trim() === '' ? '' : '  ' + raw.replace(/\s+$/, ''), kind: 'code' });
      continue;
    }

    const trimmed = raw.trim();

    if (trimmed === '') {
      lines.push({ text: '', kind: 'blank' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const level = heading[1].length;
      const title = mdInline(heading[2]).trim();
      lines.push({ text: title, kind: `h${level}` });
      if (title) chapters.push({ title, line: lines.length - 1, level });
      continue;
    }

    if (/^\s*(([-*_])\s*){3,}$/.test(raw) && !/^\s*[-*+]\s+/.test(raw)) {
      lines.push({ text: '─'.repeat(24), kind: 'hr' });
      continue;
    }

    if (/^\s*>/.test(raw)) {
      let quote = raw;
      while (/^\s*>/.test(quote)) quote = quote.replace(/^\s*>\s?/, '');
      lines.push({ text: '│ ' + mdInline(quote), kind: 'quote' });
      continue;
    }

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(raw);
    if (bullet) {
      lines.push({ text: `${bullet[1]}• ${mdInline(bullet[3])}`, kind: 'list' });
      continue;
    }

    const ordered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(raw);
    if (ordered) {
      lines.push({ text: `${ordered[1]}${ordered[2]} ${mdInline(ordered[3])}`, kind: 'list' });
      continue;
    }

    if (isTableSeparator(raw)) {
      lines.push({ text: '', kind: 'blank' });
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(raw)) {
      lines.push({ text: renderTableRow(raw), kind: 'body' });
      continue;
    }

    lines.push({ text: mdInline(raw).replace(/^\s+$/, ''), kind: 'body' });
  }

  // Drop the artificial blank line produced for each fence marker and collapse
  // the extra blank left around code blocks.
  const cleaned = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.kind === 'blank' && cleaned.length && cleaned[cleaned.length - 1].kind === 'blank') continue;
    cleaned.push(line);
  }

  return cleaned;
}

function parsePlainText(rawLines, chapters, pattern) {
  const lines = [];
  const maxHeadingLength = 80;

  for (const raw of rawLines) {
    const text = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
    const trimmed = text.trim();

    if (trimmed === '') {
      lines.push({ text: '', kind: 'blank' });
      continue;
    }

    if (trimmed.length <= maxHeadingLength && pattern.test(trimmed)) {
      lines.push({ text: trimmed, kind: 'h2' });
      chapters.push({ title: trimmed, line: lines.length - 1, level: 2 });
      continue;
    }

    lines.push({ text: text.replace(/^\s+/, (spaces) => ' '.repeat(spaces.length)), kind: 'body' });
  }

  return lines;
}

function fileStem(fileName) {
  const name = String(fileName || '未命名');
  const index = name.lastIndexOf('.');
  return index > 0 ? name.slice(0, index) : name;
}

/**
 * Turn raw file content into a document model.
 * @param {{ text: string, fileName: string, filePath?: string, chapterPattern?: string }} options
 */
function buildDocument(options) {
  const fileName = options.fileName || '未命名.txt';
  const text = normalizeRaw(options.text);
  const rawLines = text.split('\n');
  const chapters = [];
  const isMarkdown = /\.(md|markdown|mdown|mkd|mdx)$/i.test(fileName);

  const lines = isMarkdown
    ? parseMarkdown(rawLines, chapters)
    : parsePlainText(rawLines, chapters, compilePattern(options.chapterPattern));

  let title = fileStem(fileName);
  if (isMarkdown) {
    const h1 = lines.find((line) => line.kind === 'h1');
    if (h1 && h1.text.trim()) title = h1.text.trim();
  }

  const charCount = lines.reduce((sum, line) => sum + line.text.length, 0);

  return new ReaderDocument({
    title,
    fileName,
    filePath: options.filePath || '',
    lines,
    chapters,
    isMarkdown,
    charCount,
  });
}

class ReaderDocument {
  constructor({ title, fileName, filePath, lines, chapters, isMarkdown, charCount }) {
    this.title = title;
    this.fileName = fileName;
    this.filePath = filePath;
    this.lines = lines;
    this.chapters = chapters;
    this.isMarkdown = isMarkdown;
    this.charCount = charCount;
    this._visuals = [];
    this._visualWidth = 0;
  }

  get lineCount() {
    return this.lines.length;
  }

  /** Build (and cache) wrapped display lines for a terminal width. */
  wrap(width) {
    const columns = Math.max(10, Math.floor(width));
    if (this._visualWidth === columns && this._visuals.length) return this._visuals;

    const visuals = [];
    for (let lineIndex = 0; lineIndex < this.lines.length; lineIndex += 1) {
      const { text, kind } = this.lines[lineIndex];
      const parts = text === '' ? [''] : wrapLine(text, columns);
      for (let part = 0; part < parts.length; part += 1) {
        visuals.push({ text: parts[part], line: lineIndex, part, kind });
      }
    }

    this._visuals = visuals;
    this._visualWidth = columns;
    return visuals;
  }

  get visuals() {
    return this._visuals;
  }

  /** Visual row showing a given source line, optionally a wrapped part. */
  findVisualIndex(lineIndex, part = 0) {
    const visuals = this._visuals;
    if (!visuals.length) return 0;

    let low = 0;
    let high = visuals.length - 1;
    let found = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (visuals[mid].line >= lineIndex) {
        found = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    if (found === -1) return visuals.length - 1;
    if (visuals[found].line !== lineIndex) return found;

    let index = found;
    while (
      index + 1 < visuals.length &&
      visuals[index + 1].line === lineIndex &&
      visuals[index].part < part
    ) {
      index += 1;
    }
    return index;
  }

  /** Index of the chapter containing a source line, or -1. */
  chapterIndexForLine(lineIndex) {
    const chapters = this.chapters;
    if (!chapters.length) return -1;

    let low = 0;
    let high = chapters.length - 1;
    let answer = -1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (chapters[mid].line <= lineIndex) {
        answer = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return answer;
  }
}

module.exports = {
  DEFAULT_CHAPTER_PATTERN,
  buildDocument,
  decodeBuffer,
  ReaderDocument,
  mdInline,
};
