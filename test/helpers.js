'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { MigrationEngine } = require('../src/core/engine');

function makeTmp(prefix = 'dm-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function engine(root) {
  return new MigrationEngine({ root });
}

/** 跑完整条安全流水线（默认不 purge，除非传 purge=true）。 */
function runPipeline(root, opts = {}) {
  const e = engine(root);
  e.scan();
  e.ingest({});
  e.switchRefs({});
  e.verify({});
  e.cleanup({});
  if (opts.purge) e.purge({});
  return e;
}

module.exports = { makeTmp, writeFile, read, engine, runPipeline };
