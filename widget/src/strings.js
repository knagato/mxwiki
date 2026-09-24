// Every user-visible string of the widget, in one table so another language can
// be added next to `ja`. Static markup uses data-t / data-t-placeholder /
// data-t-title / data-t-aria-label attributes (applyStrings); code calls t().
const STRINGS = {
  ja: {
    "gate.connecting": "Element に接続中…",
    "gate.openAsWidget": "Element のルームウィジェットとして開くと自動で接続します。",
    "gate.waiting": "Element からの応答待ち… 権限の確認ダイアログが出ていたら許可してください。",
    "gate.noReadCapability": "ページを読む権限が許可されませんでした。ウィジェットの権限設定から許可してください。",
    "gate.error": "エラー: {msg}",
    "dev.summary": "開発モード（Element 外から、アクセストークンで直接接続）",
    "dev.homeserver": "ホームサーバー",
    "dev.room": "ルーム（ID かエイリアス）",
    "dev.token": "アクセストークン",
    "dev.connect": "接続",
    "list.filter": "絞り込み…",
    "list.filterLabel": "ページを絞り込み",
    "list.new": "新規ページ",
    "toolbar.menu": "ページ一覧",
    "toolbar.history": "履歴",
    "toolbar.historyTitle": "この画面で見える範囲の履歴",
    "toolbar.edit": "編集",
    "toolbar.save": "保存",
    "toolbar.cancel": "取消",
    "editor.slug": "slug（例: minutes/2026-09-14）",
    "editor.title": "ページタイトル",
    "editor.body": "Markdown で本文を書く… [[slug]] で他ページへリンク",
    "editor.newPage": "新規ページ",
    "page.missing": "このページはまだありません。",
    "page.createHint": "「編集」で <code>{slug}</code> を作成します。",
    "page.empty": "ページがありません。＋ で作成してください。",
    "save.badSlug": "slug は a-z 0-9 . _ - と / （フォルダ区切り）のみ。各区切りの先頭は英数字",
    "save.exists": "その slug は既にあります",
    "save.tooLarge": "本文が {bytes} B。上限 {max} B。ページを分けてください",
    "save.conflict": "編集を開いた後に {who} が更新しています（{when}）。上書きしますか？",
    "history.loading": "読み込み中…",
    "history.noteWidget": "Element がこの画面に読み込んでいる範囲の版だけ表示します。全履歴は CLI の mxwiki history。",
    "history.noteDev": "直近 500 イベントの範囲。",
    "history.none": "この範囲に版はありません。",
    "history.when": "日時",
    "history.who": "更新者",
    "history.title": "タイトル",
    "history.size": "サイズ",
    "history.current": "現在",
    "history.restore": "この版を復元",
    "history.deleted": "(削除)",
    "mode.widget": "widget",
    "mode.dev": "dev",
  },
};

const lang = "ja";
const locale = "ja-JP";

export function t(key, vars = {}) {
  const s = STRINGS[lang][key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export const fmtDate = (ms) => new Date(ms).toLocaleString(locale);

export function applyStrings(root = document) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const attr of ["placeholder", "title", "aria-label"]) {
    for (const el of root.querySelectorAll(`[data-t-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-t-${attr}`)));
  }
}
