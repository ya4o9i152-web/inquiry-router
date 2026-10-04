/**
 * サンプル問い合わせCSVを classifyWithClaude に直接渡して、分類が合うか確かめるスクリプト。
 * Webhookを繋ぐ前に分類ロジックだけを検証する（教材のヒント：動いてから繋ぐと詰まりにくい）。
 *
 *   npx tsx scripts/classify-sample.ts            # 先頭3件だけ（AIコール節約）
 *   npx tsx scripts/classify-sample.ts --ids 19,20,22
 *   npx tsx scripts/classify-sample.ts --all      # 22件すべて
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { classifyWithClaude } from "../src/lib/classify";

interface SampleRow {
  番号: string;
  チャネル: string;
  問い合わせ本文: string;
  期待カテゴリ: string;
  緊急: string;
}

function selectRows(rows: SampleRow[]): SampleRow[] {
  const args = process.argv.slice(2);
  if (args.includes("--all")) return rows;
  const idsIndex = args.indexOf("--ids");
  if (idsIndex >= 0) {
    const ids = new Set(args[idsIndex + 1].split(","));
    return rows.filter((r) => ids.has(r.番号));
  }
  return rows.slice(0, 3);
}

// 「その他/分類対象外」のような期待値は、先頭のカテゴリ名だけで比較する
const expectedCategory = (row: SampleRow) => row.期待カテゴリ.split("/")[0];

async function main() {
  const rows: SampleRow[] = parse(readFileSync("docs/samples/case5-test-inquiries.csv"), { columns: true });
  const targets = selectRows(rows);

  let categoryOk = 0;
  let urgentOk = 0;
  for (const row of targets) {
    const started = Date.now();
    const result = await classifyWithClaude(row.問い合わせ本文);
    const ms = Date.now() - started;

    const catMatch = result.category === expectedCategory(row);
    const urgMatch = result.urgent === (row.緊急 === "TRUE");
    if (catMatch) categoryOk++;
    if (urgMatch) urgentOk++;

    console.log(
      `#${row.番号.padStart(2)} ${catMatch && urgMatch ? "✅" : "❌"} ` +
        `分類:${result.category}(期待:${expectedCategory(row)}) ` +
        `緊急:${result.urgent}(期待:${row.緊急 === "TRUE"}) ` +
        `確信:${result.confidence} ${ms}ms｜${result.reason}`
    );
  }

  console.log(`\nカテゴリ一致 ${categoryOk}/${targets.length}、緊急判定一致 ${urgentOk}/${targets.length}`);
  if (categoryOk < targets.length || urgentOk < targets.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
