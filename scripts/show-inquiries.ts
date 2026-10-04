/**
 * DBに保存された最新の問い合わせを一覧表示する（動作確認用）。
 *   npx tsx scripts/show-inquiries.ts        # 最新10件
 *   npx tsx scripts/show-inquiries.ts 30     # 最新30件
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createAdminClient } from "../src/lib/supabase-admin";

async function main() {
  const limit = Number(process.argv[2] ?? 10);
  const { data, error } = await createAdminClient()
    .from("inquiries")
    .select("channel,route,status,attempts,category,is_urgent,sender_name,subject,body,received_at,created_at,slack_ts,line_pushed_at,last_error")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  for (const r of data ?? []) {
    // 受信（お客様が送った時刻）から保存までの遅れ。メールはGASの確認間隔の分だけ遅れる
    const delaySec = Math.round((Date.parse(r.created_at) - Date.parse(r.received_at)) / 1000);
    console.log(
      `[${r.channel}] ${r.route}/${r.status}` +
        (r.category ? ` → ${r.category}${r.is_urgent ? "（緊急）" : ""}` : "") +
        ` 受信→保存 ${delaySec}秒` +
        (r.sender_name ? ` 差出人:${r.sender_name}` : "") +
        (r.subject ? ` 件名:${r.subject}` : "") +
        `\n    本文: ${r.body.replace(/\s+/g, " ").slice(0, 60)}` +
        (r.last_error ? `\n    エラー: ${r.last_error}` : "")
    );
  }
  console.log(`\n${data?.length ?? 0} 件`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
