import { RetryableError } from "./slack";

const LINE_API = "https://api.line.me/v2/bot";

function authHeader() {
  return { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` };
}

/**
 * 部長の個人LINEへプッシュ通知する。
 * retryKey（UUID）を付けると、同じキーでの再送を LINE 側が受け付けない（409）ため、
 * 「送れたのにDB更新前に落ちて再処理」された場合でも二重通知にならない。
 */
export async function pushToManager(text: string, retryKey: string): Promise<void> {
  const to = process.env.LINE_MANAGER_USER_ID;
  if (!to) throw new Error("LINE_MANAGER_USER_ID が設定されていません");

  const res = await fetch(`${LINE_API}/message/push`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json", "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });

  // 409 = このリトライキーのリクエストは既に受け付け済み → 送信済みとして扱う
  if (res.ok || res.status === 409) return;
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(`LINE プッシュ一時エラー: HTTP ${res.status}`);
  }
  throw new Error(`LINE プッシュに失敗: HTTP ${res.status} ${await res.text()}`);
}

/** LINE のお客様の表示名を取得する（Slack 表示用）。取れなくても処理は続ける */
export async function getLineDisplayName(userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${LINE_API}/profile/${encodeURIComponent(userId)}`, { headers: authHeader() });
    if (!res.ok) return null;
    const profile = (await res.json()) as { displayName?: string };
    return profile.displayName ?? null;
  } catch {
    return null;
  }
}
