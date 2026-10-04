import Anthropic from "@anthropic-ai/sdk";

// 分類のみの単純タスクなので、速度（緊急通知SLA 5分）とコストを優先してHaikuから始める。
// サンプル22件の合格基準を満たさない場合は CLAUDE_MODEL=claude-sonnet-5 に切り替える。
const DEFAULT_MODEL = "claude-haiku-4-5";

export const CATEGORIES = ["賃貸", "売買", "内見", "クレーム", "その他"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Confidence = "high" | "medium" | "low";

export interface Classification {
  category: Category;
  /** 部長への緊急通知が必要か。クレームは常にtrue、クレームか迷う場合もtrue（見逃し防止を優先） */
  urgent: boolean;
  confidence: Confidence;
  reason: string;
}

let cachedClient: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY が設定されていません（.env.local を確認してください）");
    // SLAがあるので1回の待ち時間を短めにし、長引く失敗はキュー側の再処理に任せる
    cachedClient = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
  }
  return cachedClient;
}

// 自由記述をパースするより、tool_choiceで構造化出力を強制した方が分岐が安定する（案件1・4と同じ方針）
const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "classify_inquiry",
  description: "不動産管理会社に届いたお問い合わせを分類し、営業部長への緊急通知が必要か判定する",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: [...CATEGORIES],
        description: "お問い合わせのカテゴリ",
      },
      urgent: {
        type: "boolean",
        description:
          "営業部長に即時通知すべきか。categoryがクレームなら必ずtrue。クレームかどうか迷う場合もtrue。" +
          "本文に「緊急」「至急」という語があっても、内容がクレームでなければfalse",
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "categoryの判定にどれだけ確信があるか",
      },
      reason: {
        type: "string",
        description: "判定理由（Slackに表示する。30字程度の日本語）",
      },
    },
    required: ["category", "urgent", "confidence", "reason"],
  },
};

const SYSTEM_PROMPT = `あなたは不動産管理会社のお問い合わせ仕分け担当です。お客様から届いたメール・LINEの本文を読み、classify_inquiryツールで分類してください。

## カテゴリの定義
- 賃貸: 賃貸物件を探している、借りたい、賃貸契約・更新・退去・敷金精算など賃貸に関する相談
- 売買: 物件の購入・売却・査定・投資用物件・住宅ローンの相談
- 内見: すでに候補の物件があり、内見（見学）の日程調整・申し込みが主な目的のもの
- クレーム: 入居中の部屋の設備故障・不具合の申し立て、管理や対応・説明への不満や苦情
- その他: 不動産と無関係な内容、営業・宣伝、意味が読み取れないもの

## 判断のルール
- 物件を探している相談のついでに「内見も」と書かれている場合は、主目的（賃貸／売買）で分類する
- 「緊急」「至急」などの語の有無ではなく、文章の意味で判断する。「緊急ではありません」と書かれていればその通りに受け取る
- urgent は「クレーム（入居中のトラブル・不満・苦情）の可能性があるか」だけで決める。「明日」「今週中」など日程が近い内見・入居の希望は、急いでいても urgent を false にする
- クレームを見逃すことが最も避けるべき失敗。クレームの可能性が少しでもあれば urgent を true にする`;

export async function classifyWithClaude(body: string): Promise<Classification> {
  const response = await getAnthropicClient().messages.create({
    // 呼び出しのたびに読む（テストで環境変数を差し替えられるように）
    model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "classify_inquiry" },
    messages: [{ role: "user", content: `## お問い合わせ本文\n${body}` }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUse) throw new Error(`classify_inquiry が呼ばれませんでした（stop_reason: ${response.stop_reason}）`);

  const input = toolUse.input as Partial<Classification>;
  if (!input.category || !CATEGORIES.includes(input.category)) {
    throw new Error(`不正なカテゴリが返されました: ${String(input.category)}`);
  }

  return {
    category: input.category,
    // AIがurgent=falseと返しても、クレームなら必ず通知する（コード側でも二重に保証する）
    urgent: input.category === "クレーム" || input.urgent === true,
    confidence: input.confidence ?? "low",
    reason: input.reason ?? "",
  };
}
