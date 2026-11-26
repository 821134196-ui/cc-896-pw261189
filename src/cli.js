#!/usr/bin/env node
'use strict';

const path = require('path');
const { MigrationEngine } = require('./core/engine');
const { seedDemo } = require('../scripts/seed-demo');

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (a.includes('=')) {
        const [k, v] = key.split('=');
        o.flags[k] = v;
      } else if (['all', 'json', 'force'].includes(key)) {
        o.flags[key] = true;
      } else {
        o.flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      }
    } else o._.push(a);
  }
  return o;
}

function rootFrom(flags) {
  return path.resolve(flags.root || process.env.LIBRARY_ROOT || path.join(process.cwd(), 'library'));
}

function printJson(x) { console.log(JSON.stringify(x, null, 2)); }

function fmtBytes(n) {
  if (n == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function statusText(e) {
  const s = e.snapshot();
  const a = s.analytics;
  const lines = [];
  lines.push(`文件库: ${s.root}`);
  lines.push(`状态目录: ${s.stateDir}`);
  lines.push('');
  lines.push('阶段:');
  for (const [k, p] of Object.entries(s.journal.phases)) {
    lines.push(`  - ${k.padEnd(8)} ${p.state}${p.report ? '  ' + JSON.stringify(p.report) : ''}`);
  }
  lines.push('');
  lines.push(`路径总数 ${a.totalPaths} | 已切换引用 ${a.switchedCount} | 未切换 ${a.pendingCount} | 冲突/漂移 ${a.conflictCount}`);
  lines.push(`cleaned ${a.cleanedCount} | purged ${a.purgedCount}`);
  lines.push(`CAS 对象 ${a.cas.objectCount} 个 / ${fmtBytes(a.cas.bytes)}；同内容复用可省 ${fmtBytes(a.reuse.savedBytes)}`);
  lines.push(`同内容复用组 ${a.reuse.groups.length}；同名不同内容组 ${a.nameCollisions.groups.length}`);
  const activePauses = s.journal.pauses.filter((p) => p.status === 'active');
  if (activePauses.length) {
    lines.push('');
    lines.push('⚠ 活动暂停（需要明确处理）:');
    for (const p of activePauses) lines.push(`  [${p.id}] ${p.kind}: ${p.title}`);
  }
  return lines.join('\n');
}

function main() {
  const o = parse(process.argv);
  const cmd = o._[0] || 'status';
  const root = rootFrom(o.flags);

  if (cmd === 'serve') {
    process.env.LIBRARY_ROOT = root;
    if (o.flags.port) process.env.PORT = String(o.flags.port);
    require('./server');
    return;
  }

  if (cmd === 'seed') {
    const r = seedDemo(root, { scenario: o.flags.scenario === 'fresh' ? 'fresh' : 'mixed' });
    console.log('演示库已重建:', root);
    if (o.flags.json) printJson(r);
    return;
  }

  const e = new MigrationEngine({ root });
  const asJson = !!o.flags.json;
  const onePath = o.flags.path || o._[1];
  let out;

  switch (cmd) {
    case 'status':
      if (asJson) printJson(e.snapshot());
      else console.log(statusText(e));
      return;
    case 'scan': out = e.scan(); break;
    case 'ingest': out = e.ingest({ force: !!o.flags.force, paths: onePath ? [onePath] : undefined }); break;
    case 'switch':
      out = e.switchRefs({
        path: onePath,
        expectedVersion: o.flags['expected-version'],
      });
      break;
    case 'recheck': out = e.recheck(onePath); break;
    case 'verify': out = e.verify({ paths: onePath ? [onePath] : undefined }); break;
    case 'cleanup': out = e.cleanup({ paths: onePath ? [onePath] : undefined }); break;
    case 'purge': out = e.purge({}); break;
    case 'resume': out = e.resume(); break;
    case 'rollback':
      out = e.rollback({ all: !!o.flags.all, path: onePath, paths: o.flags.paths ? String(o.flags.paths).split(',') : undefined });
      break;
    case 'reuse': out = e.analytics().reuse; break;
    case 'names': out = e.analytics().nameCollisions; break;
    case 'pending': out = e.analytics().pending; break;
    case 'list': out = e.listDir(o.flags.dir || ''); break;
    case 'read': {
      const d = e.readPath(onePath);
      if (asJson) { printJson({ source: d.source, digest: d.digest, size: d.size }); return; }
      process.stdout.write(d.buffer());
      return;
    }
    case 'settings':
      out = e.updateSettings({
        rollbackWindowMs: o.flags['window-ms'] !== undefined ? Number(o.flags['window-ms']) : undefined,
        minFreeBytes: o.flags['min-free-bytes'] !== undefined ? Number(o.flags['min-free-bytes']) : undefined,
        assumeFreeBytes: o.flags['assume-free-bytes'] !== undefined
          ? (o.flags['assume-free-bytes'] === 'null' ? null : Number(o.flags['assume-free-bytes']))
          : undefined,
      });
      break;
    case 'resolve-pause':
      out = e.resolvePause(o.flags.id, o.flags.decision, { confirm: o.flags.confirm });
      break;
    default:
      console.error(`未知命令: ${cmd}`);
      console.error(`可用: status scan ingest switch recheck verify cleanup purge resume rollback reuse names pending list read settings resolve-pause seed serve`);
      process.exit(2);
  }

  if (asJson) printJson(out);
  else console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
}

try {
  main();
} catch (e) {
  console.error(`[${e.code || 'ERROR'}] ${e.message}`);
  if (e.details && Object.keys(e.details).length) console.error(JSON.stringify(e.details, null, 2));
  process.exit(1);
}
