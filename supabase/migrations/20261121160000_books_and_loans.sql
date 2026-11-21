-- 친구공책 · 책장(books)과 대출(loans) 표
-- · books  : 등록된 책 (누구나 '공개' 책은 볼 수 있고, 주인만 고치고 지울 수 있음)
-- · loans  : 대출 신청·승인·반납 이력 (책 주인과 빌린 사람만 볼 수 있음)
-- · books.loan_state 는 loans 를 보고 트리거가 채워 줍니다 (책장에서 한 번에 보이도록)

create table if not exists share_library.books (
  id bigint generated always as identity primary key,
  owner uuid not null default bmr.uid(),
  owner_name text not null default '',
  isbn13 text not null default '',
  isbn10 text not null default '',
  title text not null,
  authors text not null default '',
  publisher text not null default '',
  published_date text not null default '',
  cover_url text not null default '',
  description text not null default '',
  note text not null default '',
  share_state text not null default 'open' check (share_state in ('open', 'closed')),
  loan_state text not null default 'none' check (loan_state in ('none', 'requested', 'borrowed')),
  current_loan_id bigint,
  loan_borrower text not null default '',
  loan_due date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_title_len check (char_length(title) between 1 and 300),
  constraint books_note_len check (char_length(note) <= 500),
  constraint books_owner_name_len check (char_length(owner_name) <= 60)
);

create table if not exists share_library.loans (
  id bigint generated always as identity primary key,
  book_id bigint not null references share_library.books (id) on delete cascade,
  owner uuid not null,
  borrower uuid not null,
  borrower_name text not null default '',
  message text not null default '',
  due_date date,
  status text not null default 'requested' check (status in ('requested', 'borrowed', 'returned', 'declined', 'canceled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  returned_at timestamptz,
  constraint loans_message_len check (char_length(message) <= 500),
  constraint loans_not_self check (owner <> borrower)
);

create index if not exists books_created_idx on share_library.books (created_at desc);
create index if not exists books_owner_idx on share_library.books (owner, created_at desc);
create index if not exists books_isbn_idx on share_library.books (isbn13) where isbn13 <> '';
create index if not exists loans_book_idx on share_library.loans (book_id, status);
create index if not exists loans_borrower_idx on share_library.loans (borrower, status);
create index if not exists loans_owner_idx on share_library.loans (owner, status);

-- 같은 책은 한 번에 한 사람만 빌릴 수 있다 (여러 명이 신청하는 것은 가능)
create unique index if not exists loans_one_borrowed on share_library.loans (book_id) where status = 'borrowed';

-- ── 책 상태(대출 중/신청 있음)를 loans 보고 채우기 ────────────────────────────
create or replace function share_library.refresh_book(p_book bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  select id, status, borrower_name, due_date into r
    from share_library.loans
   where book_id = p_book and status in ('borrowed', 'requested')
   order by case status when 'borrowed' then 0 else 1 end, requested_at
   limit 1;
  if not found then
    update share_library.books
       set loan_state = 'none', current_loan_id = null, loan_borrower = '', loan_due = null
     where id = p_book and (loan_state <> 'none' or current_loan_id is not null);
  else
    update share_library.books
       set loan_state = r.status, current_loan_id = r.id,
           loan_borrower = coalesce(r.borrower_name, ''), loan_due = r.due_date
     where id = p_book;
  end if;
end;
$$;

-- ── 신청할 때: 주인·신청자·상태를 서버에서 정한다 ─────────────────────────────
create or replace function share_library.prepare_loan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare b record; me uuid := bmr.uid();
begin
  if me is null then raise exception '로그인이 필요합니다.'; end if;
  select id, owner, share_state into b from share_library.books where id = new.book_id;
  if not found then raise exception '없는 책입니다.'; end if;
  if b.owner = me then raise exception '내 책에는 대출을 신청할 수 없습니다.'; end if;
  if b.share_state <> 'open' then raise exception '지금은 빌릴 수 없는 책입니다.'; end if;
  if exists (
    select 1 from share_library.loans l
     where l.book_id = new.book_id and l.borrower = me and l.status in ('requested', 'borrowed')
  ) then raise exception '이미 신청했거나 빌리고 있는 책입니다.'; end if;

  new.owner := b.owner;
  new.borrower := me;
  new.status := 'requested';
  new.requested_at := now();
  new.decided_at := null;
  new.returned_at := null;
  if coalesce(new.borrower_name, '') = '' then new.borrower_name := coalesce(bmr.email(), '친구'); end if;
  return new;
end;
$$;

-- ── 상태를 바꿀 때: 누가 무엇으로 바꿀 수 있는지 서버에서 정한다 ───────────────
create or replace function share_library.guard_loan_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare me uuid := bmr.uid();
begin
  if new.book_id <> old.book_id or new.owner <> old.owner or new.borrower <> old.borrower then
    raise exception '책·주인·신청자는 바꿀 수 없습니다.';
  end if;
  if new.status = old.status then return new; end if;

  if old.status = 'requested' and new.status in ('borrowed', 'declined') then
    if me is not null and me <> old.owner then raise exception '책 주인만 승인하거나 거절할 수 있습니다.'; end if;
    new.decided_at := now();
  elsif old.status = 'requested' and new.status = 'canceled' then
    if me is not null and me <> old.borrower then raise exception '신청한 사람만 취소할 수 있습니다.'; end if;
  elsif old.status = 'borrowed' and new.status = 'returned' then
    if me is not null and me <> old.owner then raise exception '책 주인만 반납을 확인할 수 있습니다.'; end if;
    new.returned_at := now();
  else
    raise exception '바꿀 수 없는 상태입니다 (% → %).', old.status, new.status;
  end if;
  return new;
end;
$$;

-- ── 바뀐 뒤: 책 상태 갱신 + 승인되면 같은 책의 다른 신청은 자동 거절 ───────────
create or replace function share_library.after_loan_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'borrowed' and (tg_op = 'INSERT' or old.status is distinct from 'borrowed') then
    update share_library.loans
       set status = 'declined', decided_at = now()
     where book_id = new.book_id and status = 'requested' and id <> new.id;
  end if;
  perform share_library.refresh_book(new.book_id);
  if tg_op = 'UPDATE' and old.book_id <> new.book_id then
    perform share_library.refresh_book(old.book_id);
  end if;
  return null;
end;
$$;

drop trigger if exists loans_prepare on share_library.loans;
create trigger loans_prepare before insert on share_library.loans
  for each row execute function share_library.prepare_loan();

drop trigger if exists loans_guard on share_library.loans;
create trigger loans_guard before update on share_library.loans
  for each row execute function share_library.guard_loan_update();

drop trigger if exists loans_after on share_library.loans;
create trigger loans_after after insert or update or delete on share_library.loans
  for each row execute function share_library.after_loan_change();

create or replace function share_library.touch_book()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists books_touch on share_library.books;
create trigger books_touch before update on share_library.books
  for each row execute function share_library.touch_book();

-- ── 행 보안 정책 (RLS) ───────────────────────────────────────────────────────
-- '내가 빌린 책'인지 확인하는 도우미 — 정책 안에서 loans 표를 직접 읽으면
-- 손님(anon) 역할에 loans 권한이 없어 books 조회 자체가 막힙니다. security definer 로 감쌉니다.
create or replace function share_library.is_book_borrower(p_book bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from share_library.loans l
     where l.book_id = p_book and l.borrower = (select bmr.uid())
  )
$$;

alter table share_library.books enable row level security;
alter table share_library.loans enable row level security;

drop policy if exists books_read on share_library.books;
create policy books_read on share_library.books
  for select to anon, authenticated
  using (
    share_state = 'open'
    or owner = (select bmr.uid())
    or (select share_library.is_book_borrower(books.id))
  );

drop policy if exists books_insert on share_library.books;
create policy books_insert on share_library.books
  for insert to authenticated
  with check (owner = (select bmr.uid()));

drop policy if exists books_update on share_library.books;
create policy books_update on share_library.books
  for update to authenticated
  using (owner = (select bmr.uid()))
  with check (owner = (select bmr.uid()));

drop policy if exists books_delete on share_library.books;
create policy books_delete on share_library.books
  for delete to authenticated
  using (owner = (select bmr.uid()));

drop policy if exists loans_read on share_library.loans;
create policy loans_read on share_library.loans
  for select to authenticated
  using (owner = (select bmr.uid()) or borrower = (select bmr.uid()));

drop policy if exists loans_insert on share_library.loans;
create policy loans_insert on share_library.loans
  for insert to authenticated
  with check (borrower = (select bmr.uid()));

drop policy if exists loans_update on share_library.loans;
create policy loans_update on share_library.loans
  for update to authenticated
  using (owner = (select bmr.uid()) or borrower = (select bmr.uid()))
  with check (owner = (select bmr.uid()) or borrower = (select bmr.uid()));

-- 브라우저 역할에 권한 주기 (새 표는 기본이 '읽기'만)
grant select on share_library.books to anon, authenticated;
grant insert, update, delete on share_library.books to authenticated;
grant select, insert, update on share_library.loans to authenticated;
grant usage, select on all sequences in schema share_library to authenticated;
