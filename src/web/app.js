'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { MigrationEngine } = require('../core/engine');
const { MigrateError } = require('../core/errors');
const { seedDemo } = require('../../scripts/seed-demo');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function statusForError(e) {
  switch (e.code) {
    case 'VERSION_CONFLICT': return 409;
    case 'SOLE_COPY': return 409;
    case 'PAUSED': return 423;
    case 'LOCKED': return 423;
    case 'NOT_FOUND': return 404;
    case 'BAD_REQUEST': return 400;
    case 'FAULT_INJECTED': return 500;
    default: return 500;
  }
}

function createApp(options = {}) {
  const engine = options.engine || new MigrationEngine({ root: options.root });
  const root = engine.root;

  async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 4 * 1024 * 1024) {
          reject(new MigrateError('BAD_REQUEST', '请求体过大'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { reject(new MigrateError('BAD_REQUEST', 'JSON 解析失败')); }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function sendError(res, e) {
    const code = statusForError(e);
    if (code >= 500) console.error('[api error]', e);
    sendJson(res, code, {
      ok: false,
      error: { code: e.code || 'INTERNAL', message: e.message, details: e.details || {} },
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // 只允许 public 内文件
    const abs = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== path.join(PUBLIC_DIR, 'index.html')) {
      return sendJson(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'forbidden' } });
    }
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) {
        // SPA-ish 回退到 index
        const fallback = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(fallback, (e2, buf) => {
          if (e2) return sendJson(res, 404, { ok: false, error: { message: 'not found' } });
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(buf);
        });
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      const st2 = fs.createReadStream(abs);
      st2.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
      st2.pipe(res);
    });
  }

  /** 原始字节读取：/raw?path=... 走“旧路径读取语义” */
  function handleRaw(res, url) {
    const p = url.searchParams.get('path') || '';
    const d = engine.resolveRead(p);
    res.writeHead(200, {
      'content-type': MIME[path.extname(p)] || 'application/octet-stream',
      'x-read-source': d.source,
      'x-digest': d.digest,
      'cache-control': 'no-store',
    });
    const stream = fs.createReadStream(d.abs);
    stream.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
    stream.pipe(res);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    try {
      // ---------- 只读 API ----------
      if (req.method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, name: 'digest-migration-lab', root });
      }
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, { ok: true, ...engine.snapshot() });
      }
      if (req.method === 'GET' && pathname === '/api/analytics') {
        return sendJson(res, 200, { ok: true, ...engine.analytics() });
      }
      if (req.method === 'GET' && pathname === '/api/reuse') {
        return sendJson(res, 200, { ok: true, ...engine.analytics().reuse });
      }
      if (req.method === 'GET' && pathname === '/api/name-collisions') {
        return sendJson(res, 200, { ok: true, ...engine.analytics().nameCollisions });
      }
      if (req.method === 'GET' && pathname === '/api/pending') {
        return sendJson(res, 200, { ok: true, pending: engine.analytics().pending });
      }
      if (req.method === 'GET' && pathname === '/api/list') {
        return sendJson(res, 200, { ok: true, ...engine.listDir(url.searchParams.get('dir') || '') });
      }
      if (req.method === 'GET' && pathname === '/api/file') {
        const p = url.searchParams.get('path') || '';
        const d = engine.resolveRead(p);
        let text = null;
        if (/\.(txt|md|json|csv|log|js|css|html?|ya?ml|toml)$/i.test(p)) {
          text = fs.readFileSync(d.abs, 'utf8').slice(0, 200_000);
        }
        return sendJson(res, 200, { ok: true, path: p, source: d.source, digest: d.digest, size: d.size, preview: text });
      }
      if (req.method === 'GET' && pathname === '/raw') {
        return handleRaw(res, url);
      }

      if (req.method !== 'POST' && pathname.startsWith('/api/')) {
        throw new MigrateError('BAD_REQUEST', `不支持的方法/路由: ${req.method} ${pathname}`);
      }

      // ---------- 操作 API ----------
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        const body = await readJsonBody(req);

        if (pathname === '/api/scan') return sendJson(res, 200, { ok: true, result: engine.scan() });
        if (pathname === '/api/ingest') {
          return sendJson(res, 200, { ok: true, result: engine.ingest({ paths: body.paths, force: !!body.force }) });
        }
        if (pathname === '/api/switch') {
          // body.path 为单路径形式（可带 expectedVersion 做 If-Match 乐观锁）；
          // body.paths 或缺省为批量形式，冲突逐项放进报告。
          return sendJson(res, 200, {
            ok: true,
            result: engine.switchRefs({
              path: body.path,
              paths: body.paths,
              expectedVersion: body.expectedVersion,
            }),
          });
        }
        if (pathname === '/api/recheck') {
          if (!body.path) throw new MigrateError('BAD_REQUEST', '缺少 path');
          return sendJson(res, 200, { ok: true, result: engine.recheck(body.path) });
        }
        if (pathname === '/api/verify') {
          return sendJson(res, 200, { ok: true, result: engine.verify({ paths: body.paths }) });
        }
        if (pathname === '/api/cleanup') {
          return sendJson(res, 200, { ok: true, result: engine.cleanup({ paths: body.paths }) });
        }
        if (pathname === '/api/purge') {
          return sendJson(res, 200, { ok: true, result: engine.purge({}) });
        }
        if (pathname === '/api/resume') {
          return sendJson(res, 200, { ok: true, result: engine.resume() });
        }
        if (pathname === '/api/rollback') {
          return sendJson(res, 200, {
            ok: true,
            result: engine.rollback({ path: body.path, paths: body.paths, all: !!body.all }),
          });
        }
        if (pathname === '/api/settings') {
          return sendJson(res, 200, { ok: true, settings: engine.updateSettings(body) });
        }
        if (pathname === '/api/resolve-pause') {
          if (!body.id || !body.decision) throw new MigrateError('BAD_REQUEST', '需要 id 与 decision');
          return sendJson(res, 200, {
            ok: true,
            result: engine.resolvePause(body.id, body.decision, { confirm: body.confirm, note: body.note }),
          });
        }

        // ---------- 演示/演练辅助 ----------
        if (pathname === '/api/demo/arm-fault') {
          if (!body.point) throw new MigrateError('BAD_REQUEST', '缺少 point');
          engine.armFault(body.point);
          return sendJson(res, 200, { ok: true, armed: body.point });
        }
        if (pathname === '/api/demo/modify') {
          // 模拟“另一个进程”在迁移期间/之后改写文件
          const snap = engine.snapshot();
          let rel = body.path;
          if (!rel) {
            const candidates = Object.values(snap.journal.items)
              .filter((it) => it.liveExists !== false)
              .map((it) => it.path);
            rel = candidates.includes('parallel-edit.txt')
              ? 'parallel-edit.txt'
              : candidates[0];
          }
          if (!rel) throw new MigrateError('BAD_REQUEST', '没有可修改的文件');
          const { abs } = engine._safeRel(rel);
          const stamp = new Date().toISOString();
          if (body.mode === 'overwrite') fs.writeFileSync(abs, `被外部进程整体覆盖 @ ${stamp}\n随机串 ${Math.random()}\n`);
          else fs.appendFileSync(abs, `外部并行追加 @ ${stamp}\n`);
          return sendJson(res, 200, { ok: true, path: rel });
        }
        if (pathname === '/api/demo/reset') {
          const marker = path.join(root, '.cas-migration', 'demo-marker');
          if (!body.force && !fs.existsSync(marker)) {
            throw new MigrateError('BAD_REQUEST', '该目录不是演示库（缺少 demo-marker）；如确需重置请显式 force');
          }
          engine.faults.clear();
          const result = seedDemo(root, { scenario: body.scenario || 'mixed' });
          return sendJson(res, 200, { ok: true, result });
        }

        throw new MigrateError('NOT_FOUND', `未知 API: ${pathname}`);
      }

      // ---------- 静态页面 ----------
      if (req.method === 'GET') return serveStatic(req, res, pathname);

      sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: req.method } });
    } catch (e) {
      sendError(res, e);
    }
  };

  const server = http.createServer(handler);
  return { handler, server, engine, root };
}

module.exports = { createApp };
