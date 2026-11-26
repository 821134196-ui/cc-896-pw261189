'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * 版本令牌：size + 高精度 mtime + inode。
 * 任何并行写入/覆盖都会改变它（touch 也会），用于乐观并发的 If-Match 校验。
 * 内容摘要 sha256 是权威版本：即使令牌被伪造/时间戳不敏感，重新哈希仍可识别内容变化。
 */
function statVersion(st) {
  const mtimeUs = Math.round(st.mtimeMs * 1000);
  return `v1:${st.size}:${mtimeUs}:${st.ino}`;
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 分块哈希 + 可选地把字节同时复制到 destFd（边复制边算摘要）。 */
function hashFile(absPath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      h.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * 把 src 复制进 CAS 临时文件，同时计算摘要。
 * 返回复制期间算出的 digest（调用方随后用原子 rename 落位）。
 */
function copyAndHash(srcAbs, tmpAbs) {
  const h = crypto.createHash('sha256');
  const inf = fs.openSync(srcAbs, 'r');
  const out = fs.openSync(tmpAbs, 'w');
  let size = 0;
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(inf, chunk, 0, chunk.length, null);
      if (n === 0) break;
      const part = chunk.subarray(0, n);
      h.update(part);
      fs.writeSync(out, part, 0, n);
      size += n;
    }
    fs.fsyncSync(out);
  } finally {
    try { fs.closeSync(inf); } catch { /* ignore */ }
    try { fs.closeSync(out); } catch { /* ignore */ }
  }
  return { digest: h.digest('hex'), size };
}

module.exports = { statVersion, hashBuffer, hashFile, copyAndHash };
