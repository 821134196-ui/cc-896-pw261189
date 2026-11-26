'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mkdirp } = require('./atomic');
const { copyAndHash, hashFile } = require('./versions');

/**
 * 内容摘要存储：<stateDir>/cas/objects/<aa>/<rest>
 * 相同 sha256 永远落在同一个对象上 —— 同内容复用的物理基础。
 * 写入走“临时文件 + fsync + 原子 rename”，对象一旦落位不可变。
 */
class CasStore {
  constructor(stateDir) {
    this.root = path.join(stateDir, 'cas');
    this.objectsDir = path.join(this.root, 'objects');
    mkdirp(this.objectsDir);
  }

  objectPath(digest) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`非法摘要: ${digest}`);
    }
    return path.join(this.objectsDir, digest.slice(0, 2), digest.slice(2));
  }

  has(digest) {
    try {
      return fs.statSync(this.objectPath(digest)).isFile();
    } catch {
      return false;
    }
  }

  stat(digest) {
    return fs.statSync(this.objectPath(digest));
  }

  /**
   * 把本地文件收录进 CAS。
   * @returns {{digest:string,size:number,reused:boolean}}
   *   reused=true 表示对象已存在（本次发生同内容去重复用）。
   */
  putFile(srcAbs, knownDigest = null) {
    let digest = knownDigest;
    let size;
    if (digest && this.has(digest)) {
      // 已知摘要且对象在：仍然核对大小，避免错误元数据
      size = fs.statSync(srcAbs).size;
      return { digest, size, reused: true };
    }

    mkdirp(path.join(this.objectsDir, 'tmp'));
    const tmpAbs = path.join(
      this.objectsDir,
      'tmp',
      `${process.pid}-${crypto.randomBytes(6).toString('hex')}.part`
    );
    try {
      const r = copyAndHash(srcAbs, tmpAbs);
      digest = r.digest;
      size = r.size;
      const finalAbs = this.objectPath(digest);
      if (fs.existsSync(finalAbs)) {
        // 并发/重入：别人已经放好了相同对象，丢弃临时副本即完成去重
        fs.unlinkSync(tmpAbs);
        return { digest, size, reused: true };
      }
      mkdirp(path.dirname(finalAbs));
      fs.renameSync(tmpAbs, finalAbs);
      return { digest, size, reused: false };
    } finally {
      try { if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs); } catch { /* ignore */ }
    }
  }

  /** 重新哈希对象，确认副本仍然完整（清理旧数据前的强制核对）。 */
  verify(digest) {
    const abs = this.objectPath(digest);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return { ok: false, reason: 'missing', size: 0 };
    }
    const actual = hashFile(abs);
    return { ok: actual === digest, reason: actual === digest ? null : 'corrupt', size: st.size };
  }

  readBuffer(digest) {
    return fs.readFileSync(this.objectPath(digest));
  }

  createReadStream(digest) {
    return fs.createReadStream(this.objectPath(digest));
  }

  /** 现存对象摘要集合（用于空间统计/GC 预览）。 */
  listObjects() {
    const out = [];
    for (const aa of fs.readdirSync(this.objectsDir)) {
      if (aa === 'tmp' || !/^[0-9a-f]{2}$/.test(aa)) continue;
      const dir = path.join(this.objectsDir, aa);
      for (const rest of fs.readdirSync(dir)) {
        out.push(aa + rest);
      }
    }
    return out;
  }

  totalBytes() {
    let total = 0;
    for (const d of this.listObjects()) {
      try { total += fs.statSync(this.objectPath(d)).size; } catch { /* ignore */ }
    }
    return total;
  }
}

module.exports = { CasStore };
