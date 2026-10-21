'use strict';

const vscode = require('vscode');
const { fitText, inverseLine, stringWidth, truncate, highlightText } = require('./ansi');
const { parseKeys } = require('./keys');

const STYLES = {
  h1: '\x1b[1;96m',
  h2: '\x1b[1;36m',
  h3: '\x1b[1;33m',
  h4: '\x1b[1m',
  h5: '\x1b[1m',
  h6: '\x1b[1m',
  code: '\x1b[90m',
  quote: '\x1b[32m',
  hr: '\x1b[2m',
};

const HELP_LINES = [
  ['  阅读操作', 'h1'],
  ['', ''],
  ['  空格 / PageDown / f      下一页', ''],
  ['  b / PageUp                上一页', ''],
  ['  ↓ / j                     向下滚动一行', ''],
  ['  ↑ / k                     向上滚动一行', ''],
  ['  Home / End                跳到开头 / 结尾', ''],
  ['  g                         跳转到指定页', ''],
  ['  [ / ]                     上一章 / 下一章', ''],
  ['', ''],
  ['  查找', 'h3'],
  ['', ''],
  ['  /                         搜索文本', ''],
  ['  n / N                     下一个 / 上一个匹配', ''],
  ['  Esc                       清除搜索', ''],
  ['', ''],
  ['  其他', 'h3'],
  ['', ''],
  ['  t                         打开目录', ''],
  ['  r                         重新加载文件', ''],
  ['  ?                         显示 / 关闭帮助', ''],
  ['  q / Ctrl+C                退出阅读器', ''],
  ['', ''],
  ['  提示：阅读位置会自动保存；调整窗口大小后排版会重新计算。', 'code'],
];

const TOC_HELP = '↑/↓ 选择 · Enter / 鼠标点击跳转 · Esc 返回';

class ReaderSession {
  constructor(options) {
    this.doc = options.doc;
    this.saveState = options.saveState || (() => {});
    this.reloadCallback = options.reload || null;
    this.initialPosition = options.initialPosition || null;
    this.mouseWheel = options.mouseWheel !== false;

    this.columns = 80;
    this.rows = 24;
    this.top = 0;
    this.mode = 'normal'; // normal | input | toc | help
    this.inputKind = null; // search | goto
    this.input = '';
    this.searchQuery = '';
    this.matches = [];
    this.message = '';
    this.tocIndex = 0;
    this.tocTop = 0;
    this.helpTop = 0;

    this._opened = false;
    this._closed = false;
    this._pty = null;
    this._writeEmitter = new vscode.EventEmitter();
    this._closeEmitter = new vscode.EventEmitter();
  }

  get pty() {
    if (!this._pty) {
      this._pty = {
        onDidWrite: this._writeEmitter.event,
        onDidClose: this._closeEmitter.event,
        open: (dimensions) => this.open(dimensions),
        close: () => this.close(),
        handleInput: (data) => this.handleInput(data),
        setDimensions: (dimensions) => this.resize(dimensions),
      };
    }
    return this._pty;
  }

  // ---------------------------------------------------------------- lifecycle

  open(dimensions) {
    if (this._closed) return;
    this.applyDimensions(dimensions);
    this.doc.wrap(this.columns);
    this.top = this.initialPosition ? this.topForPosition(this.initialPosition) : 0;
    this.initialPosition = null;
    this._opened = true;
    if (this.mouseWheel) this._writeEmitter.fire('\x1b[?1000h\x1b[?1006h');
    this.recomputeMatches();
    this.render();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._opened) this._writeEmitter.fire('\x1b[?1006l\x1b[?1000l\x1b[?25h');
    this.savePosition();
    this._closeEmitter.fire();
  }

  dispose() {
    if (!this._closed) this.close();
    this._writeEmitter.dispose();
    this._closeEmitter.dispose();
  }

  resize(dimensions) {
    if (!this._opened || this._closed) return;
    const anchor = this.currentPosition();
    this.applyDimensions(dimensions);
    this.doc.wrap(this.columns);
    this.top = this.topForPosition(anchor);
    this.recomputeMatches();
    this.render();
  }

  applyDimensions(dimensions) {
    const columns = Number(dimensions && dimensions.columns) || 80;
    const rows = Number(dimensions && dimensions.rows) || 24;
    this.columns = Math.max(20, Math.floor(columns));
    this.rows = Math.max(4, Math.floor(rows));
  }

  // ------------------------------------------------------------------- input

  handleInput(data) {
    if (this._closed) return;
    for (const key of parseKeys(data)) {
      if (this._closed) return;
      try {
        this.handleKey(key);
      } catch (error) {
        console.error('[terminal-reader]', error);
        this.message = `操作失败：${error && error.message ? error.message : error}`;
      }
    }
    if (!this._closed) this.render();
  }

  handleKey(key) {
    if (this.mode === 'input') return this.handleInputKey(key);
    if (this.mode === 'toc') return this.handleTocKey(key);
    if (this.mode === 'help') return this.handleHelpKey(key);
    return this.handleNormalKey(key);
  }

  handleNormalKey(key) {
    const name = key.name;
    const char = key.char;
    this.message = '';

    if (name === 'ctrl-c' || name === 'ctrl-d' || char === 'q' || char === 'Q') {
      this.close();
      return undefined;
    }

    if (name === 'escape') {
      if (this.searchQuery) {
        this.searchQuery = '';
        this.matches = [];
      }
      return undefined;
    }

    if (name === 'wheelup') {
      this.scrollBy(-3);
      return undefined;
    }
    if (name === 'wheeldown') {
      this.scrollBy(3);
      return undefined;
    }

    if (name === 'pagedown' || char === ' ' || char === 'f') {
      this.turnPage(1);
      return undefined;
    }
    if (name === 'pageup' || char === 'b') {
      this.turnPage(-1);
      return undefined;
    }
    if (name === 'down' || char === 'j') {
      this.scrollBy(1);
      return undefined;
    }
    if (name === 'up' || char === 'k') {
      this.scrollBy(-1);
      return undefined;
    }
    if (name === 'home') {
      this.top = 0;
      this.savePosition();
      return undefined;
    }
    if (name === 'end' || char === 'G') {
      this.top = this.lastPageStart();
      this.savePosition();
      return undefined;
    }

    if (char === 'g') return this.openInput('goto');
    if (char === '/') return this.openInput('search');
    if (char === 't') return this.openToc();
    if (char === '?') {
      this.helpTop = 0;
      this.mode = 'help';
      return undefined;
    }
    if (char === 'n') return this.jumpSearch(1);
    if (char === 'N') return this.jumpSearch(-1);
    if (char === ']') return this.jumpChapter(1);
    if (char === '[') return this.jumpChapter(-1);
    if (char === 'r') return this.reload();

    return undefined;
  }

  handleInputKey(key) {
    if (key.name === 'escape') {
      this.mode = 'normal';
      this.input = '';
      this.inputKind = null;
      return;
    }
    if (key.name === 'enter') {
      const kind = this.inputKind;
      const value = this.input;
      this.mode = 'normal';
      this.input = '';
      this.inputKind = null;
      if (kind === 'goto') this.commitGoto(value);
      if (kind === 'search') this.commitSearch(value);
      return;
    }
    if (key.name === 'backspace') {
      const chars = Array.from(this.input);
      chars.pop();
      this.input = chars.join('');
      return;
    }
    if (key.name === 'ctrl-u') {
      this.input = '';
      return;
    }
    if (key.char) {
      if (this.inputKind === 'goto' && !/^[0-9]$/.test(key.char)) return;
      if (this.input.length < 120) this.input += key.char;
    }
  }

  handleTocKey(key) {
    const name = key.name;
    const char = key.char;
    const count = this.doc.chapters.length;

    if (name === 'escape' || char === 'q' || char === 't') {
      this.mode = 'normal';
      return;
    }
    if (!count) return;

    if (name === 'down' || char === 'j' || name === 'wheeldown') {
      this.tocIndex = Math.min(count - 1, this.tocIndex + (name === 'wheeldown' ? 3 : 1));
      return;
    }
    if (name === 'up' || char === 'k' || name === 'wheelup') {
      this.tocIndex = Math.max(0, this.tocIndex - (name === 'wheelup' ? 3 : 1));
      return;
    }
    if (name === 'pagedown' || char === ' ' || char === 'f') {
      this.tocIndex = Math.min(count - 1, this.tocIndex + this.tocPageSize());
      return;
    }
    if (name === 'pageup' || char === 'b') {
      this.tocIndex = Math.max(0, this.tocIndex - this.tocPageSize());
      return;
    }
    if (name === 'home') {
      this.tocIndex = 0;
      return;
    }
    if (name === 'end') {
      this.tocIndex = count - 1;
      return;
    }
    if (name === 'enter') {
      const chapter = this.doc.chapters[this.tocIndex];
      this.mode = 'normal';
      if (chapter) this.jumpToLine(chapter.line);
      return;
    }
    if (name === 'click') {
      const index = this.tocIndexForRow(key.row);
      if (index === null) return;
      this.tocIndex = index;
      this.mode = 'normal';
      this.jumpToLine(this.doc.chapters[index].line);
    }
  }

  tocVisibleRows() {
    return Math.max(1, this.bodyRows() - 2);
  }

  tocStart() {
    const count = this.doc.chapters.length;
    const visibleRows = this.tocVisibleRows();
    let start = this.tocTop;
    if (this.tocIndex < start) start = this.tocIndex;
    if (this.tocIndex >= start + visibleRows) start = this.tocIndex - visibleRows + 1;
    return Math.max(0, Math.min(start, Math.max(0, count - visibleRows)));
  }

  // Terminal coordinates are 1-based; rows 1-2 are the TOC header.
  tocIndexForRow(row) {
    const offset = Number(row) - 3;
    if (!Number.isFinite(offset) || offset < 0) return null;
    const visibleRows = this.tocVisibleRows();
    if (offset >= visibleRows) return null;
    const index = this.tocStart() + offset;
    return index >= 0 && index < this.doc.chapters.length ? index : null;
  }

  handleHelpKey(key) {
    const name = key.name;
    const char = key.char;

    if (name === 'escape' || name === 'enter' || char === 'q' || char === '?' || char === 'Q') {
      this.mode = 'normal';
      return;
    }

    const maxTop = Math.max(0, HELP_LINES.length - this.bodyRows());
    if (name === 'down' || char === 'j') this.helpTop = Math.min(maxTop, this.helpTop + 1);
    if (name === 'up' || char === 'k') this.helpTop = Math.max(0, this.helpTop - 1);
    if (name === 'wheeldown') this.helpTop = Math.min(maxTop, this.helpTop + 3);
    if (name === 'wheelup') this.helpTop = Math.max(0, this.helpTop - 3);
    if (name === 'pagedown' || char === ' ' || char === 'f') {
      this.helpTop = Math.min(maxTop, this.helpTop + this.bodyRows());
    }
    if (name === 'pageup' || char === 'b') {
      this.helpTop = Math.max(0, this.helpTop - this.bodyRows());
    }
    if (name === 'home') this.helpTop = 0;
    if (name === 'end') this.helpTop = maxTop;
  }

  // --------------------------------------------------------------- navigation

  pageSize() {
    return Math.max(1, this.rows - 1);
  }

  bodyRows() {
    return this.pageSize();
  }

  totalPages() {
    const total = this.doc.visuals.length;
    return Math.max(1, Math.ceil(total / this.pageSize()));
  }

  lastPageStart() {
    const total = this.doc.visuals.length;
    if (!total) return 0;
    return Math.floor((total - 1) / this.pageSize()) * this.pageSize();
  }

  clampTop(value) {
    return Math.max(0, Math.min(Math.floor(value), this.lastPageStart()));
  }

  clampIndex(value) {
    const last = Math.max(0, this.doc.visuals.length - 1);
    return Math.max(0, Math.min(Math.floor(value), last));
  }

  turnPage(direction) {
    if (direction > 0) {
      if (this.top >= this.lastPageStart()) return;
      this.top = Math.min(this.top + this.pageSize(), this.lastPageStart());
    } else {
      this.top = this.clampTop(this.top - this.pageSize());
    }
    this.savePosition();
  }

  scrollBy(delta) {
    if (delta > 0 && this.top >= this.lastPageStart()) return;
    this.top = this.clampTop(this.top + delta);
    this.savePosition();
  }

  currentPosition() {
    const visuals = this.doc.visuals;
    if (!visuals.length) return { line: 0, part: 0 };
    const visual = visuals[Math.max(0, Math.min(this.top, visuals.length - 1))];
    return { line: visual.line, part: visual.part };
  }

  topForPosition(position) {
    if (!position || typeof position.line !== 'number') return 0;
    const index = this.doc.findVisualIndex(position.line, position.part || 0);
    return this.clampIndex(index);
  }

  savePosition() {
    if (!this._opened || !this.doc.visuals.length) return;
    try {
      this.saveState(this.currentPosition());
    } catch (error) {
      console.error('[terminal-reader] save position failed', error);
    }
  }

  jumpToLine(lineIndex) {
    const index = this.doc.findVisualIndex(lineIndex, 0);
    this.top = this.clampIndex(index);
    this.savePosition();
  }

  jumpChapter(direction) {
    const chapters = this.doc.chapters;
    if (!chapters.length) {
      this.message = '未识别到章节';
      return;
    }

    const currentLine = this.currentPosition().line;
    if (direction > 0) {
      const chapter = chapters.find((item) => item.line > currentLine);
      if (!chapter) {
        this.message = '已经是最后一章';
        return;
      }
      this.jumpToLine(chapter.line);
      return;
    }

    const currentIndex = this.doc.chapterIndexForLine(currentLine);
    let target = currentIndex;
    if (currentIndex >= 0 && chapters[currentIndex].line === currentLine) target = currentIndex - 1;
    if (target < 0) {
      this.message = '已经是第一章';
      return;
    }
    this.jumpToLine(chapters[target].line);
  }

  openToc() {
    if (!this.doc.chapters.length) {
      this.message = '未识别到章节（txt 可在设置中调整章节正则）';
      return;
    }
    const currentLine = this.currentPosition().line;
    const chapterIndex = this.doc.chapterIndexForLine(currentLine);
    this.tocIndex = Math.max(0, chapterIndex);
    this.tocTop = 0;
    this.mode = 'toc';
  }

  tocPageSize() {
    return Math.max(1, this.bodyRows() - 2);
  }

  openInput(kind) {
    this.mode = 'input';
    this.inputKind = kind;
    this.input = '';
    this.message = '';
  }

  commitGoto(value) {
    const page = Number.parseInt(value, 10);
    const total = this.totalPages();
    if (!Number.isFinite(page) || page < 1 || page > total) {
      this.message = `页码需要在 1 - ${total} 之间`;
      return;
    }
    this.top = this.clampTop((page - 1) * this.pageSize());
    this.savePosition();
  }

  commitSearch(value) {
    const query = value.trim();
    if (!query) {
      this.searchQuery = '';
      this.matches = [];
      return;
    }

    this.searchQuery = query;
    this.recomputeMatches();

    if (!this.matches.length) {
      this.message = `未找到「${query}」`;
      return;
    }

    const first = this.matches.find((index) => index >= this.top) ?? this.matches[0];
    this.top = this.clampIndex(first);
    this.message = `找到 ${this.matches.length} 处匹配 · n/N 跳转`;
    this.savePosition();
  }

  recomputeMatches() {
    this.matches = [];
    if (!this.searchQuery) return;
    const needle = this.searchQuery.toLowerCase();
    const visuals = this.doc.visuals;
    for (let index = 0; index < visuals.length; index += 1) {
      if (visuals[index].text.toLowerCase().includes(needle)) this.matches.push(index);
    }
  }

  jumpSearch(direction) {
    if (!this.searchQuery) {
      this.message = '按 / 开始搜索';
      return;
    }
    if (!this.matches.length) this.recomputeMatches();
    if (!this.matches.length) {
      this.message = `未找到「${this.searchQuery}」`;
      return;
    }

    let target;
    if (direction > 0) {
      target = this.matches.find((index) => index > this.top);
      if (target === undefined) target = this.matches[0];
    } else {
      const before = this.matches.filter((index) => index < this.top);
      target = before.length ? before[before.length - 1] : this.matches[this.matches.length - 1];
    }

    this.top = this.clampIndex(target);
    const order = this.matches.indexOf(target) + 1;
    this.message = `匹配 ${order}/${this.matches.length}`;
    this.savePosition();
  }

  async reload() {
    if (!this.reloadCallback) {
      this.message = '无法重新加载此文件';
      return;
    }

    const anchor = this.currentPosition();
    try {
      const doc = await this.reloadCallback();
      this.doc = doc;
      this.doc.wrap(this.columns);
      this.top = this.topForPosition(anchor);
      this.searchQuery = '';
      this.matches = [];
      this.message = '已重新加载';
      this.savePosition();
    } catch (error) {
      this.message = `重新加载失败：${error && error.message ? error.message : error}`;
    }
    this.render();
  }

  // ------------------------------------------------------------------ render

  render() {
    if (!this._opened || this._closed) return;

    const columns = this.columns;
    const rows = this.bodyRows();
    const body = this.mode === 'help'
      ? this.renderHelp(rows, columns)
      : this.mode === 'toc'
        ? this.renderToc(rows, columns)
        : this.renderContent(rows, columns);

    let out = '\x1b[?25l\x1b[H';
    for (let row = 0; row < rows; row += 1) {
      out += (body[row] || ' '.repeat(columns)) + '\x1b[K\r\n';
    }
    out += inverseLine(this.buildStatus(), columns);
    this._writeEmitter.fire(out);
  }

  renderContent(rows, columns) {
    const visuals = this.doc.wrap(columns);
    const lines = [];

    for (let row = 0; row < rows; row += 1) {
      const index = this.top + row;
      if (index >= visuals.length) {
        lines.push(' '.repeat(columns));
        continue;
      }

      const visual = visuals[index];
      const style = STYLES[visual.kind] || '';
      let rendered;

      if (this.searchQuery) {
        rendered = highlightText(visual.text, this.searchQuery, style);
      } else {
        rendered = style ? style + visual.text + '\x1b[0m' : visual.text;
      }

      const padding = Math.max(0, columns - stringWidth(visual.text));
      lines.push(rendered + ' '.repeat(padding));
    }

    return lines;
  }

  renderToc(rows, columns) {
    const chapters = this.doc.chapters;
    const lines = [];
    lines.push(styleLine(` 目录 · 共 ${chapters.length} 章`, STYLES.h1, columns));
    lines.push(' '.repeat(columns));

    const visibleRows = this.tocVisibleRows();
    const start = this.tocStart();
    this.tocTop = start;

    for (let row = 0; row < visibleRows; row += 1) {
      const index = start + row;
      if (index >= chapters.length) {
        lines.push(' '.repeat(columns));
        continue;
      }

      const chapter = chapters[index];
      const page = this.pageForLine(chapter.line);
      const label = ` ${page} 页 `;
      const indent = '  '.repeat(Math.max(0, Math.min((chapter.level || 1), 3) - 1));
      const titleWidth = Math.max(4, columns - stringWidth(label) - 2);
      const title = truncate(`${indent}${chapter.title}`, titleWidth);
      const entry = ` ${String(index + 1).padStart(3, ' ')}. ${title}`;
      const gap = Math.max(1, columns - stringWidth(entry) - stringWidth(label));
      const text = entry + ' '.repeat(gap) + label;

      lines.push(index === this.tocIndex ? inverseLine(text, columns) : fitText(text, columns));
    }

    return lines;
  }

  renderHelp(rows, columns) {
    const maxTop = Math.max(0, HELP_LINES.length - rows);
    this.helpTop = Math.max(0, Math.min(this.helpTop, maxTop));

    const lines = [];
    for (let index = this.helpTop; index < HELP_LINES.length && lines.length < rows; index += 1) {
      const [text, kind] = HELP_LINES[index];
      const style = STYLES[kind] || '';
      lines.push(style ? styleLine(fitText(text, columns), style, columns, false) : fitText(text, columns));
    }
    while (lines.length < rows) lines.push(' '.repeat(columns));
    return lines;
  }

  buildStatus() {
    const columns = this.columns;

    if (this.mode === 'input') {
      const prompt = this.inputKind === 'goto' ? `跳转到页：${this.input}` : `搜索：${this.input}`;
      const hint = this.inputKind === 'goto' ? '  Enter 跳转 · Esc 取消' : '  Enter 搜索 · Esc 取消';
      return ` ${prompt}▏${hint}`;
    }

    if (this.message) return ` ${this.message} `;

    if (this.mode === 'help') return ' 帮助 · j/k 滚动 · q / Esc / ? 返回阅读 ';

    const totalPages = this.totalPages();
    const page = Math.min(totalPages, Math.floor(this.top / this.pageSize()) + 1);
    const percent = totalPages <= 1 ? 100 : ((page - 1) / (totalPages - 1)) * 100;
    const position = `${page}/${totalPages} 页 · ${percent.toFixed(1)}%`;

    if (this.mode === 'toc') {
      return this.composeStatus(`目录 · ${this.doc.title}`, TOC_HELP, columns);
    }

    const chapterIndex = this.doc.chapterIndexForLine(this.currentPosition().line);
    const chapter = chapterIndex >= 0 ? this.doc.chapters[chapterIndex].title : '';
    const hint = this.searchQuery ? 'n/N 匹配 · ? 帮助' : '? 帮助';
    const right = `${position} · ${hint} `;
    const queryPart = this.searchQuery ? ` · /${this.searchQuery}` : '';

    const candidates = [
      ` ${this.doc.title}${queryPart}${chapter ? ` · ${chapter}` : ''}`,
      ` ${this.doc.title}${queryPart}`,
      ` ${this.doc.title}`,
    ];

    for (const left of candidates) {
      if (stringWidth(left) + stringWidth(right) <= columns) {
        return left + ' '.repeat(columns - stringWidth(left) - stringWidth(right)) + right;
      }
    }

    const compact = `${position} · ${hint} `;
    return compact;
  }

  composeStatus(left, right, columns) {
    const leftText = ` ${left}`;
    const rightText = `${right} `;
    if (stringWidth(leftText) + stringWidth(rightText) <= columns) {
      return leftText + ' '.repeat(columns - stringWidth(leftText) - stringWidth(rightText)) + rightText;
    }
    return fitText(leftText, columns);
  }

  pageForLine(lineIndex) {
    const index = this.doc.findVisualIndex(lineIndex, 0);
    return Math.min(this.totalPages(), Math.floor(index / this.pageSize()) + 1);
  }
}

function styleLine(text, style, columns, pad = true) {
  const body = pad ? fitText(text, columns) : text;
  return style + body + '\x1b[0m';
}

module.exports = { ReaderSession };
