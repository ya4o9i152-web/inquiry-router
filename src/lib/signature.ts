import { createHmac, timingSafeEqual } from "node:crypto";

/** 文字列比較にかかる時間から正解を推測されないよう、長さが同じなら一定時間で比較する */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * LINE Webhook の署名検証。
 * x-line-signature = base64(HMAC-SHA256(チャネルシークレット, リクエスト本文))
 * 本文は JSON.parse する前の「受け取ったままの文字列」で計算する（整形し直すと1文字でも違えば不一致になる）。
 */
export function verifyLineSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  return safeEqual(expected, signature);
}

/** GAS → /api/mail/ingest の署名で許容する時刻のずれ。これより古いリクエストは再送攻撃とみなす */
const MAIL_SIGNATURE_TOLERANCE_SEC = 5 * 60;

/**
 * GAS から届くメール転送の署名検証（Slack の署名方式と同じ考え方）。
 * x-signature = hex(HMAC-SHA256(MAIL_INGEST_SECRET, `${timestamp}.${本文}`))
 * タイムスタンプも署名に含めるので、盗み見たリクエストを後から再送しても弾ける。
 */
export function verifyMailSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  now: number = Date.now()
): { ok: true } | { ok: false; reason: string } {
  const secret = process.env.MAIL_INGEST_SECRET;
  if (!secret) return { ok: false, reason: "MAIL_INGEST_SECRET が未設定" };
  if (!timestamp || !signature) return { ok: false, reason: "署名ヘッダーがない" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAIL_SIGNATURE_TOLERANCE_SEC) {
    return { ok: false, reason: "タイムスタンプが古い、または不正" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "署名が一致しない" };
}
