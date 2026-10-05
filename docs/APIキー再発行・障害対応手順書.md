# APIキー再発行・障害対応手順書

対象：開発担当・保守担当。スタッフ向けの日常の操作は [運用マニュアル.md](./運用マニュアル.md) を参照。

## 0. まず状況を見る（どの障害でも最初にやる）

| 確認 | 方法 | 正常な状態 |
|---|---|---|
| キューの状況 | Supabase SQL Editor で `select * from monitoring.queue_status;`（初回だけ `supabase/dashboard.sql` を実行しておく） | 未処理_3分以上・処理中_停止の疑い・失敗_再試行使い切り・クレーム通知漏れが **すべて0** |
| 全サービスへの接続 | `npm run check:connections` | 10/10 成功（Slack 5チャンネルと部長LINEに「[接続テスト]」が届く） |
| 総合点検 | `npm run ops:check`（Headless モード） | 1行目が「運用チェック結果：問題なし」 |
| サーバーのログ | `vercel logs --since 1h` | 401・500 が続いていない |

**大原則：問い合わせは受信した時点で DB に保存されている。** 障害が起きても、外部サービスが復旧すれば、Cron（1分ごと）が最大5回まで自動で再試行する。焦って DB を手で書き換えない。

---

## 1. APIキー・トークンの再発行

共通の流れ：**① 発行元で再発行 → ② `.env.local` を更新 → ③ Vercel を更新 → ④ 再デプロイ → ⑤ 接続確認**

```bash
# ③ Vercel の環境変数を上書きする（値は標準入力で渡し、画面やシェル履歴に残さない）
printf '%s' '<新しい値>' | vercel env add <変数名> production --force
# ④ 再デプロイ（環境変数は再デプロイしないと反映されない）
vercel deploy --prod
# ⑤ 接続確認
npm run check:connections
```

| キー | ① 再発行する場所 | 注意 |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com →「API Keys」→ 新しいキーを作成 → 古いキーを Disable | 新しいキーで `npm run classify:sample` が通ってから、古いキーを無効にする |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → チャネル →「Messaging API設定」→ チャネルアクセストークン（長期）「再発行」 | 再発行すると**古いトークンはすぐ使えなくなる**。③④を続けて行う |
| `LINE_CHANNEL_SECRET` | LINE Developers →「チャネル基本設定」→ チャネルシークレット「発行」 | 変えるとWebhookの署名検証がすべて失敗するので、③④を急ぐ。その後、Webhook の「検証」で成功を確認する |
| `SLACK_BOT_TOKEN` | api.slack.com/apps → アプリ →「OAuth & Permissions」→「Reinstall to Workspace」 | 漏洩時は、先に「Revoke All OAuth Tokens」で無効化してから再インストールする |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase →「Project Settings」→「API Keys」→ secret キーを新しく作成 → 古いキーを削除 | 全権限を持つキー。漏洩時は最優先で対応する |
| `MAIL_INGEST_SECRET` | `openssl rand -hex 32` で新しく作る | **GAS のスクリプト プロパティ `INGEST_SECRET` も同じ値に変える**。GAS の `checkSecret` で「長さ=64」と指紋の一致を確認する。変更中に届いたメールは、GAS が自動で再送する |
| `CRON_SECRET` | `openssl rand -hex 32` で新しく作る | `supabase/cron.sql` の `__CRON_SECRET__` を新しい値に置き換えて、SQL Editor で再実行する（Vault の値が更新される） |

**漏洩が疑われるとき**：GitHub への誤コミットや、チャットへの貼り付けなどが該当する。値を消すだけでは不十分で、**必ず再発行して古い値を無効にする**（git の履歴やキャッシュに残るため）。

---

## 2. 障害対応（症状別）

| 症状 | 考えられる原因 | 対応 |
|---|---|---|
| **LINE の問い合わせが Slack に来ない** | ① Webhook が 401（シークレットの不一致）② Vercel の障害 ③ Webhook がオフ | `vercel logs` で 401 なら `LINE_CHANNEL_SECRET` を確認。LINE Developers の Webhook「検証」を押す。Vercel の障害時は、LINE の「Webhookの再送」により復旧後に届く |
| **メールが Slack に来ない** | ① GAS のトリガーが止まった ② 署名の不一致（401）③ GAS の承認が切れた | GAS の「実行数」で `pollInbox` のエラーを見る。401 なら `checkSecret`。トリガーが無ければ `setup` を再実行する（取りこぼしたメールは、確認時刻から自動で再送される） |
| **DB に入るが Slack に来ない**（未処理・失敗が増える） | ① Cron が止まった ② Slack のトークン切れ ③ Claude API の障害 | `queue_status` と、失敗の原因を表示するクエリ（`dashboard.sql` の末尾）。Cron の履歴（`cron.job_run_details`）が 401 なら `CRON_SECRET` の不一致 |
| **Claude API の障害** | Anthropic 側の障害・混雑（429/529） | **何もしなくてよい**。2回失敗した問い合わせは「⚠️未分類」として Slack に出て、部長にも通知される。status.anthropic.com で復旧を確認する |
| **Slack の障害** | Slack 側の障害 | 問い合わせは DB に溜まり、復旧後に Cron が順に投稿する（最大5回まで再試行）。5回を使い切った分は、下の「手動で再処理する」 |
| **部長の LINE に通知が来ない** | ① 部長が公式アカウントをブロックした ② トークン切れ ③ 無料枠（月200通）を超えた | `npm run check:connections` の「部長役へのプッシュ」の結果を見る。403 なら友だち追加を確認、429 なら月の上限 → LINE公式アカウントのプランを見直す |
| **通知や誤分類が急に増えた** | 問い合わせの傾向の変化、またはモデルの挙動の変化 | `npm run eval:headless` で22件を再検証する。不合格ならプロンプト（`src/lib/classify.ts`）を調整する |

### 手動で再処理する（再試行を5回使い切った問い合わせ）

原因（トークンなど）を直したあと、SQL Editor で回数をリセットすれば、次の Cron が拾い直す。

```sql
update public.inquiries set attempts = 0, status = 'failed'
where status = 'failed' and attempts >= 5;
```

済んだ手順（分類・Slack 投稿・LINE 通知）は記録されているので、再処理しても二重に投稿されない。

---

## 3. 障害が起きた後にやること

1. `npm run ops:check` で「問題なし」に戻ったことを確認する
2. 障害の時間帯に受信した問い合わせが、すべて `done` になっていることを確認する（`monitoring.daily_summary` の「未完了」が0）
3. 何が起きて、どう直したかを記録する（[開発者向け引き継ぎ.md](./開発者向け引き継ぎ.md) の「開発中に詰まったところ」に追記する）
