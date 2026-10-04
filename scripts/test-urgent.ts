/**
 * フェーズ4の確認：緊急ルートの分離と SLA（受信→部長LINE 5分以内）を本番で測る。
 *   npx tsx scripts/test-urgent.ts [https://inquiry-router.vercel.app]
 * 本物と同じ署名の LINE Webhook を本番に送り、DB の時刻から所要時間を測る。
 * Slack に2件、部長役の LINE に1件の「[テスト]」が届く。テスト用の行は最後に削除する。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHmac } from "node:crypto";
import { createAdminClient } from "../src/lib/supabase-admin";
import { claimInquiries } from "../src/lib/process";

const BASE_URL = process.argv[2] ?? "https://inquiry-router.vercel.app";
const RUN_ID = `test-${Date.now()}`;
const db = createAdminClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => results.push({ name, ok, detail: JSON.stringify(detail) });

async function sendLine(eventId: string, text: string) {
  const body = JSON.stringify({
    destination: "Utest",
    events: [{
      type: "message", webhookEventId: eventId, timestamp: Date.now(),
      source: { type: "user", userId: "Utest-customer" },
      message: { type: "text", id: "1", text },
      deliveryContext: { isRedelivery: false },
    }],
  });
  const signature = createHmac("sha256", process.env.LINE_CHANNEL_SECRET!).update(body).digest("base64");
  const res = await fetch(`${BASE_URL}/api/line/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": signature },
    body,
  });
  return (await res.json()) as { results: { status: string; id: string; route: string }[] };
}

async function waitFor(id: string, field: "line_pushed_at" | "processed_at", timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await db.from("inquiries").select("*").eq("id", id).single();
    if (data?.[field]) return data;
    await sleep(1000);
  }
  return null;
}

const sec = (from: string, to: string) => ((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1);

async function main() {
  // --- ケース1：同じ行を10か所から同時に確保しようとしても、確保できるのは1回だけ ---
  const { data: raceRow } = await db.from("inquiries")
    .insert({ channel: "mail", external_id: `${RUN_ID}-race`, body: "[テスト] 同時確保の確認", route: "urgent" })
    .select("id").single();
  const claims = await Promise.all(Array.from({ length: 10 }, () => claimInquiries({ id: raceRow!.id })));
  const claimedCount = claims.filter((rows) => rows.length > 0).length;
  // この行は処理させずに片付ける（Cron にも拾わせない）
  await db.from("inquiries").update({ status: "done" }).eq("id", raceRow!.id);
  check("同時に10回確保 → 確保できたのは1回だけ（緊急ルートとCronの二重処理を防ぐ）", claimedCount === 1, { claimedCount });

  // --- ケース2：緊急ルート（クレーム）→ Cron を待たずに即処理、部長 LINE まで ---
  const sentAt = new Date().toISOString();
  const urgent = await sendLine(`${RUN_ID}-urgent`, "[テスト] 先月入居した部屋のエアコンが効きません。至急対応してください。苦情です。");
  const urgentId = urgent.results[0].id;
  const urgentRow = await waitFor(urgentId, "line_pushed_at", 60_000);
  if (urgentRow) {
    console.log(`緊急ルート：送信→部長LINE ${sec(sentAt, urgentRow.line_pushed_at)}秒（受信→保存 ${sec(urgentRow.received_at, urgentRow.created_at)}秒、attempts=${urgentRow.attempts}）`);
  }
  check("緊急ルート → 部長LINE まで 60秒以内（SLA 5分）", !!urgentRow && urgentRow.category === "クレーム" && urgentRow.attempts === 1, urgentRow && { category: urgentRow.category, attempts: urgentRow.attempts });

  // --- ケース3：通常ルート → すぐには処理されず、Cron（1分ごと）が処理する ---
  const normalSentAt = new Date().toISOString();
  const normal = await sendLine(`${RUN_ID}-normal`, "[テスト] 家具家電付きの賃貸はありますか？単身赴任で短期間の予定です。");
  const normalId = normal.results[0].id;
  await sleep(5000);
  const { data: normalAfter5s } = await db.from("inquiries").select("status").eq("id", normalId).single();
  check("通常ルート → 5秒後もまだ pending（Cron待ち＝緊急ルートと分離されている）", normal.results[0].route === "normal" && normalAfter5s?.status === "pending", normalAfter5s);

  const normalRow = await waitFor(normalId, "processed_at", 130_000);
  if (normalRow) console.log(`通常ルート：送信→Slack投稿完了 ${sec(normalSentAt, normalRow.processed_at)}秒（Cronの待ち時間を含む）`);
  check("通常ルート → Cron が2分以内に処理（LINE通知なし）", !!normalRow && normalRow.category === "賃貸" && !normalRow.line_pushed_at, normalRow && { category: normalRow.category });

  // --- 後片付け ---
  const { count } = await db.from("inquiries").delete({ count: "exact" }).like("external_id", `${RUN_ID}%`);
  check("後片付け：テスト用の3件を削除", count === 3, count);

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n   ${r.detail}`}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 件成功`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
