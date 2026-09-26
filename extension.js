// Twin Filer — a two-pane file manager shown in the VS Code editor area
// Twin Filer — VS Codeのエディタ領域に出す2画面ファイラー
const vscode = require('vscode');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const EXCLUDES = new Set(['.git', 'node_modules', '__pycache__', '.venv', '.tmp.drivedownload', '.tmp.driveupload']);
const FLAT_LIMIT = 5000;
const STATE_KEY = 'twinFiler.state';
const PREVIEW_TEXT_LIMIT = 256 * 1024;
const PREVIEW_IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

let panel = null;

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('twinFiler.open', () => openPanel(context)),
  );
  // Keys like F5 and Ctrl+C clash with VS Code's own shortcuts, so they are routed keybindings/context menu -> command -> webview
  // F5やCtrl+C等はVS Code本体のショートカットと衝突するので、keybindings/右クリックメニュー→コマンド→webviewへ転送する
  for (const action of ['openItem', 'openExternal', 'copy', 'cut', 'paste', 'copyToOther', 'moveToOther', 'rename', 'trash', 'mkdir', 'flat', 'refresh']) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`twinFiler.${action}`, ctx => post({ type: 'key', action, ctx }))
    );
  }
}

function defaultDir() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length ? ws[0].uri.fsPath : os.homedir();
}

function openPanel(context) {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('twinFiler', 'Twin Filer', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = new vscode.ThemeIcon('files');
  panel.webview.html = getHtml(panel.webview, context);

  const saved = context.globalState.get(STATE_KEY) || {};
  const init = {
    panes: [0, 1].map(i => ({
      dir: (saved.panes && saved.panes[i] && saved.panes[i].dir) || defaultDir(),
      flat: !!(saved.panes && saved.panes[i] && saved.panes[i].flat),
    })),
  };

  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'ready') post({ type: 'init', state: init });
    else handleMessage(context, msg);
  }, null, context.subscriptions);
  panel.onDidChangeViewState(e => { if (e.webviewPanel.active) post({ type: 'refresh' }); });
  panel.onDidDispose(() => {
    panel = null;
    vscode.commands.executeCommand('setContext', 'twinFiler.inputFocused', false);
  });
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
}

async function handleMessage(context, msg) {
  try {
    switch (msg.type) {
      case 'list': return await doList(msg);
      case 'preview': return await doPreview(msg);
      case 'inputFocus': return vscode.commands.executeCommand('setContext', 'twinFiler.inputFocused', !!msg.focused);
      case 'saveState': return context.globalState.update(STATE_KEY, msg.state);
      case 'open': return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(msg.path));
      case 'openExternal': return vscode.env.openExternal(vscode.Uri.file(msg.path));
      case 'transfer': return await doTransfer(msg.op, msg.srcs, msg.destDir);
      case 'rename': return await doRename(msg.path);
      case 'trash': return await doTrash(msg.paths);
      case 'mkdir': return await doMkdir(msg.dir);
      case 'pickFolder': return await doPickFolder(msg.pane, msg.dir);
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Twin Filer: ${err.message || err}`);
    post({ type: 'refresh' });
  }
}

async function statEntry(full, rel, isDir) {
  try {
    const st = await fsp.stat(full);
    return { name: path.basename(full), rel, path: full, isDir, size: isDir ? null : st.size, mtime: st.mtimeMs };
  } catch {
    return { name: path.basename(full), rel, path: full, isDir, size: null, mtime: null };
  }
}

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function doList({ pane, dir, flat, reqId }) {
  let entries = [];
  let truncated = false;
  let error = null;
  try {
    await fsp.access(dir);
    if (flat) {
      // List every file under subfolders (symlinks/junctions are not followed)
      // サブフォルダ以下のファイルを全部並べる(シンボリックリンク/ジャンクションは辿らない)
      const files = [];
      const stack = [''];
      while (stack.length && files.length < FLAT_LIMIT) {
        const relDir = stack.pop();
        for (const d of await readDirSafe(path.join(dir, relDir))) {
          if (EXCLUDES.has(d.name)) continue;
          const rel = relDir ? path.join(relDir, d.name) : d.name;
          if (d.isDirectory()) stack.push(rel);
          else if (d.isFile()) files.push(rel);
          if (files.length >= FLAT_LIMIT) { truncated = true; break; }
        }
      }
      entries = await Promise.all(files.map(rel => statEntry(path.join(dir, rel), rel, false)));
    } else {
      const dirents = await readDirSafe(dir);
      entries = await Promise.all(dirents.map(d => {
        const isDir = d.isDirectory() || (d.isSymbolicLink() && isDirSync(path.join(dir, d.name)));
        return statEntry(path.join(dir, d.name), d.name, isDir);
      }));
    }
  } catch (err) {
    error = vscode.l10n.t('Could not open: {0}', err.message || String(err));
  }
  post({ type: 'listResult', pane, dir, flat, reqId, entries, truncated, error });
}

function isDirSync(p) {
  try { return require('fs').statSync(p).isDirectory(); } catch { return false; }
}

function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* not UTF-8, try Shift_JIS / UTF-8でなければShift_JISを試す */ }
  try { return new TextDecoder('shift_jis').decode(buf); } catch { return buf.toString('utf8'); }
}

async function doPreview({ path: p, reqId }) {
  const res = { type: 'previewResult', reqId, path: p, name: path.basename(p) };
  try {
    const st = await fsp.stat(p);
    res.size = st.size;
    const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
    if (st.isDirectory()) {
      const ds = await readDirSafe(p);
      res.kind = 'dir';
      res.items = ds.map(d => ({ name: d.name, isDir: d.isDirectory() }))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    } else if (mime) {
      if (st.size > PREVIEW_IMAGE_LIMIT) {
        res.kind = 'binary';
      } else {
        res.kind = 'image';
        res.content = `data:${mime};base64,${(await fsp.readFile(p)).toString('base64')}`;
      }
    } else {
      const fh = await fsp.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, PREVIEW_TEXT_LIMIT));
        await fh.read(buf, 0, buf.length, 0);
        if (buf.subarray(0, 8192).includes(0)) {
          res.kind = 'binary';
        } else {
          res.kind = 'text';
          res.content = decodeText(buf);
          res.truncated = st.size > PREVIEW_TEXT_LIMIT;
        }
      } finally { await fh.close(); }
    }
  } catch (err) {
    res.kind = 'error';
    res.content = vscode.l10n.t('Could not read: {0}', err.message || String(err));
  }
  post(res);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function doTransfer(op, srcs, destDir) {
  const isCopy = op === 'copy';
  const OVERWRITE = vscode.l10n.t('Overwrite'), OVERWRITE_ALL = vscode.l10n.t('Overwrite All'), SKIP = vscode.l10n.t('Skip');
  let overwriteAll = false;
  let done = 0;
  for (const src of srcs) {
    let dest = path.join(destDir, path.basename(src));
    if (path.resolve(src).toLowerCase() === path.resolve(dest).toLowerCase()) {
      if (op !== 'copy') continue;
      dest = await uniqueCopyName(dest); // Copying into the same folder gets an Explorer-style new name / 同じフォルダへのコピーはエクスプローラー風に別名にする
    }
    if ((destDir + path.sep).toLowerCase().startsWith((src + path.sep).toLowerCase())) {
      vscode.window.showWarningMessage(isCopy
        ? vscode.l10n.t('Cannot copy "{0}" into itself.', path.basename(src))
        : vscode.l10n.t('Cannot move "{0}" into itself.', path.basename(src)));
      continue;
    }
    let overwrite = false;
    if (await exists(dest)) {
      if (!overwriteAll) {
        const ans = await vscode.window.showWarningMessage(
          vscode.l10n.t('"{0}" already exists in the destination. Overwrite it?', path.basename(src)),
          { modal: true }, OVERWRITE, OVERWRITE_ALL, SKIP);
        if (!ans) break;
        if (ans === SKIP) continue;
        if (ans === OVERWRITE_ALL) overwriteAll = true;
      }
      overwrite = true;
    }
    try {
      const s = vscode.Uri.file(src), d = vscode.Uri.file(dest);
      if (op === 'copy') await vscode.workspace.fs.copy(s, d, { overwrite });
      else await vscode.workspace.fs.rename(s, d, { overwrite });
      done++;
    } catch (err) {
      vscode.window.showErrorMessage(isCopy
        ? vscode.l10n.t('Failed to copy "{0}": {1}', path.basename(src), err.message || String(err))
        : vscode.l10n.t('Failed to move "{0}": {1}', path.basename(src), err.message || String(err)));
    }
  }
  if (done) vscode.window.setStatusBarMessage(isCopy
    ? vscode.l10n.t('Twin Filer: Copied {0} item(s)', done)
    : vscode.l10n.t('Twin Filer: Moved {0} item(s)', done), 3000);
  post({ type: 'refresh' });
}

async function uniqueCopyName(p) {
  const dir = path.dirname(p), ext = path.extname(p), stem = path.basename(p, ext);
  for (let n = 1; ; n++) {
    const cand = path.join(dir, (n > 1 ? vscode.l10n.t('{0} - Copy ({1})', stem, n) : vscode.l10n.t('{0} - Copy', stem)) + ext);
    if (!(await exists(cand))) return cand;
  }
}

async function doRename(p) {
  const oldName = path.basename(p);
  const dot = oldName.lastIndexOf('.');
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New name'), value: oldName,
    valueSelection: [0, dot > 0 ? dot : oldName.length],
    validateInput: v => (!v || /[\\/:*?"<>|]/.test(v) ? vscode.l10n.t('The name contains invalid characters') : null),
  });
  if (!name || name === oldName) return;
  await vscode.workspace.fs.rename(vscode.Uri.file(p), vscode.Uri.file(path.join(path.dirname(p), name)), { overwrite: false });
  post({ type: 'refresh' });
}

async function doTrash(paths) {
  if (!paths.length) return;
  const TRASH = vscode.l10n.t('Move to Trash');
  const question = paths.length === 1
    ? vscode.l10n.t('Move "{0}" to the Trash?', path.basename(paths[0]))
    : vscode.l10n.t('Move {0} items to the Trash?', paths.length);
  const ans = await vscode.window.showWarningMessage(question, { modal: true }, TRASH);
  if (ans !== TRASH) return;
  for (const p of paths) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(p), { recursive: true, useTrash: true });
    } catch (err) {
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to delete "{0}": {1}', path.basename(p), err.message || String(err)));
    }
  }
  post({ type: 'refresh' });
}

async function doMkdir(dir) {
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New folder name'),
    validateInput: v => (!v || /[\\/:*?"<>|]/.test(v) ? vscode.l10n.t('The name contains invalid characters') : null),
  });
  if (!name) return;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.join(dir, name)));
  post({ type: 'refresh' });
}

async function doPickFolder(pane, dir) {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    defaultUri: dir ? vscode.Uri.file(dir) : undefined, openLabel: vscode.l10n.t('Show This Folder'),
  });
  if (picked && picked[0]) post({ type: 'setDir', pane, dir: picked[0].fsPath });
}

function getHtml(webview, context) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const read = f => require('fs').readFileSync(path.join(context.extensionPath, 'media', f), 'utf8');
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${read('filer.css')}</style>
<script nonce="${nonce}">window.TF_L10N = ${JSON.stringify(vscode.l10n.bundle || {}).replace(/</g, '\\u003c')};</script>
</head><body>
${read('filer.html')}
<script nonce="${nonce}">${read('filer.js')}</script>
</body></html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
