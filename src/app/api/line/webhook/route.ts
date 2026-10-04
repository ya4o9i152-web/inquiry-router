import { verifyLineSignature } from "@/lib/signature";
import { saveInquiry, type SaveResult } from "@/lib/inquiries";
import { processUrgentAfterResponse } from "@/lib/urgent";

// 緊急ルートの after() 処理（分類→Slack→LINE通知）が収まる時間
export const maxDuration = 60;

// LINE Webhook のイベント（使う項目だけ）
// https://developers.line.biz/ja/reference/messaging-api/#webhook-event-objects
interface LineEvent {
  type: string;
  webhookEventId: string;
  timestamp: number;
  source?: { type: string; userId?: string };
  message?: { type: string; text?: string };
  deliveryContext?: { isRedelivery: boolean };
}

/** テキスト以外も「何か届いた」ことは残す（取りこぼし防止）。中身の確認はスタッフがLINEで行う */
function messageToText(message: NonNullable<LineEvent["message"]>): string {
  switch (message.type) {
    case "text":
      return message.text ?? "";
    case "image":
      return "（画像が送信されました）";
    case "video":
      return "（動画が送信されました）";
    case "audio":
      return "（音声メッセージが送信されました）";
    case "file":
      return "（ファイルが送信されました）";
    case "location":
      return "（位置情報が送信されました）";
    case "sticker":
      return "（スタンプが送信されました）";
    default:
      return `（${message.type} が送信されました）`;
  }
}

export async function POST(request: Request) {
  // 署名は「受け取ったままの本文」で検証するため、先に text() で読む（json() で読むと元の文字列が失われる）
  const rawBody = await request.text();
  if (!verifyLineSignature(rawBody, request.headers.get("x-line-signature"))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  // LINE Developers の「検証」ボタンは events: [] で届く。署名が正しければ 200 を返せばよい
  const { events = [] } = JSON.parse(rawBody) as { events?: LineEvent[] };

  const results: SaveResult[] = [];
  for (const event of events) {
    if (event.type === "follow") {
      // 部長役の userId 確認用（LINE_MANAGER_USER_ID の設定ミスを調べるときに使う）
      console.log(`[line] follow: ${event.source?.userId}`);
      continue;
    }
    if (event.type !== "message" || !event.message) continue;

    const result = await saveInquiry({
      channel: "line",
      externalId: event.webhookEventId,
      senderId: event.source?.userId ?? null,
      body: messageToText(event.message),
      receivedAt: new Date(event.timestamp).toISOString(),
    });
    results.push(result);
    // 緊急ルートはレスポンス後にこの関数内で即処理。通常ルートは Cron（1分ごと）に任せる
    processUrgentAfterResponse(result, "line");
  }

  console.log(`[line] events=${events.length} ${JSON.stringify(results)}`);
  // 保存に失敗した場合は上で例外になり 500 が返る → LINE の再送（設定でオン）で再び届く
  return Response.json({ ok: true, results });
}
