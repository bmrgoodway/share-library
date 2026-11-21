// ISBN 다듬기 — 화면(main.js)과 바코드 스캐너(scan.js)가 함께 씁니다.
/** 읽은 값을 ISBN 으로 다듬기 — 숫자만 남기고 10·13자리만 통과 */
export function normalizeIsbn(raw) {
  const clean = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (clean.length === 13 && /^97[89]/.test(clean)) return clean;
  if (clean.length === 10) return clean;
  return '';
}
