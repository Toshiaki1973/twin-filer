# twin-filer

VS Codeのエディタ領域に出す2画面ファイラー拡張。ファイラー専用のVS Codeウィンドウを別に開いて使う想定。依存パッケージ無し・ビルド不要の素のJavaScript。

## 起動

```bash
# 開発用: 拡張を読み込んだ新しいウィンドウを開く(インストール不要)
code --new-window --extensionDevelopmentPath="$(pwd)"   # このフォルダで実行
```

開いたウィンドウで コマンドパレット →「Twin Filer: 開く」。

## 構成

- `extension.js` — webviewパネルの生成とファイル操作(一覧取得・コピー/移動・名前変更・ゴミ箱・フォルダ作成)。確認ダイアログや入力はVS Code側のUI(showWarningMessage/showInputBox)で出す
- `media/filer.{html,css,js}` — 画面。表示・選択・ドラッグ&ドロップ・キー操作。ファイル操作はpostMessageで拡張側に依頼する
- 両ペインのフォルダとフラット表示の状態は `globalState` に保存

## 多言語対応(英語/日本語)

- ソース中の文言は英語で書き、日本語訳は別ファイルに置く。VS Codeの表示言語が日本語なら日本語になる
- `package.json` のタイトル類 → `%key%` 参照、訳は `package.nls.json`(英) / `package.nls.ja.json`(日)
- `extension.js` の文言 → `vscode.l10n.t('English {0}', arg)`、訳は `l10n/bundle.l10n.ja.json`(キーは英語原文そのもの)
- webviewの文言 → 拡張が `vscode.l10n.bundle` を `window.TF_L10N` としてHTMLに埋め込み、`filer.js` の `t()` で引く。`filer.html` の固定文言は `data-i18n` / `data-i18n-title` 属性。訳は同じ `bundle.l10n.ja.json` に入れる
- 文言を足したら bundle への追加漏れに注意(英語原文とキーが1文字でも違うと英語のまま出る)

## 注意点

- Ctrl+C/X/V・F5/F6/F2/F7・Delete・Ctrl+F/R は webview内のkeydownで拾わず、`package.json` の keybindings(`activeWebviewPanelId == 'twinFiler'`)→ `twinFiler.<action>` コマンド → webview へ `{type:'key'}` で転送している。webview内のキーはVS Code本体にも転送されるため、直接拾うとF5でデバッグが始まる等の衝突が起きる。右クリックメニュー(`webview/context`、`data-vscode-context` の `webviewSection` で出し分け)も同じコマンドを使う
- 入力欄フォーカス中は webview → 拡張 → `setContext('twinFiler.inputFocused')` で when句を切り、Ctrl+C/Delete等をテキスト編集に譲る
- 3画面目のプレビューはアクティブペインのカーソル行を表示。テキストは先頭256KB(UTF-8→Shift_JISの順で判定)、画像は10MBまでdata URIで渡す(CSPで `img-src data:` のみ許可)
- クリップボードはwebview内だけで持つ(OSのクリップボードとは連携していない)
- フラット表示は `.git` / `node_modules` / `__pycache__` 等を除外し、シンボリックリンク・ジャンクションは辿らない。最大5000件
- 削除は必ずゴミ箱行き(`useTrash: true`)
