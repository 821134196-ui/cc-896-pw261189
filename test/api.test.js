'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmp, writeFile } = require('./helpers');
const { createApp } = require('../src/web/app');

async function withServer(fn) {
  const root = makeTmp('dm-api-');
  writeFile(root, 'a.txt', 'same-content\n');
  writeFile(root, 'd/a.txt', 'same-content\n');
  writeFile(root, 'one.txt', 'only-one\n');
  const { handler } = createApp({ root });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, root);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

async function post(base, p, body) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP：健康检查、静态页面与完整迁移 API', async () => {
  await withServer(async (base) => {
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.ok, true);

    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /迁移总览|内容摘要/);

    assert.equal((await post(base, '/api/scan')).json.ok, true);
    const ing = (await post(base, '/api/ingest')).json.result;
    assert.equal(ing.ingested.length, 3);

    const reuse = await (await fetch(base + '/api/reuse')).json();
    assert.equal(reuse.groups.length, 1);
    assert.equal(reuse.groups[0].count, 2);

    const sw = (await post(base, '/api/switch')).json.result;
    assert.equal(sw.switched.length, 3);
    const vr = (await post(base, '/api/verify')).json.result;
    assert.equal(vr.ok, 3);
    const cl = (await post(base, '/api/cleanup')).json.result;
    assert.equal(cl.moved.length, 3);

    // /raw 仍按旧路径返回 CAS 字节，并带来源头
    const raw = await fetch(base + '/raw?path=' + encodeURIComponent('d/a.txt'));
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('x-read-source'), 'cas');
    assert.equal(await raw.text(), 'same-content\n');

    const list = await (await fetch(base + '/api/list?dir=d')).json();
    assert.ok(list.files.some((f) => f.path === 'd/a.txt'));
  });
});

test('HTTP：过期版本令牌切换返回 409 + VERSION_CONFLICT', async () => {
  await withServer(async (base, root) => {
    await post(base, '/api/scan');
    await post(base, '/api/ingest');
    const state = await (await fetch(base + '/api/state')).json();
    const v = state.journal.items['one.txt'].baseVersion;

    fs.appendFileSync(path.join(root, 'one.txt'), 'parallel\n');

    const r = await post(base, '/api/switch', { path: 'one.txt', expectedVersion: v });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'VERSION_CONFLICT');

    const pending = await (await fetch(base + '/api/pending')).json();
    assert.ok(pending.pending.some((p) => p.path === 'one.txt' && p.state === 'conflict'));

    // recheck 后可恢复
    assert.equal((await post(base, '/api/recheck', { path: 'one.txt' })).json.ok, true);
    const sw = await post(base, '/api/switch', { path: 'one.txt' });
    assert.equal(sw.status, 200);
  });
});

test('HTTP：路径穿越被拒绝（400），读/写入口都不能逃逸出库根', async () => {
  await withServer(async (base) => {
    const read = await fetch(base + '/api/file?path=' + encodeURIComponent('../../etc/passwd'));
    assert.equal(read.status, 400);

    const sw = await post(base, '/api/switch', { path: '../../etc/passwd' });
    assert.equal(sw.status, 400);

    const recheck = await post(base, '/api/recheck', { path: '/etc/passwd' });
    assert.equal(recheck.status, 400);
  });
});

test('HTTP：武装崩溃点后操作返回 FAULT_INJECTED，随后 /api/resume 对账恢复', async () => {
  const root = makeTmp('dm-api-crash-');
  writeFile(root, 'f.txt', 'fault-resume\n');
  const { handler } = createApp({ root });
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    await post(base, '/api/scan');
    await post(base, '/api/ingest');
    await post(base, '/api/demo/arm-fault', { point: 'switch:after-refs' });

    const crashed = await post(base, '/api/switch', {});
    assert.equal(crashed.status, 500);
    assert.equal(crashed.json.error.code, 'FAULT_INJECTED');

    // refs 已提交但 journal 未追认
    const refsOnDisk = JSON.parse(fs.readFileSync(path.join(root, '.cas-migration/refs.json'), 'utf8'));
    assert.ok(refsOnDisk.refs['f.txt']);

    const resume = await post(base, '/api/resume', {});
    assert.equal(resume.status, 200);
    const state = await (await fetch(base + '/api/state')).json();
    assert.ok(['verified', 'cleaned'].includes(state.journal.items['f.txt'].state));

    const raw = await fetch(base + '/raw?path=f.txt');
    assert.equal(await raw.text(), 'fault-resume\n');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('HTTP：磁盘/窗口冲突 -> purge 暂停，resolve-pause 需显式确认', async () => {
  await withServer(async (base) => {
    await post(base, '/api/scan');
    await post(base, '/api/ingest');
    await post(base, '/api/switch');
    await post(base, '/api/verify');
    await post(base, '/api/cleanup');
    await post(base, '/api/settings', { assumeFreeBytes: 1024, minFreeBytes: 10 ** 12 });

    const pg = await post(base, '/api/purge');
    assert.equal(pg.json.result.paused, true);
    const pauseId = pg.json.result.pauseId;
    assert.ok(pauseId);

    const bad = await post(base, '/api/resolve-pause', { id: pauseId, decision: 'purge_in_window', confirm: 'x' });
    assert.equal(bad.status, 400);

    const ok = await post(base, '/api/resolve-pause', {
      id: pauseId, decision: 'purge_in_window', confirm: 'PURGE_IN_WINDOW',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.result.purged.length, 3);
  });
});
