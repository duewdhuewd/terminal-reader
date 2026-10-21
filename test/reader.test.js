'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

class FakeEventEmitter {
  constructor() {
    this.listeners = [];
  }

  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((item) => item !== listener); } };
    };
  }

  fire(value) {
    for (const listener of this.listeners.slice()) listener(value);
  }

  dispose() {
    this.listeners = [];
  }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter: FakeEventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};

const { buildDocument } = require('../src/document');
const { ReaderSession } = require('../src/reader');
const { stringWidth, stripAnsi } = require('../src/ansi');

const TEXT = [
  '第一章 开始',
  '这是一个用于测试的段落。'.repeat(12),
  '',
  '第二章 继续',
  '终端阅读器需要正确处理中文宽字符。'.repeat(12),
  '',
  '第三章 结束',
  '最后一段内容，包含 search-me 这个标记。',
].join('\n');

function createSession(overrides = {}) {
  const doc = buildDocument({ fileName: 'test.txt', text: TEXT });
  const writes = [];
  const closed = [];
  const saved = [];
  const session = new ReaderSession({
    doc,
    saveState: (position) => saved.push(position),
    reload: async () => buildDocument({ fileName: 'test.txt', text: TEXT }),
    ...overrides,
  });
  session._writeEmitter.event((data) => writes.push(data));
  session._closeEmitter.event(() => closed.push(true));
  return { session, writes, closed, saved };
}

test('opens, renders content and status line', () => {
  const { session, writes } = createSession();
  session.open({ columns: 50, rows: 12 });

  const screen = writes.join('');
  assert.ok(screen.includes('第一章 开始'));
  assert.ok(screen.includes('1/'));
  assert.ok(screen.includes('帮助'));
  assert.equal(session.mode, 'normal');
});

test('pages, scrolls and jumps with keyboard input', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput('\x1b[6~');
  assert.ok(session.top > 0);
  const pageTurned = session.top;

  session.handleInput('k');
  assert.equal(session.top, pageTurned - 1);

  session.handleInput('g');
  session.handleInput('1');
  session.handleInput('\r');
  assert.equal(session.top, 0);

  session.handleInput('\x1b[F');
  assert.equal(session.top, session.lastPageStart());
});

test('search finds matches and supports next/previous', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput('/search-me\r');
  assert.equal(session.searchQuery, 'search-me');
  assert.equal(session.matches.length, 1);

  assert.equal(session.top, session.matches[0]);
  session.handleInput('n');
  assert.equal(session.top, session.matches[0]);

  session.handleInput('\x1b');
  assert.equal(session.searchQuery, '');
  assert.equal(session.matches.length, 0);
});

test('toc jumps to a chapter and help can be closed', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput('t');
  assert.equal(session.mode, 'toc');
  session.handleInput('\x1b[B');
  session.handleInput('\r');
  assert.equal(session.mode, 'normal');
  assert.equal(session.currentPosition().line, session.doc.chapters[1].line);

  session.handleInput('?');
  assert.equal(session.mode, 'help');
  session.handleInput('j');
  assert.equal(session.helpTop, 1);
  session.handleInput('q');
  assert.equal(session.mode, 'normal');
});

test('resize keeps the current source line and tiny terminals do not crash', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });
  session.handleInput('\x1b[6~');
  const before = session.currentPosition();

  session.resize({ columns: 30, rows: 8 });
  assert.equal(session.currentPosition().line, before.line);

  session.resize({ columns: 20, rows: 4 });
  assert.ok(session.columns >= 20);
  assert.ok(session.rows >= 4);
});

test('close saves position and fires the close event once', () => {
  const { session, closed, saved } = createSession();
  session.open({ columns: 50, rows: 10 });
  session.handleInput('\x1b[6~');
  session.close();
  session.close();

  assert.equal(closed.length, 1);
  assert.ok(saved.length >= 1);
  assert.ok(saved[saved.length - 1].line >= 0);
});

test('mouse wheel scrolls content, toc and help', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput('\x1b[<65;10;5M');
  assert.equal(session.top, 3);
  session.handleInput('\x1b[<64;10;5M');
  assert.equal(session.top, 0);

  session.handleInput('t');
  session.handleInput('\x1b[<65;10;5M');
  assert.equal(session.tocIndex, session.doc.chapters.length - 1);
  session.handleInput('\x1b');
  assert.equal(session.mode, 'normal');

  session.handleInput('?');
  session.handleInput('\x1b[<65;10;5M');
  assert.equal(session.helpTop, 3);
  session.handleInput('q');
  assert.equal(session.mode, 'normal');
});

test('clicking a toc row jumps to that chapter', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput('t');
  assert.equal(session.mode, 'toc');
  session.handleInput('\x1b[<0;10;4M');
  assert.equal(session.mode, 'normal');
  assert.equal(session.currentPosition().line, session.doc.chapters[1].line);

  session.handleInput('t');
  session.handleInput('\x1b[<0;10;1M'); // header row does nothing
  assert.equal(session.mode, 'toc');
  session.handleInput('\x1b[<0;10;3M');
  assert.equal(session.currentPosition().line, session.doc.chapters[0].line);
});

test('every rendered row fills the terminal width exactly', () => {
  const { session, writes } = createSession();
  session.open({ columns: 50, rows: 12 });

  const check = () => {
    const screen = writes[writes.length - 1];
    const rows = stripAnsi(screen).split('\r\n');
    assert.equal(rows.length, session.rows);
    for (const row of rows) assert.equal(stringWidth(row), 50);
  };

  check();
  session.handleInput('/测试\r');
  check();
  session.handleInput('t');
  check();
  session.handleInput('\x1b');
  session.handleInput('?');
  check();
  session.handleInput('q');
});

test('chapters can be navigated with brackets', () => {
  const { session } = createSession();
  session.open({ columns: 50, rows: 10 });

  session.handleInput(']');
  assert.equal(session.currentPosition().line, session.doc.chapters[1].line);

  session.handleInput(']');
  assert.equal(session.currentPosition().line, session.doc.chapters[2].line);

  session.handleInput('[');
  assert.equal(session.currentPosition().line, session.doc.chapters[1].line);
});
