/**
 * フェーズ3の確認：キュー処理の「分類→Slack→LINE通知」と、失敗時・再実行時の動きを試す。
 *   npx tsx scripts/test-processing.ts
 * Slack に3件、部長役のLINEに2件の「[テスト]」が届く。テスト用の行は最後に削除する。
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { createAdminClient } from "../src/lib/supabase-admin";
import { claimInquiries, processInquiry, type InquiryRow } from "../src/lib/process";

const RUN_ID = `test-${Date.now()}`;
const db = createAdminClient();
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown) => results.push({ name, ok, detail: JSON.stringify(detail) });

async function insert(suffix: string, body: string): Promise<string> {
  const { data, error } = await db
    .from("inquiries")
    .insert({ channel: "mail", external_id: `${RUN_ID}-${suffix}`, sender_id: "test@example.com", sender_name: "テスト", body })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function claimOne(id: string): Promise<InquiryRow> {
  const [row] = await claimInquiries({ id });
  if (!row) throw new Error(`確保できなかった: ${id}`);
  return row;
}

async function load(id: string) {
  const { data } = await db.from("inquiries").select("*").eq("id", id).single();
  return data;
}

async function main() {
  // --- ケース1：通常ルートのクレーム → Slack(#クレーム) と 部長LINE ---
  const complaintId = await insert("complaint", "[テスト] 先月入居した部屋のエアコンが効きません。至急対応してください。苦情です。");
  const out1 = await processInquiry(await claimOne(complaintId));
  const row1 = await load(complaintId);
  check("クレーム → 分類・Slack投稿・部長LINE通知まで完了", out1.result === "done" && row1.category === "クレーム" && !!row1.slack_ts && !!row1.line_pushed_at, out1);

  // --- ケース2：完了済みの行は二度と確保されない（Cronが拾い直さない） ---
  const reclaimed = await claimInquiries({ id: complaintId });
  check("完了済み → 再び確保されない", reclaimed.length === 0, reclaimed.length);

  // --- ケース3：途中で落ちて再処理されても、済んだ手順はやり直さない ---
  // 「Slack投稿・LINE通知は済んだがstatus更新前に落ちた」状態を作って再処理する
  await db.from("inquiries").update({ status: "failed" }).eq("id", complaintId);
  const beforeTs = row1.slack_ts;
  const out3 = await processInquiry(await claimOne(complaintId));
  const row3 = await load(complaintId);
  check("再処理 → Slack再投稿・LINE再通知なし（slack_ts不変）", out3.result === "done" && row3.slack_ts === beforeTs && row3.line_pushed_at === row1.line_pushed_at, { beforeTs, after: row3.slack_ts });

  // --- ケース4：分類が失敗し続ける → 1回目は failed、2回目で「未分類」として人に渡す ---
  process.env.CLAUDE_MODEL = "claude-model-that-does-not-exist"; // わざとAPIエラーにする
  const failId = await insert("fail", "[テスト] AI分類が失敗したときの確認です。");
  const out4a = await processInquiry(await claimOne(failId));
  const row4a = await load(failId);
  check("分類失敗1回目 → failed（次のCronで再挑戦）", out4a.result === "failed" && row4a.status === "failed" && !row4a.slack_ts, { out4a, status: row4a.status });

  const out4b = await processInquiry(await claimOne(failId));
  const row4b = await load(failId);
  check("分類失敗2回目 → 未分類としてSlack投稿＋部長LINE通知", out4b.result === "done" && row4b.category === "未分類" && !!row4b.slack_ts && !!row4b.line_pushed_at, out4b);
  delete process.env.CLAUDE_MODEL;

  // --- ケース5：緊急でない問い合わせはLINE通知しない ---
  const normalId = await insert("normal", "[テスト] 駅近の1LDKを探しています。家賃8万円くらいの物件はありますか？");
  const out5 = await processInquiry(await claimOne(normalId));
  const row5 = await load(normalId);
  check("通常の問い合わせ → Slackのみ（LINE通知なし）", out5.result === "done" && row5.category === "賃貸" && !!row5.slack_ts && !row5.line_pushed_at, out5);

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
