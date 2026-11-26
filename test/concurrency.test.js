'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeFile, engine } = require('./helpers');
const { VersionConflictError } = require('../src/core/errors');

test('并行修改竞争：带过期版本令牌切换 -> 409 风格版本冲突，引用未发布', () => {
  const root = makeTmp();
  writeFile(root, 'race.txt', '初始内容\n');
  const e = engine(root);
  e.scan();
  e.ingest({});

  const snap = e.snapshot();
  const v = snap.journal.items['race.txt'].baseVersion;

  // 另一个进程/编辑器在切换前改写文件
  fs.appendFileSync(path.join(root, 'race.txt'), '并行写入\n');

  assert.throws(
    () => e.switchRefs({ path: 'race.txt', expectedVersion: v }),
    (err) => err instanceof VersionConflictError && err.code === 'VERSION_CONFLICT'
  );

  // refs 没有被污染
  const refs = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
  assert.equal(refs.refs['race.txt'], undefined);

  const a = e.analytics();
  const p = a.pending.find((x) => x.path === 'race.txt');
  assert.equal(p.state, 'conflict');
});

test('即使不传版本令牌，权威摘要复核也能发现内容竞争', () => {
  const root = makeTmp();
  writeFile(root, 'race2.txt', 'AAAA\n');
  const e = engine(root);
  e.scan();
  e.ingest({});

  // 改成不同长度/内容（mtime 必然变化，但这里依赖的是重新哈希）
  fs.writeFileSync(path.join(root, 'race2.txt'), 'BBBB-完全不同\n');

  const sw = e.switchRefs({});
  assert.equal(sw.switched.length, 0);
  assert.equal(sw.conflicts.length, 1);
  assert.equal(sw.conflicts[0].path, 'race2.txt');
});

test('touch 仅改时间戳但内容不变：刷新版本后允许切换（不误伤）', async () => {
  const root = makeTmp();
  writeFile(root, 'touch.txt', 'same bytes\n');
  const e = engine(root);
  e.scan();
  e.ingest({});

  // 把 mtime 调到未来，制造 stat 版本变化，内容摘要不变
  const future = new Date(Date.now() + 10_000_000);
  fs.utimesSync(path.join(root, 'touch.txt'), future, future);

  const sw = e.switchRefs({});
  assert.equal(sw.conflicts.length, 0);
  assert.equal(sw.switched.length, 1);
});

test('冲突后 recheck 接受新版本，随后切换成功', () => {
  const root = makeTmp();
  writeFile(root, 'r.txt', 'v1\n');
  const e = engine(root);
  e.scan();
  e.ingest({});
  fs.writeFileSync(path.join(root, 'r.txt'), 'v2-new\n');

  const sw = e.switchRefs({});
  assert.equal(sw.conflicts.length, 1);

  const rc = e.recheck('r.txt');
  assert.equal(rc.state, 'ingested');
  assert.notEqual(rc.digest, undefined);

  const sw2 = e.switchRefs({ path: 'r.txt' });
  assert.equal(sw2.switched.length, 1);
  const vr = e.verify({ paths: ['r.txt'] });
  assert.equal(vr.ok, 1);
});

test('切换后旧路径被改写 -> verify 报 drift，cleanup 被阻止（不删唯一新版本）', () => {
  const root = makeTmp();
  writeFile(root, 'd.txt', 'migrated-v1\n');
  const e = engine(root);
  e.scan();
  e.ingest({});
  e.switchRefs({});
  e.verify({});

  // 切换后外部进程写入 v2（尚未进入 CAS）
  fs.writeFileSync(path.join(root, 'd.txt'), 'external-v2-唯一副本\n');

  const vr = e.verify({});
  assert.equal(vr.drift.length, 1);

  const cl = e.cleanup({});
  assert.equal(cl.moved.length, 0);
  assert.equal(cl.blocked.length, 1);
  assert.equal(cl.blocked[0].reason, 'unmigrated_change');

  // 旧文件原封不动
  assert.equal(fs.readFileSync(path.join(root, 'd.txt'), 'utf8'), 'external-v2-唯一副本\n');

  // 按旧路径读取仍优先 CAS 的 v1（引用一致视图），但 live v2 还在磁盘上
  const r = e.resolveRead('d.txt');
  assert.equal(r.source, 'cas');
  assert.match(r.buffer().toString(), /migrated-v1/);
});
