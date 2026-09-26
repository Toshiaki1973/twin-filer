// Twin Filer webview side: handles display, selection, keys and drag & drop; file operations are delegated to the extension
// Twin Filer webview側。表示と選択・キー/ドラッグ操作を担当し、ファイル操作は拡張側に依頼する
(function () {
  const vscode = acquireVsCodeApi();
  const L10N = window.TF_L10N || {};
  const t = (s, ...args) => (L10N[s] || s).replace(/\{(\d+)\}/g, (_, i) => args[i]);
  const DND_TYPE = 'application/x-twinfiler';
  let active = 0;
  let clip = null; // { op: 'copy' | 'cut', paths: [] }
  let showPreview = true;
  const pv = { path: null, reqId: 0, timer: null };
  let reqSeq = 0;
  const panes = [0, 1].map(i => ({
    i, dir: '', flat: false, entries: [], view: [], filter: '',
    sort: { key: 'name', asc: true }, selected: new Set(), cursor: 0, anchor: 0,
    reqId: 0, error: null, truncated: false, focusName: null, el: {},
  }));

  // ---------- Path helpers (Windows/Unix) / パス操作(Windows/Unix両対応) ----------
  function parentDir(dir) {
    const m = dir.replace(/[\\/]+$/, '');
    const i = Math.max(m.lastIndexOf('\\'), m.lastIndexOf('/'));
    if (i < 0) return dir;
    let p = m.slice(0, i);
    if (/^[A-Za-z]:$/.test(p)) p += '\\';
    return p || '/';
  }
  function baseName(p) {
    const m = p.replace(/[\\/]+$/, '');
    return m.slice(Math.max(m.lastIndexOf('\\'), m.lastIndexOf('/')) + 1);
  }

  // ---------- Rendering / 表示 ----------
  function build(p) {
    const root = document.querySelector(`.pane[data-pane="${p.i}"]`);
    root.innerHTML = `
      <div class="bar">
        <button data-act="up" title="${esc(t('Up one level (Backspace)'))}">↑</button>
        <input class="path" spellcheck="false" title="${esc(t('Type a path and press Enter'))}" data-vscode-context='{"webviewSection":"input","preventDefaultContextMenuItems":false}'>
        <button data-act="pick" title="${esc(t('Choose a folder'))}">…</button>
        <button data-act="flat" title="${esc(t('List everything in subfolders (Ctrl+F)'))}">${esc(t('Flat'))}</button>
        <button data-act="refresh" title="${esc(t('Refresh (Ctrl+R)'))}">⟳</button>
      </div>
      <div class="bar"><input class="filter" placeholder="${esc(t('Filter'))}" spellcheck="false" data-vscode-context='{"webviewSection":"input","preventDefaultContextMenuItems":false}'></div>
      <div class="head"><span class="name" data-sort="name">${esc(t('Name'))}</span><span class="size" data-sort="size">${esc(t('Size'))}</span><span class="date" data-sort="date">${esc(t('Modified'))}</span></div>
      <div class="list" tabindex="0" data-vscode-context='{"webviewSection":"pane"}'></div>`;
    p.el = {
      root, path: root.querySelector('.path'), filter: root.querySelector('.filter'),
      list: root.querySelector('.list'), flatBtn: root.querySelector('[data-act="flat"]'),
    };
    root.addEventListener('mousedown', () => setActive(p.i, false));
    root.querySelector('[data-act="up"]').onclick = () => goUp(p);
    root.querySelector('[data-act="pick"]').onclick = () => vscode.postMessage({ type: 'pickFolder', pane: p.i, dir: p.dir });
    p.el.flatBtn.onclick = () => toggleFlat(p);
    root.querySelector('[data-act="refresh"]').onclick = () => load(p);
    root.querySelectorAll('[data-sort]').forEach(h => h.onclick = () => {
      const key = h.dataset.sort;
      p.sort = { key, asc: p.sort.key === key ? !p.sort.asc : true };
      render(p);
    });
    p.el.path.addEventListener('keydown', e => {
      if (e.key === 'Enter') { navigate(p, p.el.path.value.trim()); p.el.list.focus(); }
      if (e.key === 'Escape') { p.el.path.value = p.dir; p.el.list.focus(); }
      e.stopPropagation();
    });
    p.el.filter.addEventListener('input', () => { p.filter = p.el.filter.value; p.cursor = 0; render(p); });
    p.el.filter.addEventListener('keydown', e => {
      if (e.key === 'Escape') { p.el.filter.value = ''; p.filter = ''; render(p); p.el.list.focus(); }
      if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); p.el.list.focus(); }
      e.stopPropagation();
    });
    p.el.list.addEventListener('keydown', e => onListKey(p, e));
    setupDrop(p, p.el.list, () => p.dir);
  }

  function computeView(p) {
    const f = p.filter.toLowerCase();
    let v = p.entries.filter(e => !f || e.rel.toLowerCase().includes(f));
    const { key, asc } = p.sort;
    const val = e => key === 'size' ? (e.size || 0) : key === 'date' ? (e.mtime || 0) : (p.flat ? e.rel : e.name).toLowerCase();
    v.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
    });
    if (p.flat) return groupByFolder(v);
    if (parentDir(p.dir) !== p.dir) v.unshift({ up: true, fixed: true, name: '..', rel: '..', path: parentDir(p.dir), isDir: true });
    return v;
  }

  function groupByFolder(files) {
    const groups = new Map();
    for (const e of files) {
      const folder = e.rel.slice(0, e.rel.length - baseName(e.rel).length);
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(e);
    }
    const out = [];
    const keys = [...groups.keys()].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0);
    for (const folder of keys) {
      const items = groups.get(folder);
      if (folder) {
        const first = items[0];
        const path = first.path.slice(0, first.path.length - first.name.length).replace(/[\/]+$/, '');
        out.push({ group: true, fixed: true, isDir: true, name: folder, rel: folder, path, size: null, mtime: null });
      }
      out.push(...items);
    }
    return out;
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 ** 3) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 ** 3).toFixed(2) + ' GB';
  }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms), z = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }
  function esc(s) {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function render(p) {
    p.view = computeView(p);
    p.el.path.value = p.dir;
    p.el.flatBtn.classList.toggle('on', p.flat);
    if (p.focusName != null) {
      const idx = p.view.findIndex(e => e.path === p.focusName || e.name === p.focusName);
      if (idx >= 0) p.cursor = idx;
      p.focusName = null;
    }
    p.cursor = Math.max(0, Math.min(p.cursor, p.view.length - 1));
    const list = p.el.list;
    if (p.error) { list.innerHTML = `<div class="msg">${esc(p.error)}</div>`; updateStatus(); return; }
    const html = p.view.map((e, idx) => {
      let label;
      if (e.group) {
        label = esc(e.name);
      } else if (p.flat) {
        label = esc(e.name);
      } else {
        label = e.isDir && !e.up ? esc(e.name) + '\\' : esc(e.name);
      }
      const cut = clip && clip.op === 'cut' && clip.paths.includes(e.path);
      const cls = ['row', cut ? 'cutting' : '', e.isDir ? 'dir' : '', e.group ? 'group' : '', p.flat && !e.group && e.rel !== e.name ? 'child' : '', p.selected.has(e.path) ? 'sel' : '', idx === p.cursor ? 'cursor' : ''].join(' ');
      return `<div class="${cls}" data-idx="${idx}" draggable="${e.fixed ? 'false' : 'true'}" data-vscode-context='{"webviewSection":"${e.fixed ? 'folder' : 'item'}"}' title="${esc(e.path)}">` +
        `<span class="name">${label}</span><span class="size">${fmtSize(e.size)}</span><span class="date">${fmtDate(e.mtime)}</span></div>`;
    }).join('');
    list.innerHTML = html || `<div class="msg">${esc(t('(empty)'))}</div>`;
    if (p.truncated) list.insertAdjacentHTML('beforeend', `<div class="msg">${esc(t('Too many items; only some are shown'))}</div>`);
    list.querySelectorAll('.row').forEach(row => bindRow(p, row));
    const cur = list.querySelector('.row.cursor');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
    updateStatus();
    if (p.i === active) schedulePreview();
  }

  // ---------- Preview (third pane) / プレビュー(3画面目) ----------
  function schedulePreview(force) {
    if (!showPreview) return;
    const p = panes[active];
    const e = p.view[p.cursor];
    const target = e && !e.up ? e.path : null;
    if (!force && target === pv.path) return;
    pv.path = target;
    clearTimeout(pv.timer);
    if (!target) { showPreviewContent('', ''); return; }
    // Wait a moment so rapid cursor moves don't trigger many reads
    // カーソル連打で大量に読まないよう少し待つ
    pv.timer = setTimeout(() => {
      pv.reqId = ++reqSeq;
      vscode.postMessage({ type: 'preview', path: target, reqId: pv.reqId });
    }, 120);
  }

  function showPreviewContent(titleHtml, bodyHtml) {
    const el = document.getElementById('preview');
    el.querySelector('.ptitle').innerHTML = titleHtml;
    const body = el.querySelector('.pbody');
    body.innerHTML = bodyHtml;
    body.scrollTop = 0;
  }

  function onPreviewResult(m) {
    if (m.reqId !== pv.reqId) return;
    const title = `${esc(m.name)}<span class="dim">${m.kind === 'dir' ? '' : fmtSize(m.size)}</span>`;
    let body;
    switch (m.kind) {
      case 'text':
        body = `<pre>${esc(m.content)}</pre>` + (m.truncated ? `<div class="msg">${esc(t('(File is long; showing the beginning only)'))}</div>` : '');
        break;
      case 'image': body = `<img src="${m.content}" alt="">`; break;
      case 'dir':
        body = '<div class="pdir">' + (m.items.length
          ? m.items.slice(0, 1000).map(x => `<div class="${x.isDir ? 'd' : ''}">${esc(x.name)}${x.isDir ? '\\' : ''}</div>`).join('')
          : `<div class="msg">${esc(t('(empty)'))}</div>`) + '</div>';
        break;
      case 'binary': body = `<div class="msg">${esc(t('This file cannot be previewed'))}</div>`; break;
      default: body = `<div class="msg">${esc(m.content || '')}</div>`;
    }
    showPreviewContent(title, body);
  }

  function setPreviewVisible(on) {
    showPreview = on;
    document.body.classList.toggle('nopreview', !on);
    document.getElementById('previewToggle').classList.toggle('on', on);
    if (on) schedulePreview(true);
  }

  function updateStatus() {
    const p = panes[active];
    const n = p.selected.size;
    const files = p.view.filter(e => !e.fixed).length;
    const parts = [`${active === 0 ? t('Left') : t('Right')}: ${t('{0} items', files)}`];
    if (n) parts.push(t('{0} selected', n));
    if (clip) parts.push(clip.op === 'cut' ? t('{0} cut', clip.paths.length) : t('{0} copied', clip.paths.length));
    document.getElementById('sel').textContent = parts.join(' / ');
  }

  // ---------- Row interaction / 行の操作 ----------
  function bindRow(p, row) {
    const idx = +row.dataset.idx;
    const e = p.view[idx];
    row.addEventListener('mousedown', ev => {
      if (ev.button === 2) {
        // Right-click: if the row isn't selected, select only it before the menu opens
        // 右クリック: 選択外の行なら、その行だけを選び直してからメニューを出す
        setActive(p.i, false);
        if (!e.fixed && !p.selected.has(e.path)) { p.selected.clear(); p.selected.add(e.path); }
        p.cursor = idx;
        render(p);
        return;
      }
      if (ev.button !== 0) return;
      setActive(p.i, false);
      if (ev.ctrlKey) toggleSel(p, e);
      else if (ev.shiftKey) selectRange(p, p.cursor, idx);
      else if (!p.selected.has(e.path)) { p.selected.clear(); if (!e.fixed) p.selected.add(e.path); }
      if (!ev.shiftKey) p.anchor = idx;
      p.cursor = idx;
      render(p);
      p.el.list.focus();
    });
    row.addEventListener('dblclick', () => activate(p, e));
    if (e.fixed) { setupDrop(p, row, () => e.path); return; }
    row.addEventListener('dragstart', ev => {
      if (!p.selected.has(e.path)) { p.selected.clear(); p.selected.add(e.path); }
      ev.dataTransfer.setData(DND_TYPE, JSON.stringify({ pane: p.i, paths: [...p.selected] }));
      ev.dataTransfer.effectAllowed = 'copyMove';
    });
    if (e.isDir) setupDrop(p, row, () => e.path);
  }

  function setupDrop(p, el, destFn) {
    el.addEventListener('dragover', ev => {
      if (!ev.dataTransfer.types.includes(DND_TYPE)) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.dataTransfer.dropEffect = ev.ctrlKey ? 'copy' : 'move';
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', ev => {
      el.classList.remove('drop');
      const raw = ev.dataTransfer.getData(DND_TYPE);
      if (!raw) return;
      ev.preventDefault();
      ev.stopPropagation();
      const { paths } = JSON.parse(raw);
      const destDir = destFn();
      if (paths.includes(destDir)) return;
      if (paths.every(s => parentDir(s) === destDir)) return;
      vscode.postMessage({ type: 'transfer', op: ev.ctrlKey ? 'copy' : 'move', srcs: paths, destDir });
    });
  }

  function toggleSel(p, e) {
    if (e.fixed) return;
    if (p.selected.has(e.path)) p.selected.delete(e.path); else p.selected.add(e.path);
  }
  function selectRange(p, a, b) {
    p.selected.clear();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) if (!p.view[k].fixed) p.selected.add(p.view[k].path);
  }
  function targets(p) {
    if (p.selected.size) return [...p.selected];
    const e = p.view[p.cursor];
    return e && !e.fixed ? [e.path] : [];
  }

  function activate(p, e, external) {
    if (!e) return;
    if (e.isDir) {
      if (p.flat) { p.flat = false; }
      navigate(p, e.path, e.up ? p.dir : null);
    } else {
      vscode.postMessage({ type: external ? 'openExternal' : 'open', path: e.path });
    }
  }

  function goUp(p) {
    const parent = parentDir(p.dir);
    if (parent !== p.dir) navigate(p, parent, p.dir);
  }

  function navigate(p, dir, focusPath) {
    if (!dir) return;
    p.dir = dir;
    p.selected.clear();
    p.cursor = 0;
    p.filter = '';
    p.el.filter.value = '';
    p.focusName = focusPath || null;
    load(p);
    saveState();
  }

  function toggleFlat(p) {
    p.flat = !p.flat;
    p.selected.clear();
    p.cursor = 0;
    load(p);
    saveState();
  }

  function load(p) {
    p.reqId = ++reqSeq;
    vscode.postMessage({ type: 'list', pane: p.i, dir: p.dir, flat: p.flat, reqId: p.reqId });
  }

  function setActive(i, focus = true) {
    active = i;
    panes.forEach(p => p.el.root.classList.toggle('active', p.i === i));
    if (focus) panes[i].el.list.focus();
    updateStatus();
    schedulePreview();
  }

  // ---------- Keyboard / キー操作 ----------
  function onListKey(p, e) {
    const n = p.view.length;
    const move = d => {
      const next = Math.max(0, Math.min(n - 1, p.cursor + d));
      if (e.shiftKey) selectRange(p, p.anchor, next); else p.anchor = next;
      p.cursor = next;
      render(p);
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'PageDown': e.preventDefault(); move(20); break;
      case 'PageUp': e.preventDefault(); move(-20); break;
      case 'Home': e.preventDefault(); p.cursor = 0; render(p); break;
      case 'End': e.preventDefault(); p.cursor = n - 1; render(p); break;
      case ' ': e.preventDefault(); if (p.view[p.cursor]) toggleSel(p, p.view[p.cursor]); p.cursor = Math.min(n - 1, p.cursor + 1); render(p); break;
      case 'Enter': e.preventDefault(); activate(p, p.view[p.cursor], e.shiftKey); break;
      case 'Backspace': e.preventDefault(); goUp(p); break;
      case 'Tab': e.preventDefault(); setActive(1 - p.i); break;
      case 'ArrowLeft': if (p.i === 1) { e.preventDefault(); setActive(0); } break;
      case 'ArrowRight': if (p.i === 0) { e.preventDefault(); setActive(1); } break;
      case 'Escape': p.selected.clear(); render(p); break;
      case 'a': if (e.ctrlKey) { e.preventDefault(); p.view.forEach(x => !x.fixed && p.selected.add(x.path)); render(p); } break;
      default:
        // Typing a character jumps to the filter box
        // 1文字入力で絞り込み欄へ
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey) { p.el.filter.focus(); }
    }
  }

  // Keys delivered via keybindings / context menu commands
  // keybindings・右クリックメニュー経由で届く操作
  function onCommandKey(action) {
    const p = panes[active], other = panes[1 - active];
    const t = targets(p);
    switch (action) {
      case 'openItem': activate(p, p.view[p.cursor]); break;
      case 'openExternal': activate(p, p.view[p.cursor], true); break;
      case 'copy':
      case 'cut':
        if (t.length) { clip = { op: action, paths: t }; panes.forEach(render); }
        break;
      case 'paste':
        if (clip && p.dir) {
          vscode.postMessage({ type: 'transfer', op: clip.op === 'cut' ? 'move' : 'copy', srcs: clip.paths, destDir: p.dir });
          if (clip.op === 'cut') clip = null; // A cut is pasted only once / 切り取りは1回貼ったら終わり
        }
        break;
      case 'copyToOther':
      case 'moveToOther':
        if (t.length && other.dir) vscode.postMessage({ type: 'transfer', op: action === 'copyToOther' ? 'copy' : 'move', srcs: t, destDir: other.dir });
        break;
      case 'rename': { const e = p.view[p.cursor]; if (e && !e.fixed) vscode.postMessage({ type: 'rename', path: e.path }); break; }
      case 'trash': if (t.length) vscode.postMessage({ type: 'trash', paths: t }); break;
      case 'mkdir': vscode.postMessage({ type: 'mkdir', dir: p.dir }); break;
      case 'flat': toggleFlat(p); break;
      case 'refresh': panes.forEach(load); break;
    }
  }

  // ---------- State persistence / 状態保存 ----------
  function saveState() {
    const state = { panes: panes.map(p => ({ dir: p.dir, flat: p.flat })), active, showPreview };
    vscode.setState(state);
    vscode.postMessage({ type: 'saveState', state });
  }

  // ---------- Messages from the extension / 拡張からのメッセージ ----------
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'init': {
        const st = vscode.getState() || msg.state;
        panes.forEach((p, i) => { p.dir = st.panes[i].dir; p.flat = st.panes[i].flat; load(p); });
        setPreviewVisible(st.showPreview !== false);
        setActive(st.active || 0);
        break;
      }
      case 'listResult': {
        const p = panes[msg.pane];
        if (msg.reqId !== p.reqId) return; // Drop stale responses / 古い応答は捨てる
        p.entries = msg.entries;
        p.error = msg.error;
        p.truncated = msg.truncated;
        const exist = new Set(p.entries.map(e => e.path));
        p.selected.forEach(s => { if (!exist.has(s)) p.selected.delete(s); });
        render(p);
        break;
      }
      case 'refresh': pv.path = null; panes.forEach(load); break;
      case 'previewResult': onPreviewResult(msg); break;
      case 'setDir': navigate(panes[msg.pane], msg.dir); break;
      case 'key': onCommandKey(msg.action); break;
    }
  });

  // While an input has focus, leave Ctrl+C/Delete etc. to text editing (used by the keybindings' when clause)
  // 入力欄にフォーカスがある間はCtrl+C/Delete等をテキスト操作に譲る(keybindingsのwhen句で使う)
  document.addEventListener('focusin', e => vscode.postMessage({ type: 'inputFocus', focused: e.target.tagName === 'INPUT' }));
  document.addEventListener('focusout', () => vscode.postMessage({ type: 'inputFocus', focused: false }));

  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.body.dataset.vscodeContext = JSON.stringify({ preventDefaultContextMenuItems: true });
  panes.forEach(build);
  document.getElementById('previewToggle').onclick = () => { setPreviewVisible(!showPreview); saveState(); };
  vscode.postMessage({ type: 'ready' });
})();
