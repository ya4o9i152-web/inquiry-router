#!/usr/bin/env bash
# Headlessモード（claude -p）による運用チェック。
#   bash scripts/headless-ops-check.sh [日数=7]
# 集計スクリプトの結果を Claude Code が読み、異常の有無を判定して日本語レポート（Markdown）を作る。
# 許可するのは集計スクリプトの実行だけ（DBの変更・ファイル編集はさせない）。
# 定期実行する場合は、cron や GitHub Actions の schedule からこのスクリプトを呼ぶ。
set -euo pipefail
cd "$(dirname "$0")/.."
DAYS="${1:-7}"

PROMPT=$(cat <<PROMPT_EOF
あなたは「不動産管理会社の問い合わせ集約システム」の運用担当です。次の手順で運用チェックをしてください。

1. \`npx tsx scripts/ops-report.ts ${DAYS}\` を実行する（直近${DAYS}日の集計がJSONで出る。本文などの個人情報は含まれない）
2. 次の観点で判定する
   - stuck（Slackに届いていない問い合わせ）が0件か。あれば last_error から原因を推定する。gave_up=true は自動再試行を使い切ったもの
   - complaints_without_push（クレームなのに部長へ通知されていない）が0件か ← 最重要
   - 緊急通知の SLA（受信→部長LINE 300秒以内）の違反が0件か。中央値・p95も報告する
   - unclassified（AI分類に失敗）と retried（再試行された件数）が多すぎないか
   - カテゴリの比率が、ヒアリング時の想定（賃貸50%／売買20%／内見20%／クレーム10%）から大きくずれていないか（件数が少ない場合は参考程度と明記）
3. 結果を、非エンジニアの営業部長も読める日本語の Markdown で出力する。形式：
   - 1行目：「## 運用チェック結果：問題なし」または「## 運用チェック結果：要対応（N件）」
   - 次に、上の観点ごとの表（観点／結果／判定 ✅ ⚠️ ❌）
   - 要対応がある場合のみ「## 対応してほしいこと」として、具体的な手順を書く
   - 前置きや、最後の挨拶は書かない
PROMPT_EOF
)

mkdir -p reports
OUT="reports/ops-check-$(date +%Y%m%d-%H%M%S)"
claude -p "$PROMPT" \
  --allowedTools "Bash(npx tsx scripts/ops-report.ts ${DAYS})" \
  --output-format json < /dev/null > "$OUT.json"

python3 - "$OUT" <<'PY'
import json, sys
base = sys.argv[1]
envelope = json.load(open(base + ".json"))
text = envelope.get("result", "").strip()
open(base + ".md", "w").write(text + "\n")
print(text)
print(f"\nコスト: ${envelope.get('total_cost_usd', 0):.3f} / 所要: {envelope.get('duration_ms', 0)/1000:.0f}秒 / 保存先: {base}.md")
sys.exit(0 if "問題なし" in text.splitlines()[0] else 1)
PY
