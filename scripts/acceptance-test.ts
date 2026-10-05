/**
 * 納品前の受け入れテスト（納品物チェックリストの「分類」「緊急通知」）。
 *   npx tsx scripts/acceptance-test.ts [https://inquiry-router.vercel.app]
 *
 * A. カテゴリ別のチャンネル振り分け：5カテゴリのサンプルを実際に処理し、正しいチャンネルに投稿されたか
 * B. 緊急通知SLA：クレーム10件を本番のLINE Webhookへ送り、受信→部長LINEが5分以内の件数を数える
 *    （8件はキーワードで緊急ルート、2件はキーワードに当たらない文面＝Cron経由で届くか）
 *
 * Slack に15件、部長役の LINE に11件の「[テスト]」が届く。結果は docs/受け入れテスト結果.md に保存し、テスト行は削除する。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createAdminClient } from "../src/lib/supabase-admin";
import { claimInquiries, processInquiry } from "../src/lib/process";
import { channelFor, type SlackCategory } from "../src/lib/slack";
import { detectRoute } from "../src/lib/routing";

const BASE_URL = process.argv[2] ?? "https://inquiry-router.vercel.app";
const RUN_ID = `accept-${Date.now()}`;
const SLA_SEC = 300;
const db = createAdminClient();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const md: string[] = [];

// --- A. カテゴリ別のチャンネル振り分け ---
async function testChannels() {
  const rows = parse(readFileSync("docs/samples/case5-test-inquiries.csv"), { columns: true }) as Record<string, string>[];
  const picks: [string, SlackCategory][] = [["1", "賃貸"], ["11", "売買"], ["15", "内見"], ["20", "クレーム"], ["21", "その他"]];
  md.push("## A. カテゴリ別のチャンネル振り分け", "", "| サンプル | 期待 | AIの分類 | 投稿先チャンネル | 判定 |", "|---|---|---|---|---|");
  let ok = 0;
  for (const [no, expected] of picks) {
    const body = rows.find((r) => r["番号"] === no)!["問い合わせ本文"];
    const { data } = await db.from("inquiries")
      .insert({ channel: "mail", external_id: `${RUN_ID}-cat-${no}`, sender_id: "test@example.com", sender_name: "受け入れテスト", body: `[テスト] ${body}` })
      .select("id").single();
    const [row] = await claimInquiries({ id: data!.id });
    await processInquiry(row);
    const { data: done } = await db.from("inquiries").select("category,slack_channel").eq("id", data!.id).single();
    const pass = done!.category === expected && done!.slack_channel === channelFor(expected);
    if (pass) ok++;
    md.push(`| #${no} ${body.slice(0, 24)}… | ${expected} | ${done!.category} | #問合せ-${done!.category === "未分類" ? "その他" : done!.category} | ${pass ? "✅" : "❌"} |`);
  }
  md.push("", `**結果：${ok}/${picks.length}**`, "");
  return ok === picks.length;
}

// --- B. 緊急通知 SLA（10件） ---
const COMPLAINTS = [
  "先月入居した部屋のエアコンが効きません。至急対応してください。",
  "お風呂の給湯器が壊れてお湯が出ません。",
  "上の階の騒音がひどくて夜眠れません。",
  "トイレの配管から水漏れしています。",
  "玄関の鍵が開かなくなってしまいました。",
  "共用廊下の電気がずっとつかないままです。苦情です。",
  "契約時の説明と違いすぎます。正式にクレームを申し入れます。",
  "退去費用の請求が高すぎます。返金してください。",
  // ↓ キーワードに当たらない文面。緊急ルートを通らず、Cron（1分ごと）経由でも5分以内に届くか
  "管理会社さんの対応に納得がいきません。担当者からの連絡も一週間ありません。",
  "隣の部屋のタバコの臭いが毎晩ベランダから入ってきて困っています。",
];

async function sendLine(eventId: string, text: string) {
  const body = JSON.stringify({
    destination: "Utest",
    events: [{ type: "message", webhookEventId: eventId, timestamp: Date.now(), source: { type: "user", userId: "Utest-customer" }, message: { type: "text", id: "1", text }, deliveryContext: { isRedelivery: false } }],
  });
  const signature = createHmac("sha256", process.env.LINE_CHANNEL_SECRET!).update(body).digest("base64");
  const res = await fetch(`${BASE_URL}/api/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": signature }, body });
  const json = (await res.json()) as { results: { id: string }[] };
  return json.results[0].id;
}

async function testSla() {
  const ids: string[] = [];
  for (const [i, text] of COMPLAINTS.entries()) {
    ids.push(await sendLine(`${RUN_ID}-sla-${i + 1}`, `[テスト] ${text}`));
    await sleep(1000);
  }

  // 全件に通知が届くまで（最大6分）待つ
  const deadline = Date.now() + 6 * 60_000;
  let rows: Record<string, string | number | null>[] = [];
  while (Date.now() < deadline) {
    const { data } = await db.from("inquiries").select("id,route,category,attempts,received_at,line_pushed_at").in("id", ids);
    rows = data ?? [];
    if (rows.every((r) => r.line_pushed_at)) break;
    await sleep(5000);
  }

  md.push("## B. 緊急通知 SLA（受信 → 部長LINE 5分以内）", "", "| # | 文面 | ルート | AIの分類 | 受信→部長LINE | 判定 |", "|---|---|---|---|---|---|");
  let within = 0;
  ids.forEach((id, i) => {
    const r = rows.find((x) => x.id === id)!;
    const delay = r.line_pushed_at ? (Date.parse(r.line_pushed_at as string) - Date.parse(r.received_at as string)) / 1000 : null;
    const pass = delay !== null && delay <= SLA_SEC;
    if (pass) within++;
    md.push(`| ${i + 1} | ${COMPLAINTS[i].slice(0, 26)}… | ${r.route}${detectRoute(COMPLAINTS[i]) === "normal" ? "（Cron経由）" : ""} | ${r.category} | ${delay === null ? "未着" : `${delay.toFixed(1)}秒`} | ${pass ? "✅" : "❌"} |`);
  });
  const delays = rows.filter((r) => r.line_pushed_at).map((r) => (Date.parse(r.line_pushed_at as string) - Date.parse(r.received_at as string)) / 1000).sort((a, b) => a - b);
  md.push("", `**結果：${within}/10 件が5分以内**（基準：10件中9件以上）　中央値 ${delays[Math.floor(delays.length / 2)]?.toFixed(1)}秒 / 最大 ${delays.at(-1)?.toFixed(1)}秒`, "");
  return within >= 9;
}

async function main() {
  const started = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const a = await testChannels();
  const b = await testSla();
  const { count } = await db.from("inquiries").delete({ count: "exact" }).like("external_id", `${RUN_ID}%`);

  const report = [
    "# 受け入れテスト結果",
    "",
    `実施：${started}（本番 ${BASE_URL}、モデル ${process.env.CLAUDE_MODEL || "claude-haiku-4-5"}）／ \`npx tsx scripts/acceptance-test.ts\` で再実行できる`,
    "",
    ...md,
    `テスト用の ${count} 件は実施後に削除済み。`,
    "",
  ].join("\n");
  writeFileSync("docs/受け入れテスト結果.md", report);
  console.log(report);
  if (!a || !b) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
