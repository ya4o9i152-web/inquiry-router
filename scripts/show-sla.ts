/**
 * 緊急通知のSLA実績を表示する（受信→部長LINE通知までの秒数）。
 *   npx tsx scripts/show-sla.ts        # 直近10件の緊急通知
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createAdminClient } from "../src/lib/supabase-admin";

async function main() {
  const { data, error } = await createAdminClient()
    .from("inquiries")
    .select("channel,route,category,body,received_at,created_at,line_pushed_at,attempts")
    .not("line_pushed_at", "is", null)
    .order("received_at", { ascending: false })
    .limit(Number(process.argv[2] ?? 10));
  if (error) throw new Error(error.message);

  const sec = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
  for (const r of data ?? []) {
    const total = sec(r.received_at, r.line_pushed_at);
    console.log(
      `${total <= 300 ? "✅" : "❌"} [${r.channel}/${r.route}] ${r.category} 受信→保存 ${sec(r.received_at, r.created_at).toFixed(1)}秒 / 受信→部長LINE ${total.toFixed(1)}秒（attempts=${r.attempts}）\n    ${r.body.slice(0, 50)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
