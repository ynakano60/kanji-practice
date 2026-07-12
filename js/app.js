import { getAllSets, getSet, putSet, deleteSet } from './db.js';
import { parseOcrText } from './parser.js';
import { getApiKey, setApiKey, fileToResizedBase64, extractFromImage } from './api.js';

const app = document.getElementById('app');
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));

// 画面間で受け渡す一時状態
let draft = null;        // 取り込み確認・編集中のセット
let lastResult = null;   // 直近の練習結果

const SESSION_KEY = 'kp_session';
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
const saveSession = s => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
const clearSession = () => localStorage.removeItem(SESSION_KEY);

const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 問題文の target 部分に下線を付けてHTML化
function questionHTML(q) {
  const question = q.question || '';
  const target = q.target || '';
  const idx = target ? question.indexOf(target) : -1;
  if (idx < 0) return `<u>${esc(question)}</u>`;
  return esc(question.slice(0, idx)) + `<u>${esc(target)}</u>` + esc(question.slice(idx + target.length));
}

function lastMark(q) {
  const h = q.history || [];
  if (h.length === 0) return null;
  return h[h.length - 1].ok;
}

function accuracy(set) {
  const answered = set.questions.filter(q => (q.history || []).length > 0);
  if (answered.length === 0) return null;
  const ok = answered.filter(q => lastMark(q)).length;
  return Math.round((ok / answered.length) * 100);
}

// ===== ルーター =====
window.addEventListener('hashchange', route);

async function route() {
  const hash = location.hash || '#home';
  const [name, arg] = hash.slice(1).split('/');
  try {
    if (name === 'home' || name === '') await renderHome();
    else if (name === 'import') renderImportMenu();
    else if (name === 'import-photo') renderPhotoImport();
    else if (name === 'import-ocr') renderOcrImport();
    else if (name === 'editor') renderEditor();
    else if (name === 'set') await renderSetDetail(decodeURIComponent(arg));
    else if (name === 'practice') await renderPractice();
    else if (name === 'result') renderResult();
    else if (name === 'settings') await renderSettings();
    else await renderHome();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="screen"><p class="error-msg">エラーが発生しました: ${esc(e.message)}</p>
      <button class="btn secondary" onclick="location.hash='#home'">ホームへ</button></div>`;
  }
}

function header(title, backHash, extraHTML = '') {
  return `<div class="header">
    ${backHash ? `<button class="back" onclick="location.hash='${backHash}'">‹</button>` : ''}
    <h1>${esc(title)}</h1>${extraHTML}
  </div>`;
}

// ===== ホーム(F-14: 保存済みセット一覧) =====
async function renderHome() {
  const sets = (await getAllSets()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const session = loadSession();

  const items = sets.map(s => {
    const acc = accuracy(s);
    return `<button class="set-item" data-id="${esc(s.id)}">
      <div class="title">${esc(s.title || '(無題)')}</div>
      <div class="sub">
        ${s.category ? `<span class="tag">${esc(s.category)}</span>` : ''}
        <span>${s.questions.length}問</span>
        ${acc != null ? `<span>正答率 ${acc}%</span>` : '<span>未練習</span>'}
        ${s.testDate ? `<span>テスト: ${esc(s.testDate)}</span>` : ''}
      </div>
    </button>`;
  }).join('');

  app.innerHTML = `
    ${header('漢字れんしゅう', null, `<button class="head-btn" onclick="location.hash='#settings'">⚙ 設定</button>`)}
    <div class="screen">
      ${session ? `<button class="btn ok-btn" id="resume-btn">▶ 前回のつづきから (${session.idx + 1}問目)</button>` : ''}
      <button class="btn" onclick="location.hash='#import'">＋ 新しい問題を取り込む</button>
      ${items || '<div class="empty-note">まだ問題がありません。<br>「新しい問題を取り込む」から始めましょう。</div>'}
    </div>`;

  app.querySelectorAll('.set-item').forEach(el => {
    el.onclick = () => { location.hash = '#set/' + encodeURIComponent(el.dataset.id); };
  });
  const resume = document.getElementById('resume-btn');
  if (resume) resume.onclick = () => { location.hash = '#practice'; };
}

// ===== 取り込みメニュー =====
function renderImportMenu() {
  app.innerHTML = `
    ${header('問題の取り込み', '#home')}
    <div class="screen">
      <button class="btn" onclick="location.hash='#import-photo'">📷 写真から取り込む(AI)</button>
      <p class="muted">プリントを撮影すると、AIが問題と正解を自動で読み取ります。APIキーの設定が必要です。</p>
      <button class="btn secondary" onclick="location.hash='#import-ocr'">📋 テキスト貼り付けで取り込む</button>
      <p class="muted">スマホのカメラのテキスト認識(iPhoneのテキスト認識表示 / Googleレンズ)でコピーした文字を貼り付けます。キー不要・無料。</p>
      <button class="btn secondary" id="manual-btn">✏️ 手入力で作る</button>
      <p class="muted">1問ずつ自分で入力します。</p>
    </div>`;
  document.getElementById('manual-btn').onclick = () => {
    draft = { setId: null, title: '', category: '', testDate: '', questions: [{ no: 1, question: '', target: '', answer: '' }] };
    location.hash = '#editor';
  };
}

// ===== 写真取り込み(F-1) =====
function renderPhotoImport() {
  const hasKey = !!getApiKey();
  app.innerHTML = `
    ${header('写真から取り込む', '#import')}
    <div class="screen">
      ${hasKey ? '' : `<div class="card">
        <p class="error-msg">APIキーが未設定です。</p>
        <p class="muted">写真の自動読み取りには Anthropic APIキーが必要です(写真1枚あたり数円)。</p>
        <button class="btn small secondary" onclick="location.hash='#settings'">設定画面へ</button>
        <p class="muted" style="margin-top:8px">キーなしで使う場合は「テキスト貼り付けで取り込む」をどうぞ。</p>
      </div>`}
      <label class="btn secondary" for="photo-input">📷 プリントを撮影 / 写真を選ぶ</label>
      <input type="file" id="photo-input" accept="image/*" capture="environment" style="display:none">
      <img id="photo-preview" style="display:none" alt="プレビュー">
      <button class="btn" id="extract-btn" disabled>AIで読み取る</button>
      <div id="photo-status"></div>
    </div>`;

  let selectedFile = null;
  const input = document.getElementById('photo-input');
  const preview = document.getElementById('photo-preview');
  const extractBtn = document.getElementById('extract-btn');
  const status = document.getElementById('photo-status');

  input.onchange = () => {
    selectedFile = input.files[0] || null;
    if (selectedFile) {
      preview.src = URL.createObjectURL(selectedFile);
      preview.style.display = 'block';
      extractBtn.disabled = !getApiKey();
      if (!getApiKey()) status.innerHTML = '<p class="error-msg">APIキーを設定すると読み取りできます。</p>';
    }
  };

  extractBtn.onclick = async () => {
    if (!selectedFile) return;
    extractBtn.disabled = true;
    status.innerHTML = '<div class="spinner"></div><p class="muted" style="text-align:center">読み取り中…(30秒ほどかかることがあります)</p>';
    try {
      const base64 = await fileToResizedBase64(selectedFile);
      const questions = await extractFromImage(base64);
      draft = { setId: null, title: '', category: '', testDate: '', questions };
      location.hash = '#editor';
    } catch (e) {
      status.innerHTML = `<p class="error-msg">${esc(e.message)}</p>`;
      extractBtn.disabled = false;
    }
  };
}

// ===== OCR貼り付け取り込み(F-16) =====
function renderOcrImport() {
  app.innerHTML = `
    ${header('テキスト貼り付けで取り込む', '#import')}
    <div class="screen">
      <details class="help">
        <summary>📱 やり方(iPhone / Android)</summary>
        <ol>
          <li>プリントをカメラで撮影する</li>
          <li>写真アプリで開き、文字を長押し →「すべて選択」→「コピー」<br>(iPhone: テキスト認識表示 / Android: Googleレンズ)</li>
          <li>下の欄に貼り付けて「整形する」を押す</li>
        </ol>
      </details>
      <textarea id="ocr-text" placeholder="ここに貼り付け&#10;例:&#10;41 きんし 禁止&#10;42 そうごう 総合&#10;43 水がふえる 増える"></textarea>
      <button class="btn" id="parse-btn">整形する</button>
      <p class="muted">読み間違いがあっても、次の確認画面で修正できます。</p>
    </div>`;

  document.getElementById('parse-btn').onclick = () => {
    const text = document.getElementById('ocr-text').value;
    const questions = parseOcrText(text);
    if (questions.length === 0) {
      alert('問題を読み取れませんでした。「番号 よみ 答え」の形で1行1問になっているか確認してください。');
      return;
    }
    draft = { setId: null, title: '', category: '', testDate: '', questions };
    location.hash = '#editor';
  };
}

// ===== 確認・修正/手入力/編集 画面(F-2, F-3) =====
function renderEditor() {
  if (!draft) { location.hash = '#home'; return; }

  const rows = draft.questions.map((q, i) => qRowHTML(q, i)).join('');
  app.innerHTML = `
    ${header(draft.setId ? '問題セットの編集' : '取り込み内容の確認', draft.setId ? '#set/' + encodeURIComponent(draft.setId) : '#import')}
    <div class="screen">
      <div class="card">
        <label class="field">表題(例: 5年生の6月漢字テスト用)</label>
        <input type="text" id="d-title" value="${esc(draft.title)}" placeholder="表題を入力">
        <div class="row" style="margin-top:8px">
          <div><label class="field">カテゴリ(任意)</label>
            <input type="text" id="d-category" value="${esc(draft.category)}" placeholder="例: 5年生"></div>
          <div><label class="field">テスト予定日(任意)</label>
            <input type="date" id="d-date" value="${esc(draft.testDate)}"></div>
        </div>
      </div>
      <div class="card">
        <p class="muted">各問題を確認して、間違いがあれば直してください。</p>
        <div id="q-rows">${rows}</div>
        <button class="btn small secondary" id="add-row" style="margin-top:10px">＋ 問題を追加</button>
      </div>
      <button class="btn" id="save-btn">保存する</button>
      <div id="editor-error"></div>
    </div>`;

  bindEditorRows();

  document.getElementById('add-row').onclick = () => {
    syncDraftFromDOM();
    const nextNo = draft.questions.reduce((m, q) => Math.max(m, q.no || 0), 0) + 1;
    draft.questions.push({ no: nextNo, question: '', target: '', answer: '' });
    renderEditor();
  };

  document.getElementById('save-btn').onclick = async () => {
    syncDraftFromDOM();
    const title = document.getElementById('d-title').value.trim();
    if (!title) { showEditorError('表題を入力してください。'); return; }
    const valid = draft.questions.filter(q => q.question.trim() && q.answer.trim());
    if (valid.length === 0) { showEditorError('問題文と正解が入力された問題が1問もありません。'); return; }

    const now = Date.now();
    let set;
    if (draft.setId) {
      set = await getSet(draft.setId);
    }
    if (!set) {
      set = { id: uid(), createdAt: now, questions: [] };
    }
    set.title = title;
    set.category = document.getElementById('d-category').value.trim();
    set.testDate = document.getElementById('d-date').value;
    set.updatedAt = now;
    set.questions = valid.map(q => ({
      id: q.id || uid(),
      no: q.no,
      question: q.question.trim(),
      target: (q.target || '').trim() || q.question.trim(),
      answer: q.answer.trim(),
      history: q.history || [],
    }));
    await putSet(set);
    draft = null;
    location.hash = '#set/' + encodeURIComponent(set.id);
  };

  function showEditorError(msg) {
    document.getElementById('editor-error').innerHTML = `<p class="error-msg">${esc(msg)}</p>`;
  }
}

function qRowHTML(q, i) {
  return `<div class="q-row" data-i="${i}">
    <input class="no-input" type="number" value="${q.no ?? ''}" data-f="no" aria-label="番号">
    <div class="fields">
      <input type="text" value="${esc(q.question)}" data-f="question" placeholder="問題文(例: しきんを集める)">
      <input type="text" value="${esc(q.target)}" data-f="target" placeholder="漢字に直す部分(例: しきん)">
      <input type="text" value="${esc(q.answer)}" data-f="answer" placeholder="正解(例: 資金)">
    </div>
    <button class="del" title="削除">🗑</button>
  </div>`;
}

function bindEditorRows() {
  document.querySelectorAll('.q-row .del').forEach(btn => {
    btn.onclick = () => {
      syncDraftFromDOM();
      const i = parseInt(btn.closest('.q-row').dataset.i, 10);
      draft.questions.splice(i, 1);
      renderEditor();
    };
  });
}

function syncDraftFromDOM() {
  document.querySelectorAll('.q-row').forEach(row => {
    const i = parseInt(row.dataset.i, 10);
    const q = draft.questions[i];
    if (!q) return;
    row.querySelectorAll('[data-f]').forEach(input => {
      const f = input.dataset.f;
      q[f] = f === 'no' ? (parseInt(input.value, 10) || null) : input.value;
    });
  });
}

// ===== セット詳細 =====
async function renderSetDetail(id) {
  const set = await getSet(id);
  if (!set) { location.hash = '#home'; return; }

  const acc = accuracy(set);
  const wrongCount = set.questions.filter(q => lastMark(q) === false).length;

  const qList = set.questions.map(q => {
    const mark = lastMark(q);
    const markHTML = mark === true ? '<span class="mark-ok">○</span>'
      : mark === false ? '<span class="mark-ng">×</span>'
      : '<span class="mark-none">−</span>';
    return `<div class="q-list-item"><span>${q.no}. ${questionHTML(q)}</span><span>${esc(q.answer)} ${markHTML}</span></div>`;
  }).join('');

  app.innerHTML = `
    ${header(set.title, '#home')}
    <div class="screen">
      <div class="card">
        <div class="sub muted">
          ${set.category ? `<span class="tag">${esc(set.category)}</span> ` : ''}
          ${set.questions.length}問
          ${acc != null ? ` / 正答率 ${acc}%` : ''}
          ${set.testDate ? ` / テスト: ${esc(set.testDate)}` : ''}
        </div>
      </div>
      <button class="btn" id="p-seq">▶ 番号順で練習</button>
      <button class="btn" id="p-random">🔀 ランダムで練習</button>
      ${wrongCount > 0 ? `<button class="btn ng-btn" id="p-wrong">✍ まちがえた問題だけ (${wrongCount}問)</button>` : ''}
      <div class="card">
        <p class="muted" style="margin-bottom:6px">問題一覧(直近の結果)</p>
        ${qList}
      </div>
      <div class="row">
        <button class="btn small secondary" id="edit-btn">編集</button>
        <button class="btn small ghost" id="delete-btn">削除</button>
      </div>
    </div>`;

  const start = (mode) => {
    let qids = set.questions.map(q => q.id);
    if (mode === 'wrong') qids = set.questions.filter(q => lastMark(q) === false).map(q => q.id);
    if (mode === 'random') qids = qids.slice().sort(() => Math.random() - 0.5);
    if (qids.length === 0) return;
    saveSession({ setId: set.id, qids, idx: 0, results: {}, mode, startedAt: Date.now() });
    location.hash = '#practice';
  };
  document.getElementById('p-seq').onclick = () => start('seq');
  document.getElementById('p-random').onclick = () => start('random');
  const wrongBtn = document.getElementById('p-wrong');
  if (wrongBtn) wrongBtn.onclick = () => start('wrong');

  document.getElementById('edit-btn').onclick = () => {
    draft = {
      setId: set.id,
      title: set.title,
      category: set.category || '',
      testDate: set.testDate || '',
      questions: set.questions.map(q => ({ ...q })),
    };
    location.hash = '#editor';
  };
  document.getElementById('delete-btn').onclick = async () => {
    if (!confirm(`「${set.title}」を削除しますか?\n(問題と成績が消えます)`)) return;
    await deleteSet(set.id);
    const s = loadSession();
    if (s && s.setId === set.id) clearSession();
    location.hash = '#home';
  };
}

// ===== 練習画面(F-5〜F-9) =====
async function renderPractice() {
  const session = loadSession();
  if (!session) { location.hash = '#home'; return; }
  const set = await getSet(session.setId);
  if (!set) { clearSession(); location.hash = '#home'; return; }

  if (session.idx >= session.qids.length) { finishSession(session, set); return; }

  const q = set.questions.find(x => x.id === session.qids[session.idx]);
  if (!q) { session.idx++; saveSession(session); renderPractice(); return; }

  const chars = [...q.answer];
  const cellsHTML = chars.map((_, i) => `
    <div class="cell-wrap">
      <canvas class="cell" data-i="${i}"></canvas>
      <button class="cell-clear" data-i="${i}">このマスを消す</button>
    </div>`).join('');

  app.innerHTML = `
    ${header(set.title, null, `<button class="head-btn" id="quit-btn">やめる</button>`)}
    <div class="practice">
      <div class="q-area">
        <div class="progress">${session.idx + 1} / ${session.qids.length} 問</div>
        <div class="q-text">${questionHTML(q)}</div>
        <div class="answer-line" id="answer-line"></div>
      </div>
      <div class="write-area">
        <div class="cells">${cellsHTML}</div>
      </div>
      <div class="practice-btns" id="practice-btns">
        <button class="btn secondary" id="clear-all">全部消す</button>
        <button class="btn" id="reveal-btn">答えを見る</button>
      </div>
    </div>`;

  // 手書きキャンバス初期化
  const canvases = [...app.querySelectorAll('canvas.cell')];
  canvases.forEach(setupCanvas);

  app.querySelectorAll('.cell-clear').forEach(btn => {
    btn.onclick = () => clearCanvas(canvases[parseInt(btn.dataset.i, 10)]);
  });
  document.getElementById('clear-all').onclick = () => canvases.forEach(clearCanvas);

  document.getElementById('quit-btn').onclick = () => {
    location.hash = '#set/' + encodeURIComponent(set.id);
  };

  document.getElementById('reveal-btn').onclick = () => {
    document.getElementById('answer-line').textContent = q.answer;
    document.getElementById('practice-btns').innerHTML = `
      <div class="row">
        <button class="btn ok-btn" id="mark-ok">○ できた</button>
        <button class="btn ng-btn" id="mark-ng">× まちがえた</button>
      </div>`;
    document.getElementById('mark-ok').onclick = () => grade(true);
    document.getElementById('mark-ng').onclick = () => grade(false);
  };

  async function grade(ok) {
    q.history = q.history || [];
    q.history.push({ t: Date.now(), ok });
    if (q.history.length > 50) q.history = q.history.slice(-50);
    set.updatedAt = Date.now();
    await putSet(set);
    session.results[q.id] = ok;
    session.idx++;
    saveSession(session);
    if (session.idx >= session.qids.length) finishSession(session, set);
    else renderPractice();
  }
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1f2937';
  drawGuides(canvas, ctx);

  let drawing = false;
  canvas.addEventListener('pointerdown', e => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
}

function drawGuides(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.save();
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
  ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
  ctx.stroke();
  ctx.restore();
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  drawGuides(canvas, ctx);
}

function finishSession(session, set) {
  const wrongIds = Object.entries(session.results).filter(([, ok]) => !ok).map(([id]) => id);
  lastResult = {
    setId: set.id,
    setTitle: set.title,
    total: Object.keys(session.results).length,
    correct: Object.values(session.results).filter(Boolean).length,
    wrongIds,
    wrongQuestions: set.questions.filter(q => wrongIds.includes(q.id)),
  };
  clearSession();
  location.hash = '#result';
}

// ===== 結果画面 =====
function renderResult() {
  if (!lastResult) { location.hash = '#home'; return; }
  const r = lastResult;
  const perfect = r.correct === r.total;

  const wrongList = r.wrongQuestions.map(q =>
    `<div>${q.no}. ${questionHTML(q)} → <span class="ans">${esc(q.answer)}</span></div>`).join('');

  app.innerHTML = `
    ${header('けっか', null)}
    <div class="screen">
      <div class="card result-score">
        <div class="big">${r.correct} / ${r.total}</div>
        <p>${perfect ? '🎉 ぜんぶ正解!すごい!' : 'おつかれさま!'}</p>
      </div>
      ${r.wrongIds.length > 0 ? `
        <div class="card">
          <p class="muted" style="margin-bottom:6px">まちがえた問題</p>
          <div class="wrong-list">${wrongList}</div>
        </div>
        <button class="btn ng-btn" id="retry-wrong">✍ まちがいをもう一度</button>` : ''}
      <button class="btn secondary" id="back-set">この問題セットへ</button>
      <button class="btn ghost" onclick="location.hash='#home'">ホームへ</button>
    </div>`;

  const retry = document.getElementById('retry-wrong');
  if (retry) retry.onclick = () => {
    saveSession({ setId: r.setId, qids: r.wrongIds, idx: 0, results: {}, mode: 'wrong', startedAt: Date.now() });
    location.hash = '#practice';
  };
  document.getElementById('back-set').onclick = () => {
    location.hash = '#set/' + encodeURIComponent(r.setId);
  };
}

// ===== 設定(F-13 APIキー / F-15 バックアップ) =====
async function renderSettings() {
  app.innerHTML = `
    ${header('設定', '#home')}
    <div class="screen">
      <div class="card">
        <label class="field">Anthropic APIキー(写真の自動読み取りに使用)</label>
        <input type="password" id="api-key" value="${esc(getApiKey())}" placeholder="sk-ant-...">
        <p class="muted" style="margin-top:6px">キーはこの端末の中にだけ保存されます。キーがなくても、貼り付け取り込み・手入力・練習は全部使えます。</p>
        <div class="row" style="margin-top:8px">
          <button class="btn small" id="save-key">保存</button>
          <button class="btn small ghost" id="clear-key">削除</button>
        </div>
        <p class="muted" id="key-status"></p>
      </div>
      <div class="card">
        <p style="margin-bottom:8px"><b>バックアップ</b></p>
        <p class="muted">問題と成績をファイルに保存/復元します。機種変更やデータ消去に備えて、ときどき保存しておくと安心です。</p>
        <div class="row" style="margin-top:8px">
          <button class="btn small secondary" id="export-btn">書き出す</button>
          <label class="btn small secondary" for="import-file" style="text-align:center">読み込む</label>
          <input type="file" id="import-file" accept=".json,application/json" style="display:none">
        </div>
        <p class="muted" id="backup-status"></p>
      </div>
    </div>`;

  const keyStatus = document.getElementById('key-status');
  document.getElementById('save-key').onclick = () => {
    setApiKey(document.getElementById('api-key').value.trim());
    keyStatus.textContent = '保存しました。';
  };
  document.getElementById('clear-key').onclick = () => {
    setApiKey('');
    document.getElementById('api-key').value = '';
    keyStatus.textContent = '削除しました。';
  };

  const backupStatus = document.getElementById('backup-status');
  document.getElementById('export-btn').onclick = async () => {
    const sets = await getAllSets();
    const blob = new Blob([JSON.stringify({ app: 'kanji-practice', version: 1, exportedAt: new Date().toISOString(), sets }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kanji-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    backupStatus.textContent = `${sets.length}セットを書き出しました。`;
  };
  document.getElementById('import-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const sets = Array.isArray(data) ? data : data.sets;
      if (!Array.isArray(sets)) throw new Error('形式が違います');
      let count = 0;
      for (const s of sets) {
        if (!s || !Array.isArray(s.questions)) continue;
        if (!s.id) s.id = uid();
        await putSet(s);
        count++;
      }
      backupStatus.textContent = `${count}セットを読み込みました。`;
    } catch (err) {
      backupStatus.textContent = '読み込みに失敗しました: ' + err.message;
    }
    e.target.value = '';
  };
}

// ===== 起動 =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* オフライン対応なしで続行 */ });
}
route();
