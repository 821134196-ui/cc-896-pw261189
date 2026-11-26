'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 原子写：同目录临时文件 + fsync + rename，保证 journal/refs 不会写一半。 */
function writeJsonAtomic(file, value) {
  mkdirp(path.dirname(file));
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch {
    /* 某些平台不允许 fsync 目录，忽略 */
  }
}

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

/** 进程级互斥锁（O_EXCL）。崩溃留下的锁按 pid 存活性判定为 stale 后接管。 */
class FileLock {
  constructor(lockFile) {
    this.lockFile = lockFile;
    this.held = false;
  }

  acquire(retries = 0) {
    mkdirp(path.dirname(this.lockFile));
    const payload = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
    try {
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.writeSync(fd, payload);
      fs.closeSync(fd);
      this.held = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (this._stealIfStale()) {
        this.acquire(0);
        return;
      }
      if (retries < 50) {
        // 简单退避（同步工具场景，等待很短）
        const end = Date.now() + 20;
        while (Date.now() < end) { /* spin */ }
        return this.acquire(retries + 1);
      }
      throw Object.assign(new Error('迁移正被另一个进程执行（锁占用）'), { code: 'LOCKED' });
    }
  }

  _stealIfStale() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'));
      if (!raw.pid) return false;
      try {
        process.kill(raw.pid, 0);
        return false; // 进程还活着
      } catch (e) {
        if (e.code === 'EPERM') return false;
        // ESRCH：进程已死，锁是残留
        fs.unlinkSync(this.lockFile);
        return true;
      }
    } catch {
      // 锁文件损坏：当作 stale
      try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
      return true;
    }
  }

  release() {
    if (!this.held) return;
    try { fs.unlinkSync(this.lockFile); } catch { /* ignore */ }
    this.held = false;
  }
}

module.exports = { mkdirp, writeJsonAtomic, readJson, FileLock };
