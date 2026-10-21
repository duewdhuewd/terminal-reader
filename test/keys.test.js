'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys } = require('../src/keys');

test('parses printable characters including CJK', () => {
  assert.deepEqual(parseKeys('a你'), [{ char: 'a' }, { char: '你' }]);
});

test('parses arrow, page and editing keys', () => {
  assert.deepEqual(parseKeys('\x1b[A'), [{ name: 'up' }]);
  assert.deepEqual(parseKeys('\x1b[6~'), [{ name: 'pagedown' }]);
  assert.deepEqual(parseKeys('\x1b[H'), [{ name: 'home' }]);
  assert.deepEqual(parseKeys('\x7f'), [{ name: 'backspace' }]);
  assert.deepEqual(parseKeys('\r'), [{ name: 'enter' }]);
  assert.deepEqual(parseKeys('\x1b'), [{ name: 'escape' }]);
});

test('parses control keys and bracketed paste', () => {
  assert.deepEqual(parseKeys('\x03'), [{ name: 'ctrl-c' }]);
  assert.deepEqual(parseKeys('\x1b[200~abc\x1b[201~'), [
    { char: 'a' },
    { char: 'b' },
    { char: 'c' },
  ]);
});

test('parses SGR and X10 mouse wheel events', () => {
  assert.deepEqual(parseKeys('\x1b[<64;10;5M'), [{ name: 'wheelup' }]);
  assert.deepEqual(parseKeys('\x1b[<65;10;5M'), [{ name: 'wheeldown' }]);
  assert.deepEqual(parseKeys('\x1b[<68;10;5M'), [{ name: 'wheelup' }]);
  assert.deepEqual(parseKeys('\x1b[<0;10;5M'), [{ name: 'click', column: 10, row: 5 }]);
  assert.deepEqual(parseKeys('\x1b[<0;10;5m'), []);

  const x10WheelUp = '\x1b[M' + String.fromCharCode(96, 33, 33);
  assert.deepEqual(parseKeys(x10WheelUp), [{ name: 'wheelup' }]);

  const x10Click = '\x1b[M' + String.fromCharCode(32, 42, 37);
  assert.deepEqual(parseKeys(x10Click), [{ name: 'click', column: 10, row: 5 }]);
});

test('parses mixed input in order', () => {
  const keys = parseKeys('/第一章\r');
  assert.equal(keys.length, 5);
  assert.deepEqual(keys[0], { char: '/' });
  assert.deepEqual(keys[3], { char: '章' });
  assert.deepEqual(keys[4], { name: 'enter' });
});
