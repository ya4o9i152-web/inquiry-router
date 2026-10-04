import { timingSafeEqual } from "node:crypto";
import { processQueue } from "@/lib/process";

// 1回の実行で最大10件 × 1件数秒。余裕を持たせる
export const maxDuration = 120;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return !!secret && header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

/** pg_cron（1分ごと）から呼ばれ、未処理・失敗の問い合わせを古い順に処理する */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const outcomes = await processQueue(10);
  if (outcomes.length > 0) console.log(`[cron] ${JSON.stringify(outcomes)}`);
  return Response.json({ processed: outcomes.length, outcomes });
}
