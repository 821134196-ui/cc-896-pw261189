'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { makeTmp, writeFile, engine } = require('./helpers');
const { createApp } = require('../src/web/app');

function throughCleanup(root, files = { 'q.txt': 'v1-content\n' }) {
  for (const [rel, content] of Object.entries(files)) writeFile(root, rel, content);
  const e = engine(root);
  e.scan(); e.ingest({}); e.switchRefs({}); e.verify({}); e.cleanup({});
  return e;
}

test('唯一副本：cleanup 后回退区备份被原地改写（模拟持有 fd 的并行写入），purge 绝不删除并落活动暂停', () => {
  const root = makeTmp('dm-backup-drift-');
  const e = throughCleanup(root);
  e.updateSettings({ rollbackWindowMs: 0 }); // 即使窗口已到期

  const backup = path.join(root, '.cas-migration/old/files/q.txt');
  assert.ok(fs.existsSync(backup));
  // cleanup 是 rename：外部进程持有的旧 fd 继续写，新字节落进 quarantine inode
  fs.appendFileSync(backup, 'unique-new-v2-via-open-fd\n');

  const r = e.purge({});
  assert.equal(r.purged.length, 0);
  assert.ok(r.blockedUniqueCopy.some((x) => x.path === 'q.txt' && x.reason === 'backup_drift'));

  // 含唯一新字节的备份必须还在
  assert.ok(fs.existsSync(backup));
  assert.match(fs.readFileSync(backup, 'utf8'), /unique-new-v2/);

  const pause = e.snapshot().journal.pauses
    .find((p) => p.kind === 'sole_copy_protection' && p.status === 'active');
  assert.ok(pause, '应有活动的唯一副本保护暂停');

  // 任何“窗口强制确认”都不能处理 sole_copy 暂停
  assert.throws(
    () => e.resolvePause(pause.id, 'purge_in_window', { confirm: 'PURGE_IN_WINDOW' }),
    /不支持窗口强制清理/
  );
  assert.ok(fs.existsSync(backup));

  // retry 仍然判定未恢复（不能只验 CAS 就误报健康）
  const retry = e.resolvePause(pause.id, 'retry');
  assert.equal(retry.resolved, false);
  assert.ok(fs.existsSync(backup));
});

test('边界：purge 后旧路径重现不同内容，scan 标 drift 并进入 pending，cleanup 阻止，可 recheck+switch 恢复', () => {
  const root = makeTmp('dm-reappear-');
  const e = throughCleanup(root, { 'gone.txt': 'v1\n' });
  e.updateSettings({ rollbackWindowMs: 0 });
  const pg = e.purge({});
  assert.equal(pg.purged.length, 1);

  assert.equal(e.analytics().pending.some((p) => p.path === 'gone.txt'), false);

  // 外部在旧路径重建了一个全新版本（唯一副本只在 live）
  writeFile(root, 'gone.txt', 'brand-new-v2-only-live\n');
  const scan = e.scan();
  assert.ok(scan.versionChanged >= 1);

  const item = e.snapshot().journal.items['gone.txt'];
  assert.equal(item.state, 'drift');
  assert.equal(item.reappearedWithChanges, true);

  const pending = e.analytics().pending.find((p) => p.path === 'gone.txt');
  assert.ok(pending, '重现的新版本必须出现在“哪些路径还没切换”');
  assert.equal(pending.reason, 'drift_needs_reswitch');

  const cl = e.cleanup({ paths: ['gone.txt'] });
  assert.equal(cl.moved.length, 0);
  assert.equal(cl.blocked[0].reason, 'unmigrated_change');
  assert.equal(fs.readFileSync(path.join(root, 'gone.txt'), 'utf8'), 'brand-new-v2-only-live\n');

  // 操作员确认接收新版本后可恢复
  e.recheck('gone.txt');
  e.switchRefs({ path: 'gone.txt' });
  const vr = e.verify({ paths: ['gone.txt'] });
  assert.equal(vr.ok, 1);
  assert.equal(e.snapshot().journal.items['gone.txt'].state, 'verified');
  assert.equal(e.analytics().pending.some((p) => p.path === 'gone.txt'), false);
});

test('安全：库内指向库外的符号链接不被遍历，读/列/切换入口一律 BAD_REQUEST', () => {
  const root = makeTmp('dm-symlink-root-');
  const outside = makeTmp('dm-symlink-out-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');
  writeFile(root, 'ordinary.txt', 'ordinary\n');
  try { fs.symlinkSync(outside, path.join(root, 'evil-dir')); } catch (e) { if (e.code === 'EPERM') return; throw e; }
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'evil-file.txt'));

  const e = engine(root);
  const scan = e.scan();
  assert.equal(scan.total, 1, '符号链接本身/其目录内容不应被遍历入库');
  assert.equal(e.snapshot().journal.items['evil-dir/secret.txt'], undefined);

  assert.throws(() => e.listDir('evil-dir'), (err) => err.code === 'BAD_REQUEST');
  assert.throws(() => e.resolveRead('evil-dir/secret.txt'), (err) => err.code === 'BAD_REQUEST');
  assert.throws(() => e._safeRel('evil-file.txt'), (err) => err.code === 'BAD_REQUEST');
  assert.throws(() => e._safeRel('../../etc/passwd'), (err) => err.code === 'BAD_REQUEST');

  // 库外目标原样未动
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-SECRET\n');
});

test('HTTP：符号链接逃逸在 /api/file 与 /api/list 上返回 400', async () => {
  const root = makeTmp('dm-symlink-api-');
  const outside = makeTmp('dm-symlink-api-out-');
  fs.writeFileSync(path.join(outside, 's.txt'), 'x\n');
  writeFile(root, 'a.txt', 'a\n');
  try { fs.symlinkSync(outside, path.join(root, 'lnk')); } catch (e) { if (e.code === 'EPERM') return; throw e; }

  const { handler } = createApp({ root });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const f = await fetch(base + '/api/file?path=' + encodeURIComponent('lnk/s.txt'));
    assert.equal(f.status, 400);
    const l = await fetch(base + '/api/list?dir=lnk');
    assert.equal(l.status, 400);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
