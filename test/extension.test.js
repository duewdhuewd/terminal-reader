'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

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

class FakeUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = fsPath;
    this.path = fsPath.replace(/\\/g, '/');
  }

  toString() {
    return `file:///${this.path.replace(/^\//, '')}`;
  }

  static file(fsPath) {
    return new FakeUri(fsPath);
  }

  static parse(value) {
    return new FakeUri(decodeURI(String(value).replace(/^file:\/\/\//, '')));
  }
}

const fileContent = [
  '第一章 开始',
  '这是一段足够长的正文，用来填充多个终端页面。'.repeat(30),
  '第二章 继续',
  '结尾内容。',
].join('\n');

const state = new Map();
const terminals = [];
const closeTerminalEmitter = new FakeEventEmitter();
const commands = new Map();

const vscodeStub = {
  Uri: FakeUri,
  FileType: { File: 1, Directory: 2 },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  EventEmitter: FakeEventEmitter,
  commands: {
    registerCommand(id, handler) {
      commands.set(id, handler);
      return { dispose() {} };
    },
  },
  window: {
    activeTextEditor: {
      document: { uri: FakeUri.file(path.join(__dirname, '..', 'sample.txt')) },
    },
    createTerminal(options) {
      const terminal = {
        options,
        writes: [],
        opened: false,
        show() {
          if (this.opened) return;
          this.opened = true;
          options.pty.open({ columns: 60, rows: 12 });
        },
        dispose() {
          options.pty.close();
          closeTerminalEmitter.fire(terminal);
        },
      };
      options.pty.onDidWrite((data) => terminal.writes.push(data));
      terminals.push(terminal);
      return terminal;
    },
    onDidCloseTerminal(listener) {
      return closeTerminalEmitter.event(listener);
    },
    showErrorMessage(message) {
      throw new Error(`unexpected error message: ${message}`);
    },
    showWarningMessage() {
      return Promise.resolve(undefined);
    },
    showInformationMessage() {
      return Promise.resolve(undefined);
    },
    showOpenDialog() {
      return Promise.resolve(undefined);
    },
    showQuickPick() {
      return Promise.resolve(undefined);
    },
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration() {
      return {
        get(key, fallback) {
          if (key === 'maxFileSizeMB') return 10;
          if (key === 'preservePosition') return true;
          if (key === 'chapterPattern') return undefined;
          return fallback;
        },
      };
    },
    fs: {
      async stat() {
        return { type: 1, size: Buffer.byteLength(fileContent) };
      },
      async readFile() {
        return Buffer.from(fileContent, 'utf8');
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require('../extension');

function createContext() {
  return {
    subscriptions: [],
    globalState: {
      get(key, fallback) {
        return state.has(key) ? state.get(key) : fallback;
      },
      async update(key, value) {
        state.set(key, value);
      },
    },
  };
}

test('activate registers commands and opens a reader terminal', async () => {
  const context = createContext();
  extension.activate(context);

  assert.ok(commands.has('terminalReader.openActive'));
  assert.ok(commands.has('terminalReader.openRecent'));
  assert.ok(commands.has('terminalReader.clearProgress'));

  await commands.get('terminalReader.openActive')();

  assert.equal(terminals.length, 1);
  const terminal = terminals[0];
  assert.match(terminal.options.name, /sample/);
  assert.equal(terminal.options.iconPath.id, 'book');
  assert.ok(terminal.writes.length > 0);
  assert.match(terminal.writes.join(''), /第一章 开始/);

  const recent = state.get('terminalReader.recent');
  assert.equal(recent.length, 1);
  assert.equal(recent[0].title, 'sample');

  // Reading position is persisted after navigation and on close.
  terminal.options.pty.handleInput('\x1b[6~');
  await new Promise((resolve) => setTimeout(resolve, 450));
  const positions = state.get('terminalReader.positions');
  const position = positions[FakeUri.file(path.join(__dirname, '..', 'sample.txt')).toString()];
  assert.ok(position.line > 0);

  terminal.dispose();
  extension.deactivate();
});

test('reopening uses the saved position and existing terminal is reused', async () => {
  const context = createContext();
  extension.activate(context);
  const before = terminals.length;

  await commands.get('terminalReader.openActive')();
  const first = terminals[terminals.length - 1];
  first.options.pty.handleInput('\x1b[6~');
  first.options.pty.handleInput('\x1b[6~');
  first.dispose();

  await commands.get('terminalReader.openActive')();
  assert.equal(terminals.length, before + 2);
  const second = terminals[terminals.length - 1];
  assert.match(second.writes.join(''), /[2-9]\/\d+/);

  extension.deactivate();
});

test('clearProgress removes stored positions', async () => {
  vscodeStub.window.showWarningMessage = async () => '清除';
  const context = createContext();
  state.set('terminalReader.positions', { 'file:///x': { line: 10, part: 0 } });
  extension.activate(context);

  await commands.get('terminalReader.clearProgress')();
  assert.deepEqual(state.get('terminalReader.positions'), {});
  extension.deactivate();
});
