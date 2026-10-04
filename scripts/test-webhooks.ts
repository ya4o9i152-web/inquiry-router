/**
 * フェーズ2の確認：Webhook受信の「署名検証・保存・重複防止・ルート判定」をまとめて試す。
 *   npx tsx scripts/test-webhooks.ts                      # http://localhost:3000 に送る
 *   npx tsx scripts/test-webhooks.ts https://xxx.vercel.app
 * 本物の LINE / Gmail の代わりに、同じ形式・同じ署名方式のリクエストを自分で作って送る。
 * テスト用に保存した行は最後に削除する。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createHmac, randomUUID } from "node:crypto";
import { createAdminClient } from "../src/lib/supabase-admin";

const BASE_URL = process.argv[2] ?? "http://localhost:3000";
const RUN_ID = `test-${Date.now()}`;

function lineBody(eventId: string, text: string) {
  return JSON.stringify({
    destination: "Utest",
    events: [
      {
        type: "message",
        webhookEventId: eventId,
        timestamp: Date.now(),
        source: { type: "user", userId: "Utest-customer" },
        message: { type: "text", id: "1", text },
        deliveryContext: { isRedelivery: false },
      },
    ],
  });
}

async function postLine(body: string, signature?: string) {
  const sig = signature ?? createHmac("sha256", process.env.LINE_CHANNEL_SECRET!).update(body).digest("base64");
  const res = await fetch(`${BASE_URL}/api/line/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": sig },
    body,
  });
  return { status: res.status, json: await res.json() };
}

async function postMail(payload: object, opts: { timestamp?: number; badSignature?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const sig = opts.badSignature
    ? "0".repeat(64)
    : createHmac("sha256", process.env.MAIL_INGEST_SECRET!).update(`${ts}.${body}`).digest("hex");
  const res = await fetch(`${BASE_URL}/api/mail/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-timestamp": ts, "x-signature": sig },
    body,
  });
  return { status: res.status, json: await res.json() };
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: unknown) {
  results.push({ name, ok, detail: JSON.stringify(detail) });
}

async function main() {
  console.log(`送信先: ${BASE_URL}\n`);

  // --- LINE ---
  const normalEvent = `${RUN_ID}-line-normal`;
  const body1 = lineBody(normalEvent, "駅近の1LDKを探しています。家賃8万円くらいで空いている物件はありますか？");
  const r1 = await postLine(body1);
  check("LINE: 正しい署名 → 保存（通常ルート）", r1.status === 200 && r1.json.results?.[0]?.route === "normal", r1);

  const r2 = await postLine(body1);
  check("LINE: 同じイベントの再送 → 重複として保存しない", r2.status === 200 && r2.json.results?.[0]?.status === "duplicate", r2);

  const r3 = await postLine(lineBody(`${RUN_ID}-line-urgent`, "先月入居した部屋のエアコンが効きません。至急対応してください。苦情です。"));
  check("LINE: クレーム文 → 緊急ルート", r3.status === 200 && r3.json.results?.[0]?.route === "urgent", r3);

  const r4 = await postLine(body1, "invalid-signature");
  check("LINE: 不正な署名 → 401", r4.status === 401, r4);

  const r5 = await postLine(JSON.stringify({ destination: "Utest", events: [] }));
  check("LINE: 検証ボタン（events: []）→ 200", r5.status === 200, r5);

  // --- メール ---
  const mail = {
    messageId: `${RUN_ID}-mail`,
    from: "customer@example.com",
    fromName: "テスト 太郎",
    subject: "物件について",
    body: "退去時の敷金精算について教えてください。これは緊急ではありません。",
    receivedAt: new Date().toISOString(),
  };
  const m1 = await postMail(mail);
  // 「緊急」の語でキーワードには当たる → 緊急ルートで即処理されるが、最終判定はClaude（フェーズ3・4）
  check("メール: 正しい署名 → 保存（「緊急」の語で緊急ルート）", m1.status === 200 && m1.json.result?.route === "urgent", m1);

  const m2 = await postMail(mail);
  check("メール: 同じメールの再送 → 重複", m2.status === 200 && m2.json.result?.status === "duplicate", m2);

  const m3 = await postMail({ ...mail, messageId: randomUUID() }, { badSignature: true });
  check("メール: 不正な署名 → 401", m3.status === 401, m3);

  const m4 = await postMail({ ...mail, messageId: randomUUID() }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  check("メール: 10分前のタイムスタンプ（再送攻撃）→ 401", m4.status === 401, m4);

  // --- 後片付け ---
  const { error, count } = await createAdminClient()
    .from("inquiries")
    .delete({ count: "exact" })
    .like("external_id", `${RUN_ID}%`);
  check("後片付け: テストで保存した3件を削除", !error && count === 3, { count, error: error?.message });

  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : `\n   ${r.detail}`}`);
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} 件成功`);
  if (passed < results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
