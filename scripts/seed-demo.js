'use strict';

/**
 * 构造一个能直接展示全部要点的演示文件库：
 *  - 多组“同内容复用”（完全相同的字节出现在多个路径）
 *  - 多组“同名不同内容”（notes.txt / settings.json / report.csv）
 *  - 混合迁移阶段：已清理 / 已切换核对 / 冲突 / 待切换 / 仅发现
 */

const fs = require('fs');
const path = require('path');
const { MigrationEngine } = require('../src/core/engine');

const INTRO = `项目介绍\n========\n这是一份在多个目录中保持完全一致的介绍文档，用来演示“同内容复用”。\n版本 v1，内容固定。\n`;

const TERMS = `服务条款（演示文本）\n1. 摘要相同即内容相同。\n2. 旧路径读取语义由 path -> sha256 引用维持。\n`.repeat(3);

const BANNER = `████ BANNER ████\n同一份横幅素材在三处引用，CAS 中只存一个对象。\n`.repeat(2);

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function buildFiles(root) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  // —— 同内容复用组 1：不同文件名、相同内容 ——
  write(root, 'guide/intro.md', INTRO);
  write(root, 'docs/intro-copy.md', INTRO);

  // —— 同内容复用组 2：terms.txt 两处 ——
  write(root, 'legal/terms.txt', TERMS);
  write(root, 'docs/terms.txt', TERMS);

  // —— 同内容复用组 3：banner 三份 ——
  write(root, 'branding/banner.txt', BANNER);
  write(root, 'web/assets/banner.txt', BANNER);
  write(root, 'backup/banner-2025.txt', BANNER);

  // —— 同名不同内容：notes.txt 三个版本 ——
  write(root, 'notes.txt', '根目录备忘录：周五发布，记得跑迁移核对。\n');
  write(root, 'work/notes.txt', '工作组笔记：CAS 对象路径是 aa/bbbb...，引用文件是 refs.json。\n'.repeat(2));
  write(root, 'archive/notes.txt', '2024 归档笔记：旧方案按路径存盘，没有去重。\n');

  // —— 同名不同内容：settings.json ——
  write(root, 'config/settings.json', JSON.stringify({ theme: 'dark', retries: 3, lang: 'zh-CN' }, null, 2) + '\n');
  write(root, 'fixtures/settings.json', JSON.stringify({ theme: 'light', retries: 1, env: 'test' }, null, 2) + '\n');

  // —— 同名不同内容：report.csv ——
  write(root, 'finance/report.csv', 'month,revenue\n2026-10,12000\n2026-11,15300\n');
  write(root, 'experimental/report.csv', 'month,score\n2026-10,88\n2026-11,95\n');

  // —— 普通唯一文件 ——
  write(root, 'README.txt', '演示文件库\n==========\n用页面或 CLI 操作迁移流水线。\n');
  write(root, 'docs/architecture.md', '# 架构\njournal.json + refs.json + cas/objects + old/files 回退区。\n');
  write(root, 'photos/caption.txt', '这里假装是一张照片的说明文字（演示库不放置大二进制）。\n');

  // —— 专门用于演练“并行修改竞争”的文件 ——
  write(root, 'parallel-edit.txt', '初始版本：迁移程序已经为我拍了摘要快照。\n');

  // —— 一个暂时不收录、保持“仅发现”状态的草稿 ——
  write(root, 'draft/scratch.txt', '草稿：还没轮到我 ingest，所以我会出现在未切换列表的最早阶段。\n');

  fs.mkdirSync(path.join(root, '.cas-migration'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.cas-migration', 'demo-marker'),
    `digest-migration-demo\n${new Date().toISOString()}\n`
  );
}

/**
 * @param {string} root
 * @param {{scenario?:'mixed'|'fresh'}} [opts]
 */
function seedDemo(root, opts = {}) {
  const scenario = opts.scenario || 'mixed';
  buildFiles(root);

  const engine = new MigrationEngine({ root });
  engine.scan();

  if (scenario === 'fresh') {
    return { root, scenario, note: '已生成全新演示库并完成扫描' };
  }

  // mixed：收录除 draft/scratch.txt 外的全部文件
  const snap0 = engine.snapshot();
  const allButDraft = Object.keys(snap0.journal.items).filter((p) => p !== 'draft/scratch.txt');
  engine.ingest({ paths: allButDraft });

  // 切换 + 核对一批
  const switched = [
    'README.txt',
    'guide/intro.md',
    'branding/banner.txt',
    'config/settings.json',
    'legal/terms.txt',
    'web/assets/banner.txt',
  ];
  engine.switchRefs({ paths: switched });
  engine.verify({ paths: switched });

  // 其中两个执行“旧数据清理”（移入回退区，窗口内保留）
  engine.cleanup({ paths: ['legal/terms.txt', 'web/assets/banner.txt'] });

  // 制造一个真实的并行修改竞争：收录后外部追加内容，再带旧版本令牌切换 -> 409/conflict
  const before = engine.snapshot();
  const oldVersion = before.journal.items['parallel-edit.txt'].baseVersion;
  fs.appendFileSync(path.join(root, 'parallel-edit.txt'), '并行进程在迁移切换前追加的新内容！\n');
  let conflictResult = null;
  try {
    engine.switchRefs({ path: 'parallel-edit.txt', expectedVersion: oldVersion });
  } catch (e) {
    conflictResult = { code: e.code, message: e.message, details: e.details };
  }

  return { root, scenario, switched, cleaned: ['legal/terms.txt', 'web/assets/banner.txt'], conflictResult };
}

if (require.main === module) {
  const argRoot = process.argv[2];
  const root = argRoot
    ? path.resolve(argRoot)
    : path.join(__dirname, '..', 'library');
  const scenario = process.argv.includes('--fresh') ? 'fresh' : 'mixed';
  const r = seedDemo(root, { scenario });
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { seedDemo, buildFiles };
