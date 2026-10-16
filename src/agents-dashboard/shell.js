// Agents UI shell: draws the sidebar and top bar into any page that has
// <aside class="sidebar" id="sidebar"> and <header class="topbar" id="topbar">,
// marks the current page, shows live counts, and handles the theme toggle and
// the mobile drawer. Pages call Shell.setUpdated(text) to show freshness.
(() => {
  // Lucide icons (MIT), inlined.
  const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    overview: svg('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'),
    messenger: svg('<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>'),
    investigator: svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    developer: svg('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
    whatsapp: svg('<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>'),
    tasks: svg('<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>'),
    external: svg('<path d="M7 7h10v10"/><path d="M7 17 17 7"/>'),
    moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>'),
    menu: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
  };

  const PAGES = [
    { path: '/', key: 'overview', label: 'Overview' },
    { path: '/messenger', key: 'messenger', label: 'Messenger' },
    { path: '/investigator', key: 'investigator', label: 'Investigator' },
    { path: null, key: 'developer', label: 'Developer', soon: true },
  ];
  const current = PAGES.find((p) => p.path === location.pathname) ?? (location.pathname === '/whatsapp' ? { key: 'whatsapp', label: 'WhatsApp' } : PAGES[0]);

  // ── Theme: saved choice, else the system setting ──────────────────────
  const readTheme = () => { try { return localStorage.getItem('agents-theme'); } catch { return null; } };
  const saveTheme = (t) => { try { localStorage.setItem('agents-theme', t); } catch {} };
  const applyTheme = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; };
  applyTheme(readTheme());
  const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

  const navItem = (p) =>
    p.soon
      ? `<span class="nav-item disabled">${ICONS[p.key]}<span class="grow">${p.label}</span><span class="nav-badge">soon</span></span>`
      : `<a class="nav-item${current.key === p.key ? ' active' : ''}" href="${p.path}" ${current.key === p.key ? 'aria-current="page"' : ''}>${ICONS[p.key]}<span class="grow">${p.label}</span><span class="nav-badge" data-badge="${p.key}" hidden></span></a>`;

  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="brand"><span class="brand-mark"><i></i><i></i><i></i><i></i></span>Agents</div>
      <nav aria-label="Agents">${PAGES.map(navItem).join('')}</nav>
      <div class="nav-label">Connections</div>
      <a class="nav-item${current.key === 'whatsapp' ? ' active' : ''}" href="/whatsapp">${ICONS.whatsapp}<span class="grow">WhatsApp</span><span class="nav-badge" data-badge="whatsapp" hidden></span></a>
      <div class="sidebar-bottom">
        <a class="nav-item" id="todoBoard" href="http://127.0.0.1:4319" target="_blank" rel="noopener">${ICONS.tasks}<span class="grow">Tasks board</span>${ICONS.external}</a>
        <button type="button" class="nav-item theme-toggle" id="themeToggle"></button>
      </div>`;
    const toggle = document.getElementById('themeToggle');
    const drawToggle = () => (toggle.innerHTML = isDark() ? `${ICONS.sun}<span class="grow">Light mode</span>` : `${ICONS.moon}<span class="grow">Dark mode</span>`);
    toggle.onclick = () => { const t = isDark() ? 'light' : 'dark'; saveTheme(t); applyTheme(t); drawToggle(); };
    drawToggle();
  }

  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.innerHTML = `
      <button type="button" class="menu-button" id="menuButton" aria-label="Open navigation">${ICONS.menu}</button>
      <span class="crumbs">Agents / <strong>${current.label}</strong></span>
      <span class="spacer"></span>
      <span class="updated" id="shellUpdated"></span>`;
    const app = document.querySelector('.app');
    document.getElementById('menuButton').onclick = () => app?.classList.add('nav-open');
    document.querySelector('.scrim')?.addEventListener('click', () => app?.classList.remove('nav-open'));
  }

  // ── Live counts in the sidebar ────────────────────────────────────────
  const badge = (key, text, tone) => {
    const b = document.querySelector(`[data-badge="${key}"]`);
    if (!b) return;
    b.hidden = !text;
    b.textContent = text ?? '';
    b.className = `nav-badge${tone ? ` ${tone}` : ''}`;
  };
  async function counts() {
    try {
      const d = await (await fetch('/api/overview', { cache: 'no-store' })).json();
      if (d.todoDashboardUrl) document.getElementById('todoBoard')?.setAttribute('href', d.todoDashboardUrl);
      const invs = d.investigations ?? [];
      const toReview = invs.filter((i) => i.status === 'report-ready').length;
      const running = invs.filter((i) => i.status === 'running' || i.status === 'changes-requested').length;
      badge('investigator', toReview ? `${toReview} to review` : running ? `${running} running` : '', toReview ? 'hot' : running ? 'warn' : '');
      const attention = (d.tasks ?? []).filter((t) => t.labels.includes('needs-reply') || t.labels.includes('new-comment')).length;
      badge('messenger', attention ? String(attention) : '', 'hot');
      const link = d.sources?.whatsapp?.link?.state;
      badge('whatsapp', link && link !== 'connected' && link !== 'off' ? '!' : '', 'bad');
    } catch {
      // the page shows its own "not reachable" state
    }
  }
  counts();
  setInterval(counts, 10000);

  window.Shell = {
    setUpdated(text) {
      const el = document.getElementById('shellUpdated');
      if (el) el.textContent = text;
    },
  };
})();
