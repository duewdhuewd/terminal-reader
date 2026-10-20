'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  stringWidth,
  wrapLine,
  fitText,
  truncate,
  highlightText,
  stripAnsi,
} = require('../src/ansi');

test('display width counts CJK as two cells', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('中文'), 4);
  assert.equal(stringWidth('A中B'), 4);
  assert.equal(stringWidth('😀'), 2);
  assert.equal(stringWidth('\x1b[31m中文\x1b[0m'), 4);
});

test('wrapLine breaks CJK by cell width', () => {
  assert.deepEqual(wrapLine('你好世界你好', 4), ['你好', '世界', '你好']);
  assert.deepEqual(wrapLine('abcdef', 3), ['abc', 'def']);
});

test('wrapLine prefers spaces for Latin text', () => {
  assert.deepEqual(wrapLine('hello world foo', 8), ['hello', 'world', 'foo']);
});

test('wrapLine handles empty lines and very narrow terminals', () => {
  assert.deepEqual(wrapLine('', 10), ['']);
  assert.deepEqual(wrapLine('中', 1), ['中']);
});

test('fitText pads and truncates to exact width', () => {
  assert.equal(fitText('中文', 6), '中文  ');
  assert.equal(fitText('abcdef', 4), 'abc…');
  assert.equal(fitText('中文', 3), '中…');
});

test('truncate ignores ANSI sequences', () => {
  assert.equal(truncate('\x1b[31mabcdef\x1b[0m', 4), 'abc…');
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
});

test('highlightText wraps every match and keeps the base style', () => {
  const output = highlightText('abc abc', 'abc', '\x1b[1m');
  assert.equal(stripAnsi(output), 'abc abc');
  assert.equal((output.match(/\x1b\[43;30m/g) || []).length, 2);
  assert.ok(output.endsWith('\x1b[0m'));
});
