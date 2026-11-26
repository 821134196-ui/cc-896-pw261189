'use strict';

const fs = require('fs');
const path = require('path');
const { Journal } = require('./journal');
const { CasStore } = require('./cas');
const { FileLock, mkdirp } = require('./atomic');
const { statVersion, hashFile } = require('./versions');
const { toRel, resolveInside, assertRealInside, dirOf, baseName, immediateChildren } = require('./paths');
const {
  MigrateError, VersionConflictError, SoleCopyError, FaultInjected,
} = require('./errors');

function nowIso() { return new Date().toISOString(); }

class MigrationEngine {
  /**
   * @param {object} opts
   * @param {string} opts.root 本地文件库根目录（旧的按路径存储）
   * @param {string} [opts.stateDir] 迁移状态目录，默认 <root>/.cas-migration
   */
  constructor(opts = {}) {
    if (!opts.root) throw new MigrateError('BAD_REQUEST', '缺少 root（文件库根目录）');
    this.root = path.resolve(opts.root);
    mkdirp(this.root);
    this.rootReal = fs.realpathSync(this.root);
    this.stateDir = opts.stateDir
      ? path.resolve(opts.stateDir)
      : path.join(this.root, '.cas-migration');
    mkdirp(this.stateDir);
    this.journal = new Journal(this.stateDir, this.root);
    this.cas = new CasStore(this.stateDir);
    this.oldDir = this.journal.oldDir;
    this.faults = opts.faults instanceof Set ? opts.faults : new Set();
    this.state = null;
    this.refsDoc = null;
  }

  // ---------------------------------------------------------------------------
  // 基础设施：锁 / 重载 / 保存 / 故障注入
  // ---------------------------------------------------------------------------

  _withLock(fn) {
    mkdirp(this.stateDir);
    const lock = new FileLock(this.journal.lockFile);
    lock.acquire();
    let faulted = false;
    try {
      this.state = this.journal.load();
      this.refsDoc = this.journal.loadRefs();
      // 保证磁盘上始终有可核对的 journal / refs 文件（即使尚未发生成功切换）
      if (!fs.existsSync(this.journal.file)) this._save();
      if (!fs.existsSync(this.journal.refsFile)) this._saveRefs();
      this._reconcile();
      const out = fn();
      this.journal.save(this.state);
      return out;
    } catch (e) {
      if (e instanceof FaultInjected) {
        faulted = true; // 模拟进程崩溃：最后的状态不落盘
        throw e;
      }
      try { if (this.state) this.journal.save(this.state); } catch { /* ignore */ }
      throw e;
    } finally {
      if (!faulted) { /* state already saved above */ }
      lock.release();
    }
  }

  _save() {
    this.journal.save(this.state);
  }

  /** 只读视图：加锁并重载磁盘最新状态，但不回写 journal。 */
  _withReadLock(fn) {
    mkdirp(this.stateDir);
    const lock = new FileLock(this.journal.lockFile);
    lock.acquire();
    try {
      this.state = this.journal.load();
      this.refsDoc = this.journal.loadRefs();
      return fn();
    } finally {
      lock.release();
    }
  }

  _saveRefs() {
    this.journal.saveRefs(this.refsDoc);
  }

  _history(action, detail = {}) {
    this.journal.appendHistory(this.state, action, detail);
  }

  _phase(name, patch) {
    this.state.phases[name] = { ...this.state.phases[name], ...patch };
  }

  /** 测试/演练用：在指定检查点制造一次性“崩溃”。 */
  armFault(point) { this.faults.add(point); }

  _fault(point) {
    if (this.faults.has(point)) {
      this.faults.delete(point); // 一次性
      throw new FaultInjected(point);
    }
  }

  _freeBytes() {
    const assumed = this.state?.settings?.assumeFreeBytes;
    if (Number.isFinite(assumed)) return assumed;
    const st = fs.statfsSync(this.stateDir);
    return st.bavail * st.bsize;
  }

  /**
   * 所有来自 API/CLI 的不可信路径入口：规范化为 POSIX rel，
   * 并强制解析结果仍在库根目录内（拒绝绝对路径与 .. 逃逸）。
   */
  _safeRel(relRaw) {
    const rel0 = toRel(relRaw, this.root);
    const abs = resolveInside(this.root, rel0);
    // 符号链接感知：即使词法在 root 内，realpath 逃出 root 也拒绝
    assertRealInside(this.rootReal, abs);
    const rel = toRel(abs, this.root); // 折叠 a/../b 等
    return { rel, abs };
  }

  // ---------------------------------------------------------------------------
  // 目录遍历
  // ---------------------------------------------------------------------------

  _walkLibraryFiles() {
    const out = [];
    const skipDir = this.stateDir + path.sep;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const abs = path.join(dir, ent.name);
        if (abs === this.stateDir || abs.startsWith(skipDir)) continue;
        let st;
        try { st = fs.lstatSync(abs); } catch { continue; }
        // 不跟随符号链接：库内 symlink 可能指向库外，跟随会把外部文件纳入迁移/移动
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) walk(abs);
        else if (st.isFile()) out.push(abs);
      }
    };
    walk(this.root);
    return out;
  }

  // ---------------------------------------------------------------------------
  // 崩溃恢复 / 对账：以 refs.json（引用提交点）和磁盘实际状态为准
  // ---------------------------------------------------------------------------

  _reconcile() {
    const state = this.state;
    const refs = this.refsDoc.refs;
    let changed = false;

    for (const item of Object.values(state.items)) {
      const rel = item.path;
      const ref = refs[rel];
      const absLive = path.join(this.root, rel);
      const absBackup = item.backupRel
        ? path.join(this.oldDir, item.backupRel)
        : path.join(this.oldDir, rel);
      const liveExists = fs.existsSync(absLive);
      item.liveExists = liveExists;

      if (ref) {
        // 崩溃窗口：refs 已提交，但 journal 还停在 ingested/discovered
        if (['discovered', 'ingested', 'rolled_back'].includes(item.state)) {
          if (item.digest === ref.digest || !item.digest) {
            item.digest = ref.digest;
            item.state = 'switched';
            item.switchedAt = item.switchedAt || ref.switchedAt;
            changed = true;
          }
        }
        // 崩溃窗口：cleanup 已把文件移入 old/，但 journal 还停在 switched/verified
        if (['switched', 'verified'].includes(item.state) && !liveExists && fs.existsSync(absBackup)) {
          try {
            if (hashFile(absBackup) === ref.digest) {
              const bst = fs.statSync(absBackup);
              item.state = 'cleaned';
              item.backupRel = rel;
              item.cleanedAt = bst.mtime.toISOString();
              item.purgeAfter = Date.parse(item.cleanedAt) + (this.state.settings.rollbackWindowMs || 0);
              changed = true;
            }
          } catch { /* 哈希失败则留给后续预检处理 */ }
        }
        // cleanup/purge 过程中的崩溃对账
        if (item.state === 'cleaned') {
          const backupExists = fs.existsSync(absBackup);
          if (!backupExists) {
            if (liveExists) {
              // 回退移动已把文件放回 live，backup 已消失；
              // 追认 verified 前先哈希：若内容与引用不符（外部重建的新版本），标 drift。
              try {
                const liveDigest = hashFile(absLive);
                if (ref && liveDigest !== ref.digest) {
                  item.state = 'drift';
                  item.possibleDrift = true;
                  item.statDirty = true;
                  item.drift = { at: nowIso(), actualDigest: liveDigest, refDigest: ref.digest, reconcile: true };
                  changed = true;
                } else {
                  item.state = 'verified';
                  item.backupRel = null;
                  changed = true;
                }
              } catch {
                item.state = 'verified';
                item.backupRel = null;
                changed = true;
              }
            } else if (this.cas.has(ref.digest)) {
              // purge unlink 后、journal 落盘前崩溃
              item.state = 'purged';
              item.purgedAt = item.purgedAt || nowIso();
              changed = true;
            }
          } else if (!item.backupRel) {
            item.backupRel = rel;
            changed = true;
          }
        }
        continue;
      }

      // ref 不存在，但 journal 认为已经切换过 => 回退的 refs 提交已发生，补完恢复
      if (['switched', 'drift', 'verified', 'cleaned', 'purged'].includes(item.state)) {
        try {
          this._restoreBytesForRollback(item, absLive, absBackup);
          const st = fs.statSync(absLive);
          const digest = hashFile(absLive);
          this.cas.putFile(absLive, digest);
          item.digest = digest;
          item.size = st.size;
          item.baseVersion = statVersion(st);
          item.version = item.baseVersion;
          item.statDirty = false;
          item.state = 'ingested';
          item.rolledBackAt = nowIso();
          changed = true;
        } catch (e) {
          item.lastError = `对账恢复失败: ${e.message}`;
          changed = true;
        }
      }
    }
    if (changed) this._save();
  }

  /** 为回退/对账把路径的字节恢复出来：live 已在则不动；否则 quarantine；再否则 CAS。 */
  _restoreBytesForRollback(item, absLive, absBackup) {
    if (fs.existsSync(absLive)) return 'live-existing';
    mkdirp(path.dirname(absLive));
    if (fs.existsSync(absBackup)) {
      try {
        fs.renameSync(absBackup, absLive);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(absBackup, absLive);
        fs.unlinkSync(absBackup);
      }
      return 'quarantine';
    }
    const digest = item.digest;
    if (digest && this.cas.has(digest) && this.cas.verify(digest).ok) {
      fs.copyFileSync(this.cas.objectPath(digest), absLive);
      return 'cas';
    }
    throw new SoleCopyError('SOLE_COPY', `路径 ${item.path} 没有任何可恢复副本（live/quarantine/CAS 均缺失）`, {
      path: item.path,
    });
  }

  // ---------------------------------------------------------------------------
  // 步骤 1：扫描
  // ---------------------------------------------------------------------------

  scan() { return this._withLock(() => this._scan()); }

  _scan() {
    const absFiles = this._walkLibraryFiles();
    const seen = new Set();
    let created = 0;
    let versionChanged = 0;

    for (const abs of absFiles) {
      const rel = toRel(abs, this.root);
      seen.add(rel);
      const st = fs.statSync(abs);
      const v = statVersion(st);
      let item = this.state.items[rel];
      if (!item) {
        item = {
          path: rel,
          name: baseName(rel),
          dir: dirOf(rel),
          size: st.size,
          state: 'discovered',
          version: v,
          baseVersion: null,
          statDirty: false,
          digest: null,
          switchedDigest: null,
          casReused: false,
          liveExists: true,
          createdAt: nowIso(),
        };
        this.state.items[rel] = item;
        created += 1;
      } else {
        item.name = baseName(rel);
        item.dir = dirOf(rel);
        item.size = st.size;
        item.version = v;
        item.liveExists = true;
        if (item.baseVersion && v !== item.baseVersion) {
          if (!item.statDirty) versionChanged += 1;
          item.statDirty = true;
          item.possibleDrift = ['switched', 'verified'].includes(item.state);
        }
        // 关键边界：cleaned/purged 意味着原始 live 已被移走/清除，
        // 此时旧路径上又出现文件（外部重建/并行写入），一律做权威哈希：
        // 与引用不同就是必须显示和处置的新版本，不能在 pending 视图里隐身。
        // 注意不能依赖 liveExists===false 做前置条件：_reconcile 会先于 scan 刷新它。
        if (['cleaned', 'purged'].includes(item.state)) {
          try {
            const reappearedDigest = hashFile(abs);
            const expectedDigest = this.refsDoc?.refs?.[rel]?.digest || item.digest;
            if (expectedDigest && reappearedDigest !== expectedDigest) {
              item.state = 'drift';
              item.possibleDrift = true;
              item.reappearedWithChanges = true;
              item.statDirty = true;
              item.drift = {
                at: nowIso(),
                actualDigest: reappearedDigest,
                refDigest: expectedDigest,
                reappearedAfter: item.purgedAt ? 'purged' : 'cleaned',
              };
              versionChanged += 1;
            } else {
              item.reappearedWithChanges = false;
            }
          } catch { /* 哈希失败留给 verify/后续扫描 */ }
        }
      }
    }

    for (const item of Object.values(this.state.items)) {
      if (seen.has(item.path)) continue;
      item.liveExists = false;
      if (['discovered', 'ingested', 'conflict', 'rolled_back'].includes(item.state)) {
        item.state = 'missing';
      }
      // switched/verified/cleaned/purged 下 live 不在是允许的（CAS / quarantine 负责）
    }

    this._phase('scan', {
      state: 'done',
      at: nowIso(),
      detail: { total: seen.size, created, versionChanged },
    });
    this._history('scan', { total: seen.size, created, versionChanged });
    return { total: seen.size, created, versionChanged };
  }

  // ---------------------------------------------------------------------------
  // 步骤 2：收录到 CAS（同内容在此自然去重复用）
  // ---------------------------------------------------------------------------

  ingest(opts = {}) {
    return this._withLock(() => this._ingest(opts));
  }

  _selectPaths(opts) {
    if (opts.paths && opts.paths.length) {
      return opts.paths.map((p) => this._safeRel(p).rel);
    }
    return Object.keys(this.state.items).sort();
  }

  _ingest(opts = {}) {
    if (!this.state.phases.scan.at) this._scan();
    const paths = this._selectPaths(opts);
    const report = { ingested: [], reused: [], skipped: [], conflicts: [] };

    for (const rel of paths) {
      const item = this.state.items[rel];
      if (!item) { report.skipped.push({ path: rel, reason: 'unknown' }); continue; }
      if (item.state === 'conflict' && !opts.force) {
        report.conflicts.push({ path: rel, reason: 'conflict_needs_recheck' });
        continue;
      }
      if (!item.liveExists && !fs.existsSync(path.join(this.root, rel))) {
        report.skipped.push({ path: rel, reason: 'live_missing' });
        continue;
      }
      // 已收录且版本令牌一致 + CAS 对象完好 => 幂等跳过
      const abs = path.join(this.root, rel);
      const st = fs.statSync(abs);
      const v = statVersion(st);
      if (
        item.state === 'ingested' && item.digest &&
        v === item.baseVersion && this.cas.has(item.digest)
      ) {
        report.skipped.push({ path: rel, reason: 'up_to_date' });
        continue;
      }
      try {
        const put = this.cas.putFile(abs);
        this._fault('ingest:after-cas-put'); // 崩溃点：CAS 已写，journal 未更新
        item.digest = put.digest;
        item.size = put.size;
        item.baseVersion = v;
        item.version = v;
        item.statDirty = false;
        item.state = 'ingested';
        item.lastError = null;
        item.ingestedAt = nowIso();
        this._save();
        report.ingested.push({ path: rel, digest: put.digest, reused: put.reused });
        if (put.reused) report.reused.push({ path: rel, digest: put.digest });
      } catch (e) {
        if (e instanceof FaultInjected) throw e; // 故障注入必须穿透，模拟真实崩溃
        item.state = 'error';
        item.lastError = e.message;
        this._save();
        report.skipped.push({ path: rel, reason: `error: ${e.message}` });
      }
    }

    this._phase('ingest', { state: 'done', at: nowIso(), detail: { count: report.ingested.length } });
    this._history('ingest', { count: report.ingested.length, reused: report.reused.length });
    return report;
  }

  /** 显式接受外部并行修改：重新摘要并收录当前内容。 */
  recheck(relRaw) {
    return this._withLock(() => {
      const { rel, abs } = this._safeRel(relRaw);
      const item = this.state.items[rel];
      if (!item) throw new MigrateError('NOT_FOUND', `未知路径: ${rel}`);
      if (!fs.existsSync(abs)) throw new MigrateError('NOT_FOUND', `文件不存在: ${rel}`);
      const st = fs.statSync(abs);
      const v = statVersion(st);
      const put = this.cas.putFile(abs);
      item.digest = put.digest;
      item.size = put.size;
      item.baseVersion = v;
      item.version = v;
      item.statDirty = false;
      item.conflictAt = null;
      item.conflict = null;
      item.lastError = null;
      // 若旧引用还在且摘要不同 => 需要重新 switch；否则回到待切换
      const ref = this.refsDoc.refs[rel];
      if (ref && ref.digest !== put.digest) {
        item.state = 'ingested';
        item.needsReswitch = true;
      } else if (ref) {
        item.state = 'switched';
        item.needsReswitch = false;
      } else {
        item.state = 'ingested';
      }
      this._save();
      this._history('recheck', { path: rel, digest: put.digest });
      return { path: rel, digest: put.digest, state: item.state };
    });
  }

  // ---------------------------------------------------------------------------
  // 步骤 3：切换引用（发布 path -> digest 的 refs.json，乐观版本校验）
  // ---------------------------------------------------------------------------

  switchRefs(opts = {}) {
    return this._withLock(() => this._switchRefs(opts));
  }

  _switchRefs(opts = {}) {
      // 单路径形式：始终只处理这一个 path；带 expectedVersion 时执行乐观锁校验，
      // 冲突直接抛 VersionConflictError（HTTP 409）。
      if (opts.path) {
        const { rel } = this._safeRel(opts.path);
        const item = this.state.items[rel];
        // 与批量形式一致的幂等短路：已是 switched 且引用摘要一致、且未携带显式版本令牌时不重复提交
        if (
          opts.expectedVersion === undefined &&
          item?.state === 'switched' &&
          this.refsDoc.refs[rel]?.digest === item.digest
        ) {
          return { switched: [rel], conflicts: [], idempotent: [rel] };
        }
        this._switchOne(rel, opts.expectedVersion);
        return { switched: [rel], conflicts: [] };
      }
      const paths = opts.paths?.length
        ? opts.paths.map((p) => this._safeRel(p).rel)
        : Object.keys(this.state.items).sort();
      const report = { switched: [], conflicts: [], errors: [] };
      for (const rel of paths) {
        const item = this.state.items[rel];
        if (!item) { report.errors.push({ path: rel, message: 'unknown path' }); continue; }
        if (item.state === 'switched' && this.refsDoc.refs[rel]?.digest === item.digest) {
          report.switched.push({ path: rel, idempotent: true });
          continue;
        }
        if (item.state === 'purged' || item.state === 'cleaned') {
          // 已切换过的生命周期后段，引用必然已发布
          if (this.refsDoc.refs[rel]) { report.switched.push({ path: rel, idempotent: true }); continue; }
        }
        if (item.state === 'conflict') {
          report.conflicts.push({ path: rel, reason: 'conflict_needs_recheck' });
          continue;
        }
        try {
          this._switchOne(rel, opts.expectedVersion);
          report.switched.push({ path: rel });
        } catch (e) {
          if (e instanceof FaultInjected) throw e; // 崩溃注入穿透
          if (e instanceof VersionConflictError) {
            report.conflicts.push({ path: rel, message: e.message, details: e.details });
          } else {
            report.errors.push({ path: rel, message: e.message });
          }
        }
      }
      this._phase('switch', {
        state: report.conflicts.length ? 'partial' : 'done',
        at: nowIso(),
        detail: { switched: report.switched.length, conflicts: report.conflicts.length },
      });
      this._history('switch', { switched: report.switched.length, conflicts: report.conflicts.length });
      return report;
  }

  _switchOne(relRaw, expectedVersion) {
    const { rel, abs } = this._safeRel(relRaw);
    const item = this.state.items[rel];
    if (!item) throw new MigrateError('NOT_FOUND', `未知路径: ${rel}`);
    if (!fs.existsSync(abs)) {
      item.state = 'missing';
      this._save();
      throw new MigrateError('NOT_FOUND', `旧路径文件已不存在，无法做版本校验: ${rel}`);
    }
    const st = fs.statSync(abs);
    const currentVersion = statVersion(st);

    // 乐观锁：客户端携带的版本令牌必须仍是当前版本
    if (expectedVersion != null && expectedVersion !== currentVersion) {
      item.state = 'conflict';
      item.statDirty = true;
      item.version = currentVersion;
      item.conflict = { at: nowIso(), expectedVersion, currentVersion, kind: 'version-token' };
      this._save();
      throw new VersionConflictError(`版本已变化，拒绝覆盖式切换: ${rel}`, {
        path: rel, expectedVersion, currentVersion,
      });
    }

    if (!item.digest) {
      throw new MigrateError('BAD_REQUEST', `路径尚未收录摘要，请先 ingest: ${rel}`);
    }

    // 权威校验：重新哈希。即使 mtime/size 被伪装，内容竞争也逃不过摘要比对。
    const actualDigest = hashFile(abs);
    if (actualDigest !== item.digest) {
      item.state = 'conflict';
      item.statDirty = true;
      item.version = currentVersion;
      item.conflict = {
        at: nowIso(), kind: 'digest-mismatch',
        migratedDigest: item.digest, actualDigest,
      };
      this._save();
      throw new VersionConflictError(`迁移期间文件被并行修改，摘要不一致: ${rel}`, {
        path: rel, migratedDigest: item.digest, actualDigest, currentVersion,
      });
    }

    if (currentVersion !== item.baseVersion) item.baseVersion = currentVersion; // 仅 touch 类元数据变化，内容一致

    const oldRef = this.refsDoc.refs[rel];
    this.refsDoc.refs[rel] = {
      digest: item.digest,
      size: item.size,
      version: currentVersion,
      switchedAt: nowIso(),
      switchCount: (oldRef?.switchCount || 0) + 1,
    };
    this.refsDoc.version += 1;
    this._saveRefs(); // 引用更新的提交点（原子写）
    this._fault('switch:after-refs'); // 崩溃点：引用已切换，journal 尚未记录

    item.state = 'switched';
    item.switchedDigest = item.digest;
    item.switchedAt = nowIso();
    item.needsReswitch = false;
    item.conflict = null;
    this._save();
  }

  // ---------------------------------------------------------------------------
  // 步骤 4：核对引用（独立、可复查；也是清理前的强制预检）
  // ---------------------------------------------------------------------------

  verify(opts = {}) {
    return this._withLock(() => this._verifyAll(opts));
  }

  _verifyAll(opts = {}) {
    let paths;
    if (opts.paths?.length) paths = opts.paths.map((p) => this._safeRel(p).rel);
    else paths = Object.keys(this.refsDoc.refs);

    const report = { checked: 0, ok: 0, failed: [], drift: [], results: [] };
    for (const rel of paths) {
      const r = this._verifyOne(rel);
      report.checked += 1;
      report.results.push(r);
      if (r.ok) report.ok += 1;
      if (r.legacy === 'drifted') report.drift.push({ path: rel, actualDigest: r.actualDigest });
      if (!r.ok) report.failed.push({ path: rel, reason: r.reason });
      const item = this.state.items[rel];
      if (item) this._applyVerifyToItem(item, r);
    }
    this._save();
    const summary = {
      checked: report.checked, ok: report.ok,
      failed: report.failed.length, drift: report.drift.length, at: nowIso(),
    };
    this._phase('verify', {
      state: report.failed.length ? 'failed' : (report.drift.length ? 'drift' : 'done'),
      at: nowIso(),
      report: summary,
    });
    this._history('verify', summary);
    return report;
  }

  /**
   * 核对单项：
   *  1) refs 指向的 CAS 对象存在且摘要正确；
   *  2) 通过“旧路径读取语义”读到的字节摘要与引用一致；
   *  3) 若 live 旧文件还在，比较它是否在切换后被改写（drift）。
   */
  _verifyOne(rel) {
    const ref = this.refsDoc.refs[rel];
    if (!ref) return { path: rel, ok: false, reason: 'no_ref' };
    const cv = this.cas.verify(ref.digest);
    if (!cv.ok) return { path: rel, ok: false, reason: `cas_${cv.reason}`, digest: ref.digest };

    // 通过路径读取服务取字节（CAS 路径），再次哈希，验证“按旧路径读”的链路
    let readDigest;
    try {
      const buf = this.cas.readBuffer(ref.digest);
      readDigest = require('crypto').createHash('sha256').update(buf).digest('hex');
    } catch (e) {
      return { path: rel, ok: false, reason: `readback_error: ${e.message}` };
    }
    if (readDigest !== ref.digest) return { path: rel, ok: false, reason: 'readback_digest_mismatch' };

    const abs = path.join(this.root, rel);
    let legacy = 'absent';
    let actualDigest = null;
    if (fs.existsSync(abs)) {
      actualDigest = hashFile(abs);
      legacy = actualDigest === ref.digest ? 'matches' : 'drifted';
    }
    return { path: rel, ok: true, reason: null, digest: ref.digest, legacy, actualDigest };
  }

  _applyVerifyToItem(item, r) {
    item.verification = { at: nowIso(), casOk: r.ok, legacy: r.legacy, reason: r.reason };
    if (!r.ok) {
      item.lastError = `引用核对失败: ${r.reason}`;
      return;
    }
    if (r.legacy === 'drifted') {
      // 切换后旧路径又被并行改写：新内容尚未进入 CAS，清理它等于删掉唯一副本 —— 阻止清理
      item.state = 'drift';
      item.possibleDrift = true;
      item.drift = { at: nowIso(), actualDigest: r.actualDigest, refDigest: this.refsDoc.refs[item.path]?.digest };
      return;
    }
    if (item.state === 'switched' || item.state === 'drift') {
      item.state = 'verified';
      item.verifiedAt = nowIso();
      item.lastError = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 步骤 5：旧数据清理（live -> quarantine，保留整个回退窗口，不物理删除）
  // ---------------------------------------------------------------------------

  cleanup(opts = {}) {
    return this._withLock(() => this._cleanup(opts));
  }

  _cleanup(opts = {}) {
    let paths;
    if (opts.paths?.length) paths = opts.paths.map((p) => this._safeRel(p).rel);
    else paths = Object.keys(this.refsDoc.refs).sort();

    const report = { moved: [], alreadyAbsent: [], blocked: [] };
    for (const rel of paths) {
      const item = this.state.items[rel];
      if (!item) { report.blocked.push({ path: rel, reason: 'unknown_item' }); continue; }
      if (item.state === 'cleaned' || item.state === 'purged') {
        report.alreadyAbsent.push({ path: rel, reason: item.state });
        continue;
      }
      // 强制最新预检：引用 + CAS + 回读 + live 未漂移
      const v = this._verifyOne(rel);
      this._applyVerifyToItem(item, v);
      if (!v.ok) {
        report.blocked.push({ path: rel, reason: v.reason, message: '摘要副本不可用，禁止移走旧文件（唯一副本保护）' });
        continue;
      }
      if (v.legacy === 'drifted') {
        report.blocked.push({
          path: rel, reason: 'unmigrated_change',
          message: '旧路径在切换后被改写且新版本尚未迁入摘要库；移走会删掉唯一副本。请先 recheck + switch。',
        });
        this._save();
        continue;
      }

      const absLive = path.join(this.root, rel);
      const conventionalBackup = path.join(this.oldDir, rel);
      if (!fs.existsSync(absLive)) {
        // live 已不在：若回退区已有同路径副本（崩溃遗留），追认它；否则记录为无 quarantine 字节
        if (fs.existsSync(conventionalBackup)) {
          item.state = 'cleaned';
          item.backupRel = rel;
          const bst = fs.statSync(conventionalBackup);
          item.cleanedAt = bst.mtime.toISOString();
          item.purgeAfter = Date.parse(item.cleanedAt) + this.state.settings.rollbackWindowMs;
          this._save();
          report.moved.push({ path: rel, adoptedOrphanBackup: true });
          continue;
        }
        // live 已不在（外部删除/中断遗留）：CAS 核对通过，仍可进入 cleaned，无 quarantine 字节
        item.state = 'cleaned';
        item.cleanedAt = nowIso();
        item.purgeAfter = Date.now() + this.state.settings.rollbackWindowMs;
        item.backupRel = null;
        item.noQuarantineCopy = true;
        this._save();
        report.alreadyAbsent.push({ path: rel, reason: 'live_already_absent_cas_verified' });
        continue;
      }

      const absBackup = path.join(this.oldDir, rel);
      if (fs.existsSync(absBackup)) {
        report.blocked.push({ path: rel, reason: 'backup_exists', message: '回退区已存在同路径备份，拒绝覆盖' });
        continue;
      }
      mkdirp(path.dirname(absBackup));
      const st = fs.statSync(absLive);
      try {
        fs.renameSync(absLive, absBackup);
      } catch (e) {
        if (e.code !== 'EXDEV') {
          report.blocked.push({ path: rel, reason: `move_error: ${e.message}` });
          continue;
        }
        fs.copyFileSync(absLive, absBackup);
        fs.unlinkSync(absLive);
      }
      this._fault('cleanup:after-move'); // 崩溃点：已移入回退区，journal 未更新

      item.state = 'cleaned';
      item.cleanedAt = nowIso();
      item.cleanedStat = { atimeMs: st.atimeMs, mtimeMs: st.mtimeMs };
      item.purgeAfter = Date.now() + this.state.settings.rollbackWindowMs;
      item.backupRel = rel;
      this._save();
      report.moved.push({ path: rel, backup: path.relative(this.stateDir, absBackup) });
    }

    const summary = {
      moved: report.moved.length,
      alreadyAbsent: report.alreadyAbsent.length,
      blocked: report.blocked.length,
      at: nowIso(),
    };
    this._phase('cleanup', {
      state: report.blocked.length ? 'blocked' : 'done',
      at: nowIso(),
      report: summary,
    });
    this._history('cleanup', summary);
    return report;
  }

  // ---------------------------------------------------------------------------
  // 步骤 6：物理清除回退区旧数据（窗口 + 磁盘空间 + 唯一副本三重门）
  // ---------------------------------------------------------------------------

  purge(opts = {}) {
    return this._withLock(() => this._purge(opts));
  }

  _purge(opts = {}) {
    const forceItems = opts.forceItems || null; // 来自已确认 pause 的指定清理
    const candidates = Object.values(this.state.items)
      .filter((it) => it.state === 'cleaned' || (forceItems && forceItems.includes(it.path)));

    const report = {
      purged: [], markedPurged: [], blockedUniqueCopy: [],
      retainedInWindow: [], paused: false, pauseId: null,
    };

    // 1) 唯一副本硬门：引用必须在、CAS 对象必须完好。任何不满足的永远不删。
    const safe = [];
    for (const item of candidates) {
      const ref = this.refsDoc.refs[item.path];
      const digest = ref?.digest || item.digest;
      const cv = digest ? this.cas.verify(digest) : { ok: false, reason: 'no_digest' };
      const absBackup = item.backupRel ? path.join(this.oldDir, item.backupRel) : null;
      const backupExists = absBackup && fs.existsSync(absBackup);

      if (!ref || !cv.ok) {
        report.blockedUniqueCopy.push({
          path: item.path, reason: !ref ? 'ref_missing' : `cas_${cv.reason}`,
        });
        continue; // 硬保护，任何强制操作都不能越过
      }
      if (!item.backupRel || !backupExists) {
        // 备份已不在：只需把 journal 状态推进到 purged
        item.state = 'purged';
        item.purgedAt = nowIso();
        this._save();
        report.markedPurged.push(item.path);
        continue;
      }
      // 备份内容也必须仍是“已核对的那份字节”。cleanup 是 rename：
      // 若外部进程持有旧 fd 继续原地写，新字节会落进 quarantine inode，
      // 那可能是任何地方都没有的唯一新版本 —— 一律阻止删除并暂停。
      let backupDigest;
      try {
        backupDigest = hashFile(absBackup);
      } catch (e) {
        report.blockedUniqueCopy.push({ path: item.path, reason: `backup_unreadable: ${e.code || e.message}` });
        continue;
      }
      if (backupDigest !== digest) {
        report.blockedUniqueCopy.push({
          path: item.path,
          reason: 'backup_drift',
          expectedDigest: digest,
          actualDigest: backupDigest,
          message: '回退区副本在清理后被改写（可能是持有旧文件句柄的进程写入了新版本），其中或含唯一副本，禁止删除',
        });
        continue;
      }
      const size = fs.statSync(absBackup).size;
      safe.push({ item, absBackup, size, digest, backupDigest });
    }

    if (report.blockedUniqueCopy.length) {
      this._raisePause('sole_copy_protection', '检测到“唯一副本”风险，已禁止删除任何受影响旧数据', {
        items: report.blockedUniqueCopy,
        guidance: '请先重新收录/核对摘要副本（recheck + ingest + switch + verify），再重试清理。该保护不可强制绕过。',
      });
    }

    const now = Date.now();
    const explicitSet = forceItems ? new Set(forceItems) : null;
    const windowMs = this.state.settings.rollbackWindowMs || 0;
    const eligible = [];
    const inWindow = [];
    for (const c of safe) {
      const forced = explicitSet && explicitSet.has(c.item.path);
      // 以 cleanedAt + “当前”窗口策略计算：操作员显式缩短窗口会立即生效
      const cleanedAtMs = c.item.cleanedAt ? Date.parse(c.item.cleanedAt) : now;
      const eligibleAt = Number.isFinite(cleanedAtMs) ? cleanedAtMs + windowMs : (c.item.purgeAfter || 0);
      c.eligibleAt = eligibleAt;
      if (forced || eligibleAt <= now) eligible.push(c);
      else inWindow.push(c);
    }

    // 2) 磁盘空间 vs 回退窗口冲突预判
    const minFree = this.state.settings.minFreeBytes || 0;
    const assumed = this.state.settings.assumeFreeBytes;
    let freeBytes = this._freeBytes();
    const reclaimEligible = eligible.reduce((s, c) => s + c.size, 0);
    const inWindowBytes = inWindow.reduce((s, c) => s + c.size, 0);
    const simulated = Number.isFinite(assumed);
    const projectedFree = freeBytes + reclaimEligible;

    const forcedPause = opts.forcePause || null;
    const overridingWindow = !!(forcedPause && opts.confirmed === 'PURGE_IN_WINDOW');

    if (
      !overridingWindow &&
      inWindow.length > 0 &&
      minFree > 0 &&
      projectedFree < minFree
    ) {
      // 冲突成立：删除全部“窗口已到期”项后仍低于保留空间，
      // 而剩余可回收字节都在回退窗口内。宁可明确暂停，也不删窗口内副本。
      const pause = this._raisePause('window_disk_conflict', '回退窗口与磁盘最低空间冲突：已明确暂停，未删除窗口内旧副本', {
        freeBytes,
        simulatedFreeBytes: simulated,
        minFreeBytes: minFree,
        reclaimableEligibleBytes: reclaimEligible,
        projectedFreeAfterEligible: projectedFree,
        deficitBytes: minFree - projectedFree,
        inWindowBytes,
        inWindowCount: inWindow.length,
        items: inWindow.map((c) => ({
          path: c.item.path, size: c.size, purgeAfter: c.eligibleAt
            ? new Date(c.eligibleAt).toISOString() : null,
        })),
        options: [
          '保持旧副本并去释放磁盘空间，然后“重新检查”',
          '显式缩短/结束回退窗口后再清理（修改设置）',
          '输入确认指令，明确放弃这些路径的回退窗口并清理（审计留痕）',
        ],
      });
      report.paused = true;
      report.pauseId = pause.id;
      report.retainedInWindow = inWindow.map((c) => c.item.path);
      // 注意：冲突时不执行任何物理删除，把完整决定权交给人。
      const summary = {
        purged: 0, paused: true, pauseId: pause.id,
        blockedUniqueCopy: report.blockedUniqueCopy.length,
        retainedInWindow: inWindow.length, at: nowIso(),
      };
      this._phase('purge', { state: 'paused', at: nowIso(), report: summary });
      this._history('purge-paused-window-disk-conflict', { pauseId: pause.id });
      return report;
    }

    // 3) 执行删除（仅窗口到期项，或已明确确认的 pause 指定项）
    let freedSoFar = 0;
    let atUnlinkBlocked = 0;
    for (const c of eligible) {
      // 删除前最后一次复核 CAS 与备份字节，杜绝 TOCTOU 窗口
      const cv = this.cas.verify(c.digest);
      if (!cv.ok) {
        report.blockedUniqueCopy.push({ path: c.item.path, reason: `cas_${cv.reason}_at_unlink` });
        atUnlinkBlocked += 1;
        continue;
      }
      let backupDigestNow;
      try { backupDigestNow = hashFile(c.absBackup); }
      catch (e) {
        report.blockedUniqueCopy.push({ path: c.item.path, reason: `backup_unreadable_at_unlink: ${e.code || e.message}` });
        atUnlinkBlocked += 1;
        continue;
      }
      if (backupDigestNow !== c.digest) {
        report.blockedUniqueCopy.push({
          path: c.item.path, reason: 'backup_drift_at_unlink',
          expectedDigest: c.digest, actualDigest: backupDigestNow,
        });
        atUnlinkBlocked += 1;
        continue;
      }
      fs.unlinkSync(c.absBackup);
      this._fault('purge:after-unlink'); // 崩溃点：已删备份，journal 未推进
      c.item.state = 'purged';
      c.item.purgedAt = nowIso();
      c.item.purgeSource = overridingWindow ? 'operator-confirmed-window-override' : 'window-elapsed';
      freedSoFar += c.size;
      report.purged.push({ path: c.item.path, size: c.size });
    }

    if (atUnlinkBlocked > 0) {
      // 删除前最后一刻发现风险：同样落到不可绕过的活动暂停上
      this._raisePause('sole_copy_protection', '删除前最后复核发现唯一副本风险，已中止对应删除', {
        items: report.blockedUniqueCopy,
        guidance: '请人工检查回退区副本，重新收录/核对后再决定；该保护不可强制绕过。',
      });
    }

    for (const c of inWindow) report.retainedInWindow.push(c.item.path);

    if (overridingWindow && forcedPause) {
      forcedPause.status = 'resolved';
      forcedPause.resolution = {
        decision: 'purge_in_window', at: nowIso(),
        confirmed: opts.confirmed, purged: report.purged.map((p) => p.path),
      };
      this._history('operator_override_window', {
        pauseId: forcedPause.id, paths: report.purged.map((p) => p.path),
      });
    }

    const summary = {
      purged: report.purged.length,
      markedPurged: report.markedPurged.length,
      blockedUniqueCopy: report.blockedUniqueCopy.length,
      retainedInWindow: report.retainedInWindow.length,
      freedBytes: freedSoFar,
      paused: false,
      at: nowIso(),
    };
    this._phase('purge', {
      state: report.blockedUniqueCopy.length ? 'blocked' : 'done',
      at: nowIso(), report: summary,
    });
    this._history('purge', summary);
    return report;
  }

  _raisePause(kind, title, details) {
    // 同类活动 pause 去重：更新内容而不是堆叠
    let pause = this.state.pauses.find((p) => p.kind === kind && p.status === 'active');
    if (!pause) {
      pause = {
        id: `pause_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        kind, title, status: 'active', createdAt: nowIso(), details,
      };
      this.state.pauses.unshift(pause);
    } else {
      pause.title = title;
      pause.details = details;
      pause.updatedAt = nowIso();
    }
    if (this.state.pauses.length > 20) {
      this.state.pauses.length = 20;
    }
    return pause;
  }

  /** 人工处理暂停：retry / keep / purge_in_window / recheck */
  resolvePause(pauseId, decision, opts = {}) {
    return this._withLock(() => {
      const pause = this.state.pauses.find((p) => p.id === pauseId);
      if (!pause) throw new MigrateError('NOT_FOUND', `暂停记录不存在: ${pauseId}`);

      if (decision === 'purge_in_window') {
        if (pause.kind !== 'window_disk_conflict') {
          throw new MigrateError('BAD_REQUEST', '该暂停类型不支持窗口强制清理');
        }
        if (opts.confirm !== 'PURGE_IN_WINDOW') {
          throw new MigrateError('BAD_REQUEST', '必须显式确认（confirm=PURGE_IN_WINDOW）');
        }
        const paths = (pause.details.items || []).map((i) => i.path);
        this._save(); // 先持久化“已确认”意图前的状态无意义，但保持锁内一致
        const report = this._purge({ forceItems: paths, forcePause: pause, confirmed: opts.confirm });
        // _purge 已写入含 confirmed/purged 列表的详细 resolution；这里只补决定字段，勿覆盖审计细节
        pause.status = 'resolved';
        pause.resolution = {
          ...(pause.resolution || {}),
          decision,
          at: pause.resolution?.at || nowIso(),
        };
        this._history('pause-resolved', { pauseId, decision, purged: report.purged?.length || 0 });
        return report;
      }

      if (decision === 'retry' || decision === 'recheck') {
        if (pause.kind === 'sole_copy_protection') {
          // 完整重跑 purge 门检（ref + CAS + 备份摘要一致性），
          // 而不是只验证 CAS：backup_drift 等风险必须仍能挡住“已恢复”结论。
          const report = this._purge({});
          const stillActive = this.state.pauses
            .some((p) => p.kind === 'sole_copy_protection' && p.status === 'active');
          if (!stillActive && report.blockedUniqueCopy.length === 0) {
            pause.status = 'resolved';
            pause.resolution = { decision, at: nowIso(), result: 'all_replicas_healthy' };
            this._history('pause-resolved', { pauseId, decision });
            return { resolved: true, purge: report };
          }
          return { resolved: false, blocked: report.blockedUniqueCopy, purge: report };
        }
        // window/disk：重新跑一次 purge 预检/执行
        const report = this._purge({});
        if (!report.paused) {
          pause.status = 'resolved';
          pause.resolution = { decision, at: nowIso(), result: 'space_ok_or_eligible_purged' };
        }
        return report;
      }

      if (decision === 'keep') {
        pause.status = 'acknowledged_keep';
        pause.resolution = { decision, at: nowIso(), note: opts.note || 'operator keeps old copies' };
        this._history('pause-keep', { pauseId });
        return { resolved: true, kept: true };
      }

      throw new MigrateError('BAD_REQUEST', `未知决定: ${decision}`);
    });
  }

  // ---------------------------------------------------------------------------
  // 回退（单路径或全部）：quarantine 移回 / CAS 重建，并撤销 refs
  // ---------------------------------------------------------------------------

  rollback(opts = {}) {
    return this._withLock(() => this._rollback(opts));
  }

  _rollback(opts = {}) {
    let rels;
    if (opts.all) {
      rels = [...new Set([
        ...Object.keys(this.refsDoc.refs),
        ...Object.values(this.state.items)
          .filter((it) => ['switched', 'drift', 'verified', 'cleaned', 'purged'].includes(it.state))
          .map((it) => it.path),
      ])].sort();
    } else if (opts.paths?.length) {
      rels = opts.paths.map((p) => this._safeRel(p).rel);
    } else if (opts.path) {
      rels = [this._safeRel(opts.path).rel];
    } else {
      throw new MigrateError('BAD_REQUEST', 'rollback 需要 path/paths 或 all=true');
    }

    const report = { rolledBack: [], blocked: [] };
    const relsToRemoveRef = [];

    // 阶段 A：恢复 live 字节（不覆盖现存文件）
    for (const rel of rels) {
      const item = this.state.items[rel];
      if (!item) { report.blocked.push({ path: rel, reason: 'unknown_item' }); continue; }
      const absLive = path.join(this.root, rel);
      const absBackup = item.backupRel ? path.join(this.oldDir, item.backupRel) : path.join(this.oldDir, rel);
      try {
        let source;
        if (fs.existsSync(absLive)) {
          // 现存路径解析后必须是普通文件；若是目录等异常占位（含指向目录的链接），
          // 不覆盖、不撤销引用，交给人工处理。
          let fst;
          try { fst = fs.statSync(absLive); } catch { fst = null; }
          if (fst && !fst.isFile()) {
            throw new MigrateError('SOLE_COPY', `旧路径被非文件对象占用，拒绝覆盖或撤销引用: ${rel}`, { path: rel });
          }
          source = 'live-existing'; // 绝不覆盖，包括切换后外部改过的更新版本
        } else {
          source = this._restoreBytesForRollback(item, absLive, absBackup);
        }
        relsToRemoveRef.push(rel);
        report.rolledBack.push({ path: rel, source });
      } catch (e) {
        report.blocked.push({ path: rel, reason: e.code || 'restore_failed', message: e.message });
      }
    }

    // 阶段 B：撤销引用（单一提交点）
    for (const rel of relsToRemoveRef) delete this.refsDoc.refs[rel];
    this.refsDoc.version += 1;
    this._saveRefs();
    this._fault('rollback:after-refs');

    // 阶段 C：以当前磁盘内容重新登记，回到“未切换”状态
    for (const rel of relsToRemoveRef) {
      const item = this.state.items[rel];
      const absLive = path.join(this.root, rel);
      try {
        const st = fs.statSync(absLive);
        const put = this.cas.putFile(absLive); // 回退后的内容也保证有摘要副本
        item.digest = put.digest;
        item.size = put.size;
        item.baseVersion = statVersion(st);
        item.version = item.baseVersion;
        item.statDirty = false;
        item.state = 'ingested';
        item.rolledBackAt = nowIso();
        item.backupRel = null;
        item.needsReswitch = false;
      } catch (e) {
        item.state = 'error';
        item.lastError = `回退后重新登记失败: ${e.message}`;
      }
    }

    this._phase('switch', { state: 'rolled_back', at: nowIso(), detail: report });
    this._history('rollback', { count: report.rolledBack.length, blocked: report.blocked.length });
    this._save();
    return report;
  }

  // ---------------------------------------------------------------------------
  // 中断后继续：幂等推进所有阶段，直到完成或遇到需要人决定的冲突/暂停
  // ---------------------------------------------------------------------------

  resume(opts = {}) {
    return this._withLock(() => {
      const out = { steps: [], conflicts: [], blocked: [], paused: null };

      const scan = this._scan();
      out.steps.push({ step: 'scan', ...scan });

      const ing = this._ingest({});
      out.steps.push({ step: 'ingest', ingested: ing.ingested.length, reused: ing.reused.length });
      out.conflicts.push(...ing.conflicts);

      const sw = this._switchRefs({});
      out.steps.push({ step: 'switch', switched: sw.switched.length, conflicts: sw.conflicts.length });
      out.conflicts.push(...sw.conflicts);

      const vr = this._verifyAll({});
      out.steps.push({ step: 'verify', checked: vr.checked, ok: vr.ok, drift: vr.drift.length, failed: vr.failed.length });

      const cl = this._cleanup({});
      out.steps.push({ step: 'cleanup', moved: cl.moved.length, blocked: cl.blocked.length });
      out.blocked.push(...cl.blocked);

      const pg = this._purge({});
      out.steps.push({
        step: 'purge', purged: pg.purged.length,
        retainedInWindow: pg.retainedInWindow.length, paused: pg.paused,
      });
      if (pg.paused) out.paused = { pauseId: pg.pauseId };

      this._history('resume', {
        conflicts: out.conflicts.length, blocked: out.blocked.length, paused: !!pg.paused,
      });
      return out;
    });
  }

  // ---------------------------------------------------------------------------
  // 设置
  // ---------------------------------------------------------------------------

  updateSettings(patch = {}) {
    return this._withLock(() => {
      const s = this.state.settings;
      if (patch.rollbackWindowMs !== undefined) {
        const v = Number(patch.rollbackWindowMs);
        if (!Number.isFinite(v) || v < 0) throw new MigrateError('BAD_REQUEST', 'rollbackWindowMs 必须是非负数字');
        s.rollbackWindowMs = v;
      }
      if (patch.minFreeBytes !== undefined) {
        const v = Number(patch.minFreeBytes);
        if (!Number.isFinite(v) || v < 0) throw new MigrateError('BAD_REQUEST', 'minFreeBytes 必须是非负数字');
        s.minFreeBytes = v;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'assumeFreeBytes')) {
        if (patch.assumeFreeBytes === null) s.assumeFreeBytes = null;
        else {
          const v = Number(patch.assumeFreeBytes);
          if (!Number.isFinite(v) || v < 0) throw new MigrateError('BAD_REQUEST', 'assumeFreeBytes 必须是 null 或非负数字');
          s.assumeFreeBytes = v;
        }
      }
      this._history('settings-update', { ...patch });
      return { ...s };
    });
  }

  // ---------------------------------------------------------------------------
  // 旧路径 / 目录读取语义
  // ---------------------------------------------------------------------------

  /**
   * 按旧路径读取的解析结果（在只读锁内得到一致描述符）。
   * 优先 refs -> CAS；否则读 live；再否则 quarantine。
   * 返回 {source,digest,size,abs}，调用方自行 createReadStream(abs)。
   */
  resolveRead(relRaw) {
    return this._withReadLock(() => this._resolveRead(relRaw));
  }

  _resolveRead(relRaw) {
    const rel = toRel(relRaw, this.root);
    const abs = resolveInside(this.root, rel);
    assertRealInside(this.rootReal, abs);
    const ref = this.refsDoc.refs[rel];

    if (ref && this.cas.has(ref.digest)) {
      const cv = this.cas.verify(ref.digest);
      if (cv.ok) {
        const casAbs = this.cas.objectPath(ref.digest);
        return {
          source: 'cas', digest: ref.digest, size: cv.size, abs: casAbs,
          buffer: () => fs.readFileSync(casAbs),
          stream: () => fs.createReadStream(casAbs),
        };
      }
    }
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      return {
        source: 'legacy', digest: hashFile(abs), size: st.size, abs,
        buffer: () => fs.readFileSync(abs),
        stream: () => fs.createReadStream(abs),
      };
    }
    const item = this.state.items[rel];
    const backupRel = item?.backupRel || rel;
    const absBackup = path.join(this.oldDir, backupRel);
    if (fs.existsSync(absBackup)) {
      return {
        source: 'quarantine', digest: hashFile(absBackup), size: fs.statSync(absBackup).size, abs: absBackup,
        buffer: () => fs.readFileSync(absBackup),
        stream: () => fs.createReadStream(absBackup),
      };
    }
    throw new MigrateError('NOT_FOUND', `路径不可读: ${rel}`);
  }

  /** 测试/CLI 用：直接取 Buffer。 */
  readPath(relRaw) {
    const d = this.resolveRead(relRaw);
    return { ...d, buffer: () => fs.readFileSync(d.abs) };
  }

  /** 目录列举：合并 live 目录树与 refs 摘要索引（清理后旧路径/目录依然可见可读）。 */
  listDir(dirRaw = '') {
    return this._withReadLock(() => this._listDir(dirRaw));
  }

  _listDir(dirRaw = '') {
    const dirRel = toRel(dirRaw || '', this.root);
    const absDir = dirRel ? resolveInside(this.root, dirRel) : this.root;
    assertRealInside(this.rootReal, absDir);

    const dirMap = new Map(); // rel -> {path,name,fromFs,fromRefs}
    const fileMap = new Map();

    // 1) live 文件系统
    if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
      for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
        const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
        if (ent.name === '.cas-migration') continue;
        if (ent.isDirectory()) dirMap.set(rel, { path: rel, name: ent.name, fs: true, refs: false });
        else if (ent.isFile() || ent.isSymbolicLink()) {
          let st; try { st = fs.statSync(path.join(absDir, ent.name)); } catch { continue; }
          fileMap.set(rel, this._rowFor(rel, st.size, true));
        }
      }
    }

    // 2) refs / journal 中属于该目录的条目（覆盖已清理/purged 的路径，并补合成目录）
    const prefix = dirRel ? `${dirRel}/` : '';
    const allKnown = new Set([
      ...Object.keys(this.refsDoc?.refs || {}),
      ...Object.keys(this.state?.items || {}),
    ]);
    for (const rel of allKnown) {
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) {
        const subRel = prefix + rest.slice(0, slash);
        if (!dirMap.has(subRel)) {
          dirMap.set(subRel, { path: subRel, name: baseName(subRel), fs: false, refs: true });
        } else dirMap.get(subRel).refs = true;
        continue;
      }
      if (!fileMap.has(rel)) fileMap.set(rel, this._rowFor(rel));
      else {
        const row = fileMap.get(rel);
        const ref = this.refsDoc?.refs?.[rel];
        if (ref) { row.switched = true; row.digest = ref.digest; }
      }
    }

    const dirs = [...dirMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...fileMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { dir: dirRel, dirs, files };
  }

  _rowFor(rel, liveSize = null, liveExists = false) {
    const item = this.state?.items?.[rel];
    const ref = this.refsDoc?.refs?.[rel];
    const abs = path.join(this.root, rel);
    let size = liveSize;
    let exists = liveExists;
    if (size == null) {
      try { const st = fs.statSync(abs); size = st.size; exists = true; }
      catch { size = ref?.size ?? item?.size ?? null; exists = false; }
    }
    const backupAbs = path.join(this.oldDir, item?.backupRel || rel);
    return {
      path: rel,
      name: baseName(rel),
      size,
      liveExists: exists,
      backupExists: fs.existsSync(backupAbs),
      digest: ref?.digest || item?.digest || null,
      refDigest: ref?.digest || null,
      currentDigest: item?.digest || null,
      switched: !!ref,
      stale: !!(ref && item?.digest && ref.digest !== item.digest),
      state: item?.state || (ref ? 'switched' : 'unknown'),
      stateLabel: item ? require('./journal').STATE_LABELS[item.state] || item.state : (ref ? '引用中' : '未登记'),
      statDirty: !!item?.statDirty,
    };
  }

  // ---------------------------------------------------------------------------
  // 分析视图：同内容复用 / 同名不同内容 / 未切换路径
  // ---------------------------------------------------------------------------

  analytics() {
    return this._withLock(() => this._analytics());
  }

  _analytics() {
    const items = Object.values(this.state.items);
    const refs = this.refsDoc.refs;

    // 同内容复用：按当前摘要分组
    const digestMap = new Map();
    for (const it of items) {
      if (!it.digest || it.state === 'missing') continue;
      if (!digestMap.has(it.digest)) {
        digestMap.set(it.digest, { digest: it.digest, size: it.size || 0, paths: [], switchedPaths: [] });
      }
      const g = digestMap.get(it.digest);
      g.paths.push(it.path);
      if (refs[it.path]) g.switchedPaths.push(it.path);
      if (it.size) g.size = it.size;
    }
    const reuseGroups = [...digestMap.values()]
      .filter((g) => g.paths.length >= 2)
      .map((g) => ({
        ...g,
        count: g.paths.length,
        reusedCopies: g.paths.length - 1,
        savedBytes: g.size * (g.paths.length - 1),
        casPresent: this.cas.has(g.digest),
      }))
      .sort((a, b) => b.savedBytes - a.savedBytes || b.count - a.count);

    // 同名不同内容：按 basename 分组后统计不同摘要
    const nameMap = new Map();
    for (const it of items) {
      if (!it.digest) continue;
      if (!nameMap.has(it.name)) nameMap.set(it.name, new Map());
      const dm = nameMap.get(it.name);
      if (!dm.has(it.digest)) dm.set(it.digest, { digest: it.digest, size: it.size || 0, paths: [] });
      dm.get(it.digest).paths.push(it.path);
    }
    const nameCollisionGroups = [];
    for (const [name, dm] of nameMap) {
      if (dm.size < 2) continue;
      const variants = [...dm.values()].map((v) => ({ ...v, count: v.paths.length }));
      nameCollisionGroups.push({
        name,
        variantCount: variants.length,
        totalPaths: variants.reduce((s, v) => s + v.paths.length, 0),
        variants: variants.sort((a, b) => b.paths.length - a.paths.length),
      });
    }
    nameCollisionGroups.sort((a, b) => b.variantCount - a.variantCount || a.name.localeCompare(b.name));

    // 还没切换的路径：无 ref，或 ref 摘要已落后于当前版本，
    // 或处于 conflict/drift（引用仍是旧版本，等待 recheck + 重新切换）
    const pending = [];
    for (const it of items) {
      const ref = refs[it.path];
      const stale = !!(ref && it.digest && ref.digest !== it.digest);
      const conflictState = it.state === 'conflict';
      const driftState = it.state === 'drift';
      if (!ref || stale || conflictState || driftState) {
        let reason;
        if (conflictState) reason = 'version_conflict';
        else if (driftState) reason = 'drift_needs_reswitch';
        else if (!ref) reason = 'never_switched';
        else reason = 'version_changed_needs_reswitch';
        pending.push({
          path: it.path,
          name: it.name,
          state: it.state,
          stateLabel: require('./journal').STATE_LABELS[it.state] || it.state,
          reason,
          stale,
          statDirty: !!it.statDirty,
          reappearedWithChanges: !!it.reappearedWithChanges,
          conflict: it.conflict || null,
          drift: it.drift || null,
          size: it.size,
          liveExists: it.liveExists !== false,
          version: it.baseVersion || it.version || null,
          digest: it.digest,
        });
      }
    }
    pending.sort((a, b) => a.path.localeCompare(b.path));

    const counts = {};
    for (const it of items) counts[it.state] = (counts[it.state] || 0) + 1;

    const casObjects = this.cas.listObjects();
    const switchedCount = Object.keys(refs).length;
    const totalBytes = items.reduce((s, it) => s + (it.size || 0), 0);
    const uniqueBytes = [...digestMap.keys()].reduce((s, d) => {
      const v = this.cas.verify(d);
      return s + (v.ok ? v.size : 0);
    }, 0);

    return {
      counts,
      totalPaths: items.length,
      switchedCount,
      pendingCount: pending.length,
      conflictCount: (counts.conflict || 0) + (counts.drift || 0),
      cleanedCount: counts.cleaned || 0,
      purgedCount: counts.purged || 0,
      reuse: {
        groups: reuseGroups,
        duplicatePaths: reuseGroups.reduce((s, g) => s + g.count, 0),
        savedBytes: reuseGroups.reduce((s, g) => s + g.savedBytes, 0),
      },
      nameCollisions: { groups: nameCollisionGroups },
      pending,
      cas: {
        objectCount: casObjects.length,
        bytes: this.cas.totalBytes(),
        logicalBytes: totalBytes,
        uniqueBytes,
      },
    };
  }

  /** /api/state 使用的完整只读视图（自带锁，保证读到一致快照）。 */
  snapshot() {
    return this._withLock(() => {
      const analytics = this._analytics();
      let disk = null;
      try {
        const assumed = this.state.settings.assumeFreeBytes;
        disk = {
          freeBytes: this._freeBytes(),
          simulated: Number.isFinite(assumed),
          minFreeBytes: this.state.settings.minFreeBytes,
          statfsAvailable: (() => { try { return fs.statfsSync(this.stateDir).bavail * fs.statfsSync(this.stateDir).bsize; } catch { return null; } })(),
        };
      } catch (e) { disk = { error: e.message }; }
      return {
        root: this.root,
        stateDir: this.stateDir,
        journal: this.state,
        refs: this.refsDoc,
        disk,
        analytics,
        faults: [...this.faults],
      };
    });
  }
}

module.exports = { MigrationEngine };
