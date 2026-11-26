'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeFile, engine } = require('./helpers');

test('完整迁移：扫描→收录去重→切换→核对→清理，路径与目录读取语义保持', () => {
  const root = makeTmp();
  const same = '相同内容-abc123\n'.repeat(10);
  writeFile(root, 'a.txt', same);
  writeFile(root, 'dir/b.txt', same); // 同内容
  writeFile(root, 'dir/c.txt', '另一个内容\n');

  const e = engine(root);
  const scan = e.scan();
  assert.equal(scan.total, 3);

  const ing = e.ingest({});
  assert.equal(ing.ingested.length, 3);
  assert.equal(ing.reused.length, 1, '第二个相同内容对象应被去重复用');

  const analytics = e.analytics();
  assert.equal(analytics.totalPaths, 3);
  assert.equal(analytics.reuse.groups.length, 1);
  assert.equal(analytics.reuse.groups[0].count, 2);

  const sw = e.switchRefs({});
  assert.equal(sw.switched.length, 3);
  assert.equal(sw.conflicts.length, 0);

  const vr = e.verify({});
  assert.equal(vr.ok, 3);
  assert.equal(vr.drift.length, 0);

  // 清理前：live 文件还在，读取来源可能是 cas（refs 优先）
  let r = e.resolveRead('a.txt');
  assert.equal(r.source, 'cas');
  assert.equal(r.buffer().toString(), same);

  const cl = e.cleanup({});
  assert.equal(cl.moved.length, 3);
  for (const rel of ['a.txt', 'dir/b.txt', 'dir/c.txt']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} live 应已移走`);
  }

  // 清理后：旧路径依然可读，字节来自 CAS
  r = e.resolveRead('dir/b.txt');
  assert.equal(r.source, 'cas');
  assert.equal(r.buffer().toString(), same);

  // 目录语义：dir/ 仍可列举，包含 b.txt/c.txt（refs 合并）
  const listing = e.listDir('dir');
  assert.deepEqual(listing.files.map((f) => f.path).sort(), ['dir/b.txt', 'dir/c.txt']);
  assert.ok(listing.files.every((f) => f.switched));

  // 根目录仍能看到 dir 目录（合成 + 历史合并）
  const rootList = e.listDir('');
  assert.ok(rootList.dirs.some((d) => d.path === 'dir'));
});

test('同名不同内容与未切换路径视图正确', () => {
  const root = makeTmp();
  writeFile(root, 'notes.txt', '版本一\n');
  writeFile(root, 'work/notes.txt', '版本二内容更长一些\n');
  writeFile(root, 'arc/notes.txt', 'v3\n');
  writeFile(root, 'same/x.txt', 'X');
  writeFile(root, 'same/y.txt', 'X');

  const e = engine(root);
  e.scan();
  e.ingest({});

  const a = e.analytics();
  const notes = a.nameCollisions.groups.find((g) => g.name === 'notes.txt');
  assert.ok(notes);
  assert.equal(notes.variantCount, 3);

  // 尚未切换：全部路径都在 pending
  assert.equal(a.pendingCount, 5);
  e.switchRefs({ paths: ['notes.txt'] });
  const a2 = e.analytics();
  assert.equal(a2.pendingCount, 4);
  assert.ok(!a2.pending.some((p) => p.path === 'notes.txt' && !p.stale));
});

test('重复执行幂等：已收录/已切换/已清理不会产生重复或错误', () => {
  const root = makeTmp();
  writeFile(root, 'a.txt', 'hello\n');
  const e = engine(root);
  e.scan();
  e.ingest({});
  e.ingest({}); // 第二次应 skip
  e.switchRefs({});
  e.switchRefs({});
  // 单路径形式同样幂等：重复切换不增加 switchCount
  const one = e.switchRefs({ path: 'a.txt' });
  assert.deepEqual(one.idempotent, ['a.txt']);
  e.switchRefs({ path: 'a.txt' });
  e.verify({});
  e.cleanup({});
  const c2 = e.cleanup({});
  assert.ok(c2.alreadyAbsent.length >= 1);
  const refs = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
  assert.equal(Object.keys(refs.refs).length, 1);
  assert.equal(refs.refs['a.txt'].switchCount, 1, '幂等切换不应增加 switchCount');
});
