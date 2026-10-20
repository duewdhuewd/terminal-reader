'use strict';

const path = require('path');
const vscode = require('vscode');
const { buildDocument, decodeBuffer } = require('./src/document');
const { ReaderSession } = require('./src/reader');

const POSITIONS_KEY = 'terminalReader.positions';
const RECENT_KEY = 'terminalReader.recent';
const SAVE_DELAY = 350;

let manager;

function activate(context) {
  manager = new ReaderManager(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('terminalReader.openActive', () => manager.openActive()),
    vscode.commands.registerCommand('terminalReader.openFile', () => manager.pickFile()),
    vscode.commands.registerCommand('terminalReader.openPath', (uri) => manager.openFromCommand(uri)),
    vscode.commands.registerCommand('terminalReader.openRecent', () => manager.openRecent()),
    vscode.commands.registerCommand('terminalReader.clearProgress', () => manager.clearProgress()),
  );
}

function deactivate() {
  if (manager) {
    manager.dispose();
    manager = null;
  }
}

class ReaderManager {
  constructor(context) {
    this.context = context;
    this.terminals = new Map();
    this.saveTimers = new Map();
  }

  async openActive() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('终端阅读器：请先打开一个 txt 或 Markdown 文件。');
      return;
    }
    await this.openUri(editor.document.uri);
  }

  async pickFile() {
    const defaultUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length
      ? vscode.workspace.workspaceFolders[0].uri
      : undefined;

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      defaultUri,
      openLabel: '在终端中阅读',
      filters: {
        '文本与 Markdown': ['txt', 'text', 'md', 'markdown', 'mdown', 'log'],
        所有文件: ['*'],
      },
    });

    if (selected && selected.length) await this.openUri(selected[0]);
  }

  async openFromCommand(value) {
    let uri = value;
    if (Array.isArray(value)) uri = value[0];
    if (typeof value === 'string') {
      uri = /^file:/i.test(value) ? vscode.Uri.parse(value) : vscode.Uri.file(value);
    }
    if (!uri) return;
    await this.openUri(uri);
  }

  async openUri(uri) {
    if (!uri || uri.scheme !== 'file') {
      vscode.window.showWarningMessage('终端阅读器：目前仅支持本地文件。');
      return;
    }

    const key = uri.toString();
    const existing = this.terminals.get(key);
    if (existing && existing.terminal) {
      existing.terminal.show();
      return;
    }

    try {
      const doc = await this.loadDocument(uri);
      const config = vscode.workspace.getConfiguration('terminalReader');
      const session = new ReaderSession({
        doc,
        initialPosition: this.getPosition(key),
        mouseWheel: config.get('mouseWheel', true),
        saveState: (position) => this.savePosition(key, position),
        reload: () => this.loadDocument(uri),
      });

      const terminal = vscode.window.createTerminal({
        name: `阅读: ${doc.title}`,
        iconPath: new vscode.ThemeIcon('book'),
        pty: session.pty,
        isTransient: true,
      });

      const closeListener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        closeListener.dispose();
        this.terminals.delete(key);
        this.clearPendingSave(key);
        this.storePosition(key, session.currentPosition());
        session.dispose();
      });

      this.terminals.set(key, { terminal, session, closeListener });
      this.context.subscriptions.push(closeListener);

      terminal.show();
      this.addRecent(uri, doc);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      vscode.window.showErrorMessage(`终端阅读器：${message}`);
    }
  }

  async loadDocument(uri) {
    const config = vscode.workspace.getConfiguration('terminalReader');
    const stat = await vscode.workspace.fs.stat(uri);

    if (stat.type === vscode.FileType.Directory) throw new Error('无法阅读文件夹。');

    const maxBytes = Math.max(1, config.get('maxFileSizeMB', 10)) * 1024 * 1024;
    if (stat.size > maxBytes) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      throw new Error(`文件过大（${sizeMB} MB），上限为 ${config.get('maxFileSizeMB', 10)} MB，可在设置中调整 terminalReader.maxFileSizeMB。`);
    }

    const raw = await vscode.workspace.fs.readFile(uri);
    const text = decodeBuffer(raw);
    const fileName = path.basename(uri.fsPath || uri.path) || '未命名.txt';
    const doc = buildDocument({
      text,
      fileName,
      filePath: uri.fsPath,
      chapterPattern: config.get('chapterPattern'),
    });

    if (!doc.lines.some((line) => line.text.trim() !== '')) throw new Error('文件内容为空。');
    return doc;
  }

  getPosition(key) {
    const config = vscode.workspace.getConfiguration('terminalReader');
    if (!config.get('preservePosition', true)) return null;
    const positions = this.context.globalState.get(POSITIONS_KEY, {});
    return positions && positions[key] ? positions[key] : null;
  }

  savePosition(key, position) {
    const previous = this.saveTimers.get(key);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.saveTimers.delete(key);
      this.storePosition(key, position);
    }, SAVE_DELAY);

    this.saveTimers.set(key, timer);
  }

  storePosition(key, position) {
    const positions = this.context.globalState.get(POSITIONS_KEY, {});
    const next = positions && typeof positions === 'object' ? { ...positions } : {};
    next[key] = {
      line: Math.max(0, position.line || 0),
      part: Math.max(0, position.part || 0),
      updated: Date.now(),
    };

    const keys = Object.keys(next);
    if (keys.length > 200) {
      keys
        .sort((a, b) => (next[a].updated || 0) - (next[b].updated || 0))
        .slice(0, keys.length - 200)
        .forEach((oldKey) => delete next[oldKey]);
    }

    this.context.globalState.update(POSITIONS_KEY, next);
  }

  clearPendingSave(key) {
    const timer = this.saveTimers.get(key);
    if (timer) clearTimeout(timer);
    this.saveTimers.delete(key);
  }

  addRecent(uri, doc) {
    const key = uri.toString();
    const recents = this.context.globalState.get(RECENT_KEY, []);
    const next = Array.isArray(recents) ? recents.filter((item) => item && item.path !== key) : [];
    next.unshift({
      path: key,
      title: doc.title,
      name: doc.fileName,
      at: Date.now(),
    });
    this.context.globalState.update(RECENT_KEY, next.slice(0, 20));
  }

  async openRecent() {
    const recents = this.context.globalState.get(RECENT_KEY, []);
    if (!Array.isArray(recents) || !recents.length) {
      vscode.window.showInformationMessage('终端阅读器：还没有阅读记录。');
      return;
    }

    const items = recents.map((item) => {
      let description = item.name || '';
      try {
        description = vscode.Uri.parse(item.path).fsPath || description;
      } catch {
        // keep the file name
      }
      return {
        label: `$(book) ${item.title || item.name || '未命名'}`,
        description,
        detail: '在终端中继续阅读',
        uri: item.path,
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: '最近阅读',
      placeHolder: '选择要继续阅读的文件',
      matchOnDescription: true,
    });

    if (!picked) return;

    try {
      await this.openUri(vscode.Uri.parse(picked.uri));
    } catch (error) {
      vscode.window.showErrorMessage(`终端阅读器：无法打开文件（${error.message}）。`);
    }
  }

  async clearProgress() {
    const answer = await vscode.window.showWarningMessage(
      '确定要清除所有文件的阅读进度吗？阅读记录会保留。',
      { modal: true },
      '清除',
    );
    if (answer !== '清除') return;
    await this.context.globalState.update(POSITIONS_KEY, {});
    vscode.window.showInformationMessage('终端阅读器：阅读进度已清除。');
  }

  dispose() {
    for (const [key, entry] of this.terminals) {
      try {
        this.storePosition(key, entry.session.currentPosition());
        entry.session.dispose();
        entry.terminal.dispose();
      } catch {
        // terminal may already be gone
      }
    }
    this.terminals.clear();
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
  }
}

module.exports = { activate, deactivate };
