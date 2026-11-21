// share-library-fn — 친구공책 서버 함수
//   GET  /health                DB 연결 확인 (허브 운영 현황이 읽는 표준 모양)
//   GET  /book?isbn=9788936434120   ISBN → 책 정보 (카카오 책 검색 → 구글 북스 → 오픈라이브러리)
//   GET  /search?q=한강&size=10     제목·저자 키워드 검색 (카카오)
//   GET  /cover?u=<표지 주소>       표지 그림 대신 받아 오기 (허용된 주소만)
//   GET  /hello                 부른 사람 확인 (시작 예시 그대로)
//
// 카카오 REST API 키는 함수 비밀값 SHARE_LIBRARY_KAKAO_REST_API_KEY 로만 읽습니다.
// 브라우저 코드·저장소에 키를 넣지 마세요.
import { checkHubAuth, healthJson, type HubUser } from './lib/hub.ts';

const FN = 'share-library-fn';
const PREFIX = 'SHARE_LIBRARY_';
const ORIGINS = ['https://bmrgoodway.github.io', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

const secret = (name: string) => Deno.env.get(PREFIX + name) ?? '';
const KAKAO_KEY = secret('KAKAO_REST_API_KEY');

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

const route = (req: Request) => {
  const p = new URL(req.url).pathname; const i = p.indexOf('/' + FN);
  return (i < 0 ? '/' : p.slice(i + FN.length + 1)).replace(/\/+$/, '') || '/';
};

// ── 책 정보 모양 ──────────────────────────────────────────────────────────────
type BookInfo = {
  source: 'kakao' | 'google' | 'openlibrary';
  isbn13: string;
  isbn10: string;
  title: string;
  authors: string;
  publisher: string;
  published_date: string;
  cover: string;
  description: string;
  url: string;
};
const clean = (s: unknown, max = 600): string =>
  String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const digits = (s: unknown): string => String(s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();

/** 카카오 응답 한 건 → BookInfo */
function fromKakao(d: Record<string, unknown>): BookInfo {
  const isbnRaw = String(d.isbn ?? '').split(/\s+/).filter(Boolean);
  const isbn13 = isbnRaw.find((v) => v.length === 13) ?? '';
  const isbn10 = isbnRaw.find((v) => v.length === 10) ?? '';
  return {
    source: 'kakao',
    isbn13,
    isbn10,
    title: clean(d.title, 300),
    authors: (Array.isArray(d.authors) ? d.authors : []).map((a) => clean(a, 80)).filter(Boolean).join(', '),
    publisher: clean(d.publisher, 120),
    published_date: clean(d.datetime, 10),
    cover: String(d.thumbnail ?? ''),
    description: clean(d.contents, 800),
    url: String(d.url ?? ''),
  };
}

// ── 카카오 책 검색 ────────────────────────────────────────────────────────────
async function kakaoApi(path: string, params: Record<string, string>): Promise<Record<string, unknown>[] | null> {
  if (!KAKAO_KEY) return null;
  const u = new URL('https://dapi.kakao.com' + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) { await r.body?.cancel(); return null; }
  const j = await r.json() as { documents?: Record<string, unknown>[] };
  return Array.isArray(j.documents) ? j.documents : [];
}

/** ISBN 으로 한 권 찾기 — 카카오(ISBN·키워드) → 구글 북스 → 오픈라이브러리 */
async function findBook(isbn: string): Promise<BookInfo | null> {
  const codes = [isbn];
  const alt = isbn.length === 10 ? isbn13Of(isbn) : isbn10Of(isbn);
  if (alt) codes.push(alt);

  for (const code of codes) {
    const docs = await kakaoApi('/v3/search/book', { target: 'isbn', query: code, size: '5' });
    const hit = (docs ?? []).find((d) => String(d.isbn ?? '').replace(/[^0-9Xx]/g, '').includes(code)) ?? docs?.[0];
    if (hit) return fromKakao(hit);
  }
  // ISBN 이 색인에 없을 때: 같은 번호로 키워드 검색
  const byKeyword = await kakaoApi('/v3/search/book', { query: isbn, size: '5' });
  if (byKeyword?.[0]) return fromKakao(byKeyword[0]);

  const google = await findGoogle(isbn);
  if (google) return google;
  const ol = await findOpenLibrary(isbn);
  if (ol) return ol;
  return null;
}

async function findGoogle(isbn: string): Promise<BookInfo | null> {
  try {
    const r = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=1&country=KR`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json() as { items?: { volumeInfo?: Record<string, unknown> }[] };
    const v = j.items?.[0]?.volumeInfo;
    if (!v) return null;
    const ids = (Array.isArray(v.industryIdentifiers) ? v.industryIdentifiers : []) as { type?: string; identifier?: string }[];
    const cover = String((v.imageLinks as { thumbnail?: string; smallThumbnail?: string } | undefined)?.thumbnail
      ?? (v.imageLinks as { smallThumbnail?: string } | undefined)?.smallThumbnail ?? '').replace(/^http:/, 'https:');
    return {
      source: 'google',
      isbn13: ids.find((i) => i.type === 'ISBN_13')?.identifier ?? (isbn.length === 13 ? isbn : ''),
      isbn10: ids.find((i) => i.type === 'ISBN_10')?.identifier ?? (isbn.length === 10 ? isbn : ''),
      title: clean(v.title, 300),
      authors: (Array.isArray(v.authors) ? v.authors : []).map((a) => clean(a, 80)).filter(Boolean).join(', '),
      publisher: clean(v.publisher, 120),
      published_date: clean(v.publishedDate, 10),
      cover,
      description: clean(v.description, 800),
      url: String(v.infoLink ?? ''),
    };
  } catch { return null; }
}

async function findOpenLibrary(isbn: string): Promise<BookInfo | null> {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&format=json&jscmd=data`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const j = await r.json() as Record<string, Record<string, unknown>>;
    const d = j[`ISBN:${isbn}`];
    if (!d) return null;
    const cover = (d.cover as { large?: string; medium?: string; small?: string } | undefined);
    return {
      source: 'openlibrary',
      isbn13: (Array.isArray(d.identifiers) ? d.identifiers : []).map(String).find((v) => v.length === 13) ?? (isbn.length === 13 ? isbn : ''),
      isbn10: (Array.isArray(d.identifiers) ? d.identifiers : []).map(String).find((v) => v.length === 10) ?? (isbn.length === 10 ? isbn : ''),
      title: clean(d.title, 300),
      authors: (Array.isArray(d.authors) ? d.authors as { name?: string }[] : []).map((a) => clean(a.name, 80)).filter(Boolean).join(', '),
      publisher: (Array.isArray(d.publishers) ? d.publishers as { name?: string }[] : []).map((p) => clean(p.name, 120)).filter(Boolean).join(', '),
      published_date: clean(d.publish_date, 10),
      cover: cover?.large ?? cover?.medium ?? cover?.small ?? '',
      description: clean(d.notes ?? d.subtitle ?? '', 800),
      url: String(d.url ?? ''),
    };
  } catch { return null; }
}

/** ISBN-10 → ISBN-13 (978 접두) */
function isbn13Of(isbn10: string): string {
  const c = digits(isbn10);
  if (c.length !== 10) return '';
  const base = '978' + c.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return base + check;
}

/** ISBN-13(978…) → ISBN-10 */
function isbn10Of(isbn13: string): string {
  const c = digits(isbn13);
  if (c.length !== 13 || !c.startsWith('978')) return '';
  const base = c.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(base[i]) * (10 - i);
  const check = (11 - (sum % 11)) % 11;
  return base + (check === 10 ? 'X' : String(check));
}

// ── 표지 그림 대신 받아 오기 (핫링크 차단·혼합 콘텐츠 회피) ────────────────────
const COVER_HOSTS = ['search1.kakaocdn.net', 't1.daumcdn.net', 'books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org'];
const MAX_COVER = 3_000_000;

async function proxyCover(req: Request, raw: string): Promise<Response> {
  let u: URL;
  try { u = new URL(raw); } catch { return json(req, 400, { error: '표지 주소가 올바르지 않습니다.' }); }
  if (u.protocol !== 'https:' || !COVER_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h))) {
    return json(req, 403, { error: '허용되지 않은 표지 주소입니다.' });
  }
  const r = await fetch(u, { headers: { Accept: 'image/*' }, signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (!r.ok) { await r.body?.cancel(); return json(req, 502, { error: '표지를 받아 오지 못했습니다.' }); }
  const type = r.headers.get('content-type') ?? '';
  const len = Number(r.headers.get('content-length') ?? 0);
  if (!type.startsWith('image/') || (len && len > MAX_COVER)) { await r.body?.cancel(); return json(req, 502, { error: '표지 형식이 올바르지 않습니다.' }); }
  return new Response(r.body, {
    status: 200,
    headers: {
      ...cors(req),
      'Content-Type': type,
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o)) return json(req, 403, { error: '허용되지 않은 출처입니다.' });
  const path = route(req);
  const q = new URL(req.url).searchParams;
  try {
    if (path === '/health') return json(req, 200, { ...healthJson(true), kakao_ready: Boolean(KAKAO_KEY) });

    if (path === '/hello') {
      const user: HubUser | null = await checkHubAuth(req);
      return json(req, 200, { app: 'share-library', user, kakao_ready: Boolean(KAKAO_KEY), time: new Date().toISOString() });
    }

    if (path === '/book') {
      const isbn = digits(q.get('isbn') ?? '');
      if (![10, 13].includes(isbn.length)) return json(req, 400, { error: 'ISBN 10자리 또는 13자리 숫자를 넣어 주세요.' });
      const book = await findBook(isbn);
      if (!book) return json(req, 404, { error: '이 ISBN 으로는 책을 찾지 못했습니다. 직접 입력해 주세요.', isbn });
      return json(req, 200, { book });
    }

    if (path === '/search') {
      const term = clean(q.get('q') ?? '', 120);
      if (term.length < 1) return json(req, 400, { error: '찾을 책 제목이나 저자를 넣어 주세요.' });
      const size = Math.min(20, Math.max(1, Number(q.get('size') ?? 10) || 10));
      const docs = await kakaoApi('/v3/search/book', { query: term, size: String(size) });
      if (!docs) return json(req, 502, { error: '책 검색을 쓰려면 카카오 REST API 키(함수 비밀값)가 필요합니다.' });
      return json(req, 200, { books: docs.map(fromKakao), query: term });
    }

    if (path === '/cover') {
      const raw = q.get('u') ?? '';
      if (!raw) return json(req, 400, { error: '표지 주소(u)가 없습니다.' });
      return await proxyCover(req, raw);
    }

    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    console.error(FN, (e as { name?: string })?.name ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버에서 책 정보를 가져오지 못했습니다.' });
  }
});
