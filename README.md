# 本地文件库：从「按路径存储」迁移到「按内容摘要索引」

一个**零外部依赖**（仅 Node.js ≥ 20 内置模块）的可运行参考实现，包含：

- 内容摘要库 CAS（sha256，`objects/aa/bbbb…`）与 `path -> digest` 引用索引 `refs.json`
- 旧路径 / 目录读取语义完整保留：旧文件清理后，仍按原路径、原目录结构浏览和读取，字节来自 CAS
- 并行修改竞争的版本检测：`size:mtimeNs:inode` 乐观版本令牌（If-Match）+ 切换前权威重哈希
- 断点续迁：journal / refs 全部原子写，每个崩溃窗口都有对账（reconcile），操作幂等
- 单路径 / 全量回退：live 原样、回退区 quarantine、CAS 重建三种恢复来源，绝不覆盖更新的外部写入
- 三个专题页面：**同内容复用**、**同名不同内容**、**哪些路径还没切换**
- 引用更新（switch）与旧数据清理（cleanup / purge）拆成独立、带报告、可核对的步骤
- 回退窗口 × 磁盘最低空间冲突时**明确暂停**；「唯一副本」硬保护在任何强制操作下都不可绕过
- Web 控制台 + JSON API + CLI + 32 个 node:test 测试（含故障注入恢复、409 竞争、安全暂停、符号链接逃逸）

---

## 快速开始

```bash
npm test          # 运行全部 32 个测试（零依赖，node --test）
npm start         # 启动 Web 控制台
# 默认 http://localhost:3000 （未设 PORT 时还会尝试 8000/8080/5173，方便预览发现）
```

默认操作 `/workspace/library`（可用 `--root /path/to/lib` 或 `LIBRARY_ROOT` 覆盖）。
首次启动若目录为空，会自动播种一个**混合阶段演示库**：已有清理 / 已切换核对 / 版本冲突 / 待切换 / 仅发现等各种状态，三个专题页面开箱即有数据。

```bash
node scripts/seed-demo.js                 # 重新播种 mixed 演示库到 ./library
node scripts/seed-demo.js /tmp/my-lib --fresh
node src/cli.js --root /tmp/my-lib status # CLI 查看状态
```

页面：

| 页面 | 地址 | 内容 |
| --- | --- | --- |
| 总览 / 流水线 / 目录读取验证 / 演练 | `/` 或 `/index.html` | 六步流水线、暂停与冲突处置、目录浏览器、文件读取来源、审计历史、竞争/崩溃/磁盘演练 |
| 同内容复用 | `/reuse.html` | 按 sha256 分组：共享路径数、节省字节、CAS 对象状态 |
| 同名不同内容 | `/names.html` | 按 basename 分组后列出不同摘要变体及各自路径 |
| 尚未切换路径 | `/pending.html` | 无引用 / 引用过期 / 冲突路径，可行内收录、重校验、切换 |

---

## 需求点 → 实现位置 / 验证方式

| 需求 | 实现 | 自动验证 |
| --- | --- | --- |
| 按路径库 → 内容摘要索引 | `src/core/cas.js`、`switchRefs()` 写 `refs.json` | `test/migration.test.js` |
| 保留旧路径与目录读取语义 | `resolveRead()`（refs→CAS→live→quarantine）、`listDir()` 合并 live 树与 refs 键；`/raw?path=`、`/api/list`、`/api/file` | 「完整迁移…路径与目录读取语义保持」 |
| 并行修改版本变化检测 | `statVersion()` 令牌 + `_switchOne()` 的 expectedVersion 比对与重哈希；冲突置 `conflict`，HTTP 409 `VERSION_CONFLICT`；切换后漂移由 verify 标 `drift` | `test/concurrency.test.js`（5 例）、API 409 测试 |
| 中断后继续 | 原子写 `writeJsonAtomic()`；检查点故障 `_fault()`；`_reconcile()` 对账所有崩溃窗口；`resume()` 幂等推进 | `test/recovery.test.js`（5 个崩溃点 + 锁） |
| 回退 | `rollback()`：live-existing / quarantine / cas 三来源，撤销 refs 单一提交点，回退后重登记 | `test/rollback.test.js`（4 例，含 purge 后 CAS 重建） |
| 页面：同内容复用 | `/reuse.html` + `/api/reuse`（`analytics().reuse`） | API 测试断言分组 |
| 页面：同名不同内容 | `/names.html` + `/api/name-collisions` | 「同名不同内容与未切换路径视图正确」 |
| 页面：哪些路径没切换 | `/pending.html` + `/api/pending`（含 stale/conflict） | 同上 + API 409 后出现冲突待办 |
| 引用更新与旧数据清理分成可核对步骤 | `switch → verify → cleanup → purge` 各自独立命令/按钮/报告；cleanup 强制最新预检 | 全部流水线测试 |
| 回退窗口 vs 磁盘空间冲突 → 明确暂停 | `_purge()` 预判 `free + eligibleReclaim < minFree` 且窗口内有数据 → 建 `window_disk_conflict` 活动暂停，**零删除**；UI 红色暂停卡 + 三种明确决定 | `test/safety.test.js` |
| 不能删掉唯一副本 | 删除前硬门：有效 ref + CAS `verify()` 通过 + unlink 前再次复核；不满足进 `sole_copy_protection`，**任何确认都不可绕过**；drift 文件同样阻止 cleanup | 「唯一副本硬保护…强制确认也不删」 |

---

## 迁移状态机与磁盘布局

```
<library-root>/
├── …旧的按目录/路径存放的用户文件（迁移期间保持不动）…
└── .cas-migration/
    ├── journal.json          # 每项状态/版本令牌/报告/暂停/审计（原子写）
    ├── refs.json             # ★ 内容摘要索引：{ "rel/path": {digest, version,…} }
    ├── migration.lock        # 进程互斥锁（死进程残留锁自动接管）
    ├── cas/objects/aa/bbbb…  # ★ sha256 内容对象，相同内容物理上只有一份
    └── old/files/<rel-path>  # 清理后的旧文件 quarantine（回退窗口内保留）
```

单项状态：

```
discovered → ingested → switched → verified → cleaned → purged
                │           │
                ├→ conflict（切换竞争，等 recheck）
                └→ drift（切换后被外部改写，cleanup 被阻止）
```

关键安全顺序（任何删除之前必须全部成立）：

1. `refs.json` 已原子提交 `path -> digest`；
2. CAS 对象存在且重新哈希等于该 digest；
3. 按旧路径读取链路回读摘要一致；
4. live 旧文件与 digest 一致（若已被改写为未收录的新版本 → `unmigrated_change` 阻止清理，因为那是唯一副本）；
5. purge 时再次复核 1–2，并重新哈希 quarantine 备份确认它仍是已核对的那份字节（防止 cleanup 后持有旧 fd 的进程原地写入唯一新版本），再检查回退窗口与磁盘预留空间。任一门不过：不删除并落 `sole_copy_protection` 活动暂停。

路径入口同时做词法（`..`/绝对路径）与 realpath（库内符号链接指向库外）两层 containment 校验，违例返回 `BAD_REQUEST`/HTTP 400；目录遍历使用 `lstat` 且不跟随符号链接。

### 磁盘 / 窗口冲突的行为

设置：`rollbackWindowMs`（默认 7 天）、`minFreeBytes`（默认 1 GiB）、
`assumeFreeBytes`（仅演练/测试覆盖 statfs）。

purge 预判：即使删掉所有「窗口已到期」副本，可用空间仍低于 `minFreeBytes`，
而剩余可回收字节都在回退窗口内 → 进入 `paused`，写一条
`window_disk_conflict` 暂停记录，**本次 purge 不执行任何物理删除**，等待明确决定。
操作员可：

- **保持旧副本**，自行释放磁盘后「重新检查」；
- 显式缩短/结束回退窗口（`POST /api/settings`，审计留痕）；
- 输入确认串 `PURGE_IN_WINDOW` 明确放弃窗口并清理（`operator_override_window` 审计）。

而「唯一副本」保护没有强制旁路：CAS 副本不健康的项永远不会被删。

---

## HTTP API 摘要

所有 POST 为 JSON。错误形如 `{ok:false,error:{code,message,details}}`，
`VERSION_CONFLICT`/`SOLE_COPY` → 409，暂停/锁 → 423，`NOT_FOUND` → 404。

```
GET  /api/state            # journal + refs + analytics + disk（一致快照）
GET  /api/reuse  /api/name-collisions  /api/pending  /api/analytics
GET  /api/list?dir=rel/dir
GET  /api/file?path=rel     # 元数据 + 文本预览
GET  /raw?path=rel          # 原始字节（响应头 x-read-source: cas|legacy|quarantine）

POST /api/scan  /api/ingest  /api/switch  /api/verify
POST /api/cleanup  /api/purge  /api/resume  /api/rollback  /api/recheck
POST /api/settings
POST /api/resolve-pause     # {id, decision: retry|keep|purge_in_window, confirm}
POST /api/demo/modify       # 模拟外部并行修改
POST /api/demo/arm-fault    # 武装一次性崩溃点
POST /api/demo/reset        # 仅对带 demo-marker 的演示库生效
```

乐观并发调用示例：

```bash
V=$(curl -s …/api/state | jq -r '.journal.items["parallel-edit.txt"].baseVersion')
# …另一进程修改文件…
curl -X POST …/api/switch -d "{\"path\":\"parallel-edit.txt\",\"expectedVersion\":\"$V\"}"
# → 409 VERSION_CONFLICT，随后 /api/recheck + /api/switch 恢复
```

## CLI

```bash
node src/cli.js [--root DIR] [--json] <command>
# status scan ingest switch [path] recheck <path> verify cleanup purge
# resume rollback --all|--path P reuse names pending list [--dir D]
# read --path P settings --window-ms N --min-free-bytes N resolve-pause --id … --decision …
# seed [--scenario fresh|mixed] serve [--port N]
```

## 测试与故障注入

`test/` 下 32 个用例全部使用临时目录，覆盖：

- 正常流水线、去重分组、同名分组、pending 视图、幂等（含单路径 switch 不重复计数）
- 过期令牌 409、无令牌摘要竞争、touch 不误伤、recheck 恢复、切换后 drift 阻止清理
- **purge 后旧路径重现不同内容**：scan 标 drift、进入 pending、cleanup 阻止、recheck+switch 恢复
- 五个真实崩溃窗口（CAS 写后 / refs 提交后 / cleanup 移动后 / purge unlink 后 / rollback refs 后）的新实例续迁
- 锁竞争
- 三种回退来源与「不覆盖外部新版本」
- 窗口/磁盘冲突零删除暂停、确认串门、审计、唯一副本硬保护
- **quarantine 备份在 cleanup 后被原地改写（持有旧 fd 的并行写入）时，删除前摘要门识别 `backup_drift`，任何强制确认都不删**
- **库内符号链接指向库外不被遍历，读/列/切换入口经 realpath 检查返回 400**（`test/security.test.js`）
- HTTP API 端到端（静态页、`/raw` 来源头、409、路径穿越 + 符号链接 400、故障注入后 `/api/resume` 恢复、暂停确认）

故障点：`ingest:after-cas-put`、`switch:after-refs`、`cleanup:after-move`、
`purge:after-unlink`、`rollback:after-refs`。
