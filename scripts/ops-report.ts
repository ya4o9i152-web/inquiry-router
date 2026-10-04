/**
 * 運用チェック用の集計を JSON で出力する（Headless モードの運用チェックが読む）。
 *   npx tsx scripts/ops-report.ts          # 直近7日
 *   npx tsx scripts/ops-report.ts 1        # 直近1日
 * 個人情報（本文・差出人）は出さず、件数・時間・エラー内容だけを出す。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createAdminClient } from "../src/lib/supabase-admin";

const SLA_SEC = 5 * 60;

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await createAdminClient()
    .from("inquiries")
    .select("id,channel,route,status,attempts,category,is_urgent,received_at,created_at,processed_at,line_pushed_at,locked_at,last_error")
    .gte("received_at", since);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const now = Date.now();
  const sec = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
  const ageMin = (iso: string) => Math.round((now - Date.parse(iso)) / 60_000);

  // 止まっている問い合わせ：Slack に届いていない＝スタッフが気づけない
  const stuck = rows
    .filter((r) =>
      (r.status === "pending" && ageMin(r.created_at) >= 3) ||
      (r.status === "processing" && r.locked_at && ageMin(r.locked_at) >= 3) ||
      r.status === "failed"
    )
    .map((r) => ({ id: r.id, status: r.status, attempts: r.attempts, age_min: ageMin(r.created_at), last_error: r.last_error, gave_up: r.attempts >= 5 }));

  const urgentDelays = rows.filter((r) => r.line_pushed_at).map((r) => sec(r.received_at, r.line_pushed_at));
  const sorted = [...urgentDelays].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] : null);

  const count = <K extends string>(key: (r: (typeof rows)[number]) => K | null) =>
    rows.reduce<Record<string, number>>((acc, r) => {
      const k = key(r) ?? "(未処理)";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

  const report = {
    period_days: days,
    generated_at: new Date().toISOString(),
    total: rows.length,
    by_channel: count((r) => r.channel),
    by_route: count((r) => r.route),
    by_category: count((r) => r.category),
    by_status: count((r) => r.status),
    retried: rows.filter((r) => r.attempts > 1).length,
    unclassified: rows.filter((r) => r.category === "未分類").length,
    urgent_notifications: {
      count: urgentDelays.length,
      sla_sec: SLA_SEC,
      sla_violations: urgentDelays.filter((d) => d > SLA_SEC).length,
      median_sec: pct(50),
      p95_sec: pct(95),
      max_sec: sorted.at(-1) ?? null,
    },
    // クレームなのに通知されていない＝最も避けたい事故
    complaints_without_push: rows.filter((r) => r.category === "クレーム" && r.status === "done" && !r.line_pushed_at).length,
    stuck,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
