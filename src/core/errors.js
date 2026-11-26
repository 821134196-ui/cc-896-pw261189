'use strict';

/**
 * 统一错误类型。HTTP 层依据 code 映射状态码：
 *  - VERSION_CONFLICT -> 409（并行修改导致版本变化）
 *  - PAUSED           -> 423（安全策略明确暂停，等待人工决定）
 *  - SOLE_COPY        -> 409（唯一副本保护，禁止删除）
 *  - NOT_FOUND        -> 404
 *  - BAD_REQUEST      -> 400
 */
class MigrateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrateError';
    this.code = code;
    this.details = details;
  }
}

class VersionConflictError extends MigrateError {
  constructor(message, details = {}) {
    super('VERSION_CONFLICT', message, details);
    this.name = 'VersionConflictError';
  }
}

class PausedError extends MigrateError {
  constructor(message, details = {}) {
    super('PAUSED', message, details);
    this.name = 'PausedError';
  }
}

class SoleCopyError extends MigrateError {
  constructor(message, details = {}) {
    super('SOLE_COPY', message, details);
    this.name = 'SoleCopyError';
  }
}

class FaultInjected extends Error {
  constructor(point) {
    super(`[fault-injection] simulated crash at ${point}`);
    this.name = 'FaultInjected';
    this.code = 'FAULT_INJECTED';
    this.point = point;
  }
}

module.exports = {
  MigrateError,
  VersionConflictError,
  PausedError,
  SoleCopyError,
  FaultInjected,
};
