/**
 * Cron（pg_cron → /api/cron/process-queue）が自動で動いているかの確認。
 * テスト行を1件入れて、誰も呼ばずに処理されるまで待つ（最大5分）。
 *   npx tsx scripts/check-cron.ts
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { createAdminClient } from "../src/lib/supabase-admin";
async function main() {
  const db = createAdminClient();
  const ext = `cron-check-${Date.now()}`;
  const { data, error } = await db.from("inquiries").insert({ channel: "mail", external_id: ext, sender_id: "test@example.com", sender_name: "Cron確認", body: "[テスト] Cronの自動処理の確認です。学生向けの安いアパートはありますか？" }).select("id,created_at").single();
  if (error) throw error;
  const t0 = Date.now();
  console.log("投入:", new Date().toLocaleTimeString("ja-JP"));
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { data: row } = await db.from("inquiries").select("status,category,processed_at,attempts").eq("id", data.id).single();
    if (row?.status === "done") {
      console.log(`自動処理されました: ${row.category} / 投入から ${Math.round((Date.parse(row.processed_at) - t0) / 1000)}秒 / attempts=${row.attempts}`);
      await db.from("inquiries").delete().eq("id", data.id);
      return;
    }
  }
  console.log("5分待っても処理されませんでした（行は残しています）", data.id);
  process.exitCode = 1;
}
main();
