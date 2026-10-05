-- 監視ダッシュボード（未処理件数・失敗件数・SLA）
-- Supabase の SQL Editor で1回実行すると、monitoring スキーマにビューが3つできる。
-- 以後は Table Editor のスキーマ切り替えで「monitoring」を選ぶか、下の「確認用クエリ」を実行して見る。
--
-- monitoring スキーマは Data API（PostgREST）に公開していないので、外部からは読めない。
-- ビューには本文・差出人などの個人情報を含めない（件数と時間だけ）。

create schema if not exists monitoring;
revoke all on schema monitoring from public, anon, authenticated;

-- ① いまの状況：1行で「未処理」「処理中」「失敗」「あきらめ（再試行を使い切った）」が分かる
create or replace view monitoring.queue_status as
select
  count(*) filter (where status = 'pending')                                              as 未処理,
  count(*) filter (where status = 'pending' and created_at < now() - interval '3 minutes') as 未処理_3分以上,
  count(*) filter (where status = 'processing')                                           as 処理中,
  count(*) filter (where status = 'processing' and locked_at < now() - interval '3 minutes') as 処理中_停止の疑い,
  count(*) filter (where status = 'failed' and attempts < 5)                              as 失敗_再試行待ち,
  count(*) filter (where status = 'failed' and attempts >= 5)                             as 失敗_再試行使い切り,
  count(*) filter (where category = 'クレーム' and status = 'done' and line_pushed_at is null) as クレーム通知漏れ,
  count(*) filter (where received_at >= date_trunc('day', now() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo') as 本日の受信,
  max(received_at)                                                                        as 最終受信
from public.inquiries;

-- ② 日別の件数（直近14日）：カテゴリ・経路・未分類・再試行
create or replace view monitoring.daily_summary as
select
  (received_at at time zone 'Asia/Tokyo')::date                  as 日付,
  count(*)                                                       as 合計,
  count(*) filter (where channel = 'line')                       as line,
  count(*) filter (where channel = 'mail')                       as メール,
  count(*) filter (where category = '賃貸')                      as 賃貸,
  count(*) filter (where category = '売買')                      as 売買,
  count(*) filter (where category = '内見')                      as 内見,
  count(*) filter (where category = 'クレーム')                  as クレーム,
  count(*) filter (where category = 'その他')                    as その他,
  count(*) filter (where category = '未分類')                    as 未分類,
  count(*) filter (where attempts > 1)                           as 再試行あり,
  count(*) filter (where status <> 'done')                       as 未完了
from public.inquiries
where received_at >= now() - interval '14 days'
group by 1
order by 1 desc;

-- ③ 緊急通知のSLA（直近30日）：受信 → 部長LINE の秒数
create or replace view monitoring.urgent_sla as
select
  count(*)                                                                                   as 通知件数,
  count(*) filter (where extract(epoch from line_pushed_at - received_at) <= 300)            as 五分以内,
  round(100.0 * count(*) filter (where extract(epoch from line_pushed_at - received_at) <= 300) / nullif(count(*), 0), 1) as 達成率_percent,
  round(percentile_cont(0.5)  within group (order by extract(epoch from line_pushed_at - received_at))::numeric, 1) as 中央値_秒,
  round(percentile_cont(0.95) within group (order by extract(epoch from line_pushed_at - received_at))::numeric, 1) as p95_秒,
  round(max(extract(epoch from line_pushed_at - received_at))::numeric, 1)                  as 最大_秒
from public.inquiries
where line_pushed_at is not null
  and received_at >= now() - interval '30 days';

-- 確認用クエリ（このまま実行すると①の結果が表示される）
select * from monitoring.queue_status;

-- その他の確認用クエリ（必要なときに1行ずつ実行する）
-- select * from monitoring.daily_summary;
-- select * from monitoring.urgent_sla;
-- 失敗している問い合わせの原因：
-- select id, channel, attempts, last_error, received_at from public.inquiries where status = 'failed' order by received_at desc;
-- Cron の実行履歴（直近10回）：
-- select start_time, status, return_message from cron.job_run_details order by start_time desc limit 10;
