/* 共享前端工具：API 封装、格式化、徽标、Toast、导航计数 */
window.DM = (function () {
  const STATE_LABELS = {
    discovered: '已发现',
    ingested: '已收录摘要',
    conflict: '版本冲突',
    missing: '文件丢失',
    switched: '引用已切换',
    drift: '切换后被改写',
    verified: '引用已核对',
    cleaned: '旧数据回退保留中',
    purged: '旧数据已清除',
    rolled_back: '已回退',
    unknown: '未登记',
  };

  async function api(path, body) {
    const opt = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, opt);
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    if (!res.ok || (json && json.ok === false)) {
      const err = new Error(json?.error?.message || `请求失败 ${res.status}`);
      err.code = json?.error?.code;
      err.details = json?.error?.details;
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  function fmtBytes(n) {
    if (n == null || Number.isNaN(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function shortDigest(d, n = 12) {
    if (!d) return '—';
    return d.length > n ? d.slice(0, n) + '…' : d;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function stateBadge(state) {
    const map = {
      discovered: 'gray', ingested: 'blue', conflict: 'red', missing: 'red',
      switched: 'violet', drift: 'amber', verified: 'green',
      cleaned: 'amber', purged: 'gray', rolled_back: 'blue', unknown: 'gray',
    };
    return `<span class="badge ${map[state] || 'gray'}">${esc(STATE_LABELS[state] || state)}</span>`;
  }

  function sourceBadge(src) {
    if (src === 'cas') return '<span class="badge green">内容摘要索引 (CAS)</span>';
    if (src === 'legacy') return '<span class="badge blue">旧路径原文件</span>';
    if (src === 'quarantine') return '<span class="badge amber">回退区副本</span>';
    return `<span class="badge gray">${esc(src)}</span>`;
  }

  let toastTimer = null;
  function toast(message, kind = '') {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'toast-wrap';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    wrap.appendChild(el);
    clearTimeout(toastTimer);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
    setTimeout(() => el.remove(), 4800);
  }

  async function runAction(btn, fn, okMsg) {
    const old = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; btn.innerHTML = '执行中…'; }
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
      return r;
    } catch (e) {
      toast(`${e.code ? '[' + e.code + '] ' : ''}${e.message}`, 'err');
      throw e;
    } finally {
      if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.innerHTML = old; }
    }
  }

  async function refreshNavCounts() {
    try {
      const s = await api('/api/state');
      const a = s.analytics;
      const setPill = (id, n) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (n > 0) { el.textContent = n > 99 ? '99+' : n; el.style.display = 'inline-block'; }
        else el.style.display = 'none';
      };
      setPill('pill-pending', a.pendingCount);
      setPill('pill-names', a.nameCollisions.groups.length);
      setPill('pill-reuse', a.reuse.groups.length);
      setPill('pill-alerts', s.journal.pauses.filter((p) => p.status === 'active').length + a.conflictCount);
    } catch { /* nav counts optional */ }
  }

  function nav(active) {
    const items = [
      ['index.html', '总览 / 迁移流水线', 'nav-home', ''],
      ['reuse.html', '同内容复用', 'nav-reuse', 'pill-reuse'],
      ['names.html', '同名不同内容', 'nav-names', 'pill-names'],
      ['pending.html', '哪些路径还没切换', 'nav-pending', 'pill-pending'],
    ];
    const html = `
      <div class="topbar">
        <h1>📦 本地文件库 · 内容摘要迁移控制台</h1>
        <div class="sub">路径存储 → sha256 内容索引 ｜ 保留旧路径与目录读取语义 ｜ 版本冲突检测 · 断点续迁 · 可回退</div>
        <nav class="nav">
          ${items.map(([href, label, , pill], i) => `
            <a href="${href}" class="${active === href ? 'active' : ''}">
              ${label}${pill ? `<span class="pill" id="${pill}" style="display:none">0</span>` : ''}
            </a>`).join('')}
        </nav>
      </div>`;
    document.body.insertAdjacentHTML('afterbegin', html);
    refreshNavCounts();
    setInterval(refreshNavCounts, 4000);
  }

  function confirmModal({ title, body, confirmText = '确认', danger = false, requireText = null }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-back show';
      back.innerHTML = `
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div class="body">${body}</div>
          ${requireText ? `<p class="small muted">请输入 <b class="mono">${esc(requireText)}</b> 以继续：
             <input type="text" class="confirm-text" style="width:100%;margin-top:6px"></p>` : ''}
          <div class="actions">
            <button class="btn cancel">取消</button>
            <button class="btn ${danger ? 'red' : 'primary'} ok" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const input = back.querySelector('.confirm-text');
      const okBtn = back.querySelector('.ok');
      if (input) input.addEventListener('input', () => { okBtn.disabled = input.value !== requireText; });
      const close = (v) => { back.remove(); resolve(v); };
      back.querySelector('.cancel').onclick = () => close(null);
      okBtn.onclick = () => close({ confirmed: true, text: input?.value || null });
      back.addEventListener('click', (e) => { if (e.target === back) close(null); });
      setTimeout(() => input?.focus(), 30);
    });
  }

  return {
    api, fmtBytes, shortDigest, esc, stateBadge, sourceBadge,
    toast, runAction, nav, refreshNavCounts, confirmModal, STATE_LABELS,
  };
})();
