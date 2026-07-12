// 写真取り込み(F-1): ブラウザから Claude API を直接呼び、プリント画像から問題を抽出する
// API キーは端末の localStorage にのみ保存し(F-13)、リポジトリには含めない。

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

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
- answer は必ずプリントに印刷されている漢字表記と一致させること`;

export function getApiKey() {
  return localStorage.getItem('kp_apiKey') || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem('kp_apiKey', key);
  else localStorage.removeItem('kp_apiKey');
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

export async function extractFromImage(base64Jpeg) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('APIキーが設定されていません。設定画面で登録してください。');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
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

  const parsed = JSON.parse(textBlock.text);
  const questions = (parsed.questions || []).map(q => ({
    no: q.no,
    question: q.question || '',
    target: q.target || q.question || '',
    answer: q.answer || '',
  }));
  if (questions.length === 0) throw new Error('問題を見つけられませんでした。写真を撮り直してみてください。');
  return questions;
}
