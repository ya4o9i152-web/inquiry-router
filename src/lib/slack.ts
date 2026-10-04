import type { Category } from "./classify";

export type SlackCategory = Category | "未分類";

const CHANNEL_ENV: Record<SlackCategory, string> = {
  賃貸: "SLACK_CHANNEL_RENTAL",
  売買: "SLACK_CHANNEL_SALES",
  内見: "SLACK_CHANNEL_VIEWING",
  クレーム: "SLACK_CHANNEL_COMPLAINT",
  その他: "SLACK_CHANNEL_OTHER",
  // 分類に失敗したものも捨てずに「その他」チャンネルへ出す（目立つ見出しを付ける）
  未分類: "SLACK_CHANNEL_OTHER",
};

export function channelFor(category: SlackCategory): string {
  const id = process.env[CHANNEL_ENV[category]];
  if (!id) throw new Error(`${CHANNEL_ENV[category]} が設定されていません`);
  return id;
}

/** Slack の mrkdwn で特別な意味を持つ記号をエスケープする（お客様の本文に < > が含まれても崩れないように） */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 429（レート制限）など、時間をおけば成功しうる失敗。キューの再処理に任せる */
export class RetryableError extends Error {}

export async function postSlackMessage(channel: string, text: string, blocks?: unknown[]): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    // text は通知・検索用のプレーンテキスト、blocks が実際の表示
    body: JSON.stringify({ channel, text, blocks, unfurl_links: false }),
  });

  if (res.status === 429) {
    throw new RetryableError(`Slack レート制限（Retry-After: ${res.headers.get("retry-after")}秒）`);
  }
  const json = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  if (!json.ok || !json.ts) throw new Error(`Slack 投稿に失敗: ${json.error}`);
  return json.ts;
}
