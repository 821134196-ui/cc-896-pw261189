/* 总览页逻辑 */
(function () {
  const { api, fmtBytes, shortDigest, esc, stateBadge, sourceBadge, toast, runAction, confirmModal, refreshNavCounts, nav } = window.DM;
  let S = null;
  let cwd = '';
  let selectedPath = null;

  const STEPS = [
    { key: 'scan', n: 1, title: '扫描文件库', desc: '遍历旧路径树，记录 size/mtime/inode 版本令牌。', action: '/api/scan', label: '重新扫描' },
    { key: 'ingest', n: 2, title: '收录到内容摘要库 (CAS)', desc: '复制并计算 sha256；相同摘要只存一个对象，自然去重。', action: '/api/ingest', label: '收录全部' },
    { key: 'switch', n: 3, title: '切换引用（path → digest）', desc: '发布 refs.json。切换前重新哈希做版本检测，并行修改会得到 409/冲突。', action: '/api/switch', label: '切换全部引用' },
    { key: 'verify', n: 4, title: '核对引用', desc: '验证 CAS 对象、按旧路径回读摘要，以及 live 文件是否在切换后漂移。', action: '/api/verify', label: '执行核对' },
    { key: 'cleanup', n: 5, title: '清理旧路径文件 → 回退区', desc: '核对通过后把旧文件移入 .cas-migration/old，回退窗口内不物理删除。', action: '/api/cleanup', label: '执行清理' },
    { key: 'purge', n: 6, title: '彻底删除窗口到期旧数据', desc: '三重门：引用有效 + CAS 副本完好 + 窗口到期且磁盘策略允许；冲突时明确暂停。', action: '/api/purge', label: '清除到期数据' },
  ];

  async function load() {
    S = await api('/api/state');
    renderStats();
    renderAlerts();
    renderSteps();
    renderSettings();
    renderHistory();
    renderDemoPathOptions();
    await loadDir(cwd, true);
    refreshNavCounts();
  }

  function renderStats() {
    const a = S.analytics;
    const cards = [
      { cls: '', num: a.totalPaths, lbl: '库内路径总数', foot: `CAS 对象 ${a.cas.objectCount} · 逻辑 ${fmtBytes(a.cas.logicalBytes)}` },
      { cls: 'green', num: a.switchedCount, lbl: '已切换到摘要引用', foot: `verified/cleaned/purged 均含有效引用` },
      { cls: 'amber', num: a.pendingCount, lbl: '尚未切换 / 需重新切换', foot: '见“尚未切换路径”页' },
      { cls: 'red', num: a.conflictCount, lbl: '版本冲突 / 切换后漂移', foot: `活动安全暂停 ${S.journal.pauses.filter(p => p.status === 'active').length}` },
    ];
    document.getElementById('stats').innerHTML = cards.map(c => `
      <div class="card stat ${c.cls}">
        <div class="num">${c.num}</div>
        <div class="lbl">${c.lbl}</div>
        <div class="foot">${esc(c.foot)}</div>
      </div>`).join('');
  }

  function renderAlerts() {
    const box = document.getElementById('alerts');
    const pauses = S.journal.pauses.filter(p => p.status === 'active');
    const conflicts = Object.values(S.journal.items).filter(i => i.state === 'conflict' || i.state === 'drift');
    let html = '';

    for (const p of pauses) {
      const isWindow = p.kind === 'window_disk_conflict';
      const d = p.details || {};
      html += `<div class="alert ${isWindow ? 'amber' : 'red'}">
        <div class="ico">${isWindow ? '⏸️' : '🛑'}</div>
        <div style="flex:1">
          <b>${esc(p.title)}</b>
          <div class="small">${esc(p.kind)} · ${esc(p.id)}</div>
          ${isWindow ? `<div class="small" style="margin-top:6px">
            当前可用 <b>${fmtBytes(d.freeBytes)}</b>${d.simulatedFreeBytes ? '（模拟值）' : ''}，
            最低保留 <b>${fmtBytes(d.minFreeBytes)}</b>；删除已到期项仅能回收
            <b>${fmtBytes(d.reclaimableEligibleBytes)}</b>，仍缺口 <b>${fmtBytes(d.deficitBytes)}</b>。
            窗口内旧副本共 <b>${d.inWindowCount}</b> 个 / ${fmtBytes(d.inWindowBytes)}。
            <br>系统<b>没有删除任何窗口内副本</b>，等待明确决定。
          </div>` : `<pre class="small">${esc((d.items || []).map(i => `• ${i.path} (${i.reason})`).join('\n'))}</pre>`}
        </div>
        <div class="actions">
          <button class="btn sm" data-pause-retry="${p.id}">🔄 ${isWindow ? '重新检查' : '重新核对副本'}</button>
          <button class="btn sm" data-pause-keep="${p.id}">保持旧副本</button>
          ${isWindow ? `<button class="btn sm red" data-pause-force="${p.id}">明确放弃窗口并清理…</button>` : ''}
        </div>
      </div>`;
    }

    if (conflicts.length) {
      html += `<div class="alert red">
        <div class="ico">⚡</div>
        <div style="flex:1">
          <b>检测到 ${conflicts.length} 个版本变化 / 竞争路径</b>
          <div class="small">迁移快照之后文件被改写。系统不会覆盖新版本；可核对后收录新版本并重新切换。</div>
          <div class="small mono" style="margin-top:6px;max-height:96px;overflow:auto">
            ${conflicts.slice(0, 8).map(c => `• ${esc(c.path)} — ${c.state === 'drift' ? '切换后被外部改写' : (c.conflict?.kind || 'version changed')}`).join('<br>')}
            ${conflicts.length > 8 ? `<br>…另有 ${conflicts.length - 8} 个，见“尚未切换路径”页` : ''}
          </div>
        </div>
        <div class="actions">
          <button class="btn sm amber" id="btn-recheck-all-conflicts">全部收录新版本并重新切换</button>
        </div>
      </div>`;
    }

    box.innerHTML = html;

    box.querySelectorAll('[data-pause-retry]').forEach(b => b.onclick = () => pauseRetry(b.dataset.pauseRetry, b));
    box.querySelectorAll('[data-pause-keep]').forEach(b => b.onclick = () => pauseKeep(b.dataset.pauseKeep, b));
    box.querySelectorAll('[data-pause-force]').forEach(b => b.onclick = () => pauseForce(b.dataset.pauseForce, b));
    const rb = document.getElementById('btn-recheck-all-conflicts');
    if (rb) rb.onclick = (e) => recheckAllConflicts(e.target);
  }

  async function pauseRetry(id, btn) {
    await runAction(btn, () => api('/api/resolve-pause', { id, decision: 'retry' }), '已重新检查');
    await load();
  }
  async function pauseKeep(id, btn) {
    await runAction(btn, () => api('/api/resolve-pause', { id, decision: 'keep', note: 'UI: operator keeps copies' }), '已记录“保持旧副本”');
    await load();
  }
  async function pauseForce(id, btn) {
    const ok = await confirmModal({
      title: '明确放弃回退窗口？',
      danger: true,
      confirmText: '我确认删除',
      requireText: 'PURGE_IN_WINDOW',
      body: `<p>该操作将物理删除暂停中列出的、仍处于回退窗口内的旧副本。</p>
             <p class="small muted">只有在 CAS 摘要副本校验完好时才会执行；唯一副本风险项会继续被硬保护拦截。操作会写入审计历史。</p>`,
    });
    if (!ok) return;
    await runAction(btn, () => api('/api/resolve-pause', { id, decision: 'purge_in_window', confirm: ok.text }), '已按明确确认清理窗口内副本');
    await load();
  }

  async function recheckAllConflicts(btn) {
    await runAction(btn, async () => {
      const items = Object.values(S.journal.items).filter(i => i.state === 'conflict' || i.state === 'drift');
      for (const it of items) {
        try {
          await api('/api/recheck', { path: it.path });
          await api('/api/switch', { path: it.path });
        } catch (e) { /* 保留冲突现场，继续其他路径 */ }
      }
      await api('/api/verify', {});
    }, '已处理全部冲突路径');
    await load();
  }

  function renderSteps() {
    const phases = S.journal.phases;
    document.getElementById('steps').innerHTML = STEPS.map(st => {
      const p = phases[st.key] || {};
      const cls = p.state === 'done' ? 'done'
        : ['partial', 'blocked', 'drift', 'paused', 'failed'].includes(p.state) ? p.state : '';
      let meta = '';
      if (p.at) meta += `上次执行 ${new Date(p.at).toLocaleString('zh-CN')}`;
      if (p.detail) meta += ` · ${esc(JSON.stringify(p.detail))}`;
      if (p.report) meta += ` · 报告 ${esc(JSON.stringify(p.report))}`;
      return `<div class="step ${cls}">
        <div class="dot">${p.state === 'done' ? '✓' : st.n}</div>
        <div>
          <h3>${st.title}</h3>
          <p>${st.desc}</p>
          ${meta ? `<div class="meta">${meta}</div>` : ''}
        </div>
        <div class="act">
          <button class="btn sm primary" data-action="${st.action}">${st.label}</button>
        </div>
      </div>`;
    }).join('');

    document.querySelectorAll('[data-action]').forEach(b => {
      b.onclick = async () => {
        try {
          const r = await runAction(b, () => api(b.dataset.action, {}));
          summarizeAction(b.dataset.action, r);
        } catch { /* toast 已提示 */ }
        await load();
      };
    });
  }

  function summarizeAction(action, r) {
    const res = r?.result;
    if (!res) return;
    if (action === '/api/switch' && res.conflicts?.length) {
      toast(`切换完成 ${res.switched.length} 个；${res.conflicts.length} 个版本冲突`, 'err');
    } else if (action === '/api/cleanup' && res.blocked?.length) {
      toast(`清理 ${res.moved.length} 个；阻止 ${res.blocked.length} 个（唯一副本/未迁移变更）`, 'err');
    } else if (action === '/api/purge' && res.paused) {
      toast('磁盘/窗口冲突：已明确暂停，未删除窗口内副本', 'err');
    }
  }

  function renderSettings() {
    const s = S.journal.settings;
    const disk = S.disk;
    document.getElementById('settings-box').innerHTML = `
      <div class="kv">
        <dt>回退窗口</dt>
        <dd><label class="field"><input type="number" id="set-days" min="0" step="1" style="width:90px"
              value="${(s.rollbackWindowMs / 86400000).toFixed(2).replace(/\.?0+$/, '')}"> 天（0 = 立即到期）</label></dd>
        <dt>磁盘保留空间</dt>
        <dd><label class="field"><input type="number" id="set-gb" min="0" step="0.1" style="width:90px"
              value="${(s.minFreeBytes / 1073741824).toFixed(2).replace(/\.?0+$/, '')}"> GiB</label></dd>
        <dt>当前可用空间</dt>
        <dd>${fmtBytes(disk.freeBytes)} ${disk.simulated ? '<span class="badge amber">模拟值</span>' : '<span class="badge gray">statfs 真实值</span>'}</dd>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn sm primary" id="btn-save-settings">保存策略</button>
        <span class="muted small">缩短窗口属于显式策略决定，会被审计记录。</span>
      </div>`;
    document.getElementById('btn-save-settings').onclick = async (e) => {
      const days = Number(document.getElementById('set-days').value);
      const gb = Number(document.getElementById('set-gb').value);
      await runAction(e.target, () => api('/api/settings', {
        rollbackWindowMs: Math.max(0, days) * 86400000,
        minFreeBytes: Math.max(0, gb) * 1073741824,
      }), '安全策略已更新');
      await load();
    };
  }

  function renderHistory() {
    const h = [...S.journal.history].slice(-24).reverse();
    document.getElementById('history').innerHTML = h.length
      ? h.map(x => `<div class="h"><span class="t">${new Date(x.at).toLocaleString('zh-CN', { hour12: false })}</span>
          <span><b>${esc(x.action)}</b> <span class="muted">${esc(JSON.stringify(x.detail))}</span></span></div>`).join('')
      : '<div class="empty small">暂无历史</div>';
  }

  function renderDemoPathOptions() {
    const sel = document.getElementById('demo-path');
    if (!sel || sel.options.length) return;
    const paths = Object.keys(S.journal.items).sort();
    sel.innerHTML = paths.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    if (paths.includes('parallel-edit.txt')) sel.value = 'parallel-edit.txt';
  }

  // ---------------- 目录浏览 ----------------
  async function loadDir(dir, keepSelection) {
    cwd = dir;
    const d = await api(`/api/list?dir=${encodeURIComponent(dir)}`);
    const parts = dir ? dir.split('/') : [];
    const crumbs = [`<a href="#" data-dir="">库根</a>`];
    let acc = '';
    parts.forEach((p, i) => {
      acc += (i ? '/' : '') + p;
      const target = acc;
      crumbs.push(`<span class="sep">/</span><a href="#" data-dir="${esc(target)}">${esc(p)}</a>`);
    });
    document.getElementById('crumbs').innerHTML = crumbs.join('');
    document.querySelectorAll('#crumbs [data-dir]').forEach(a => a.onclick = (e) => {
      e.preventDefault(); loadDir(a.dataset.dir);
    });

    const rows = [
      ...d.dirs.map(x => `<tr class="clickable" data-dir="${esc(x.path)}">
        <td>📁 ${esc(x.name)}/</td><td></td><td class="muted small">目录${x.refs ? ' · 摘要索引中保留' : ''}</td></tr>`),
      ...d.files.map(f => `<tr class="clickable" data-file="${esc(f.path)}">
        <td>📄 <span class="path">${esc(f.name)}</span></td>
        <td class="nowrap">${stateBadge(f.state)} ${f.stale ? '<span class="badge red">引用过期</span>' : ''}</td>
        <td class="digest">${esc(shortDigest(f.digest))} · ${fmtBytes(f.size)}
          <span class="live-dot ${f.liveExists ? 'yes' : 'no'}" title="${f.liveExists ? 'live 文件存在' : 'live 已清理'}"></span>
        </td>
      </tr>`),
    ].join('');
    document.getElementById('dirlist').innerHTML = `<table><tbody>${rows || '<tr><td class="empty">空目录</td></tr>'}</tbody></table>`;
    document.querySelectorAll('#dirlist [data-dir]').forEach(tr => tr.onclick = () => loadDir(tr.dataset.dir));
    document.querySelectorAll('#dirlist [data-file]').forEach(tr => tr.onclick = () => openFile(tr.dataset.file));
  }

  async function openFile(p) {
    selectedPath = p;
    const f = await api(`/api/file?path=${encodeURIComponent(p)}`);
    const canRollback = f.source === 'cas' || f.source === 'quarantine';
    document.getElementById('file-meta').innerHTML = `
      <dl class="kv">
        <dt>旧路径</dt><dd class="path">${esc(f.path)}</dd>
        <dt>读取来源</dt><dd>${sourceBadge(f.source)}</dd>
        <dt>摘要</dt><dd class="digest">${esc(f.digest)}</dd>
        <dt>大小</dt><dd>${fmtBytes(f.size)}</dd>
        <dt>原始字节</dt><dd><a href="/raw?path=${encodeURIComponent(p)}" target="_blank">/raw?path=…</a></dd>
      </dl>
      ${canRollback ? `<div class="btn-row" style="margin-top:12px">
        <button class="btn sm ghost-danger" id="btn-rollback-one">↩ 回退此路径到旧路径存储</button>
      </div>` : ''}`;
    const rbOne = document.getElementById('btn-rollback-one');
    if (rbOne) rbOne.onclick = async (e) => {
      try {
        const r = await runAction(e.target, () => api('/api/rollback', { path: p }), '该路径已回退');
        if (r.result.blocked.length) toast('回退被阻止：没有可恢复副本', 'err');
      } finally { await load(); await openFile(p).catch(() => {}); }
    };
    const pre = document.getElementById('file-preview');
    if (f.preview != null) { pre.style.display = 'block'; pre.textContent = f.preview; }
    else { pre.style.display = 'none'; }
  }

  // ---------------- 顶部/演练操作 ----------------
  document.getElementById('btn-refresh').onclick = () => load();

  document.getElementById('btn-resume').onclick = async (e) => {
    try {
      const r = await runAction(e.target, () => api('/api/resume', {}));
      const x = r.result;
      if (x.paused) toast('继续执行到安全暂停点：磁盘/窗口冲突，等待决定', 'err');
      else if (x.conflicts?.length) toast(`继续完成；${x.conflicts.length} 个路径存在版本冲突`, 'err');
      else toast('断点续迁完成：所有可安全推进的步骤均已推进', 'ok');
    } finally { await load(); }
  };

  document.getElementById('btn-rollback-all').onclick = async (e) => {
    const ok = await confirmModal({
      title: '回退全部已切换路径？',
      danger: true, confirmText: '全部回退',
      body: '<p>将撤销 refs 引用，并从 live / 回退区 / CAS 恢复旧路径文件。切换后被外部改写的 live 文件不会被覆盖。</p>',
    });
    if (!ok) return;
    try {
      const r = await runAction(e.target, () => api('/api/rollback', { all: true }));
      toast(`已回退 ${r.result.rolledBack.length} 个路径，阻止 ${r.result.blocked.length} 个`, 'ok');
    } finally { await load(); }
  };

  document.getElementById('btn-demo-modify').onclick = async (e) => {
    const path = document.getElementById('demo-path').value;
    await runAction(e.target, () => api('/api/demo/modify', { path }), `已模拟外部进程修改：${path}`);
    await load();
  };

  document.getElementById('btn-demo-switch-stale').onclick = async (e) => {
    const path = document.getElementById('demo-path').value;
    const v = S.journal.items[path]?.baseVersion;
    try {
      await runAction(e.target, () => api('/api/switch', { path, expectedVersion: v }));
      toast('版本令牌仍匹配，切换成功（可先点“模拟外部并行修改”制造过期令牌）', 'ok');
    } catch { /* 409 toast */ }
    await load();
  };

  document.getElementById('btn-demo-race-oneclick').onclick = async (e) => {
    const path = document.getElementById('demo-path').value;
    const token = S.journal.items[path]?.baseVersion;
    await runAction(e.target, async () => {
      await api('/api/demo/modify', { path });
      try {
        // 故意使用修改前的版本令牌，模拟迁移与并行写入竞争
        await api('/api/switch', { path, expectedVersion: token });
      } catch (err) {
        if (err.code === 'VERSION_CONFLICT') {
          toast('已捕获 VERSION_CONFLICT(409)：系统检测到版本变化并拒绝覆盖', 'err');
          return;
        }
        throw err;
      }
      toast('该路径没有可冲突的旧令牌（可能尚未收录），已直接切换', 'ok');
    }, '竞争演练完成');
    await load();
  };

  document.getElementById('btn-arm-fault').onclick = async (e) => {
    const point = document.getElementById('fault-point').value;
    await runAction(e.target, () => api('/api/demo/arm-fault', { point }), `已武装一次性崩溃点：${point}。现在点击对应步骤或“一键继续”。`);
  };

  document.getElementById('btn-disk-pressure').onclick = async (e) => {
    await runAction(e.target, () => api('/api/settings', { assumeFreeBytes: 1024 }), '已模拟可用空间仅 1KB；去点“清除到期数据”或“一键继续”');
    await load();
  };
  document.getElementById('btn-disk-drill').onclick = async (e) => {
    await runAction(e.target, async () => {
      // 只影响“已切换引用”的路径，不替用户切换其余 pending 路径
      await api('/api/settings', { assumeFreeBytes: 1024, minFreeBytes: 100 * 1024 * 1024 });
      let pg = await api('/api/purge', {});
      if (!pg.result.paused) {
        await api('/api/cleanup', {}); // 把已切换+核对的路径移入回退区
        pg = await api('/api/purge', {});
      }
      if (!pg.result.paused) toast('没有可触发冲突的窗口内旧数据', 'err');
    }, '已制造“回退窗口 × 磁盘空间”冲突暂停：页面顶部出现暂停卡');
    await load();
  };
  document.getElementById('btn-disk-reset').onclick = async (e) => {
    await runAction(e.target, () => api('/api/settings', { assumeFreeBytes: null }), '已恢复为真实 statfs 空间');
    await load();
  };

  async function doReset(scenario, btn) {
    const ok = await confirmModal({
      title: '重置演示文件库？',
      danger: true, confirmText: '确认重置',
      body: `<p>将删除默认演示库目录并重新播种（${scenario}）。该接口仅对带 demo-marker 的演示库生效。</p>`,
    });
    if (!ok) return;
    await runAction(btn, () => api('/api/demo/reset', { scenario }), '演示库已重置');
    cwd = '';
    await load();
  }
  document.getElementById('btn-reset-mixed').onclick = (e) => doReset('mixed', e.target);
  document.getElementById('btn-reset-fresh').onclick = (e) => doReset('fresh', e.target);

  nav('index.html');
  const openParam = new URLSearchParams(location.search).get('open');
  load()
    .then(() => { if (openParam) return openFile(openParam); })
    .catch(e => toast(e.message, 'err'));
  setInterval(() => { if (!document.querySelector('.modal-back.show')) load().catch(() => {}); }, 5000);
})();
