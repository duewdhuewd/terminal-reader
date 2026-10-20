'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDocument, decodeBuffer, mdInline } = require('../src/document');

test('detects txt chapters and derives the book title', () => {
  const doc = buildDocument({
    fileName: 'novel.txt',
    text: '第一章 开始\n正文第一段。\n\n第二章 继续\n正文第二段。\n',
  });

  assert.equal(doc.title, 'novel');
  assert.equal(doc.chapters.length, 2);
  assert.deepEqual(doc.chapters.map((chapter) => chapter.title), ['第一章 开始', '第二章 继续']);
  assert.equal(doc.lines[0].kind, 'h2');
  assert.equal(doc.lines[1].kind, 'body');
});

test('supports custom chapter regex', () => {
  const doc = buildDocument({
    fileName: 'custom.txt',
    chapterPattern: '^\\[\\d+\\]',
    text: '[01] 起点\n内容\n[02] 终点\n内容\n',
  });
  assert.equal(doc.chapters.length, 2);
});

test('strips YAML front matter and Markdown syntax', () => {
  const doc = buildDocument({
    fileName: 'book.md',
    text: [
      '---',
      'title: 测试',
      '---',
      '# 书名',
      '',
      '## 第一章',
      '**加粗** 和 [链接](https://example.com) 以及 `code`。',
      '- 列表项',
      '> 引用',
      '',
      '```js',
      'console.log(1)',
      '```',
    ].join('\n'),
  });

  assert.equal(doc.title, '书名');
  assert.equal(doc.chapters.length, 2);
  assert.equal(doc.chapters[1].title, '第一章');
  assert.equal(mdInline('**加粗** 和 [链接](https://example.com) 以及 `code`。'), '加粗 和 链接 以及 code。');
  assert.ok(doc.lines.some((line) => line.kind === 'list' && line.text.includes('列表项')));
  assert.ok(doc.lines.some((line) => line.kind === 'quote' && line.text.includes('引用')));
  assert.ok(doc.lines.some((line) => line.kind === 'code' && line.text.includes('console.log')));
});

test('wraps lines and maps source positions to visual rows', () => {
  const doc = buildDocument({
    fileName: 'lines.txt',
    text: '你好世界你好世界\n第二行\n',
  });
  doc.wrap(10);

  assert.equal(doc.visuals.length, 4);
  assert.equal(doc.visuals[1].line, 0);
  assert.equal(doc.findVisualIndex(0, 1), 1);
  assert.equal(doc.findVisualIndex(1, 0), 2);
  assert.equal(doc.findVisualIndex(99, 0), 3);
  assert.equal(doc.chapterIndexForLine(0), -1);
});

test('sample txt and Markdown documents parse into chapters', () => {
  const samples = path.join(__dirname, '..', 'samples');
  const txt = buildDocument({
    fileName: 'demo.txt',
    text: fs.readFileSync(path.join(samples, 'demo.txt'), 'utf8'),
  });
  assert.equal(txt.title, 'demo');
  assert.equal(txt.chapters.length, 3);

  const md = buildDocument({
    fileName: 'demo.md',
    text: fs.readFileSync(path.join(samples, 'demo.md'), 'utf8'),
  });
  assert.equal(md.title, '终端阅读器示例');
  assert.ok(md.chapters.length >= 5);
  assert.ok(!md.lines.some((line) => line.text.includes('author:')));
});

test('decodes UTF-8 BOM and GB18030 buffers', () => {
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')]);
  assert.equal(decodeBuffer(utf8), '中文');

  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBuffer(gbk), '中文');
});
