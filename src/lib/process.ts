import { classifyWithClaude } from "./classify";
import { getLineDisplayName, pushToManager } from "./line";
import { channelFor, escapeSlack, postSlackMessage, type SlackCategory } from "./slack";
import { createAdminClient } from "./supabase-admin";

/** inquiries テーブルの1行（処理に使う列） */
export interface InquiryRow {
  id: string;
  channel: "line" | "mail";
  sender_id: string | null;
  sender_name: string | null;
  subject: string | null;
  body: string;
  received_at: string;
  route: "urgent" | "normal";
  attempts: number;
  category: SlackCategory | null;
  is_urgent: boolean | null;
  confidence: string | null;
  reason: string | null;
  slack_ts: string | null;
  line_pushed_at: string | null;
}

/**
 * 分類がこの回数失敗したら、AIを待たずに「未分類」として Slack へ出し、部長にも通知する。
 * 1分ごとのCronで2回目が失敗した時点＝受信から約2〜3分。SLA 5分の内側で人に知らせるため。
 */
const MAX_CLASSIFY_ATTEMPTS = 2;

export type ProcessOutcome =
  | { id: string; result: "done"; category: SlackCategory; urgent: boolean; ms: number }
  | { id: string; result: "failed"; error: string; ms: number };

const CATEGORY_ICON: Record<SlackCategory, string> = {
  賃貸: "🏠",
  売買: "🏢",
  内見: "🔑",
  クレーム: "🚨",
  その他: "📨",
  未分類: "⚠️",
};

function formatJst(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function senderLabel(row: InquiryRow): string {
  const via = row.channel === "line" ? "LINE" : "メール";
  const name = row.sender_name ?? (row.channel === "line" ? "LINEのお客様" : row.sender_id ?? "不明");
  return row.channel === "mail" && row.sender_id ? `${via}｜${name}（${row.sender_id}）` : `${via}｜${name}`;
}

function buildSlackMessage(row: InquiryRow, category: SlackCategory) {
  const headline = `${CATEGORY_ICON[category]} ${category === "未分類" ? "未分類（AI判定に失敗・要確認）" : `${category}のお問い合わせ`}`;
  const meta = [
    senderLabel(row),
    `受信 ${formatJst(row.received_at)}`,
    row.reason ? `AI判定：${row.reason}${row.confidence ? `（確信度 ${row.confidence}）` : ""}` : null,
  ].filter(Boolean).join("　/　");

  const quoted = escapeSlack(row.body.slice(0, 2500)).replace(/^/gm, "> ");
  const subjectLine = row.subject ? `*件名：${escapeSlack(row.subject)}*\n` : "";
  const replyHint = row.channel === "line" ? "返信は LINE公式アカウントのチャット から" : "返信は Gmail から";

  return {
    text: `${headline}｜${row.body.slice(0, 80)}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: headline } },
      { type: "section", text: { type: "mrkdwn", text: `${subjectLine}${quoted}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `${escapeSlack(meta)}\n${replyHint}` }] },
    ],
  };
}

function buildManagerPush(row: InquiryRow, category: SlackCategory): string {
  const head = category === "未分類" ? "【要確認】AIが分類できなかった問い合わせ" : "【緊急】クレームの可能性がある問い合わせ";
  return `${head}\n${senderLabel(row)}\n受信 ${formatJst(row.received_at)}\n\n${row.body.slice(0, 300)}\n\n詳細はSlackの #問合せ-${category === "未分類" ? "その他" : category} を確認してください。`;
}

/**
 * 確保済み（status = processing）の問い合わせ1件を処理する。
 * 各手順の完了を DB に記録し、再処理されても「済んだ手順」はやり直さない（冪等）。
 *   1. 分類（category が空のときだけ）
 *   2. Slack 投稿（slack_ts が空のときだけ）
 *   3. 部長へ LINE 通知（緊急で、line_pushed_at が空のときだけ）
 */
export async function processInquiry(row: InquiryRow): Promise<ProcessOutcome> {
  const started = Date.now();
  const db = createAdminClient();
  const update = async (fields: Partial<InquiryRow> & Record<string, unknown>) => {
    const { error } = await db.from("inquiries").update(fields).eq("id", row.id);
    if (error) throw new Error(`DB更新に失敗: ${error.message}`);
    Object.assign(row, fields);
  };

  try {
    // 1. 分類
    if (!row.category) {
      try {
        const result = await classifyWithClaude(row.subject ? `件名：${row.subject}\n${row.body}` : row.body);
        await update({ category: result.category, is_urgent: result.urgent, confidence: result.confidence, reason: result.reason });
      } catch (err) {
        if (row.attempts < MAX_CLASSIFY_ATTEMPTS) throw err; // 次の Cron で再挑戦
        // 規定回数失敗：クレームかどうか分からない＝見逃し防止のため緊急扱いで人に渡す
        await update({ category: "未分類", is_urgent: true, reason: `AI分類に${row.attempts}回失敗` });
      }
    }
    const category = row.category!;

    // LINE のお客様は名前が無いので、Slack 表示用に一度だけ取得して保存する
    if (row.channel === "line" && !row.sender_name && row.sender_id) {
      const name = await getLineDisplayName(row.sender_id);
      if (name) await update({ sender_name: name });
    }

    // 2. Slack 投稿
    if (!row.slack_ts) {
      const channel = channelFor(category);
      const message = buildSlackMessage(row, category);
      const ts = await postSlackMessage(channel, message.text, message.blocks);
      await update({ slack_channel: channel, slack_ts: ts });
    }

    // 3. 部長への緊急通知（リトライキー＝問い合わせID。LINE側でも二重送信を防ぐ）
    if (row.is_urgent && !row.line_pushed_at) {
      await pushToManager(buildManagerPush(row, category), row.id);
      await update({ line_pushed_at: new Date().toISOString() });
    }

    await update({ status: "done", processed_at: new Date().toISOString(), last_error: null, locked_at: null });
    return { id: row.id, result: "done", category, urgent: row.is_urgent === true, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 失敗として記録 → Cron が attempts の上限まで再処理する
    await db.from("inquiries").update({ status: "failed", last_error: message.slice(0, 1000), locked_at: null }).eq("id", row.id);
    return { id: row.id, result: "failed", error: message, ms: Date.now() - started };
  }
}

/** 処理対象を確保する。id を渡すとその1件だけ（緊急ルート）、省略すると古い順に limit 件（Cron） */
export async function claimInquiries(options: { id?: string; limit?: number } = {}): Promise<InquiryRow[]> {
  const { data, error } = await createAdminClient().rpc("claim_inquiries", {
    p_id: options.id ?? null,
    p_limit: options.limit ?? 10,
  });
  if (error) throw new Error(`キューの確保に失敗: ${error.message}`);
  return (data ?? []) as InquiryRow[];
}

/** キューを消化する（Cron から呼ぶ）。確保した分を順に処理する */
export async function processQueue(limit = 10): Promise<ProcessOutcome[]> {
  const rows = await claimInquiries({ limit });
  const outcomes: ProcessOutcome[] = [];
  for (const row of rows) outcomes.push(await processInquiry(row));
  return outcomes;
}
