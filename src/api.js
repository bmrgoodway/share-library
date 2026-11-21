// 친구공책 데이터층 — 화면(src/main.js)은 여기 함수만 부르면 됩니다.
// 읽기는 supabase-js(RLS 가 지켜 줌), 책 정보 조회는 서버 함수(카카오 키는 서버에만)를 씁니다.
import { supabase, FN_URL } from './supabase.js';

export const BOOK_COLUMNS =
  'id,owner,owner_name,isbn13,isbn10,title,authors,publisher,published_date,cover_url,description,note,share_state,loan_state,current_loan_id,loan_borrower,loan_due,created_at,updated_at';

/** 표지 그림 주소 — 서버 함수가 대신 받아 와서 핫링크·혼합 콘텐츠 문제를 피합니다 */
export function coverUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return '';
  if (u.startsWith(`${FN_URL}/cover`)) return u;
  return `${FN_URL}/cover?u=${encodeURIComponent(u)}`;
}

async function callFn(path) {
  const r = await fetch(`${FN_URL}${path}`, { headers: { Accept: 'application/json' } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `책 정보를 가져오지 못했습니다 (${r.status})`);
  return body;
}

/** ISBN → 책 정보. 없으면 null */
export async function lookupIsbn(isbn) {
  try {
    const { book } = await callFn(`/book?isbn=${encodeURIComponent(isbn)}`);
    return book ?? null;
  } catch (e) {
    if (String(e.message).includes('찾지 못했')) return null;
    throw e;
  }
}

/** 제목·저자로 찾기 */
export async function searchBooks(term) {
  const { books } = await callFn(`/search?q=${encodeURIComponent(term)}&size=12`);
  return Array.isArray(books) ? books : [];
}

/** 모두의 책장 — 내가 볼 수 있는 책 전부 (비공개는 주인에게만, RLS) */
export async function fetchBooks() {
  const { data, error } = await supabase
    .from('books')
    .select(BOOK_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(readable(error));
  return data ?? [];
}

/** 내 대출(빌린 것 + 내 책에 들어온 신청) — 책 정보를 붙여 돌려준다 */
export async function fetchLoans(uid) {
  if (!uid) return [];
  const { data, error } = await supabase
    .from('loans')
    .select('id,book_id,owner,borrower,borrower_name,message,due_date,status,requested_at,decided_at,returned_at')
    .order('requested_at', { ascending: false })
    .limit(300);
  if (error) throw new Error(readable(error));
  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.book_id).filter(Boolean))];
  let books = [];
  if (ids.length) {
    const r = await supabase.from('books').select(BOOK_COLUMNS).in('id', ids);
    if (!r.error) books = r.data ?? [];
  }
  const byId = new Map(books.map((b) => [b.id, b]));
  return rows.map((r) => ({ ...r, book: byId.get(r.book_id) ?? null }));
}

export async function addBook(payload) {
  const { data, error } = await supabase.from('books').insert(payload).select('id').single();
  if (error) throw new Error(readable(error));
  return data?.id;
}

export async function updateBook(id, patch) {
  const { error } = await supabase.from('books').update(patch).eq('id', id);
  if (error) throw new Error(readable(error));
}

export async function deleteBook(id) {
  const { error } = await supabase.from('books').delete().eq('id', id);
  if (error) throw new Error(readable(error));
}

export async function requestLoan({ bookId, dueDate, message, name }) {
  const { error } = await supabase.from('loans').insert({
    book_id: bookId,
    due_date: dueDate || null,
    message: message || '',
    borrower_name: name || '',
  });
  if (error) throw new Error(readable(error));
}

export async function setLoanStatus(id, status) {
  const { error } = await supabase.from('loans').update({ status }).eq('id', id);
  if (error) throw new Error(readable(error));
}

/** 서버가 보낸 오류 문장을 그대로 쓰되, 기술적인 문장은 쉬운 말로 */
export function readable(error) {
  const raw = String(error?.message ?? error ?? '');
  if (!raw) return '알 수 없는 오류가 났습니다.';
  if (/duplicate key.*loans_one_borrowed/i.test(raw)) return '이미 다른 친구가 빌려 간 책입니다.';
  if (/row-level security/i.test(raw)) return '권한이 없습니다. 로그인 상태와 이 책의 주인을 확인해 주세요.';
  if (/JWT|token/i.test(raw)) return '로그인이 풀렸습니다. 다시 로그인해 주세요.';
  if (/violates check constraint/i.test(raw)) return '입력한 내용이 규칙에 맞지 않습니다. 글자 수를 확인해 주세요.';
  return raw;
}

/** 로그인한 사람의 부르는 이름 */
export function displayName(user) {
  if (!user) return '';
  const m = user.user_metadata ?? {};
  return String(m.full_name || m.name || m.nickname || (user.email ?? '').split('@')[0] || '친구').slice(0, 40);
}
