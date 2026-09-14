# MyWiki 設計メモ（Matrix ネイティブ Wiki）

Matrix を土台にした「情報がフローに流れない（ストック型）」コミュニティ Wiki。
Element のようなチャット UI ではなく、専用の Web SPA でページ指向の閲覧・編集を行う。

## 基本アーキテクチャ（両 Tier 共通）

- **1 ルーム = 1 Wiki**。ページは `state_key` = slug で識別。
- **本文 = timeline イベント**、**state = ポインタ `{title, latest_event_id}`** に統一。
  - state を小さく保つ（Synapse の状態解決メモリに本文を載せない）。
  - state event は暗号化されないので、機密は必ず timeline 側に置く。
  - 履歴 = 過去イベント／`m.replace`。ページ一覧 = `GET /rooms/{room}/state` を type でフィルタ。
- **クライアントは Web SPA**。静的ホスティングで配布可、認証・データは Matrix に委譲。

## Tier 1: 限定公開 Wiki（サーバーアカウント単位で閲覧制限）

- **状態: ほぼ完成**（PoC = `mywiki/plan-a.html` を本線に、`index.html`/`plan-b.html` はデモ）。
- 本文 = 平文 timeline イベント、画像 = 平文 media（mxc 参照）。
- 閲覧境界:
  - ページ一覧・タイトル・本文（state/timeline）= **ルームメンバー限定**（membership が効く）。
  - 画像（media）= **サーバーにアカウントを持つ人**なら mxc を知れば取得可（ルーム参加は不問）。
    → Tier 1 の狙いが「サーバー参加者限定」なので許容。
- 締め: 公開登録 OFF（デフォルト）＋ `guest_access: forbidden` で、アカウントの無い人からは読めない。

## Tier 2: 暗号化 Wiki（ルームメンバー単位で閲覧制限）

- **状態: PoC 実装済み**（`mywiki/tier2/`, Vite + matrix-js-sdk 37 + rust-crypto-wasm + matrix-encrypt-attachment）。
  - 実装: 本文=暗号化 timeline(`m.room.message`), state ポインタ `com.example.wiki.page_e {title,latest_event_id}`,
    画像=encryptAttachment で暗号化アップロード＋復号鍵を本文 content の `wiki.images` に格納、
    本文中は `![](enc:IMGID)` プレースホルダ。回復キー/パスフレーズ解錠 UI あり。
  - **要事前設定**: 使うアカウントに Element 等で クロスサイニング＋鍵バックアップ＋回復キー を作成しておくこと。
    未設定だと別ブラウザからの過去ページ復号が不可（同一ブラウザ内は鍵ローカルで可）。ブラウザ実機テストは未実施。
- Tier 1 とストレージ構造は同じ、暗号化レイヤーが乗るだけ。
- 本文= `m.room.message` の暗号化イベント。`body` はタイトルのみ（Element でフロー化しないため）、
  実体は同イベント content の `wiki.raw`、画像鍵は `wiki.images`。→ Element はタイトルだけ表示、SPA が全文表示。

### Tier 2 実機で判明した知見（重要）

- **HTTPS 必須**: E2EE は WebCrypto(`crypto.subtle`) を使い、これはセキュアコンテキスト(https / localhost)限定。
  社内・家庭内のホスト名でも `http://` は非セキュア扱いで不可。
- 開発時は Vite を HTTPS で提供し、`/_matrix`・`/_synapse` を Synapse へ `server.proxy` でリバースプロキシすると、
  単一オリジンに集約できて CORS / mixed content の問題が消える（SPA の homeserver 欄は空欄 = 同一オリジン）。
- **device_id を使い回さない**: 使い回すと永続 crypto ストアが「鍵アップロード済み」と誤認し、
  新デバイスにデバイス鍵が上がらず署名対象が無く未検証になる。→ ログインごと新デバイス（prefix もデバイス別）。
- **自己署名(検証済み化)**: 解錠時に 4S の回復キーで getSecretStorageKey を満たし、
  `bootstrapCrossSigning({authUploadDeviceSigningKeys: パスワードUIA})` → `crossSignDevice(自device)`。
  署名直後は SPA 自身の `getDeviceVerificationStatus` がローカル遅延で未検証を返すが、
  サーバー反映が真（他クライアントは即検証済み表示）。→ 状態チェックで throw しない。
- device 一括削除は全セッションをログアウトさせる（Element 等も）。表示名/最終アクティビティで対象を絞ること。
  クロスサイニング(4S)と鍵バックアップが残っていれば、回復キーで各クライアント再ログイン→再検証で復旧可。
- **matrix-js-sdk（or rust-crypto-wasm）前提**。megolm/olm の手書きは非現実的。
- 本文 = **暗号化 timeline イベント**（SDK が megolm で暗復号）。
- 画像 = **暗号化 media**（SDK が AES-CTR でクライアント暗号化、復号鍵は暗号化イベント内の `EncryptedFile` に格納）。
  - → mxc を知られても鍵が無いので復号不可 = **真のメンバー限定**。base64 埋め込みは 64KiB 制限で不可、SDK なら暗号化 media が事実上タダなので不要。
- state ポインタには非機密のみ（タイトルも隠すなら暗号化イベント側へ）。

### 鍵・ログイン UX（Tier 2 の必須要件）

- 新デバイス（＝新ブラウザ）でのログイン時、**初回だけ**次のどちらかが必要:
  - A. **回復キー / セキュリティフレーズ**で鍵バックアップ(4S/Secure Storage)を解錠 → 過去ページの鍵を復元。
  - B. 既存の信頼済みデバイスと**検証**（絵文字/QR）→ 鍵共有。
- Wiki は過去記事の閲覧が本質なので、**実質 鍵バックアップ（回復キー）が前提**。
- 以降はブラウザの IndexedDB に鍵を永続化 → 再訪時は回復キー入力不要。別ブラウザ/別PC/シークレットは新デバイス扱いで再度初回解錠。
- 前提: アカウントに **クロスサイニング＋鍵バックアップ＋回復キー**が設定済みであること（未設定なら初回クライアントが `bootstrapSecretStorage` でセットアップ）。
- SPA UX: 「初回だけ回復キー入力モーダル → 以降自動」で Element 同等にできる。

## 共通化と切り替え

- Space 下に `MyWiki-public`(Tier1) と `MyWiki-secret`(Tier2) を並置可能。
- SPA は「そのルームが暗号化か否か」で読み書き経路（平文 fetch / SDK 暗号化）を切り替える。
- ページ指向 UI・state ポインタ方式・履歴モデルは両 Tier 共通。

## Obsidian Vault 連携（検討メモ 2026-09-12, 未実装）

方針: **Matrix が正・Vault は読み取りミラー**。まず Tier1 から。編集は SPA のみ、
Obsidian はグラフビュー/バックリンク付きの閲覧・検索クライアントとして使う。

### 前提（調査で確定）

- **本文の実体は `wiki.raw`**。`plan-a.html` は `body` に `[wiki:<slug>] <title>\n\n<本文>` の前置き付きで、
  `wiki.raw` に素の本文を書いている。`loadBody` は `body` を読むので SPA 表示に前置きが混ざっている。
  → ミラーは `wiki.raw` 優先、無ければ `body` から前置き行を剥がす。
- **`m.replace` を畳む必要はない**。state ポインタの `latest_event_id` が常に最新版を指すので、
  state 一覧 → 各 `latest_event_id` を 1発 GET、で最新本文が揃う。編集チェーンを辿る実装は不要。
- **Synapse は認証付きメディアが必須**（非認証 `/_matrix/media/v3/download` は凍結済み）。
  `![](https://…/_matrix/…)` を .md に書いても Obsidian は Bearer を付けられず表示不可。
  → 画像は**ローカルに実体をダウンロードする以外に選択肢がない**（設計の選択肢ではなく制約）。
- Tier1 本線 `page_a` に画像添付はまだ無い。`plan-b.html` は画像デモではなく
  「本文を media repo に置く」**別アーキテクチャ(案B, `page_b`)** のデモ。→ 画像は変換規則だけ決めて実装は後回し可。

### 共通スキーマ

```
<Vault>/MyWiki/            ← ミラー専用。機械が所有する（既存ノートと隔離）
  <slug>.md
  _attachments/<media_id>.<ext>
  _trash/                  ← state から消えた slug の退避先
```

frontmatter: `title` / `mywiki_slug` / `mywiki_room` / `mywiki_event_id` / `mywiki_synced_at`。

- **ファイル名 = slug**（title ではなく）。本文中の `[[slug]]` が無変換で解決する。
- **`mywiki_event_id` が冪等キー**。`latest_event_id` と一致すれば書き込みスキップ。
  → 飾りではなく必須。無いと定期実行のたびに同期サービスが全件を再アップロードする。
- 削除: state event の空 content 上書きが「削除」。ファイルは消さず `_trash/` へ移動。

### 実装形態の比較

読み取り専用・平文になったことで、**Obsidian プラグイン案の優位性は消える**
（プラグインの強みは ①Electron のセキュアコンテキストで E2EE が楽 ②Vault API でローカル編集を捕捉、
の2点だが Tier1 平文・書き込み無しではどちらも効かない）。

| | A: 定期CLI | B: 常駐デーモン | C: プラグイン |
|---|---|---|---|
| 初期コスト | 低 | 中 | 中〜高 |
| 状態管理 | 不要(frontmatterが持つ) | sqlite + since | 不要 |
| 鮮度 | 数分 | 即時 | Obsidian 起動時 |
| 双方向へ発展 | 作り直し | そのまま拡張 | 有利 |

**推奨 = 案A: 単発 CLI + 定期フルリビルド**（cron / launchd などで 5〜15 分おき）。

```
GET /rooms/{room}/state → page_a 一覧
  各 slug: frontmatter の event_id == latest_event_id なら skip
           違えば GET /rooms/{room}/event/{eid} → wiki.raw → 書き出し
  state に無い slug → _trash/
```

状態DB不要・`/sync` 不要・差分追従なし。状態は全部 frontmatter にあるので毎回まっさらに再構築できる。
Python stdlib + urllib で 100〜200行、依存の追加も不要。
案B は今の要件にオーバースペック（読み取りミラーに sqlite/heartbeat/since トークン管理という障害モードを足す理由がない）。
双方向に転じたくなった時点で案Bへ作り直す判断をすればよい。
案C はプラグインの有効化＋開発者モード＋esbuild の立ち上げコストに見合わない。

### 横断的な決めごと

- **読み取り専用の担保**: 書き込み前にローカル内容ハッシュが前回書いた値と違えば、上書きせず
  `<slug>.local-<ts>.md` に退避してから書く（うっかり編集を消さない）。`chmod 444` は Obsidian のエラーが不親切。
- **画像（規則のみ先決め）**: 本文の `![](mxc://server/id)` → `![[_attachments/<id>.<ext>]]`。
  実体は `GET /_matrix/client/v1/media/download/{server}/{id}`（要 Bearer）、拡張子は Content-Type から。
  `_attachments/` は event_id と無関係に不変なので、既存ならダウンロードごとスキップ。
- **リンク**: `[[slug]]` を mywiki の正式リンク構文に採用すれば（下記 TODO）、ミラーは本文を無変換で出すだけで
  バックリンク/グラフビューが機能する。ミラー側に変換ロジックは不要。

## 制限・注意（Matrix 由来）

- 1 イベント 64 KiB（本文実質 ~2万字）。超長文は分割。
- state event 数はハード上限なしだが数千で状態解決が重い → ルーム分割で対応。
- 編集履歴は無限に蓄積（版管理の裏返し）。

## 未実装 TODO（本命の作り込み）

- [ ] 編集履歴の表示（過去イベント / replaces_state を辿る）
- [ ] ページ間 `[[リンク]]`
- [ ] 編集権限の制御（Power Level で編集者を限定）
- [ ] 画像添付 UI（Tier1 は `plan-b.html` に実装済み、本線へ移植）
- [ ] Tier 2: matrix-js-sdk 版 SPA（E2EE ルーム、暗号化 timeline + 暗号化 media + 回復キー UX）
- [ ] 常設化（http 配信を docker-compose / launchd に）
- [ ] Obsidian Vault 読み取りミラー（Tier1, 案A: 定期 CLI）→ 上記「Obsidian Vault 連携」節
