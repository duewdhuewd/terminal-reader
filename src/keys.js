'use strict';

const CSI_FINAL_NAMES = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};

const CSI_TILDE_NAMES = {
  1: 'home',
  2: 'insert',
  3: 'delete',
  4: 'end',
  5: 'pageup',
  6: 'pagedown',
  7: 'home',
  8: 'end',
};

const SS3_NAMES = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
};

/**
 * Parse raw terminal input into logical key presses.
 * Supports arrows, PageUp/PageDown, Home/End, ESC, backspace, Ctrl+letter
 * and bracketed paste markers.
 */
function parseKeys(input) {
  const data = String(input ?? '')
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '');

  const keys = [];
  let index = 0;

  while (index < data.length) {
    const rest = data.slice(index);

    if (rest[0] === '\x1b') {
      // SGR mouse reporting: CSI < button ; column ; row M/m
      const sgrMouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (sgrMouse) {
        const code = Number(sgrMouse[1]);
        const column = Number(sgrMouse[2]);
        const row = Number(sgrMouse[3]);
        const pressed = sgrMouse[4] === 'M';
        const button = code & ~(4 | 8 | 16);
        if (button === 64) keys.push({ name: 'wheelup' });
        else if (button === 65) keys.push({ name: 'wheeldown' });
        else if (button === 0 && pressed) keys.push({ name: 'click', column, row });
        index += sgrMouse[0].length;
        continue;
      }

      // Classic X10 mouse reporting: CSI M followed by three bytes.
      const x10Mouse = /^\x1b\[M([\s\S]{3})/.exec(rest);
      if (x10Mouse) {
        const button = x10Mouse[1].charCodeAt(0) - 32;
        const column = x10Mouse[1].charCodeAt(1) - 32;
        const row = x10Mouse[1].charCodeAt(2) - 32;
        if (button === 64) keys.push({ name: 'wheelup' });
        else if (button === 65) keys.push({ name: 'wheeldown' });
        else if (button === 0) keys.push({ name: 'click', column, row });
        index += x10Mouse[0].length;
        continue;
      }

      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const params = csi[1];
        const final = csi[2];
        let name;

        if (final === '~') {
          name = CSI_TILDE_NAMES[params.split(';')[0]];
        } else {
          name = CSI_FINAL_NAMES[final];
        }

        if (name) keys.push({ name });
        index += csi[0].length;
        continue;
      }

      const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
      if (ss3) {
        const name = SS3_NAMES[ss3[1]];
        if (name) keys.push({ name });
        index += ss3[0].length;
        continue;
      }

      // Lone ESC or Alt+key: treat Alt as ESC.
      keys.push({ name: 'escape' });
      index += 1;
      continue;
    }

    const ch = data[index];

    if (ch === '\r' || ch === '\n') {
      keys.push({ name: 'enter' });
      index += 1;
      continue;
    }
    if (ch === '\x7f' || ch === '\b') {
      keys.push({ name: 'backspace' });
      index += 1;
      continue;
    }
    if (ch === '\t') {
      keys.push({ name: 'tab' });
      index += 1;
      continue;
    }
    if (ch === '\x00') {
      index += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      keys.push({ name: `ctrl-${String.fromCharCode(96 + code)}` });
      index += 1;
      continue;
    }

    const cp = data.codePointAt(index);
    const char = String.fromCodePoint(cp);
    keys.push({ char });
    index += char.length;
  }

  return keys;
}

module.exports = { parseKeys };
