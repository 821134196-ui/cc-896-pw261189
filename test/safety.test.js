'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeFile, engine } = require('./helpers');

function cleanedLibrary(root, files = { 'a.txt': 'aaa\n', 'b.txt': 'bbb\n' }) {
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});
  return e;
}

test('磁盘空间与回退窗口冲突：明确暂停，不删除任何窗口内旧副本', () => {
  const root = makeTmp();
  const e = cleanedLibrary(root);
  e.updateSettings({ rollbackWindowMs: 7 * 86400_000, assumeFreeBytes: 4096, minFreeBytes: 100 * 1024 * 1024 });

  const r = e.purge({});
  assert.equal(r.paused, true);
  assert.equal(r.purged.length, 0);
  assert.equal(r.retainedInWindow.length, 2);
  assert.ok(r.pauseId);

  // 唯一副本（quarantine 旧数据）一个都没删
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/old/files/a.txt')));
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/old/files/b.txt')));

  const snap = e.snapshot();
  const pause = snap.journal.pauses.find((p) => p.id === r.pauseId);
  assert.equal(pause.kind, 'window_disk_conflict');
  assert.ok(pause.details.deficitBytes > 0);
});

test('窗口已到期时 purge 正常删除；窗口内默认保留', () => {
  const root = makeTmp();
  const e = cleanedLibrary(root);

  // 默认 7 天窗口：全部保留
  const r1 = e.purge({});
  assert.equal(r1.purged.length, 0);
  assert.equal(r1.retainedInWindow.length, 2);

  // 窗口置 0：全部可清理
  e.updateSettings({ rollbackWindowMs: 0 });
  const r2 = e.purge({});
  assert.equal(r2.purged.length, 2);
  assert.equal(fs.existsSync(path.join(root, '.cas-migration/old/files/a.txt')), false);
});

test('冲突暂停的处理：错误确认指令被拒绝；正确显式确认后才清理并审计', () => {
  const root = makeTmp();
  const e = cleanedLibrary(root);
  e.updateSettings({ assumeFreeBytes: 1, minFreeBytes: 10 ** 12 });
  const r = e.purge({});
  const id = r.pauseId;

  assert.throws(() => e.resolvePause(id, 'purge_in_window', { confirm: 'yes' }), /PURGE_IN_WINDOW/);

  const out = e.resolvePause(id, 'purge_in_window', { confirm: 'PURGE_IN_WINDOW' });
  assert.equal(out.purged.length, 2);

  const snap = e.snapshot();
  const pause = snap.journal.pauses.find((p) => p.id === id);
  assert.equal(pause.status, 'resolved');
  assert.ok(snap.journal.history.some((h) => h.action === 'operator_override_window'));
});

test('唯一副本硬保护：CAS 对象丢失/损坏时，即使强制确认也不删旧数据', () => {
  const root = makeTmp();
  const e = cleanedLibrary(root, { 'only.txt': 'unique-bytes\n' });
  e.updateSettings({ rollbackWindowMs: 0 });

  // 删除 CAS 对象，制造“旧副本是唯一完好副本”的局面
  const snap = e.snapshot();
  const digest = snap.refs.refs['only.txt'].digest;
  const objPath = e.cas.objectPath(digest);
  fs.unlinkSync(objPath);

  const r = e.purge({});
  assert.equal(r.purged.length, 0);
  assert.deepEqual(r.blockedUniqueCopy.map((x) => x.path), ['only.txt']);
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/old/files/only.txt')), '旧副本必须保留');

  // 即便试图通过“窗口强制确认”处理 sole_copy 暂停，也会被拒绝
  const solePause = e.snapshot().journal.pauses.find((p) => p.kind === 'sole_copy_protection' && p.status === 'active');
  assert.ok(solePause, '应存在活动的唯一副本保护暂停');
  assert.throws(
    () => e.resolvePause(solePause.id, 'purge_in_window', { confirm: 'PURGE_IN_WINDOW' }),
    /不支持窗口强制清理/
  );
  assert.ok(fs.existsSync(path.join(root, '.cas-migration/old/files/only.txt')));
});

test('磁盘空间充足时，窗口内数据仍按窗口策略保留且不产生暂停', () => {
  const root = makeTmp();
  const e = cleanedLibrary(root);
  e.updateSettings({ assumeFreeBytes: 500 * 1024 ** 3, minFreeBytes: 1024 ** 3 });
  const r = e.purge({});
  assert.equal(r.paused, false);
  assert.equal(r.purged.length, 0);
  assert.equal(r.retainedInWindow.length, 2);
});
