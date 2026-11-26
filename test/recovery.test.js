'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeFile, engine } = require('./helpers');
const { MigrationEngine } = require('../src/core/engine');
const { FaultInjected } = require('../src/core/errors');

function freshEngine(root) {
  return new MigrationEngine({ root });
}

test('中断后继续：ingest CAS 写入后崩溃，resume 不丢数据且最终一致', () => {
  const root = makeTmp();
  writeFile(root, 'a.txt', 'resume-me\n');

  const e1 = new MigrationEngine({ root, faults: new Set(['ingest:after-cas-put']) });
  e1.scan();
  assert.throws(() => e1.ingest({}), FaultInjected);

  // journal 仍认为 a.txt 未收录
  const j1 = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/journal.json'), 'utf8'));
  assert.equal(j1.items['a.txt'].state, 'discovered');
  // 但 CAS 对象已经物理存在
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/cas/objects')));

  // 新进程/新实例：resume 幂等推进到完成
  const e2 = freshEngine(root);
  const out = e2.resume();
  assert.ok(out.steps.some((s) => s.step === 'switch'));
  const snap = e2.snapshot();
  assert.equal(snap.analytics.switchedCount, 1);
  const r = e2.resolveRead('a.txt');
  assert.equal(r.buffer().toString(), 'resume-me\n');
});

test('中断后继续：refs 提交后、journal 落盘前崩溃，对账自动追认 switched', () => {
  const root = makeTmp();
  writeFile(root, 'b.txt', 'commit-point\n');
  const e1 = new MigrationEngine({ root, faults: new Set(['switch:after-refs']) });
  e1.scan();
  e1.ingest({});
  assert.throws(() => e1.switchRefs({}), FaultInjected);

  // refs 已更新
  const refs = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
  assert.ok(refs.refs['b.txt']);
  // journal 还停在 ingested
  const j = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/journal.json'), 'utf8'));
  assert.equal(j.items['b.txt'].state, 'ingested');

  const e2 = freshEngine(root);
  const snap = e2.snapshot(); // snapshot 内部会 reconcile
  assert.equal(snap.journal.items['b.txt'].state, 'switched');

  e2.verify({});
  e2.cleanup({});
  assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
  assert.equal(e2.resolveRead('b.txt').buffer().toString(), 'commit-point\n');
});

test('中断后继续：cleanup 移动后崩溃，resume 能追认 cleaned 并继续', () => {
  const root = makeTmp();
  writeFile(root, 'c.txt', 'clean-crash\n');
  const e1 = new MigrationEngine({ root, faults: new Set(['cleanup:after-move']) });
  e1.scan(); e1.ingest({}); e1.switchRefs({}); e1.verify({});
  assert.throws(() => e1.cleanup({}), FaultInjected);

  assert.equal(fs.existsSync(path.join(root, 'c.txt')), false);
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/old/files/c.txt')));

  const e2 = freshEngine(root);
  e2.resume();
  const snap = e2.snapshot();
  assert.equal(snap.journal.items['c.txt'].state, 'cleaned');
  // 路径读取仍然正常（CAS 优先）
  assert.equal(e2.resolveRead('c.txt').buffer().toString(), 'clean-crash\n');
});

test('中断后继续：purge unlink 后、journal 推进前崩溃，对账为 purged 且引用读取不受影响', () => {
  const root = makeTmp();
  writeFile(root, 'd.txt', 'purge-crash\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});
  // 让回退窗口立即到期
  e.updateSettings({ rollbackWindowMs: 0 });

  const eFault = new MigrationEngine({ root, faults: new Set(['purge:after-unlink']) });
  assert.throws(() => eFault.purge({}), FaultInjected);
  assert.equal(fs.existsSync(path.join(root, '.cas-migration/old/files/d.txt')), false);

  const e2 = freshEngine(root);
  const snap = e2.snapshot();
  assert.equal(snap.journal.items['d.txt'].state, 'purged');
  assert.equal(e2.resolveRead('d.txt').buffer().toString(), 'purge-crash\n');
});

test('中断后继续：rollback 提交 refs 后崩溃，对账补完恢复，文件回到旧路径', () => {
  const root = makeTmp();
  writeFile(root, 'e.txt', 'rollback-crash\n');
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});

  const eFault = new MigrationEngine({ root, faults: new Set(['rollback:after-refs']) });
  assert.throws(() => eFault.rollback({ all: true }), FaultInjected);

  // refs 已撤销
  const refs = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
  assert.equal(refs.refs['e.txt'], undefined);

  const e2 = freshEngine(root);
  const snap = e2.snapshot(); // reconcile 应从 quarantine 恢复并置回 ingested
  assert.equal(fs.existsSync(path.join(root, 'e.txt')), true);
  assert.equal(fs.readFileSync(path.join(root, 'e.txt'), 'utf8'), 'rollback-crash\n');
  assert.equal(snap.journal.items['e.txt'].state, 'ingested');
});

test('锁：第二个并发引擎在锁被持有时收到 LOCKED/可恢复错误，而不是写坏 journal', () => {
  const root = makeTmp();
  writeFile(root, 'l.txt', 'lock\n');
  const e = engine(root);
  e.scan();

  // 手工持锁模拟另一个长事务进程
  const { FileLock } = require('../src/core/atomic');
  const lock = new FileLock(path.join(root, '.cas-migration/migration.lock'));
  lock.acquire();
  try {
    const e2 = engine(root);
    assert.throws(() => e2.switchRefs({ all: true }), /迁移正被另一个进程执行|LOCKED/);
  } finally {
    lock.release();
  }
  // 锁释放后恢复正常
  const e3 = engine(root);
  assert.doesNotThrow(() => e3.ingest({}));
});
