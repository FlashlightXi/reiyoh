# reiyoh

OwOの観測記録を使う、自己ホスト型Discordヘルパー。収集・表示・AI相談の仕組みを提供します。戦略資料や計算モデルは運用者が追加して育てられます。

## できること

- 指定した1サーバー・複数チャンネルでOwOと登録済み補助Botの返信・編集履歴をSQLiteへ保存
- `g`：タイマー、`gx team / pets / battle`：編成・ペット・戦績、本人用ページボタン
- `gx battle` とAI相談で連勝を表示。OwOの表示値を優先し、観測した連続勝利だけの値は下限として区別
- `gai 質問`：OpenRouter経由のツール付き相談。回答への返信で会話を継続
- Components V2で取得状況、入出力トークン、キャッシュ実績、応答時間を表示
- 外部の知識カード・指示文・計算ツールを任意追加

## 導入

Node.js 22.13以上とDiscord Botを用意します。

```sh
npm ci
cp .env.example .env
npm start
```

PowerShellでは `Copy-Item .env.example .env` を使えます。`.env`に `DISCORD_TOKEN`、`GUILD_ID`、`LOG_CHANNEL_IDS`（カンマ区切り）を設定します。AIを使う場合は `OPENROUTER_KEY` も設定します。起動はリポジトリ直下から行ってください。

Developer PortalでMessage Content Intentを有効にし、対象チャンネルの閲覧・メッセージ送信・履歴閲覧・ファイル添付を許可してBotを招待します。`bot` と `applications.commands` のスコープを使用します。管理者権限の付与は不要です。

`gx` で通常メニュー、`gx admin` で収集設定を確認できます。`gx collect on` でチャンネルを追加し、`gx collect neonutil @Bot` で補助Botを登録します。設定変更には「サーバーの管理」権限が必要です。

初期状態では文字・標準絵文字で動作します。自作SVG/PNGは `assets/ui/` にあります。アプリ絵文字へ登録したら、外部JSONのキー `tool, model, input, output, time, won, lost, tie, pending` に `<:name:id>` を指定し、`REIYOH_DISPLAY_EMOJIS_FILE` にパスを設定できます。元の外部絵文字を置換する場合は `source_元ID` キーを使います。タイマー絵文字の対応表は `EMOJI_MAP_PATH` で指定できます。配布には外部サービスの絵文字画像を含めていません。

## 自分の知識と計算ツールを追加する

公開リポジトリとは別のディレクトリに資料を保存し、`.env`から絶対パスで指定します。

| 設定 | 内容 |
|---|---|
| `REIYOH_KNOWLEDGE_FILE` | 知識カードのJSON配列。省略時は空 |
| `REIYOH_INSTRUCTIONS_FILE` | 追加ではなく置換する指示文。省略時は共通の `prompts/advisor.md` |
| `REIYOH_TOOLS_MODULE` | 運用者の信頼済みCommonJSモジュール。`createTools(scope)` をexport |
| `REIYOH_DISPLAY_EMOJIS_FILE` | アイコンと外部絵文字の対応表 |

`examples/knowledge.json` と `examples/tools.cjs` は架空データの形式例です。実戦の戦略やシミュレーターは同梱していません。

知識カードには `id, tags, finding, action, limits, sources` を付け、編成・目的・成立条件・検証結果・例外・出典を短くまとめます。`ownerId` を付けたカードは公開チャンネルのAIから除外され、運用者用CLIでは一致する本人に限定して参照されます。ownerIdなしのカードは共通知識として公開回答に使われます。

計算モジュールは `definitions`（function tool定義）と `invoke(name,args)` を返します。scopeにはホストで確定した `guildId, userId, channelIds, visibility` と、読み取り専用の `data.bossHistory({includeLogs, limit, maxLogBytes})` が渡ります。後者は本人の討伐メールと、本人に帰属が確認できた保存済み詳細ログ（`includeLogs` でJSON化済みの本文、既定20MB上限）を返します。モジュール側でも引数・試行数・閲覧権限を検証し、条件・出典・未対応範囲を結果に添えてください。`visibility: 'channel'` では同チャンネルへ結果が出ます。個別の検証を公開したくない場合、そのモードでdefinitionsを空にしてください。モデルからモジュールパスを変更する経路はありません。これはローカルコードの拡張口であり、信頼できるモジュールだけを設定してください。

運用者用CLI：`npm run advisor -- GUILD_ID USER_ID CHANNEL_ID "相談文"`。対象範囲を指定できるため、運用者自身が権限を確認して使用します。

## 説明動画

`REIYOH_VIDEOS_FILE` に動画一覧のJSONを指定すると、`gx v 名前` で動画を添付して返します。`gx v` だけなら種類ごとの一覧とメニューを表示し、メニューで選んだ動画は選んだ本人にだけ表示されます。`/g video` は名前の入力補完つきで、既定は本人だけに表示します（`public` で全員に表示）。

```json
{
  "kinds": {"passive": {"label": "PASSIVE", "color": "#3B4FD8"}},
  "videos": [
    {"kind": "passive", "id": "lifesteal", "name": "Lifesteal", "aliases": ["ls"], "file": "passive/lifesteal.mp4", "summary": "与ダメージの一部を回復"}
  ]
}
```

`file` は一覧JSONのあるフォルダからの相対パスで、その外は読みません。名前は `id`・`name`・`aliases` の完全一致、前方一致、部分一致の順で探します。添付の上限は10MBです。一覧JSONは更新時刻を見て読み直すため、差し替えに再起動は不要です。動画そのものはリポジトリに含めません。

## データとAIの扱い

対象チャンネルで今後受信するメッセージと編集を保存します。停止中の編集は取得範囲外です。名前や時刻の近さだけで所持者を確定せず、表示中編成と選択中編成も区別します。各ユーザーのAI相談は本人・呼出元チャンネルの観測と共通知識をOpenRouterへ送信し、同チャンネルに回答します。外部ツールは運用者がこの境界を維持してください。導入時にサーバーの利用者へ収集範囲と外部送信を案内してください。

既定のAIは `openai/gpt-6-luna`、推論設定 `xhigh`。最大5リクエスト/12ツール、応答上限8000トークン、1リクエスト120秒。本人1件・全体2件まで同時実行し、開始間隔は15秒です。会話履歴はメモリ内30分・最大40回答・各50000文字。再起動で消えます。SQLiteとログはローカルに残るため、運用者がバックアップ・保持期間を管理してください。

## 開発と公開

```sh
npm test
npm run check:public
```

テストは架空のID・データを使い、DiscordやOpenRouterへの接続を行いません。`check:public` はGit管理対象を許可リストで確認します。`.env`、`data/`、`docs/`、`knowledge/`、`private/`、ローカル作業記録は公開対象から除外しています。

MIT License。OwO/Discord/NeonUtilとは独立した非公式プロジェクトです。各サービスの利用条件・API制限に従って運用してください。

## 連勝とコマンドの集計

連勝は戦闘フッターの `Streak:` とteam表示の `Current Streak / Highest Streak` を根拠にします。表示値がある場合は `reported`、表示値にその後の観測勝利を足した値は `estimated`、このチャンネルで観測した連続勝利だけの値は `observed-lower-bound` として返し、実際の連勝がそれ以上になり得ることを示します。連勝が切れた時の長さ、勝率、観測したXPとボーナスXPも同じ集計に含めます。ボス戦の返信は通常戦の勝敗と連勝から分けます。

AIの `get_command_usage` は、本人が同チャンネルで入力したOwOコマンドを接頭辞・別名・引数の形ごとに数え、OwOの返信種別（待機、エラーなど）を添えます。引数は `<id>` `<n>` `<user>` `<arg>` に置き換えて返します。

## ボス記録

`gx boss` は呼出元チャンネルの最新ボス表示、予定報酬OCR、最終観測時刻を表示します。逃走時刻を過ぎた表示は終了時刻経過と表示し、再表示は `gboss` で行います。状態の自動ポーリングは行いません。

OwOのボス画面・討伐メールを観測履歴から抽出し、ボスと確認できたリンクの詳細を公式ログ配信先からUUIDごとに保存します。`gx boss logs` は同チャンネルで本人に帰属する保存済みログを書き出します。ログ本文は公式のv2シリアライズ形式を保持します。メールと進行中ボスの推測による自動結合は行いません。

報酬画像は620×60の4枠に対応し、メモリ内で切り出し・拡大してローカルOCRします。2通りの拡大結果の一致と信頼度を確認し、不一致の値は未確定にします。経験値は表示値を保存し、倍率アイコンで再乗算しません。元画像はディスク保存せず、読取値・OCR文字列・ハッシュをSQLiteへ記録します。初回にTesseractの英語言語データを取得し、データディレクトリのocr-cacheへ保存します。画像の外部AI送信はありません。

詳細ログと画像取得は直列・サイズ制限・タイムアウト付きです。失敗はDBへ記録して自動再試行を止めます。ボス画像自体は元メッセージのCDN URLで表示するため、古いURLが無効になった場合は `gboss` で更新してください。
