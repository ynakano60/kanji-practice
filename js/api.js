// 写真取り込み(F-1): ブラウザから AI API を直接呼び、プリント画像から問題を抽出する
// 対応エンジン: Google Gemini(無料枠あり) / Anthropic Claude
// API キーは端末の localStorage にのみ保存し(F-13)、リポジトリには含めない。

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-4-8';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          no: { type: 'integer', description: '問題番号' },
          question: { type: 'string', description: '問題文全体(ひらがな部分+文脈)。例:「しきんを集める」' },
          target: { type: 'string', description: 'questionのうち漢字に直す部分(下線部)。例:「しきん」' },
          answer: { type: 'string', description: '正解の漢字表記(送りがな含む)。例:「資金」' },
        },
        required: ['no', 'question', 'target', 'answer'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

const EXTRACT_PROMPT = `この画像は日本の小学校の漢字テスト練習プリントです。表形式で、各マスに「問題番号」「正解の漢字語(大きく印刷)」「読み(ひらがな。下線付きの部分が漢字に直す箇所)」が縦書きで書かれています。

すべての問題を読み取り、JSONで出力してください。各問題について:
- no: 問題番号
- question: 児童に見せる問題文。読み(ひらがな)と、ひらがなのまま残る文脈を合わせた全体。例: 正解「増える」で「水がふえる」と書かれていれば question は「水がふえる」
- target: question のうち漢字に直す部分(下線が引かれている部分)。例:「ふえる」
- answer: 正解の漢字表記(送りがなを含む)。例:「増える」

注意:
- 番号順に全問を漏れなく出力すること
- 読み取れない箇所は question に「?」を入れてよい(後で人間が修正します)
- answer は必ずプリントに印刷されている漢字表記と一致させること

出力は次の形の JSON のみ(前後の説明文やコードフェンスは不要):
{"questions":[{"no":41,"question":"しきんを集める","target":"しきん","answer":"資金"}]}`;

export function getApiKey() {
  return localStorage.getItem('kp_apiKey') || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem('kp_apiKey', key);
  else localStorage.removeItem('kp_apiKey');
}

export function getGeminiKey() {
  return localStorage.getItem('kp_geminiKey') || '';
}

export function setGeminiKey(key) {
  if (key) localStorage.setItem('kp_geminiKey', key);
  else localStorage.removeItem('kp_geminiKey');
}

// 利用可能なエンジン一覧(キーが設定されているもの)。Gemini(無料枠)を優先表示
export function availableEngines() {
  const list = [];
  if (getGeminiKey()) list.push({ id: 'gemini', label: 'Gemini(無料枠)' });
  if (getApiKey()) list.push({ id: 'claude', label: 'Claude' });
  return list;
}

// 画像ファイルを長辺 maxDim px 以下の JPEG(base64)へ縮小する
export function fileToResizedBase64(file, maxDim = 2048) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      resolve(dataUrl.split(',')[1]);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

export async function extractFromImage(base64Jpeg, engine = 'gemini') {
  if (engine === 'gemini') return extractWithGemini(base64Jpeg);
  return extractWithClaude(base64Jpeg);
}

// ===== Google Gemini(無料枠あり・キーは https://aistudio.google.com/ で取得) =====
// モデル名は決め打ちにせず、このキーで使える最新の flash 系モデルを自動選択する。
// (Google はモデルの提供を予告なく打ち切るため。404 が出たら次の候補を試す)

async function listGeminiCandidates(apiKey) {
  const res = await fetch(`${GEMINI_BASE}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!res.ok) throw await geminiError(res);
  const data = await res.json();
  const names = (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace(/^models\//, ''))
    .filter(n => /^gemini-[\d.]+-flash/.test(n));
  // 新しいバージョンを優先。lite/8b(小型)や preview/exp(実験版)は後回し
  const score = n => {
    const ver = parseFloat((n.match(/^gemini-([\d.]+)/) || [])[1] || '0');
    let s = ver * 100;
    if (/lite|8b/.test(n)) s -= 20;
    if (/preview|exp/.test(n)) s -= 5;
    if (/^gemini-[\d.]+-flash$/.test(n)) s += 3; // 素の flash 名を優先
    return s;
  };
  return [...new Set(names)].sort((a, b) => score(b) - score(a));
}

async function geminiError(res) {
  let detail = '';
  try {
    const err = await res.json();
    detail = err?.error?.message || '';
  } catch { /* ignore */ }
  if ((res.status === 400 || res.status === 403) && /API key/i.test(detail)) {
    return new Error('Gemini APIキーが正しくありません。設定画面で確認してください。');
  }
  if (res.status === 429) {
    return new Error('無料枠の上限に達したか、アクセスが集中しています。1分ほど待ってからもう一度お試しください。');
  }
  return new Error(`読み取りに失敗しました (${res.status}) ${detail}`);
}

async function extractWithGemini(base64Jpeg) {
  const apiKey = getGeminiKey();
  if (!apiKey) throw new Error('Gemini APIキーが設定されていません。設定画面で登録してください。');

  const body = JSON.stringify({
    contents: [{
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
        { text: EXTRACT_PROMPT },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json' },
  });

  // 前回成功したモデル → だめなら使えるモデルを探して順に試す
  const tried = new Set();
  let candidates = [];
  const cached = localStorage.getItem('kp_geminiModel');
  if (cached) candidates.push(cached);
  let discovered = false;
  let lastErr = new Error('使えるGeminiモデルが見つかりませんでした。時間をおいてお試しください。');

  while (true) {
    if (candidates.length === 0) {
      if (discovered) break;
      discovered = true;
      candidates = (await listGeminiCandidates(apiKey)).filter(m => !tried.has(m)).slice(0, 4);
      if (candidates.length === 0) break;
    }
    const model = candidates.shift();
    tried.add(model);

    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body,
    });

    if (res.status === 404) {
      // このモデルは使えない(提供終了など)→ 次の候補へ
      if (cached === model) localStorage.removeItem('kp_geminiModel');
      lastErr = await geminiError(res);
      continue;
    }
    if (!res.ok) throw await geminiError(res);

    localStorage.setItem('kp_geminiModel', model);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (!text) throw new Error('読み取り結果が空でした。もう一度お試しください。');
    return toQuestions(parseJsonLoose(text));
  }
  throw lastErr;
}

// ===== Anthropic Claude =====
async function extractWithClaude(base64Jpeg) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Claude APIキーが設定されていません。設定画面で登録してください。');

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Jpeg } },
          { type: 'text', text: EXTRACT_PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* ignore */ }
    if (res.status === 401) throw new Error('APIキーが正しくありません。設定画面で確認してください。');
    if (res.status === 429) throw new Error('アクセスが集中しています。少し待ってからもう一度お試しください。');
    throw new Error(`読み取りに失敗しました (${res.status}) ${detail}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('AIが読み取りを実行できませんでした。手入力またはOCR貼り付けをお試しください。');
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('読み取り結果が空でした。もう一度お試しください。');
  return toQuestions(parseJsonLoose(textBlock.text));
}

// ===== 共通ヘルパー =====
// コードフェンス付き等の緩い JSON も受け付ける
function parseJsonLoose(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    throw new Error('AIの返答を解釈できませんでした。もう一度お試しください。');
  }
}

function toQuestions(parsed) {
  const src = Array.isArray(parsed) ? parsed : (parsed.questions || []);
  const questions = src.map(q => ({
    no: q.no,
    question: q.question || '',
    target: q.target || q.question || '',
    answer: q.answer || '',
  })).filter(q => q.question || q.answer);
  if (questions.length === 0) throw new Error('問題を見つけられませんでした。写真を撮り直してみてください。');
  return questions;
}
