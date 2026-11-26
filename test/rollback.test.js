'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeFile, engine } = require('./helpers');

test('回退：切换后尚未清理时回退，旧路径文件原样保留、refs 撤销、路径走 legacy', () => {
  const root = makeTmp();
  writeFile(root, 'a.txt', 'stay\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({});

  const rb = e.rollback({ path: 'a.txt' });
  assert.equal(rb.rolledBack[0].source, 'live-existing');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'stay\n');

  const refs = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
  assert.equal(refs.refs['a.txt'], undefined);
  const r = e.resolveRead('a.txt');
  assert.equal(r.source, 'legacy');
});

test('回退：cleanup 后从 quarantine 移回', () => {
  const root = makeTmp();
  writeFile(root, 'dir/q.txt', 'quarantine-restore\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});
  assert.equal(fs.existsSync(path.join(root, 'dir/q.txt')), false);

  const rb = e.rollback({ path: 'dir/q.txt' });
  assert.equal(rb.rolledBack[0].source, 'quarantine');
  assert.equal(fs.readFileSync(path.join(root, 'dir/q.txt'), 'utf8'), 'quarantine-restore\n');
  assert.equal(fs.existsSync(path.join(root, '.cas-migration/old/files/dir/q.txt')), false);
});

test('回退：purge 后旧副本已删，仍可从 CAS 重建到旧路径', () => {
  const root = makeTmp();
  writeFile(root, 'p.txt', 'cas-restore\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});
  e.updateSettings({ rollbackWindowMs: 0 });
  e.purge({});
  assert.equal(fs.existsSync(path.join(root, '.cas-migration/old/files/p.txt')), false);

  const rb = e.rollback({ path: 'p.txt' });
  assert.equal(rb.rolledBack[0].source, 'cas');
  assert.equal(fs.readFileSync(path.join(root, 'p.txt'), 'utf8'), 'cas-restore\n');
});

test('回退不覆盖切换后外部写入的更新版本，而是保留它并撤销引用', () => {
  const root = makeTmp();
  writeFile(root, 'x.txt', 'v1\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({});
  fs.writeFileSync(path.join(root, 'x.txt'), 'external-v2\n');

  const rb = e.rollback({ path: 'x.txt' });
  assert.equal(rb.rolledBack[0].source, 'live-existing');
  assert.equal(fs.readFileSync(path.join(root, 'x.txt'), 'utf8'), 'external-v2\n');

  // 回退后重新登记的摘要是 v2，且 CAS 中有 v2 副本
  const snap = e.snapshot();
  const item = snap.journal.items['x.txt'];
  assert.equal(item.state, 'ingested');
  assert.ok(e.cas.has(item.digest));
});
