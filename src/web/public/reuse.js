(function () {
  const { api, fmtBytes, esc, shortDigest, stateBadge, toast, nav } = window.DM;

  async function load() {
    const [data, state] = await Promise.all([api('/api/reuse'), api('/api/state')]);
    const itemMap = state.journal.items;

    document.getElementById('summary').innerHTML = [
      { n: data.groups.length, l: '同内容分组数', c: 'brand' },
      { n: data.duplicatePaths, l: '涉及路径数', c: '' },
      { n: fmtBytes(data.savedBytes), l: '去重后少存储的字节', c: 'green' },
    ].map(c => `<div class="card stat ${c.c}"><div class="num">${c.n}</div><div class="lbl">${c.l}</div></div>`).join('');

    const box = document.getElementById('groups');
    if (!data.groups.length) {
      box.innerHTML = `<div class="card empty"><div class="big">🗂️</div>暂未发现同内容多路径分组。先执行扫描与收录。</div>`;
      return;
    }

    box.innerHTML = data.groups.map(g => `
      <div class="card group-card">
        <h2>
          <span class="badge mono blue">${esc(shortDigest(g.digest, 20))}…</span>
          ${g.count} 个路径共享 · 单份 ${fmtBytes(g.size)}
          <span class="badge green">节省 ${fmtBytes(g.savedBytes)}</span>
          ${g.casPresent ? '<span class="badge green">CAS 对象完好</span>' : '<span class="badge red">CAS 对象缺失</span>'}
        </h2>
        <table>
          <thead><tr><th>路径（保留旧路径语义）</th><th style="width:150px">迁移状态</th><th style="width:120px">引用</th></tr></thead>
          <tbody>
            ${g.paths.map(p => {
              const it = itemMap[p] || {};
              const switched = !!state.refs.refs[p];
              return `<tr class="clickable" data-path="${esc(p)}">
                <td class="path">${esc(p)}</td>
                <td>${stateBadge(it.state || 'unknown')}</td>
                <td>${switched ? '<span class="badge violet">path→digest</span>' : '<span class="badge gray">未切换</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`).join('');

    box.querySelectorAll('tr[data-path]').forEach(tr => tr.onclick = () => {
      window.open(`/index.html?open=${encodeURIComponent(tr.dataset.path)}`, '_self');
    });
  }

  nav('reuse.html');
  load().catch(e => toast(e.message, 'err'));
  setInterval(() => load().catch(() => {}), 5000);
})();
