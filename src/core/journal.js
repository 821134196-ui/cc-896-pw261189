'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJson, mkdirp } = require('./atomic');

const JOURNAL_VERSION = 1;

/** 单项状态机：
 * discovered -> ingested -> switched -> verified -> cleaned -> purged
 *     |             |           |
 *     +-> missing   +-> conflict +-> drift（切换后旧路径又被外部改写）
 * 任意非终态均可 recheck / resume；rollback 后回到 ingested（CAS 副本仍在）。
 */
const ITEM_STATES = [
  'discovered', 'ingested', 'conflict', 'missing',
  'switched', 'drift', 'verified', 'cleaned', 'purged', 'rolled_back',
];

const STATE_LABELS = {
  discovered: '已发现',
  ingested: '已收录摘要',
  conflict: '版本冲突',
  missing: '原文件丢失',
  switched: '引用已切换',
  drift: '切换后被改写',
  verified: '引用已核对',
  cleaned: '旧数据待回退窗口',
  purged: '旧数据已清除',
  rolled_back: '已回退',
};

function defaultSettings() {
  return {
    // 回退窗口：默认 7 天。窗口内旧副本只移动到 quarantine，不物理删除。
    rollbackWindowMs: 7 * 24 * 60 * 60 * 1000,
    // 磁盘最低保留空间（字节）。低于该值且窗口内数据不能动 -> 明确暂停。
    minFreeBytes: 1024 * 1024 * 1024, // 1 GiB
    // 演示/测试用：覆盖真实 statfs 得到的可用空间（null = 使用真实磁盘数据）。
    assumeFreeBytes: null,
  };
}

function freshState(root) {
  const now = new Date().toISOString();
  return {
    journalVersion: JOURNAL_VERSION,
    root,
    createdAt: now,
    updatedAt: now,
    settings: defaultSettings(),
    items: {},
    phases: {
      scan: { state: 'pending', at: null, detail: null },
      ingest: { state: 'pending', at: null, detail: null },
      switch: { state: 'pending', at: null, detail: null },
      verify: { state: 'pending', at: null, report: null },
      cleanup: { state: 'pending', at: null, report: null },
      purge: { state: 'pending', at: null, report: null },
    },
    pauses: [],
    history: [],
    refsVersion: 0,
  };
}

class Journal {
  constructor(stateDir, root) {
    this.stateDir = stateDir;
    this.root = root;
    this.file = path.join(stateDir, 'journal.json');
    this.refsFile = path.join(stateDir, 'refs.json');
    this.lockFile = path.join(stateDir, 'migration.lock');
    this.oldDir = path.join(stateDir, 'old', 'files');
    mkdirp(stateDir);
  }

  load() {
    const s = readJson(this.file, null);
    if (!s) return freshState(this.root);
    // 向前兼容：补齐新增字段
    const fresh = freshState(this.root);
    const merged = { ...fresh, ...s };
    merged.settings = { ...fresh.settings, ...(s.settings || {}) };
    merged.phases = { ...fresh.phases, ...(s.phases || {}) };
    for (const k of Object.keys(fresh.phases)) {
      merged.phases[k] = { ...fresh.phases[k], ...((s.phases || {})[k] || {}) };
    }
    merged.items = s.items || {};
    merged.pauses = Array.isArray(s.pauses) ? s.pauses : [];
    merged.history = Array.isArray(s.history) ? s.history : [];
    return merged;
  }

  save(state) {
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, state);
  }

  loadRefs() {
    return readJson(this.refsFile, { version: 0, updatedAt: null, refs: {} });
  }

  saveRefs(refsDoc) {
    refsDoc.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.refsFile, refsDoc);
  }

  appendHistory(state, action, detail = {}) {
    state.history.push({ at: new Date().toISOString(), action, detail });
    if (state.history.length > 300) state.history.splice(0, state.history.length - 300);
  }
}

module.exports = { Journal, freshState, defaultSettings, ITEM_STATES, STATE_LABELS, JOURNAL_VERSION };
