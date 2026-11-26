'use strict';

const path = require('path');
const fs = require('fs');

/** 统一使用 POSIX 相对路径作为库内标识（journal / refs / API）。 */
function toRel(absOrRel, root) {
  let rel = absOrRel;
  if (root && path.isAbsolute(absOrRel)) {
    rel = path.relative(root, absOrRel);
  }
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * 把不可信的相对路径安全地解析到 base 目录内。
 * 拒绝绝对路径与逃逸的 `..`。
 */
function resolveInside(base, untrustedRel) {
  if (typeof untrustedRel !== 'string' || untrustedRel === '') {
    return base;
  }
  const normalized = untrustedRel.split('\\').join('/');
  if (path.posix.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    const err = new Error('绝对路径不允许');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const abs = path.resolve(base, normalized);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('路径越界');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return abs;
}

/**
 * 符号链接感知的越界检查：解析 target 最近的“真实存在的祖先”的 realpath，
 * 确认其仍在 rootReal 之内。target 末尾不存在的组件不可能是符号链接，
 * 按词法拼回即可。防止“库内符号链接 → 库外目录/文件”绕过 resolveInside。
 * 返回 target 的真实/推断绝对路径；越界时抛 code=BAD_REQUEST。
 */
function assertRealInside(rootReal, targetAbs) {
  let cur = path.resolve(targetAbs);
  const tail = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let real;
    try {
      real = fs.realpathSync(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) {
        real = cur; // 到达文件系统根仍不存在（理论上少见）
      } else {
        tail.push(path.basename(cur));
        cur = parent;
        continue;
      }
    }
    let full = real;
    for (let i = tail.length - 1; i >= 0; i -= 1) full = path.join(full, tail[i]);
    const rel = path.relative(rootReal, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const err = new Error(`符号链接解析到库根之外: ${targetAbs}`);
      err.code = 'BAD_REQUEST';
      throw err;
    }
    return full;
  }
}

function dirOf(relPosix) {
  const i = relPosix.lastIndexOf('/');
  return i < 0 ? '' : relPosix.slice(0, i);
}

function baseName(relPosix) {
  const i = relPosix.lastIndexOf('/');
  return i < 0 ? relPosix : relPosix.slice(i + 1);
}

/** 列出某 POSIX 目录的直接子目录与文件（输入为完整 rel 集合时做派生）。 */
function immediateChildren(dirPosix, allRelPaths) {
  const prefix = dirPosix ? dirPosix.replace(/\/?$/, '/') : '';
  const dirs = new Set();
  const files = [];
  for (const rel of allRelPaths) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash < 0) {
      files.push(rel);
    } else {
      dirs.add(prefix + rest.slice(0, slash));
    }
  }
  return { dirs: [...dirs].sort(), files: files.sort() };
}

module.exports = {
  toRel, resolveInside, assertRealInside, dirOf, baseName, immediateChildren,
};
