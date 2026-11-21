import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { supabase } from './supabase.js';
import { loginWithGoogle, loginWithPassword, logout } from './auth.js';
import { local } from './store.js';
import * as api from './api.js';
import { normalizeIsbn } from './isbn.js';

const $ = (s, r = document) => r.querySelector(s);
const app = $('#app');
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
const sheetTitle = $('#sheet-title');
const toastEl = $('#toast');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  user: null,
  books: [],
  loans: [],
  loansReady: false,
  loading: true,
  loadError: '',
  view: 'shelf',
  query: '',
  filter: 'all',
  sort: 'new',
  mineTab: 'books',
  sheetKind: '',
  sheetId: 0,
  confirmDelete: 0,
  add: null,
  scan: null,
  busy: false,
};

const FILTERS = [
  ['all', '전체'],
  ['open', '빌릴 수 있는 책'],
  ['loan', '대출 중'],
  ['mine', '내 책'],
];

/* ────────────────────────────── 작은 도구 ────────────────────────────── */

function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast ${kind}`;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

const fmtDate = (v) => {
  if (!v) return '';
  const d = String(v).slice(0, 10).split('-');
  return d.length === 3 ? `${Number(d[0])}.${Number(d[1])}.${Number(d[2])}` : String(v);
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const plusDaysISO = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function coverMarkup(book, cls = '') {
  const url = api.coverUrl(book?.cover_url);
  const title = esc(book?.title || '제목 없음');
  const ph = `<div class="cover-ph"><span class="ph-title">${title}</span><span class="ph-mark">친구공책</span></div>`;
  return `<div class="cover ${cls}">${url ? `<img src="${esc(url)}" alt="${title} 표지" loading="lazy" referrerpolicy="no-referrer">${ph}` : ph}</div>`;
}

function stateChip(book, uid) {
  const mine = uid && book.owner === uid;
  if (book.share_state === 'closed') return '<span class="state-chip closed">비공개</span>';
  if (book.loan_state === 'borrowed') return `<span class="state-chip borrowed">대출 중${book.loan_due ? ` · ${esc(fmtDate(book.loan_due))} 반납` : ''}</span>`;
  if (book.loan_state === 'requested') return '<span class="state-chip requested">신청 있음</span>';
  return `<span class="state-chip open">${mine ? '대여 가능 · 내 책' : '대여 가능'}</span>`;
}

function ownerLabel(book, uid) {
  const name = book.owner_name || '이름 없는 친구';
  return uid && book.owner === uid ? `${esc(name)} (나)` : esc(name);
}

/* ────────────────────────────── 데이터 ────────────────────────────── */

async function loadAll() {
  try {
    S.loadError = '';
    const [books, loans] = await Promise.all([
      api.fetchBooks(),
      S.user ? api.fetchLoans(S.user.id) : Promise.resolve([]),
    ]);
    S.books = books;
    S.loans = loans;
    S.loansReady = Boolean(S.user);
  } catch (e) {
    S.loadError = e.message || '책장을 불러오지 못했습니다.';
  } finally {
    S.loading = false;
  }
  updateHeader();
  renderMain();
  if (S.sheetKind === 'book') renderBookSheet();
}

function pendingRequests() {
  if (!S.user) return [];
  return S.loans.filter((l) => l.owner === S.user.id && l.status === 'requested');
}
function myLoanFor(bookId) {
  if (!S.user) return null;
  return S.loans.find((l) => l.book_id === bookId && l.borrower === S.user.id && (l.status === 'requested' || l.status === 'borrowed')) ?? null;
}

/* ────────────────────────────── 머리 · 화면 ────────────────────────────── */

function updateHeader() {
  const pending = pendingRequests().length;
  const badge = $('#nav-badge');
  badge.hidden = pending === 0;
  badge.textContent = String(pending);

  const name = S.user ? api.displayName(S.user) : '로그인';
  $('#user-name').textContent = name;
  $('#btn-user').setAttribute('aria-label', S.user ? `${name} 계정` : '로그인');
  const dot = $('#btn-user .user-dot');
  dot.textContent = S.user ? (api.displayName(S.user)[0] || '나') : '?';
  dot.classList.toggle('on', Boolean(S.user));

  for (const a of document.querySelectorAll('[data-nav]')) {
    const on = (a.dataset.nav === 'shelf' && S.view === 'shelf') || (a.dataset.nav === 'mine' && S.view === 'mine');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function renderMain() {
  if (S.loading) { app.innerHTML = '<div class="boot">책장을 펼치는 중…</div>'; return; }
  if (S.loadError) {
    app.innerHTML = `<div class="wrap"><div class="empty"><span class="empty-art">⚠️</span><b>책장을 불러오지 못했습니다</b><p>${esc(S.loadError)}</p><button class="btn primary" data-act="retry">다시 불러오기</button></div></div>`;
    return;
  }
  if (S.view === 'mine') renderMine(); else renderShelf();
  updateHeader();
}

function visibleBooks() {
  const q = S.query.trim().toLowerCase();
  let list = S.books.slice();
  if (S.filter === 'open') list = list.filter((b) => b.share_state === 'open' && b.loan_state !== 'borrowed');
  if (S.filter === 'loan') list = list.filter((b) => b.loan_state === 'borrowed');
  if (S.filter === 'mine') list = list.filter((b) => S.user && b.owner === S.user.id);
  if (q) {
    list = list.filter((b) => [b.title, b.authors, b.publisher, b.note, b.owner_name, b.isbn13].join(' ').toLowerCase().includes(q));
  }
  if (S.sort === 'title') list.sort((a, b) => String(a.title).localeCompare(String(b.title), 'ko'));
  return list;
}

function renderShelf() {
  const total = S.books.length;
  const open = S.books.filter((b) => b.share_state === 'open' && b.loan_state !== 'borrowed').length;
  const loaned = S.books.filter((b) => b.loan_state === 'borrowed').length;
  const owners = new Set(S.books.map((b) => b.owner)).size;

  app.innerHTML = `
  <div class="wrap">
    <section class="hero">
      <div class="hero-copy">
        <span class="kicker">GOODWAY APPS · 친구들 책장</span>
        <h1>바코드로 올리고,<br><em>서로 빌려 읽는</em> 책장</h1>
        <p class="hero-lede">책 뒷면 ISBN 바코드를 찍으면 표지·제목·저자가 저절로 채워집니다. 올린 책은 친구들이 빌려 갈 수 있고, 빌린 책은 주인이 반납을 확인하면 다시 책장으로 돌아옵니다.</p>
        <ul class="hero-stats">
          <li><b>${total}</b>권</li>
          <li><b>${open}</b>빌릴 수 있음</li>
          <li><b>${loaned}</b>대출 중</li>
          <li><b>${owners}</b>명의 책장</li>
        </ul>
      </div>
      <div class="hero-art" aria-hidden="true">${heroArt()}</div>
    </section>

    ${S.user ? '' : `<div class="notice-strip"><span class="dot"></span>책장 구경은 누구나! 책을 올리거나 대출을 신청하려면 로그인해 주세요.<button class="btn small info" data-act="login">로그인</button></div>`}

    <div class="toolbar">
      <div class="search">
        <input type="search" id="q" value="${esc(S.query)}" placeholder="제목·저자·주인으로 찾기" aria-label="책 찾기" autocomplete="off">
        ${S.query ? '<button class="search-x" data-act="clear-q" aria-label="검색어 지우기">✕</button>' : ''}
      </div>
      <div class="chips" id="chips">${chipsMarkup()}</div>
      <button class="chip small" data-act="sort">${S.sort === 'new' ? '최신순' : '제목순'}</button>
    </div>
    <p class="count-note" id="shelf-count">${countNote()}</p>
    <div class="shelf-grid" id="shelf-grid">${gridMarkup()}</div>
  </div>`;
}

function chipsMarkup() {
  return FILTERS.map(([v, label]) =>
    `<button class="chip" data-act="filter" data-v="${v}" aria-pressed="${S.filter === v}">${label}</button>`).join('');
}

function countNote() {
  const list = visibleBooks();
  const who = S.filter === 'mine' ? '내가 올린 책 ' : '';
  return `${who}${list.length}권${S.query ? ` · “${esc(S.query)}” 검색` : ''}`;
}

function gridMarkup() {
  const list = visibleBooks();
  if (!list.length) {
    return `<div class="empty span-all">
      <span class="empty-art">📚</span>
      <b>${S.query || S.filter !== 'all' ? '조건에 맞는 책이 없어요' : '아직 책장이 비어 있어요'}</b>
      <p>${S.query || S.filter !== 'all' ? '검색어나 조건을 바꿔 보세요.' : '첫 번째 책을 올려 주세요. 책 뒷면 바코드를 찍으면 1분이면 끝납니다.'}</p>
      <button class="btn primary" data-act="add">＋ 책 등록</button>
    </div>`;
  }
  return list.map((b) => {
    const tag = b.loan_state === 'borrowed' ? '<span class="cover-tag borrowed">대출 중</span>'
      : b.share_state === 'closed' ? '<span class="cover-tag closed">비공개</span>'
      : b.loan_state === 'requested' ? '<span class="cover-tag requested">신청 있음</span>'
      : '<span class="cover-tag">대여 가능</span>';
    return `
    <button class="book-card" data-act="book" data-id="${b.id}" aria-label="${esc(b.title)} 자세히 보기">
      <div class="rel">
        ${coverMarkup(b)}
        ${tag}
      </div>
      <div class="book-body">
        <span class="book-title">${esc(b.title)}</span>
        <span class="book-sub">${esc(b.authors || '저자 미상')}${b.publisher ? ` · ${esc(b.publisher)}` : ''}</span>
        ${b.note ? `<span class="book-note">“${esc(b.note)}”</span>` : ''}
        <span class="book-owner"><span>${ownerLabel(b, S.user?.id)}</span>${b.loan_state === 'borrowed' && b.loan_borrower ? `<span>${esc(b.loan_borrower)} 읽는 중</span>` : ''}</span>
      </div>
    </button>`;
  }).join('');
}

function renderGrid() {
  const g = $('#shelf-grid');
  if (g) g.innerHTML = gridMarkup();
  const c = $('#shelf-count');
  if (c) c.textContent = countNote();
}

function heroArt() {
  return `<svg viewBox="0 0 300 220" preserveAspectRatio="xMidYMax slice" role="img" aria-label="책장에 꽂힌 책들">
    <rect width="300" height="220" fill="#0abbee"/>
    <g stroke="#10131a" stroke-width="2">
      <rect x="18" y="132" width="34" height="70" fill="#ffd400"/>
      <rect x="52" y="120" width="26" height="82" fill="#fffdf6"/>
      <rect x="78" y="140" width="30" height="62" fill="#ff614a"/>
      <rect x="108" y="112" width="24" height="90" fill="#02c245"/>
      <path d="M132 128 l26 0 l14 74 l-26 0 z" fill="#7e65c1"/>
      <rect x="172" y="136" width="32" height="66" fill="#fffdf6"/>
      <rect x="204" y="118" width="22" height="84" fill="#ff8a3d"/>
      <rect x="226" y="142" width="34" height="60" fill="#ffd400"/>
      <rect x="260" y="126" width="22" height="76" fill="#fffdf6"/>
    </g>
    <g fill="#10131a">
      <rect x="0" y="202" width="300" height="6"/>
      <rect x="0" y="208" width="300" height="12" fill="#10131a" opacity="0.15"/>
    </g>
    <g stroke="#10131a" stroke-width="2" fill="none" opacity="0.9">
      <path d="M24 96 h40 M24 96 v-10 M64 96 v-10" />
    </g>
    <g fill="#10131a" font-family="sans-serif" font-size="10" font-weight="700">
      <text x="24" y="88">ISBN</text>
    </g>
    <g stroke="#10131a" stroke-width="2">
      <rect x="96" y="40" width="120" height="34" fill="#fffdf6"/>
      <path d="M106 50 v14 M112 50 v14 M118 50 v14 M126 50 v14 M132 50 v14 M140 50 v14 M146 50 v14 M154 50 v14 M162 50 v14 M170 50 v14 M178 50 v14 M186 50 v14 M194 50 v14 M202 50 v14" />
    </g>
    <circle cx="248" cy="52" r="16" fill="#ffd400" stroke="#10131a" stroke-width="2"/>
    <path d="M241 52 l5 6 l10 -12" stroke="#10131a" stroke-width="2.5" fill="none"/>
  </svg>`;
}

/* ────────────────────────────── 내 서재 ────────────────────────────── */

function renderMine() {
  if (!S.user) {
    app.innerHTML = `<div class="wrap"><div class="empty"><span class="empty-art">🔑</span><b>내 서재는 로그인하면 열립니다</b><p>구글 계정으로 3초 만에 시작할 수 있어요. 내가 올린 책, 빌린 책, 들어온 대출 신청을 한곳에서 봅니다.</p><button class="btn primary" data-act="login">구글로 로그인</button></div></div>`;
    return;
  }
  const uid = S.user.id;
  const myBooks = S.books.filter((b) => b.owner === uid);
  const borrowed = S.loans.filter((l) => l.borrower === uid && l.status !== 'declined' && l.status !== 'canceled');
  const incoming = S.loans.filter((l) => l.owner === uid && (l.status === 'requested' || l.status === 'borrowed'));
  const pending = incoming.filter((l) => l.status === 'requested').length;

  app.innerHTML = `
  <div class="wrap">
    <div class="toolbar page-top">
      <h1 class="flex1">내 서재</h1>
      <button class="btn primary" data-act="add">＋ 책 등록</button>
    </div>
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" data-act="mine-tab" data-v="books" aria-selected="${S.mineTab === 'books'}">내가 올린 책 <span class="n">${myBooks.length}</span></button>
      <button class="tab" role="tab" data-act="mine-tab" data-v="borrowed" aria-selected="${S.mineTab === 'borrowed'}">빌린 책 <span class="n">${borrowed.length}</span></button>
      <button class="tab" role="tab" data-act="mine-tab" data-v="requests" aria-selected="${S.mineTab === 'requests'}">받은 신청 ${pending ? `<span class="n">${pending}</span>` : `<span class="n zero">0</span>`}</button>
    </div>
    <div id="mine-body">${mineBody()}</div>
  </div>`;
}

function mineBody() {
  const uid = S.user.id;
  if (S.mineTab === 'books') {
    const list = S.books.filter((b) => b.owner === uid);
    if (!list.length) {
      return `<div class="empty"><span class="empty-art">📗</span><b>아직 올린 책이 없어요</b><p>바코드를 찍어 첫 책을 올려 보세요. 친구들이 빌려 갈 수 있습니다.</p><button class="btn primary" data-act="add">＋ 책 등록</button></div>`;
    }
    return `<div class="rows">${list.map((b) => `
      <div class="row-card">
        <div class="row-cover">${bookThumb(b)}</div>
        <div class="row-main">
          <span class="row-title">${esc(b.title)}</span>
          <span class="row-sub">${esc(b.authors || '저자 미상')}</span>
          <span class="status-line">${stateChip(b, uid)} ${b.loan_state === 'borrowed' && b.loan_borrower ? `${esc(b.loan_borrower)} 님이 읽는 중` : ''}</span>
          <div class="row-actions">
            <button class="btn small" data-act="book" data-id="${b.id}">자세히</button>
            <button class="btn small ghost" data-act="toggle-state" data-id="${b.id}" data-v="${b.share_state === 'open' ? 'closed' : 'open'}">${b.share_state === 'open' ? '비공개로' : '대여 가능으로'}</button>
            <button class="btn small ghost" data-act="edit-book" data-id="${b.id}">수정</button>
          </div>
        </div>
      </div>`).join('')}</div>`;
  }

  if (S.mineTab === 'borrowed') {
    if (!S.loansReady) return '<div class="empty"><span class="empty-art">⏳</span><b>대출 정보를 불러오는 중…</b></div>';
    const list = S.loans.filter((l) => l.borrower === uid && l.status !== 'declined' && l.status !== 'canceled');
    if (!list.length) {
      return `<div class="empty"><span class="empty-art">🔖</span><b>빌린 책이 없어요</b><p>모두의 책장에서 ‘대여 가능’한 책을 골라 대출을 신청해 보세요.</p><button class="btn" data-act="go-shelf">모두의 책장 열기</button></div>`;
    }
    return `<div class="rows">${list.map((l) => `
      <div class="row-card">
        <div class="row-cover">${l.book ? bookThumb(l.book) : ''}</div>
        <div class="row-main">
          <span class="row-title">${esc(l.book?.title || '삭제된 책')}</span>
          <span class="row-sub">${esc(l.book?.authors || '')}${l.book?.owner_name ? ` · ${esc(l.book.owner_name)} 님 책` : ''}</span>
          <span class="status-line">${loanChip(l.status)}${l.due_date ? ` · ${esc(fmtDate(l.due_date))}까지` : ''}</span>
          <div class="row-actions">
            ${l.status === 'requested' ? `<button class="btn small danger" data-act="loan-cancel" data-id="${l.id}">신청 취소</button>` : ''}
            ${l.book ? `<button class="btn small" data-act="book" data-id="${l.book.id}">책 보기</button>` : ''}
          </div>
        </div>
      </div>`).join('')}</div>`;
  }

  if (!S.loansReady) return '<div class="empty"><span class="empty-art">⏳</span><b>대출 정보를 불러오는 중…</b></div>';
  const incoming = S.loans.filter((l) => l.owner === uid && (l.status === 'requested' || l.status === 'borrowed'));
  if (!incoming.length) {
    return `<div class="empty"><span class="empty-art">📨</span><b>받은 신청이 없어요</b><p>친구가 내 책을 신청하면 여기에서 승인하거나 거절할 수 있습니다.</p><button class="btn" data-act="go-shelf">모두의 책장 열기</button></div>`;
  }
  return `<div class="rows">${incoming.map((l) => `
    <div class="row-card">
      <div class="row-cover">${l.book ? bookThumb(l.book) : ''}</div>
      <div class="row-main">
        <span class="row-title">${esc(l.book?.title || '책')}</span>
        <span class="row-sub"><b>${esc(l.borrower_name || '친구')}</b> 님의 ${l.status === 'requested' ? '대출 신청' : '대출'}${l.due_date ? ` · ${esc(fmtDate(l.due_date))}까지` : ''}</span>
        ${l.message ? `<span class="row-msg">${esc(l.message)}</span>` : ''}
        <div class="row-actions">
          ${l.status === 'requested' ? `
            <button class="btn small go" data-act="loan-approve" data-id="${l.id}">승인</button>
            <button class="btn small danger" data-act="loan-decline" data-id="${l.id}">거절</button>` : `
            <button class="btn small go" data-act="loan-return" data-id="${l.id}">반납 확인</button>`}
        </div>
      </div>
    </div>`).join('')}</div>`;
}

function loanChip(status) {
  const map = {
    requested: ['requested', '승인 기다리는 중'],
    borrowed: ['borrowed', '읽는 중'],
    returned: ['open', '반납 완료'],
    declined: ['closed', '거절됨'],
    canceled: ['closed', '취소함'],
  };
  const [cls, label] = map[status] ?? ['closed', status];
  return `<span class="state-chip ${cls}">${label}</span>`;
}

function bookThumb(b) {
  const url = api.coverUrl(b.cover_url);
  return url
    ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="ph">${esc(String(b.title).slice(0, 12))}</div>`;
}

/* ────────────────────────────── 시트 ────────────────────────────── */

function openSheet(title, html, kind = '') {
  sheetTitle.textContent = title;
  sheetBody.innerHTML = html;
  sheet.hidden = false;
  sheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('sheet-open');
  S.sheetKind = kind;
  setTimeout(() => {
    // 사용자가 이미 어딘가를 짚고 있으면 포커스를 빼앗지 않습니다
    if (sheetBody.contains(document.activeElement)) return;
    sheetBody.querySelector('input,button,select,textarea')?.focus();
  }, 60);
}

function closeSheet() {
  stopScan();
  sheet.hidden = true;
  sheet.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('sheet-open');
  sheetBody.innerHTML = '';
  S.sheetKind = '';
  S.confirmDelete = 0;
  S.add = null;
}

/* ── 로그인 ── */
function openLogin() {
  openSheet('로그인', `
    <div class="login-box">
      <p class="login-note">친구공책은 GOODWAY APPS 공용 계정을 씁니다. 구글 계정으로 바로 시작하세요.</p>
      <button class="btn primary big block" data-act="login-google">구글로 계속하기</button>
      <div class="divider">또는</div>
      <details class="email-login">
        <summary>이메일로 로그인</summary>
        <form data-form="login-email" class="pt">
          <div class="field"><label for="lg-email">이메일</label><input id="lg-email" type="email" required autocomplete="username" placeholder="you@example.com"></div>
          <div class="field"><label for="lg-pw">비밀번호</label><input id="lg-pw" type="password" required autocomplete="current-password" minlength="6"></div>
          <button class="btn info block" type="submit">로그인</button>
        </form>
      </details>
      <p class="login-note">책장 구경은 로그인 없이도 됩니다. 책 등록·대출 신청·관리만 로그인이 필요해요.</p>
    </div>`, 'login');
}

/* ── 책 상세 ── */
function findBook(id) { return S.books.find((b) => Number(b.id) === Number(id)) ?? null; }

function openBook(id) {
  S.sheetId = Number(id);
  S.confirmDelete = 0;
  if (S.sheetKind !== 'book') {
    sheet.hidden = false;
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    S.sheetKind = 'book';
  }
  renderBookSheet();
}

function renderBookSheet() {
  if (S.sheetKind !== 'book') return;
  const b = findBook(S.sheetId);
  if (!b) { closeSheet(); return; }
  const uid = S.user?.id ?? '';
  const mine = uid && b.owner === uid;
  const myLoan = myLoanFor(b.id);
  const incoming = S.loans.filter((l) => l.book_id === b.id && l.owner === uid && (l.status === 'requested' || l.status === 'borrowed'));

  sheetTitle.textContent = mine ? '내 책' : '책 자세히 보기';
  sheetBody.innerHTML = `
    <div class="detail">
      ${coverMarkup(b)}
      <div class="detail-info">
        <h3 class="detail-title">${esc(b.title)}</h3>
        <span class="detail-sub">${esc(b.authors || '저자 미상')}${b.publisher ? ` · ${esc(b.publisher)}` : ''}${b.published_date ? ` · ${esc(fmtDate(b.published_date))}` : ''}</span>
        <div class="detail-tags">${stateChip(b, uid)}${b.isbn13 ? `<span class="state-chip plain">ISBN ${esc(b.isbn13)}</span>` : ''}</div>
        ${b.note ? `<div class="note-box"><b>한줄 추천평</b>${esc(b.note)}</div>` : ''}
        ${b.description ? `<p class="detail-desc" id="desc">${esc(b.description)}</p><button data-act="desc-toggle" class="btn small ghost self-start">소개 더 보기</button>` : ''}
        <dl class="meta-list">
          <dt>올린 사람</dt><dd>${ownerLabel(b, uid)}</dd>
          ${b.loan_state !== 'none' ? `<dt>${b.loan_state === 'borrowed' ? '빌려 간 사람' : '신청한 사람'}</dt><dd>${esc(b.loan_borrower || '친구')}</dd>` : ''}
          ${b.loan_due ? `<dt>반납 예정</dt><dd>${esc(fmtDate(b.loan_due))}</dd>` : ''}
          <dt>올린 날</dt><dd>${esc(fmtDate(b.created_at))}</dd>
        </dl>
      </div>
    </div>

    <div class="detail-actions">
      ${bookActions(b, { mine, myLoan, uid })}
    </div>

    ${mine && incoming.length ? `
      <h3 class="req-head">들어온 신청 ${incoming.filter((l) => l.status === 'requested').length}건</h3>
      <div class="req-list">${incoming.map((l) => `
        <div class="req-card">
          <span><b>${esc(l.borrower_name || '친구')}</b> 님 · ${esc(fmtDate(l.requested_at))} 신청${l.due_date ? ` · ${esc(fmtDate(l.due_date))}까지` : ''}</span>
          ${l.message ? `<span class="row-msg">${esc(l.message)}</span>` : ''}
          <div class="row-actions">
            ${l.status === 'requested'
              ? `<button class="btn small go" data-act="loan-approve" data-id="${l.id}">승인</button><button class="btn small danger" data-act="loan-decline" data-id="${l.id}">거절</button>`
              : `<button class="btn small go" data-act="loan-return" data-id="${l.id}">반납 확인</button>`}
          </div>
        </div>`).join('')}</div>` : ''}
  `;
}

function bookActions(b, { mine, myLoan }) {
  if (!S.user) {
    return `<button class="btn primary" data-act="login">로그인하고 대출 신청</button>
            <span class="muted tiny self-center">책장 구경은 로그인 없이도 됩니다.</span>`;
  }
  if (mine) {
    const st = b.share_state === 'open' ? 'closed' : 'open';
    return `
      <button class="btn" data-act="toggle-state" data-id="${b.id}" data-v="${st}">${b.share_state === 'open' ? '비공개로 돌리기' : '대여 가능으로 열기'}</button>
      <button class="btn" data-act="edit-book" data-id="${b.id}">정보 수정</button>
      ${S.confirmDelete === b.id
        ? `<button class="btn danger" data-act="delete-book" data-id="${b.id}">정말 삭제할까요?</button><button class="btn ghost" data-act="cancel-delete">취소</button>`
        : `<button class="btn ghost" data-act="ask-delete" data-id="${b.id}">삭제</button>`}`;
  }
  if (myLoan) {
    return myLoan.status === 'requested'
      ? `<span class="state-chip requested">승인을 기다리는 중</span><button class="btn small danger" data-act="loan-cancel" data-id="${myLoan.id}">신청 취소</button>`
      : `<span class="state-chip borrowed">읽는 중${b.loan_due ? ` · ${esc(fmtDate(b.loan_due))}까지` : ''}</span>`;
  }
  if (b.share_state === 'closed') return `<span class="muted">주인이 비공개로 둔 책입니다.</span>`;
  if (b.loan_state === 'borrowed') return `<span class="state-chip borrowed">지금은 다른 친구가 읽고 있어요</span>`;
  return `<button class="btn primary big" data-act="request" data-id="${b.id}">대출 신청하기</button>`;
}

/* ── 대출 신청 ── */
function openRequest(id) {
  const b = findBook(id);
  if (!b) return;
  S.sheetId = Number(id);
  openSheet('대출 신청', `
    <div class="detail detail-mini">
      ${coverMarkup(b)}
      <div><b class="big-title">${esc(b.title)}</b><div class="detail-sub">${esc(b.authors || '')} · ${ownerLabel(b, S.user?.id)} 님 책</div></div>
    </div>
    <form data-form="request-loan">
      <div class="field">
        <label for="req-due">언제까지 읽을까요?</label>
        <input id="req-due" type="date" min="${todayISO()}" value="${plusDaysISO(14)}">
        <span class="hint">주인에게 보이는 희망 반납일입니다. 사정이 생기면 이야기로 조정하면 됩니다.</span>
      </div>
      <div class="field">
        <label for="req-msg">하고 싶은 말 (선택)</label>
        <textarea id="req-msg" maxlength="300" placeholder="예: 이번 주말에 읽고 다음 주에 돌려드릴게요!"></textarea>
      </div>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-act="close-sheet">닫기</button>
        <button type="submit" class="btn primary">신청 보내기</button>
      </div>
    </form>`, 'request');
}

/* ── 책 등록 ── */
function newAddState() {
  return {
    method: 'scan',          // scan | isbn | search | manual
    book: null,              // 찾은 책 정보
    form: null,              // 등록 폼 값
    results: [],
    status: '',              // 안내 문구
    busy: false,
  };
}

function openAdd() {
  if (!S.user) { openLogin(); toast('로그인하면 책을 올릴 수 있어요.'); return; }
  S.add = newAddState();
  renderAddSheet();
}

function renderAddSheet() {
  const a = S.add;
  if (!a) return;
  if (S.sheetKind !== 'add') {
    sheet.hidden = false;
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    S.sheetKind = 'add';
  }
  sheetTitle.textContent = a.form ? '책 등록' : '어떤 책을 올릴까요?';
  sheetBody.innerHTML = a.form ? addFormMarkup() : addFinderMarkup();
  if (a.method === 'scan' && !a.form) setTimeout(startCameraScan, 60);
}

function addFinderMarkup() {
  const a = S.add;
  const methods = [
    ['scan', '📷', '바코드 스캔', '책 뒷면 ISBN을 카메라로'],
    ['isbn', '🔢', 'ISBN 입력', '바코드 아래 숫자를 직접'],
    ['search', '🔎', '제목·저자 검색', '기억나는 대로 찾기'],
    ['manual', '✍️', '직접 입력', '책 정보를 손으로'],
  ];
  return `
    <div class="methods">
      ${methods.map(([v, ico, title, sub]) => `
        <button class="method" data-act="method" data-v="${v}" aria-pressed="${a.method === v}">
          <span class="m-ico" aria-hidden="true">${ico}</span>
          <span>${title}</span>
          <span class="m-sub">${sub}</span>
        </button>`).join('')}
    </div>
    ${a.method === 'scan' ? scanPanel() : ''}
    ${a.method === 'isbn' ? `
      <form data-form="isbn">
        <div class="field">
          <label for="isbn-in">ISBN (10자리 또는 13자리)</label>
          <input id="isbn-in" type="text" inputmode="numeric" autocomplete="off" placeholder="9788936434120" maxlength="17">
          <span class="hint">책 뒷면 바코드 아래에 978로 시작하는 13자리 숫자가 있습니다. 하이픈은 넣어도 됩니다.</span>
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">책 찾기</button></div>
      </form>` : ''}
    ${a.method === 'search' ? `
      <form data-form="search">
        <div class="field">
          <label for="book-q">책 제목이나 저자</label>
          <input id="book-q" type="search" autocomplete="off" placeholder="예: 소년이 온다, 한강">
        </div>
        <div class="form-actions"><button class="btn primary" type="submit">찾기</button></div>
      </form>
      ${a.results.length ? `<div class="rows mt">${a.results.map((r, i) => `
        <button class="row-card left" data-act="pick" data-i="${i}">
          <div class="row-cover">${bookThumb(r)}</div>
          <div class="row-main">
            <span class="row-title">${esc(r.title)}</span>
            <span class="row-sub">${esc(r.authors || '저자 미상')}${r.publisher ? ` · ${esc(r.publisher)}` : ''}</span>
            <span class="row-sub">${r.isbn13 ? `ISBN ${esc(r.isbn13)}` : 'ISBN 없음'}</span>
          </div>
        </button>`).join('')}</div>` : ''}
      ${a.status === 'noresult' ? '<p class="scan-help">찾는 책이 없습니다. ISBN으로 찾거나 직접 입력해 주세요.</p>' : ''}` : ''}
    ${a.method === 'manual' ? `<p class="scan-help">직접 입력으로 넘어갑니다.</p><div class="form-actions"><button class="btn primary" data-act="manual-form">책 정보 직접 입력</button></div>` : ''}
    ${a.busy ? '<p class="scan-help">찾는 중…</p>' : ''}
    ${a.status && a.status !== 'noresult' ? `<p class="scan-help">${esc(a.status)}</p>` : ''}
  `;
}

function scanPanel() {
  return `
    <div class="scan-box" id="scan-box">
      <div class="scan-idle" id="scan-idle">카메라를 켜는 중…</div>
      <video id="scan-video" playsinline muted hidden></video>
      <div class="scan-frame" id="scan-frame" hidden></div>
    </div>
    <p class="scan-help" id="scan-help">카메라가 안 되면 아래 ‘ISBN 입력’으로 바꿔 주세요. 숫자만 넣어도 책을 찾아 드립니다.</p>
    <div class="form-actions start">
      <button class="btn small" data-act="method" data-v="isbn">ISBN 직접 입력</button>
    </div>`;
}

async function startCameraScan() {
  const a = S.add;
  if (!a || a.form) return;
  const video = $('#scan-video');
  const idle = $('#scan-idle');
  const frame = $('#scan-frame');
  const help = $('#scan-help');
  if (!video) return;
  stopScan();
  // 스캐너 코드(약 400KB)는 스캔을 켤 때만 내려받습니다
  let startScanner;
  try { ({ startScanner } = await import('./scan.js')); }
  catch { if (idle) idle.textContent = '카메라 기능을 불러오지 못했습니다. ISBN을 직접 입력해 주세요.'; return; }
  const scanner = await startScanner({
    video,
    onCode: async (isbn) => {
      stopScan();
      if (help) help.textContent = `바코드를 읽었습니다 · ${isbn}`;
      await findByIsbn(isbn);
    },
    onError: (msg) => {
      if (idle) idle.textContent = msg;
      if (frame) frame.hidden = true;
    },
    onHint: (msg) => { if (help) help.textContent = msg; },
  });
  S.scan = scanner;
  video.hidden = false;
  if (idle) idle.hidden = true;
  if (frame) frame.hidden = false;
}

function stopScan() {
  try { S.scan?.stop(); } catch { /* 이미 멈춤 */ }
  S.scan = null;
}

async function findByIsbn(isbn) {
  const a = S.add;
  if (!a) return;
  const code = normalizeIsbn(isbn);
  if (!code) { a.status = 'ISBN은 13자리(978·979로 시작) 또는 10자리 숫자입니다.'; renderAddSheet(); return; }
  a.busy = true; a.status = '';
  renderAddSheet();
  try {
    const book = await api.lookupIsbn(code);
    if (book) { a.book = book; a.form = bookToForm(book); }
    else { a.status = '이 ISBN으로는 책을 찾지 못했습니다. 제목으로 찾거나 직접 입력해 주세요.'; a.method = 'search'; }
  } catch (e) {
    a.status = e.message;
  } finally {
    a.busy = false;
    renderAddSheet();
  }
}

function bookToForm(b) {
  return {
    title: b.title || '',
    authors: b.authors || '',
    publisher: b.publisher || '',
    published_date: b.published_date || '',
    isbn13: b.isbn13 || '',
    isbn10: b.isbn10 || '',
    cover_url: b.cover || '',
    description: b.description || '',
    note: '',
    share_state: 'open',
    bookUrl: b.url || '',
    source: b.source || '',
  };
}

function addFormMarkup() {
  const f = S.add.form;
  const preview = { title: f.title, cover_url: f.cover_url };
  return `
    <div class="detail detail-mini form-preview">
      ${coverMarkup(preview)}
      <div class="detail-info">
        <b class="big-title">${esc(f.title || '제목 없음')}</b>
        <span class="detail-sub">${esc(f.authors || '저자 미상')}${f.publisher ? ` · ${esc(f.publisher)}` : ''}</span>
        <span class="hint tiny">${f.source ? `책 정보: ${esc(sourceLabel(f.source))} · ` : ''}${f.isbn13 ? `ISBN ${esc(f.isbn13)}` : 'ISBN 없음'}</span>
        <button class="btn small ghost self-start mt-sm" data-act="restart-add">다른 책 찾기</button>
      </div>
    </div>
    <form data-form="add-book">
      <div class="form-grid">
        <div class="field full">
          <label for="f-title">제목 *</label>
          <input id="f-title" type="text" required maxlength="300" value="${esc(f.title)}" placeholder="책 제목">
        </div>
        <div class="field"><label for="f-authors">저자</label><input id="f-authors" type="text" maxlength="200" value="${esc(f.authors)}" placeholder="저자"></div>
        <div class="field"><label for="f-publisher">출판사</label><input id="f-publisher" type="text" maxlength="120" value="${esc(f.publisher)}" placeholder="출판사"></div>
        <div class="field"><label for="f-isbn">ISBN</label><input id="f-isbn" type="text" maxlength="17" value="${esc(f.isbn13 || f.isbn10)}" placeholder="9788936434120"></div>
        <div class="field"><label for="f-pubdate">출간일</label><input id="f-pubdate" type="text" maxlength="20" value="${esc(f.published_date)}" placeholder="2014-05-19"></div>
        <div class="field full">
          <label for="f-note">한줄 추천평</label>
          <input id="f-note" type="text" maxlength="200" value="${esc(f.note)}" placeholder="예: 이 문장 하나 때문에라도 꼭 읽어 보세요.">
          <span class="hint">친구들이 책장에서 이 한 줄을 먼저 봅니다.</span>
        </div>
        <div class="field full">
          <label for="f-cover">표지 주소 (선택)</label>
          <input id="f-cover" type="url" maxlength="600" value="${esc(f.cover_url)}" placeholder="https://…">
          <span class="hint">자동으로 채워집니다. 비워 두면 제목으로 표지를 그립니다.</span>
        </div>
        <div class="field full">
          <span class="field-label">책 상태</span>
          <div class="seg">
            <label><input type="radio" name="share" value="open" ${f.share_state === 'open' ? 'checked' : ''}><span>대여 가능</span></label>
            <label><input type="radio" name="share" value="closed" ${f.share_state === 'closed' ? 'checked' : ''}><span>비공개</span></label>
          </div>
          <span class="hint">비공개로 두면 나만 볼 수 있습니다. 나중에 언제든 바꿀 수 있어요.</span>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn ghost" data-act="close-sheet">취소</button>
        <button type="submit" class="btn primary big">책장에 올리기</button>
      </div>
    </form>`;
}

const sourceLabel = (s) => ({ kakao: '카카오 책 검색', google: '구글 북스', openlibrary: '오픈라이브러리' }[s] ?? s);

/* ────────────────────────────── 동작 ────────────────────────────── */

async function approveLoan(id) {
  if (S.busy) return; S.busy = true;
  try { await api.setLoanStatus(id, 'borrowed'); toast('대출을 승인했습니다.', 'good'); await loadAll(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { S.busy = false; }
}
async function declineLoan(id) {
  if (S.busy) return; S.busy = true;
  try { await api.setLoanStatus(id, 'declined'); toast('신청을 거절했습니다.'); await loadAll(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { S.busy = false; }
}
async function returnLoan(id) {
  if (S.busy) return; S.busy = true;
  try { await api.setLoanStatus(id, 'returned'); toast('반납을 확인했습니다. 책장에 다시 올렸습니다.', 'good'); await loadAll(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { S.busy = false; }
}
async function cancelLoan(id) {
  if (S.busy) return; S.busy = true;
  try { await api.setLoanStatus(id, 'canceled'); toast('신청을 취소했습니다.'); await loadAll(); }
  catch (e) { toast(e.message, 'bad'); }
  finally { S.busy = false; }
}

async function toggleState(id, next) {
  try {
    await api.updateBook(id, { share_state: next });
    toast(next === 'open' ? '대여 가능으로 바꿨습니다.' : '비공개로 돌렸습니다.', 'good');
    await loadAll();
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteBook(id) {
  try {
    await api.deleteBook(id);
    S.confirmDelete = 0;
    closeSheet();
    toast('책을 책장에서 내렸습니다.');
    await loadAll();
  } catch (e) { toast(e.message, 'bad'); }
}

function openEdit(id) {
  const b = findBook(id);
  if (!b) return;
  S.add = { ...newAddState(), form: { ...bookToForm({ ...b, cover: b.cover_url }), note: b.note || '', share_state: b.share_state, source: '' } , editing: id };
  S.add.form.title = b.title; S.add.form.authors = b.authors; S.add.form.publisher = b.publisher;
  S.add.form.published_date = b.published_date; S.add.form.cover_url = b.cover_url; S.add.form.note = b.note;
  S.add.form.isbn13 = b.isbn13; S.add.form.isbn10 = b.isbn10; S.add.form.bookUrl = '';
  renderAddSheet();
}

function onLoginGlobal() {
  openLogin();
}

function goShelf() {
  S.view = 'shelf';
  if (location.hash !== '#/' && location.hash !== '#') location.hash = '#/';
  else renderMain();
}

/* 이벤트: 클릭 한 곳에서 처리 */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const id = Number(t.dataset.id || 0);

  switch (act) {
    case 'login': onLoginGlobal(); break;
    case 'login-google': {
      const r = await loginWithGoogle();
      if (r?.error) toast(r.error.message, 'bad');
      break;
    }
    case 'logout': {
      await logout();
      closeSheet();
      S.view = 'shelf';
      if (location.hash && location.hash !== '#/' && location.hash !== '#') location.hash = '#/';
      toast('로그아웃했습니다.');
      await loadAll();
      break;
    }
    case 'add': openAdd(); break;
    case 'book': closeSheet(); openBook(id); break;
    case 'request': openRequest(id); break;
    case 'retry': S.loading = true; renderMain(); await loadAll(); break;
    case 'clear-q': S.query = ''; renderShelf(); break;
    case 'filter': S.filter = t.dataset.v; renderShelf(); break;
    case 'sort': S.sort = S.sort === 'new' ? 'title' : 'new'; renderShelf(); break;
    case 'mine-tab': S.mineTab = t.dataset.v; renderMine(); break;
    case 'go-shelf': goShelf(); break;
    case 'close-sheet': closeSheet(); break;
    case 'desc-toggle': {
      const d = $('#desc');
      if (d) { d.classList.toggle('open-desc'); t.textContent = d.classList.contains('open-desc') ? '소개 접기' : '소개 더 보기'; }
      break;
    }
    case 'ask-delete': S.confirmDelete = id; renderBookSheet(); break;
    case 'cancel-delete': S.confirmDelete = 0; renderBookSheet(); break;
    case 'delete-book': await deleteBook(id); break;
    case 'toggle-state': await toggleState(id, t.dataset.v); break;
    case 'edit-book': closeSheet(); openEdit(id); break;
    case 'loan-approve': await approveLoan(id); break;
    case 'loan-decline': await declineLoan(id); break;
    case 'loan-return': await returnLoan(id); break;
    case 'loan-cancel': await cancelLoan(id); break;
    case 'method': {
      S.add.method = t.dataset.v;
      if (t.dataset.v === 'manual') { S.add.form = bookToForm({}); }
      renderAddSheet();
      break;
    }
    case 'manual-form': S.add.form = bookToForm({}); renderAddSheet(); break;
    case 'restart-add': S.add = { ...newAddState(), method: 'isbn' }; renderAddSheet(); break;
    case 'pick': {
      const r = S.add.results[Number(t.dataset.i)];
      if (r) { S.add.book = r; S.add.form = bookToForm(r); renderAddSheet(); }
      break;
    }
    default: break;
  }
});

/* 이벤트: 폼 제출 */
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;

  if (kind === 'login-email') {
    const email = $('#lg-email').value.trim();
    const pw = $('#lg-pw').value;
    const { error } = await loginWithPassword(email, pw);
    if (error) toast(error.message === 'Invalid login credentials' ? '이메일이나 비밀번호가 맞지 않습니다.' : error.message, 'bad');
    else { closeSheet(); toast('로그인했습니다.', 'good'); }
    return;
  }

  if (kind === 'isbn') {
    const v = $('#isbn-in').value;
    await findByIsbn(v);
    return;
  }

  if (kind === 'search') {
    const term = $('#book-q').value.trim();
    if (!term) return;
    S.add.busy = true; S.add.status = ''; renderAddSheet();
    try {
      const res = await api.searchBooks(term);
      S.add.results = res;
      S.add.status = res.length ? '' : 'noresult';
    } catch (err) { S.add.status = err.message; }
    finally { S.add.busy = false; renderAddSheet(); }
    return;
  }

  if (kind === 'request-loan') {
    const due = $('#req-due').value;
    const msg = $('#req-msg').value.trim();
    try {
      await api.requestLoan({ bookId: S.sheetId, dueDate: due, message: msg, name: api.displayName(S.user) });
      closeSheet();
      toast('대출을 신청했습니다. 주인 승인을 기다려 주세요.', 'good');
      await loadAll();
    } catch (err) { toast(err.message, 'bad'); }
    return;
  }

  if (kind === 'add-book') {
    const f = {
      title: $('#f-title').value.trim(),
      authors: $('#f-authors').value.trim(),
      publisher: $('#f-publisher').value.trim(),
      isbn: $('#f-isbn').value.trim(),
      published_date: $('#f-pubdate').value.trim(),
      note: $('#f-note').value.trim(),
      cover_url: $('#f-cover').value.trim(),
      description: S.add.form.description || '',
    };
    const share = form.querySelector('input[name="share"]:checked')?.value ?? 'open';
    if (!f.title) { toast('책 제목을 넣어 주세요.', 'bad'); return; }
    const isbnClean = f.isbn.replace(/[^0-9Xx]/g, '').toUpperCase();
    const payload = {
      title: f.title.slice(0, 300),
      authors: f.authors.slice(0, 200),
      publisher: f.publisher.slice(0, 120),
      published_date: f.published_date.slice(0, 20),
      isbn13: isbnClean.length === 13 ? isbnClean : '',
      isbn10: isbnClean.length === 10 ? isbnClean : '',
      cover_url: f.cover_url.slice(0, 600),
      description: String(f.description || '').slice(0, 800),
      note: f.note.slice(0, 200),
      share_state: share,
      owner_name: api.displayName(S.user),
    };
    try {
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = true; button.textContent = '올리는 중…'; }
      if (S.add.editing) {
        await api.updateBook(S.add.editing, {
          title: payload.title, authors: payload.authors, publisher: payload.publisher,
          published_date: payload.published_date, isbn13: payload.isbn13, isbn10: payload.isbn10,
          cover_url: payload.cover_url, note: payload.note, share_state: payload.share_state,
        });
        toast('책 정보를 고쳤습니다.', 'good');
      } else {
        await api.addBook(payload);
        toast('책장에 올렸습니다!', 'good');
      }
      closeSheet();
      await loadAll();
    } catch (err) {
      toast(err.message, 'bad');
      const button = form.querySelector('button[type="submit"]');
      if (button) { button.disabled = false; button.textContent = S.add?.editing ? '수정 저장' : '책장에 올리기'; }
    }
  }
});

/* 검색 입력 — 목록만 다시 그려 입력 포커스를 유지 */
document.addEventListener('input', (e) => {
  if (e.target.id === 'q') {
    S.query = e.target.value;
    renderGrid();
    const x = document.querySelector('.search-x');
    if (S.query && !x) {
      const host = document.querySelector('.search');
      if (host) host.insertAdjacentHTML('beforeend', '<button class="search-x" data-act="clear-q" aria-label="검색어 지우기">✕</button>');
    } else if (!S.query && x) x.remove();
  }
});

document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.closest('.cover, .row-cover')) t.remove();
}, true);

sheet.addEventListener('click', (e) => { if (e.target.matches('[data-close]')) closeSheet(); });
$('#sheet-close').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

/* ── 낮/밤 ── */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const night = theme === 'night';
  const btn = $('#btn-theme');
  btn.setAttribute('aria-pressed', String(night));
  btn.setAttribute('aria-label', night ? '낮 화면으로 바꾸기' : '밤 화면으로 바꾸기');
  $('#theme-icon').textContent = night ? '☀' : '☾';
  document.querySelector('meta[name="theme-color"]').setAttribute('content', night ? '#12141a' : '#f7f4ec');
}
$('#btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'night' ? 'day' : 'night';
  applyTheme(next);
  local.set('theme', next);
});

/* ── 로그인 상태 ── */
function bindAuth() {
  supabase.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    const changed = (S.user?.id ?? '') !== (user?.id ?? '');
    S.user = user;
    if (changed) {
      if (user) closeSheetIfLogin();
      // 로그인 처리 중에 바로 조회하면 supabase-js 잠금과 겹칠 수 있어 한 박자 뒤에 부릅니다
      setTimeout(() => loadAll(), 0);
    }
    updateHeader();
  });
}
function closeSheetIfLogin() {
  if (S.sheetKind === 'login') closeSheet();
}

document.addEventListener('click', (e) => {
  const navLink = e.target.closest('a[data-nav]');
  if (navLink) {
    // 지금 주소와 같은 링크를 눌러도 화면이 따라오도록 hashchange 를 기다리지 않고 직접 그립니다
    e.preventDefault();
    const href = navLink.getAttribute('href') || '#/';
    if (location.hash === href) route(); else location.hash = href;
    return;
  }
  if (e.target.closest('#btn-add')) { e.preventDefault(); openAdd(); }
  if (e.target.closest('#btn-user')) {
    e.preventDefault();
    if (S.user) openSheet('내 계정', `
      <div class="login-box">
        <p><b>${esc(api.displayName(S.user))}</b><br><span class="muted">${esc(S.user.email || '')}</span></p>
        <p class="login-note">책장 구경은 로그인 없이도 됩니다. 로그아웃해도 올린 책은 그대로 남습니다.</p>
        <button class="btn danger block" data-act="logout">로그아웃</button>
      </div>`, 'account');
    else openLogin();
  }
});

/* ── 첫 화면 ── */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  S.view = h.startsWith('mine') ? 'mine' : 'shelf';
  renderMain();
}

applyTheme(local.get('theme', 'day') === 'night' ? 'night' : 'day');
window.addEventListener('hashchange', route);
bindAuth();
route();
loadAll();
