#!/usr/bin/env bash
# Headlessモード（claude -p）で、サンプル22件の分類精度を検証し、合格判定レポートを作る。
#   bash scripts/headless-eval.sh
# Claude Code が分類スクリプトを実行 → 結果を合格基準と照合 → JSON で判定を返す。
# 許可するのは分類スクリプトの実行だけ（ファイル編集などはさせない）。
set -euo pipefail
cd "$(dirname "$0")/.."

PROMPT=$(cat <<'PROMPT_EOF'
あなたは問い合わせ分類システムのQA担当です。次の手順で検証してください。

1. `npx tsx scripts/classify-sample.ts --all` を実行する（サンプル22件をClaude APIで分類し、期待値と比べた結果が出る）
2. 結果を次の合格基準と照合する
   - 緊急判定：#19・#20 が緊急 true、#22 が緊急 false。3件すべて正解であること（見逃し0件・誤検知0件）
   - カテゴリ分類：22件中20件以上が期待カテゴリと一致すること
3. 最後に、次の形式のJSONだけを出力する（前後に説明文を付けない）
{"pass": true/false, "urgent_correct": "3/3", "category_correct": "N/22", "avg_ms": 数値, "misclassified": [{"no": 番号, "expected": "期待", "actual": "結果", "note": "なぜ間違えたかの考察"}], "suggestion": "プロンプト改善の提案（不合格・誤分類がある場合のみ。なければ空文字）"}
PROMPT_EOF
)

OUT="reports/headless-eval-$(date +%Y%m%d-%H%M%S).json"
claude -p "$PROMPT" \
  --allowedTools "Bash(npx tsx scripts/classify-sample.ts --all)" \
  --output-format json < /dev/null > "$OUT"

# --output-format json の .result に、Claude が最後に出力したテキスト（＝判定JSON）が入る
python3 - "$OUT" <<'PY'
import json, sys, re
envelope = json.load(open(sys.argv[1]))
text = envelope.get("result", "")
match = re.search(r"\{.*\}", text, re.S)
report = json.loads(match.group(0)) if match else {"raw": text}
print(json.dumps(report, ensure_ascii=False, indent=2))
print(f"\nコスト: ${envelope.get('total_cost_usd', 0):.3f} / 所要: {envelope.get('duration_ms', 0)/1000:.0f}秒 / 保存先: {sys.argv[1]}")
sys.exit(0 if report.get("pass") else 1)
PY
