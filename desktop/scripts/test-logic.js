'use strict';

// Unit tests for pure review helpers (no Electron window required).
const Module = require('module');
const path = require('path');
const assert = require('assert');

// Stub electron modules before loading app code.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => require('os').tmpdir(),
        getVersion: () => '0.0.0-test',
        whenReady: () => Promise.resolve(),
        on: () => {},
        isPackaged: false,
      },
      BrowserWindow: function () {},
      ipcMain: { handle: () => {} },
      shell: { openExternal: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: {
        invoke: async () => null,
        on: () => {},
        removeListener: () => {},
        sendSync: () => null,
        send: () => {},
      },
    };
  }
  if (request === 'electron-store') {
    class Store {
      constructor(opts = {}) {
        this.store = JSON.parse(JSON.stringify(opts.defaults || {}));
      }
      get(k) {
        return k ? this.store[k] : this.store;
      }
      set(k, v) {
        if (typeof k === 'object') Object.assign(this.store, k);
        else this.store[k] = v;
      }
      clear() {
        this.store = {};
      }
    }
    return Store;
  }
  return origLoad.apply(this, arguments);
};

const review = require(path.join(__dirname, '..', 'src', 'main', 'review.js'));

// validLine
const diff = '@@ -1,3 +1,4 @@\n keep\n-old line\n+new line\n+another new\n context\n';
assert.strictEqual(review.validLine(diff, 'new', 1), true);
assert.strictEqual(review.validLine(diff, 'old', 1), true);
assert.strictEqual(review.validLine(diff, 'new', 2), true);
assert.strictEqual(review.validLine(diff, 'new', 3), true);
assert.strictEqual(review.validLine(diff, 'old', 2), true);
assert.strictEqual(review.validLine(diff, 'new', 99), false);
assert.strictEqual(review.validLine('', 'new', 1), false);

// skip filters
assert.ok(review.SKIP_PATH_RE.test('package-lock.json'));
assert.ok(review.SKIP_PATH_RE.test('dist/app.min.js'));
assert.ok(!review.SKIP_PATH_RE.test('src/main.py'));

// parse fenced JSON
const data = review.parseReviewJson('```json\n{"summary":"ok","issues":[]}\n```');
assert.strictEqual(data.summary, 'ok');
assert.deepStrictEqual(data.issues, []);

// filterChanges
const filtered = review.filterChanges([
  { new_path: 'package-lock.json', diff: '@@ @@\n+x\n' },
  { new_path: 'src/a.ts', diff: '@@ @@\n+x\n' },
  { new_path: 'src/b.ts', diff: '' },
]);
assert.deepStrictEqual(
  filtered.map((c) => c.new_path),
  ['src/a.ts']
);

// buildDiffPayload truncates
const mr = {
  changes: [
    { new_path: 'a.txt', diff: 'x'.repeat(100) },
    { new_path: 'b.txt', diff: 'y'.repeat(100) },
  ],
};
const { text, used } = review.buildDiffPayload(mr, { maxDiffBytes: 120, maxFileDiff: 50 });
assert.ok(text.length < 400);
assert.ok(used.length >= 1);

console.log('ALL_LOGIC_OK');
