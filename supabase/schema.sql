-- 問い合わせ集約・通知システム スキーマ
-- Supabase の SQL Editor で実行する。

create extension if not exists pgcrypto;

-- ============================================================
-- inquiries: 受信した問い合わせ（＝処理キュー）
-- 「まず保存してから処理する」ため、受信直後は status = 'pending'。
-- ============================================================
create table if not exists public.inquiries (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null check (channel in ('line', 'mail')),
  -- 冪等性①：LINEの webhookEventId / Gmailの messageId。同じ問い合わせを二重に保存しない
  external_id   text not null,
  sender_id     text,                 -- LINE userId / メールアドレス
  sender_name   text,
  subject       text,                 -- メールの件名（LINEはnull）
  body          text not null,
  received_at   timestamptz not null default now(),

  -- 受信時のキーワード判定で決めるルート。urgent は受信した関数内で即処理、normal はCronで処理
  route         text not null default 'normal' check (route in ('urgent', 'normal')),

  -- キューの状態。processing 中に関数が落ちた場合は locked_at から一定時間後に再取得される
  status        text not null default 'pending'
                check (status in ('pending', 'processing', 'done', 'failed')),
  attempts      int  not null default 0,
  locked_at     timestamptz,
  last_error    text,

  -- AI分類の結果（「未分類」は分類が規定回数失敗したとき）
  category      text check (category in ('賃貸', '売買', '内見', 'クレーム', 'その他', '未分類')),
  is_urgent     boolean,
  confidence    text check (confidence in ('high', 'medium', 'low')),
  reason        text,

  -- 冪等性③：完了済みの手順を記録し、再処理時に二重投稿・二重通知しない
  slack_channel text,
  slack_ts      text,
  line_pushed_at timestamptz,

  processed_at  timestamptz,
  created_at    timestamptz not null default now(),

  unique (channel, external_id)
);

create index if not exists inquiries_queue_idx on public.inquiries (status, received_at);

-- クライアント（ブラウザ）からは一切触らせない。サーバーの service_role だけが使う。
alter table public.inquiries enable row level security;

-- 「Automatically expose new tables」がOFFのプロジェクトでは自動GRANTされないため明示する（案件3の学び）
grant select, insert, update, delete on public.inquiries to service_role;

-- ============================================================
-- claim_inquiries: 処理対象を「確保」して返す
-- 冪等性②：緊急ルート（受信関数）とCronが同じ行を同時に処理しないよう、
-- pending → processing への書き換えを1つのUPDATEで行う（FOR UPDATE SKIP LOCKED）。
--   p_id 指定あり … 緊急ルートが自分で保存した1件だけを確保する
--   p_id 指定なし … Cronが古い順に p_limit 件まで確保する
-- ============================================================
create or replace function public.claim_inquiries(
  p_id uuid default null,
  p_limit int default 10,
  p_max_attempts int default 5,
  p_stale interval default interval '2 minutes'
)
returns setof public.inquiries
language sql
as $$
  update public.inquiries as q
     set status = 'processing',
         locked_at = now(),
         attempts = q.attempts + 1
   where q.id in (
     select id
       from public.inquiries
      where (p_id is null or id = p_id)
        and attempts < p_max_attempts
        and (
          status in ('pending', 'failed')
          -- 処理中のまま関数が落ちた行を救済する
          or (status = 'processing' and locked_at < now() - p_stale)
        )
      order by received_at
      limit p_limit
      for update skip locked
   )
  returning q.*;
$$;

revoke execute on function public.claim_inquiries(uuid, int, int, interval) from public, anon, authenticated;
grant execute on function public.claim_inquiries(uuid, int, int, interval) to service_role;
