// OCR 貼り付けテキストを「番号・問題文・正解」に整形する(F-16)
// 期待する形式の例:
//   41 きんし 禁止
//   42 そうごう 総合
//   水がふえる 増える
// 1トークン目に漢字が含まれるものを正解、かな部分を問題文とみなす。

const KANJI_RE = /[㐀-鿿々]/;

function toHalfWidthDigits(s) {
  return s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

export function parseOcrText(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = toHalfWidthDigits(raw).trim();
    if (!line) continue;

    // 行頭の番号を分離
    let no = null;
    const m = line.match(/^(\d{1,3})[\s.。、．:：)）]*/);
    if (m) {
      no = parseInt(m[1], 10);
      line = line.slice(m[0].length).trim();
    }
    if (!line) continue;

    // 空白・区切りでトークン化。正解(漢字表記)は読み+文脈より短いのが普通なので、
    // 漢字を含むトークンのうち最短のものを正解とみなす(同長なら漢字含有率が高い方)。
    // 例:「水がふえる 増える」→ 増える、「目的地をすぎる 過ぎる」→ 過ぎる
    const tokens = line.split(/[\s,、/／|｜]+/).filter(Boolean);
    const ratio = t => [...t].filter(c => KANJI_RE.test(c)).length / t.length;
    let ansIdx = -1;
    tokens.forEach((t, i) => {
      if (!KANJI_RE.test(t)) return;
      if (ansIdx < 0) { ansIdx = i; return; }
      const cur = tokens[ansIdx];
      if (t.length < cur.length || (t.length === cur.length && ratio(t) > ratio(cur))) {
        ansIdx = i;
      }
    });
    const answer = ansIdx >= 0 ? tokens[ansIdx] : '';
    const question = tokens.filter((_, i) => i !== ansIdx).join('');
    if (!question && !answer) continue;

    entries.push({
      no,
      question: question,
      target: question, // 既定では全体を「漢字に直す部分」とする(確認画面で修正可)
      answer,
    });
  }
  // 番号がない行に連番を振る
  let next = entries.reduce((max, e) => Math.max(max, e.no || 0), 0);
  for (const e of entries) {
    if (e.no == null) e.no = ++next;
  }
  entries.sort((a, b) => a.no - b.no);
  return entries;
}
