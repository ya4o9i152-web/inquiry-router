import { createAdminClient } from "./supabase-admin";
import { detectRoute, type Route } from "./routing";

export interface NewInquiry {
  channel: "line" | "mail";
  /** LINE の webhookEventId / Gmail の messageId。同じ値の二重保存を DB の一意制約で防ぐ */
  externalId: string;
  senderId?: string | null;
  senderName?: string | null;
  subject?: string | null;
  body: string;
  receivedAt?: string;
}

export type SaveResult =
  | { status: "saved"; id: string; route: Route }
  | { status: "duplicate" };

/** 本文の上限（長文メールの署名・引用部分でDBやClaudeへの入力が膨らみすぎないように） */
const MAX_BODY_LENGTH = 10_000;

/**
 * 受信した問い合わせを「まず保存」する。ここで保存できれば、以降の処理が失敗しても問い合わせは消えない。
 * LINE の Webhook 再送や GAS の重複送信で同じ問い合わせが来た場合は、保存せず duplicate を返す。
 */
export async function saveInquiry(inquiry: NewInquiry): Promise<SaveResult> {
  const route = detectRoute(`${inquiry.subject ?? ""}\n${inquiry.body}`);

  const { data, error } = await createAdminClient()
    .from("inquiries")
    .upsert(
      {
        channel: inquiry.channel,
        external_id: inquiry.externalId,
        sender_id: inquiry.senderId ?? null,
        sender_name: inquiry.senderName ?? null,
        subject: inquiry.subject ?? null,
        body: inquiry.body.slice(0, MAX_BODY_LENGTH),
        received_at: inquiry.receivedAt ?? new Date().toISOString(),
        route,
      },
      // 既存の行は上書きしない（ON CONFLICT DO NOTHING）。重複時は data が空になる
      { onConflict: "channel,external_id", ignoreDuplicates: true }
    )
    .select("id");

  if (error) throw new Error(`問い合わせの保存に失敗: ${error.message}`);
  if (!data || data.length === 0) return { status: "duplicate" };
  return { status: "saved", id: data[0].id as string, route };
}
