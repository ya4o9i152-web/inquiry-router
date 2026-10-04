import { after } from "next/server";
import { claimInquiries, processInquiry } from "./process";
import type { SaveResult } from "./inquiries";

/**
 * 緊急ルート：受信した関数の中で、レスポンスを返した直後に処理する（Cronの最大1分を待たない）。
 * 別の関数やキューを経由しないので、コールドスタートや待ち行列の遅れが SLA を食わない。
 *
 * Cron が同じ行を同時に拾おうとしても、claim_inquiries（FOR UPDATE SKIP LOCKED）で
 * どちらか一方しか確保できないため、二重処理にはならない。
 * ここで失敗しても行は failed になり、Cron が1分後に拾い直す。
 */
export function processUrgentAfterResponse(result: SaveResult, source: string): void {
  if (result.status !== "saved" || result.route !== "urgent") return;

  after(async () => {
    const [row] = await claimInquiries({ id: result.id });
    if (!row) {
      console.log(`[urgent:${source}] ${result.id} は既に Cron が確保済み`);
      return;
    }
    const outcome = await processInquiry(row);
    console.log(`[urgent:${source}] ${JSON.stringify(outcome)}`);
  });
}
