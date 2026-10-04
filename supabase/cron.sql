-- キュー消化Cron：1分ごとに /api/cron/process-queue を呼び、未処理・失敗の問い合わせを処理する
-- Supabase の SQL Editor で実行する。
-- __CRON_SECRET__ は .env.local の CRON_SECRET に置き換える（supabase/cron.local.sql は置き換え済みで、gitには含めない）

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 認証用の秘密鍵は SQL に直接書かず、Vault（暗号化して保存する仕組み）に入れる
delete from vault.secrets where name = 'inquiry_cron_secret';
select vault.create_secret('__CRON_SECRET__', 'inquiry_cron_secret', '/api/cron/process-queue の認証用');

-- 同じ名前のジョブがあれば作り直す（何度実行しても1つだけになる）
select cron.unschedule(jobid) from cron.job where jobname = 'process-inquiry-queue';

select cron.schedule(
  'process-inquiry-queue',
  '* * * * *',  -- 毎分
  $$
  select net.http_post(
    url := 'https://inquiry-router.vercel.app/api/cron/process-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'inquiry_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- 確認：ジョブが1件表示されればOK
select jobid, jobname, schedule, active from cron.job where jobname = 'process-inquiry-queue';
