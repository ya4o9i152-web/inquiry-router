import { verifyMailSignature } from "@/lib/signature";
import { saveInquiry } from "@/lib/inquiries";
import { processUrgentAfterResponse } from "@/lib/urgent";

export const maxDuration = 60;

// GAS（gas/mail-forwarder.gs）が送ってくる本文
interface MailPayload {
  messageId: string;
  from: string;
  fromName?: string;
  subject?: string;
  body: string;
  receivedAt: string;
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = verifyMailSignature(
    rawBody,
    request.headers.get("x-timestamp"),
    request.headers.get("x-signature")
  );
  if (!verified.ok) {
    console.warn(`[mail] 署名検証に失敗: ${verified.reason}`);
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  const mail = JSON.parse(rawBody) as MailPayload;
  if (!mail.messageId || !mail.body) {
    return Response.json({ error: "messageId と body は必須です" }, { status: 400 });
  }

  const result = await saveInquiry({
    channel: "mail",
    externalId: mail.messageId,
    senderId: mail.from,
    senderName: mail.fromName ?? null,
    subject: mail.subject ?? null,
    body: mail.body,
    receivedAt: mail.receivedAt,
  });
  processUrgentAfterResponse(result, "mail");

  console.log(`[mail] ${JSON.stringify(result)}`);
  // 重複（duplicate）も 200 を返す。GAS は 200 を「転送済み」とみなして次へ進む
  return Response.json({ ok: true, result });
}
