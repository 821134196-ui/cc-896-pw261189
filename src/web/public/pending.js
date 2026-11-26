(function () {
  const { api, fmtBytes, esc, shortDigest, stateBadge, toast, runAction, nav } = window.DM;
  let rows = [];

  const REASON_LABELS = {
    never_switched: '尚未发布引用',
    version_changed_needs_reswitch: '文件有新版本，需重新切换',
    version_conflict: '乐观版本冲突，需重新核对后切换',
    drift_needs_reswitch: '切换/清除后文件被改写或重现，新版本需重新收录与切换',
  };

  async function load() {
    const data = await api('/api/pending');
    rows = data.pending;
    const box = document.getElementById('table');
    if (!rows.length) {
      box.innerHTML = `<div class="empty"><div class="big">✅</div>所有已登记路径都已切换到当前摘要引用。</div>`;
      return;
    }
    box.innerHTML = `<table>
      <thead><tr>
        <th>路径</th><th style="width:130px">状态</th><th style="width:210px">原因</th>
        <th style="width:120px">摘要</th><th style="width:90px">大小</th><th style="width:230px">操作</th>
      </tr></thead>
      <tbody>
        ${rows.map(p => `
          <tr data-path="${esc(p.path)}">
            <td class="path">${esc(p.path)}
              ${p.liveExists ? '<span class="live-dot yes" title="live 文件存在"></span>' : '<span class="live-dot no" title="live 文件不存在"></span>'}
              ${p.reappearedWithChanges ? '<span class="badge red">清除后重现新版本</span>' : ''}
              ${p.statDirty ? '<span class="badge amber">stat 版本已变</span>' : ''}
            </td>
            <td>${stateBadge(p.state)}</td>
            <td class="small muted">${esc(REASON_LABELS[p.reason] || '文件有新版本，需重新切换')}</td>
            <td class="digest">${esc(shortDigest(p.digest))}</td>
            <td>${fmtBytes(p.size)}</td>
            <td><div class="btn-row">
              ${p.state === 'conflict' || p.state === 'drift' || p.stale
                ? `<button class="btn sm amber" data-act="recheck">收录新版本</button>
                   <button class="btn sm primary" data-act="reswitch">重新切换</button>`
                : p.state === 'discovered' || p.state === 'missing'
                  ? `<button class="btn sm" data-act="ingest">先收录</button>
                     <button class="btn sm primary" data-act="switch">切换</button>`
                  : `<button class="btn sm primary" data-act="switch">切换</button>`}
            </div></td>
          </tr>`).join('')}
      </tbody>
    </table>`;

    box.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const tr = btn.closest('tr');
        const p = tr.dataset.path;
        const act = btn.dataset.act;
        try {
          if (act === 'recheck') {
            await runAction(btn, () => api('/api/recheck', { path: p }), '已重新收录当前内容');
          } else if (act === 'ingest') {
            await runAction(btn, () => api('/api/ingest', { paths: [p], force: true }), '已收录');
          } else if (act === 'switch' || act === 'reswitch') {
            // 不带 expectedVersion：引擎用重新哈希做权威版本检测；
            // 批量接口把竞争放进 result.conflicts 而不是 HTTP 错误，需如实提示。
            const r = await runAction(btn, () => api('/api/switch', { paths: [p] }));
            const conflicts = r?.result?.conflicts || [];
            if (conflicts.length) {
              window.DM.toast('切换被版本检测拒绝：请先“收录新版本”', 'err');
            } else {
              window.DM.toast('引用已切换', 'ok');
            }
          }
        } catch { /* toast 已处理 */ }
        await load();
        window.DM.refreshNavCounts();
      };
    });
  }

  document.getElementById('btn-switch-all').onclick = async (e) => {
    try {
      const r = await runAction(e.target, () => api('/api/switch', {}));
      toast(`切换 ${r.result.switched.length} 个，冲突 ${r.result.conflicts.length} 个`,
        r.result.conflicts.length ? 'err' : 'ok');
    } finally { await load(); }
  };
  document.getElementById('btn-resume').onclick = async (e) => {
    try { await runAction(e.target, () => api('/api/resume', {}), '继续执行完成'); }
    finally { await load(); }
  };

  nav('pending.html');
  load().catch(e => toast(e.message, 'err'));
  setInterval(() => load().catch(() => {}), 5000);
})();
