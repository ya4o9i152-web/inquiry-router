/**
 * フェーズ1の完了確認：各外部サービスに実際に接続できるかを1回ずつ確かめる。
 *   npx tsx scripts/check-connections.ts
 * Slackの5チャンネルと部長役のLINEに「[接続テスト]」が1通ずつ届く。
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createAdminClient } from "../src/lib/supabase-admin";

type Check = { name: string; run: () => Promise<string> };

const SLACK_CHANNELS = {
  賃貸: "SLACK_CHANNEL_RENTAL",
  売買: "SLACK_CHANNEL_SALES",
  内見: "SLACK_CHANNEL_VIEWING",
  クレーム: "SLACK_CHANNEL_COMPLAINT",
  その他: "SLACK_CHANNEL_OTHER",
} as const;

async function slackApi(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string; [k: string]: unknown };
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

const checks: Check[] = [
  {
    name: "Supabase: inquiries テーブル",
    run: async () => {
      const { count, error } = await createAdminClient()
        .from("inquiries")
        .select("*", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return `接続OK（現在 ${count} 件）`;
    },
  },
  {
    name: "Supabase: claim_inquiries 関数",
    run: async () => {
      // 存在しないIDを指定すると、何も確保せず空配列が返る（＝関数が呼べることだけ確認）
      const { data, error } = await createAdminClient().rpc("claim_inquiries", {
        p_id: "00000000-0000-0000-0000-000000000000",
      });
      if (error) throw new Error(error.message);
      return `呼び出しOK（${(data as unknown[]).length} 件）`;
    },
  },
  {
    name: "Slack: Botトークン",
    run: async () => {
      const json = await slackApi("auth.test", {});
      return `${json.team} / ${json.user}`;
    },
  },
  ...Object.entries(SLACK_CHANNELS).map(([label, envName]) => ({
    name: `Slack: #問合せ-${label} へ投稿`,
    run: async () => {
      await slackApi("chat.postMessage", {
        channel: process.env[envName],
        text: `[接続テスト] #問合せ-${label} への投稿確認です`,
      });
      return "投稿OK";
    },
  })),
  {
    name: "LINE: チャネルアクセストークン",
    run: async () => {
      const res = await fetch("https://api.line.me/v2/bot/info", {
        headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const info = (await res.json()) as { displayName: string };
      return `公式アカウント「${info.displayName}」`;
    },
  },
  {
    name: "LINE: 部長役へのプッシュ",
    run: async () => {
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: process.env.LINE_MANAGER_USER_ID,
          messages: [{ type: "text", text: "[接続テスト] 緊急通知の送り先の確認です" }],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return "プッシュOK（個人LINEに届いているか確認してください）";
    },
  },
];

async function main() {
  let failed = 0;
  for (const check of checks) {
    try {
      console.log(`✅ ${check.name}: ${await check.run()}`);
    } catch (err) {
      failed++;
      console.log(`❌ ${check.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 件成功`);
  if (failed > 0) process.exitCode = 1;
}

main();
