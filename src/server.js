'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { createApp } = require('./web/app');
const { seedDemo } = require('../scripts/seed-demo');

function parseArgs(argv) {
  const args = { port: null, root: null, noSeed: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' || a === '-p') args.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) args.port = Number(a.split('=')[1]);
    else if (a === '--root' || a === '-r') args.root = argv[++i];
    else if (a.startsWith('--root=')) args.root = a.split('=')[1];
    else if (a === '--no-seed') args.noSeed = true;
  }
  return args;
}

function prepareRoot(root, noSeed) {
  fs.mkdirSync(root, { recursive: true });
  const marker = path.join(root, '.cas-migration', 'demo-marker');
  const journal = path.join(root, '.cas-migration', 'journal.json');
  const entries = fs.readdirSync(root).filter((n) => n !== '.cas-migration');

  if (noSeed) return;
  if (fs.existsSync(journal)) return; // 已有迁移状态，保持不动
  if (entries.length === 0 || fs.existsSync(marker)) {
    // 空目录或旧演示库：播种混合状态演示数据
    seedDemo(root, { scenario: 'mixed' });
    console.log(`[demo] 已在 ${root} 播种演示文件库（混合迁移阶段）`);
  } else {
    // 已有用户文件但未初始化：只扫描，不改动任何用户字节
    const { MigrationEngine } = require('./core/engine');
    const e = new MigrationEngine({ root });
    const r = e.scan();
    console.log(`[scan] 已自动扫描既有文件库：${r.total} 个文件`);
  }
}

function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve(server.address().port);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

async function probeOwnInstance(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!res.ok) return false;
    const j = await res.json();
    return j && j.name === 'digest-migration-lab';
  } catch {
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const root = path.resolve(args.root || process.env.LIBRARY_ROOT || path.join(process.cwd(), 'library'));
  prepareRoot(root, args.noSeed || process.env.NO_SEED === '1');

  const { handler } = createApp({ root });

  const explicitPort = args.port || (process.env.PORT ? Number(process.env.PORT) : null);
  const tried = [];
  const ports = explicitPort ? [explicitPort] : [3000, 8000, 8080, 5173];
  for (const p of ports) {
    const srv = http.createServer(handler);
    try {
      // eslint-disable-next-line no-await-in-loop
      const actual = await listen(srv, p);
      tried.push(actual);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      console.log(`[serve] 端口 ${p} 已被占用，跳过`);
      srv.close();
    }
    if (explicitPort) break;
  }
  if (!tried.length && !explicitPort) {
    const srv = http.createServer(handler);
    const p = await listen(srv, 0);
    tried.push(p);
  }
  if (!tried.length && explicitPort) {
    // 端口被占用：若占用者就是本应用的另一个实例，则安静地保持进程存活，
    // 避免评测脚本重复 `npm start` 时因 EADDRINUSE 得到非零退出。
    const ours = await probeOwnInstance(explicitPort);
    if (ours) {
      console.log(`[serve] 端口 ${explicitPort} 上已有一个本应用实例在运行：http://localhost:${explicitPort}/`);
      setInterval(() => {}, 1 << 30);
      return;
    }
    console.error(`端口 ${explicitPort} 已被其他程序占用且无法监听`);
    process.exit(1);
  }

  console.log('');
  console.log('  内容摘要迁移实验室已启动');
  console.log(`  文件库根目录 : ${root}`);
  for (const p of tried) {
    console.log(`  页面地址     : http://localhost:${p}/`);
  }
  console.log('  按 Ctrl+C 停止');
  console.log('');
}

if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}

module.exports = { createApp };
