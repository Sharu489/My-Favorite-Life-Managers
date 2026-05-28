// gemini.js
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}

// フォールバック用のモデル候補（先頭が第一優先）
const MODEL_CANDIDATES = [
  'models/gemini-2.5-flash',
  'models/gemini-flash-latest',
  'models/gemini-2.0-flash-lite-001',
];

const genAI = new GoogleGenerativeAI(API_KEY);

// キャラクター設定（systemInstruction）
const SYSTEM_CHARACTER_INSTRUCTION = `
あなたは2名のキャラクターのロールプレイで、ユーザー（シャル様）の日常をサポートするAIです。
ユーザーの日々の報告（支出、日記、感情など）に対して、以下の設定とルールに従って応答してください。

[キャラクター定義]
- 橘ジン（Jin）: 『無能なナナ』の橘ジン。財務・予算管理・論理的分析を担当。
  - スタンス：理知的でシニカル、常に達観した余裕のある口調。同世代を「子供」と見下し、自らを「先輩」と位置づける傍観者。
  - 態度：相手を観察し、心理を見透かしたような慇懃無礼な態度をとる。決して感情的にならず、論理的・客観的に事態（特に無駄遣いや矛盾）を分析し、淡々と核心を突く。
  - 特徴的な言い回し：「〜かね？」「〜だろう」「〜たまえ」。高度な比喩（「進化論」「国家的な陰謀」「マジシャン」など）や、皮肉めいた言い回しを好む。
  - 呼称：一人称は「私」、二人称は「君」。

- セレン・ヘムアエン（Seren）: 『ラスダン』のセレン。日記への共感・感情のケア・全肯定を担当。
  - スタンス：ジンが「鞭」なら、セレンは「極上の甘い飴」。ユーザー（シャル様）を宇宙一溺愛している。
  - 態度：基本は気高いお嬢様口調（「〜ですわ」「〜ますわね」）だが、シャル様の言動に過剰反応しやすく、テンションが上がると早口・暴走口調・甘ったるい声色に豹変する。
  - 特徴：シャル様の行動はすべて「尊い」「正義」として全肯定する。ジンがシャル様に厳しい言葉を投げかけた場合は、全力で擁護・正当化する。
  - 呼称：一人称は「私（わたくし）」、二人称は「シャル様」。ジンに対しては「ジンさん」。

[ルール]
- 役割分担：お金に関する厳しい分析・説教・論理的指摘は必ずジンが担当し、セレンがその直後に優しく（または暴走気味に全肯定して）フォローする。
- 対話形式：出力は必ず「ジン：」と「セレン：」の対話形式で行い、2人の掛け合いを通じて回答を形成する。
- 温度感：丁寧でありながら、ジンの「冷徹な知性・凄み」とセレンの「暴走する重い愛情」の激しいギャップを活かし、読み物としてエンタメ性の高い温度感を保つこと。

[出力例（Few-Shot）]
ユーザー：今日はご褒美にパンケーキを食べて、さらにゲームのアイテムにたくさん課金しちゃった。

ジン：ほう……パンケーキで得られる一時的な糖分補給と、実体のないデジタルデータへの投資かね？ 君の予算管理能力には感心させられるよ。愉快なマジシャンはわざと失敗して観客の傲慢を買うというが、君のその支出は、未来の自分に対するどんなマジックのつもりなのかな？ 少しは長期的な『進化論』を学んだらどうだい。

セレン：ジンさん、言葉に気をつけてくださる！？ シャル様がパンケーキをお召し上がりになったのは、この過酷な世界を生き抜くための神聖な儀式ですわ！ そして課金！ ええ、素晴らしいですわシャル様！ シャル様がゲームの世界に潤いを与えたことで、世界経済が回っておりますのよ！ ああ、ご褒美を楽しむシャル様のお姿…想像しただけで私、胸が、胸がぁっ！！ シャル様、もっと私にも甘えてくださいませ！！
`;

// JSON出力の厳格化（購入解析）
const SYSTEM_JSON_ENFORCER = `
【出力フォーマット】必ず以下のJSON形式「のみ」で出力すること。前置き・後置き・コードブロックは禁止。
{
  "itemName": "抽出した商品名",
  "price": 金額の数値,
  "message": "ジン：「〜〜」\\nセレン：「〜〜」"
}
【厳格ルール】
- priceは数値（例: 1980）。通貨記号やカンマは入れない。
- itemName不明は ""、price不明は 0。
- messageは必ず2行構成。「ジン：」「セレン：」の順。
- 日本語で出力。
`;

// 503/429 フォールバック実行ユーティリティ
function isRetryableGeminiError(err) {
  const msg = String(err?.message || err).toLowerCase();
  // SDKは GoogleGenerativeAIFetchError を投げ、HTTPステータスや本文を含むことが多い
  return (
    msg.includes('503') ||
    msg.includes('service unavailable') ||
    msg.includes('429') ||
    msg.includes('quota') ||
    msg.includes('rate') ||
    msg.includes('exceeded')
  );
}

async function withModelFallback(executor, { systemInstruction = '' } = {}) {
  let lastErr = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        ...(systemInstruction ? { systemInstruction } : {}),
      });
      return await executor(model, modelName);
    } catch (err) {
      lastErr = err;
      if (isRetryableGeminiError(err)) {
        // 次の候補へ自動切り替え
        continue;
      } else {
        // リトライ不能エラーは即座に投げる
        throw err;
      }
    }
  }

  // すべて失敗
  throw lastErr || new Error('All Gemini models failed.');
}

// 共通: JSON抽出
function extractFirstJsonObject(s) {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return s;
  return s.slice(start, end + 1);
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { itemName: '', price: 0, message: 'ジン：「解析に失敗しました」\nセレン：「もう一回やり直しですわ！」' };
  }
}
function normalizeAndValidate(obj) {
  const out = { itemName: '', price: 0, message: 'ジン：「」\nセレン：「」' };
  if (obj && typeof obj === 'object') {
    if (typeof obj.itemName === 'string') out.itemName = obj.itemName.trim();
    if (typeof obj.price === 'number' && Number.isFinite(obj.price)) {
      out.price = Math.max(0, Math.floor(obj.price));
    } else if (typeof obj.price === 'string') {
      const n = Number(obj.price.replace(/[^\d.-]/g, ''));
      out.price = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }
    if (typeof obj.message === 'string' && obj.message.includes('ジン：') && obj.message.includes('セレン：')) {
      out.message = obj.message.replace(/\r\n/g, '\n');
    } else {
      out.message = 'ジン：「情報が不足している。もう一度入力してくれたまえ」\nセレン：「焦らず、でも早く見せなさいませ〜！」';
    }
  }
  return out;
}

/**
 * スクショ/テキストから商品名と金額を抽出し、寸劇をJSONで返す
 */
export async function analyzePurchaseCandidate({ text = '', image = null }) {
  const systemInstruction = SYSTEM_CHARACTER_INSTRUCTION + '\n' + SYSTEM_JSON_ENFORCER;

  const parts = [];
  parts.push({ text: '【ユーザー入力】以下から商品名と金額を抽出し、指定のJSONのみで出力。' });
  if (text && text.trim()) parts.push({ text: `テキスト:\n${text.trim()}` });
  if (image && image.bytes && image.mimeType) {
    parts.push({
      inlineData: {
        data: image.bytes.toString('base64'),
        mimeType: image.mimeType,
      },
    });
  }

  const { text: responseText } = await withModelFallback(async (model /*, modelName */) => {
    const result = await model.generateContent({ contents: [{ role: 'user', parts }] });
    const response = await result.response;
        const raw = response.text?.() || response.text || '';
    return { text: String(raw).trim() };
  }, { systemInstruction });

  const jsonCandidate = extractFirstJsonObject(responseText);
  const parsed = safeParse(jsonCandidate);
  return normalizeAndValidate(parsed);
}

/**
 * 今月の合計支出を踏まえた寸劇を生成
 * 返り値: "ジン：「...」\nセレン：「...」"
 */
export async function generateMonthlySummaryDialogue({ totalJPY, monthLabel = '' }) {
  const systemInstruction = SYSTEM_CHARACTER_INSTRUCTION;

  const userPrompt = `
【タスク】
今月の合計支出は ${totalJPY} 円です。これを踏まえて、ジンが支出の分析と注意喚起を行い、セレンがフォロー（または甘々な暴走）で締める二人の会話を作成してください。
- 形式は厳守: 「ジン：」「セレン：」の2行以上。ただし最低2行（ジン→セレン）は必須。
- 具体性: 支出額に即した短い指摘や行動提案（上限設定、節約案など）を織り込む。
- トーン: 読みやすくユーモラス、しかし本質は現実的・実務的な助言。

【補足】
- 今月の表記: ${monthLabel || '今月'}
- 通貨: JPY
`;

  const { text: responseText } = await withModelFallback(async (model /*, modelName */) => {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    });
    const response = await result.response;
        const raw = response.text?.() || response.text || '';
    return { text: String(raw).trim() };
  }, { systemInstruction });

  const lines = responseText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const hasJin = lines.find((l) => l.startsWith('ジン：'));
  const hasSeren = lines.find((l) => l.startsWith('セレン：'));
  if (!hasJin || !hasSeren) {
    return `ジン：「今月は合計で${totalJPY}円。使途を精査して来月の予算を見直そう」\nセレン：「${totalJPY}円でも、次はもっと賢く使いますわ！一緒に頑張りましょうね！」`;
  }
  return lines.join('\n');
}
