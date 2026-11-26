(function () {
  const { api, fmtBytes, esc, shortDigest, toast, nav } = window.DM;

  async function load() {
    const data = await api('/api/name-collisions');
    const box = document.getElementById('groups');
    if (!data.groups.length) {
      box.innerHTML = `<div class="card empty"><div class="big">🔍</div>暂未发现“同名不同内容”分组（需要先收录摘要）。</div>`;
      return;
    }
    box.innerHTML = data.groups.map(g => `
      <div class="card group-card">
        <h2>📛 ${esc(g.name)}
          <span class="badge amber">${g.variantCount} 种不同内容</span>
          <span class="badge gray">${g.totalPaths} 个路径</span>
        </h2>
        ${g.variants.map((v, i) => `
          <div class="variant" style="border-left-color: ${['#2f54eb', '#dc2626', '#0e9f6e', '#7c3aed', '#b45309'][i % 5]}">
            <div class="small">
              <span class="badge mono">${esc(shortDigest(v.digest, 16))}…</span>
              <span class="muted">${fmtBytes(v.size)} · ${v.count} 个路径</span>
            </div>
            <div class="paths">
              ${v.paths.map(p => `<span class="path">📄 ${esc(p)}</span>`).join('')}
            </div>
          </div>`).join('')}
      </div>`).join('');
  }

  nav('names.html');
  load().catch(e => toast(e.message, 'err'));
  setInterval(() => load().catch(() => {}), 5000);
})();
