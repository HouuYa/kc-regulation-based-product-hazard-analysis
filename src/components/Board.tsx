import Link from 'next/link';

/**
 * 게시판 — 찾기 · 정렬 · 페이지 넘김
 *
 * 담당자 요청: "사고보고서와 리콜이 양이 많아지므로 게시판 형태로 1페이지에
 * 보여주고 페이지 넘김 기능을 해줘. 날짜를 넣어서 정렬 기능, 찾기 기능도"
 *
 * 지금 리콜만 2,259건이고 앞으로 더 는다. 전부 한 화면에 쏟으면 브라우저도 느려지고
 * 찾을 수도 없다.
 *
 * 클라이언트 자바스크립트를 쓰지 않는다
 *   이 프로젝트의 다른 화면들과 같은 방식이다. 상태를 주소줄(?q=&page=&sort=)에
 *   두고 서버가 그 조건으로 조회한다. 그래서
 *     - 주소를 복사해 붙이면 같은 화면이 그대로 열린다(동료에게 보낼 수 있다)
 *     - 뒤로 가기가 제대로 동작한다
 *     - 자바스크립트가 안 떠도 검색과 정렬이 된다
 *   찾기·개수 선택은 평범한 GET 폼이고, 정렬·페이지는 평범한 링크다.
 */

export interface BoardParams {
  q?: string;
  page?: string;
  per?: string;
  sort?: string;
  dir?: string;
  [key: string]: string | undefined;
}

/** 한 화면에 몇 건을 보일 것인가 */
export const PER_PAGE_OPTIONS = [10, 25, 50, 100];

export function parseBoard(params: BoardParams, defaultSort: string) {
  const per = PER_PAGE_OPTIONS.includes(Number(params.per)) ? Number(params.per) : 25;
  const page = Math.max(1, Number(params.page) || 1);
  return {
    q: (params.q ?? '').trim(),
    per,
    page,
    offset: (page - 1) * per,
    sort: params.sort || defaultSort,
    dir: params.dir === 'asc' ? ('asc' as const) : ('desc' as const),
  };
}

/** 지금 조건을 유지하면서 몇 가지만 바꾼 주소를 만든다 */
function href(basePath: string, params: BoardParams, changes: Record<string, string | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...changes })) {
    if (v != null && v !== '') sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * 찾기 · 보기 개수 · 걸러 보기
 *
 * GET 폼이라 제출하면 조건이 주소줄에 실린다. 페이지 번호는 일부러 빼서
 * 새 조건으로 찾으면 언제나 1쪽부터 보이게 한다 — 3쪽을 보다가 검색어를 바꿨는데
 * 결과가 1쪽뿐이면 빈 화면이 나오기 때문이다.
 */
export function BoardToolbar({
  basePath, params, placeholder, filters = [],
}: {
  basePath: string;
  params: BoardParams;
  placeholder: string;
  filters?: { name: string; label: string; options: { value: string; label: string }[] }[];
}) {
  const { per, sort, dir } = parseBoard(params, sort0(params));
  return (
    <form method="get" action={basePath} className="mt-8 flex flex-wrap items-center gap-2">
      {/* 정렬 상태는 검색해도 유지한다 */}
      <input type="hidden" name="sort" value={sort} />
      <input type="hidden" name="dir" value={dir} />

      <input
        type="search"
        name="q"
        defaultValue={params.q ?? ''}
        placeholder={placeholder}
        className="min-w-0 flex-1 border border-rule bg-surface px-3 py-2 text-[13px]"
      />

      {filters.map((f) => (
        <select
          key={f.name}
          name={f.name}
          defaultValue={params[f.name] ?? ''}
          className="border border-rule bg-surface px-2 py-2 text-[12px]"
          aria-label={f.label}
        >
          <option value="">{f.label} 전체</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ))}

      <select
        name="per"
        defaultValue={String(per)}
        className="border border-rule bg-surface px-2 py-2 text-[12px]"
        aria-label="한 쪽에 보일 건수"
      >
        {PER_PAGE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}건씩</option>
        ))}
      </select>

      <button
        type="submit"
        className="border border-measure bg-measure px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
      >
        찾기
      </button>
    </form>
  );
}

function sort0(params: BoardParams) {
  return params.sort || '';
}

/**
 * 정렬 가능한 열 제목.
 *
 * 지금 정렬 중인 열을 누르면 오름차순↔내림차순이 바뀐다. 그 사실을 화살표로 보인다 —
 * 아무 표시가 없으면 눌러도 되는 줄 모른다.
 */
export function SortHeader({
  basePath, params, field, label, align = 'left',
}: {
  basePath: string;
  params: BoardParams;
  field: string;
  label: string;
  align?: 'left' | 'right';
}) {
  const { sort, dir } = parseBoard(params, field);
  const active = sort === field;
  const nextDir = active && dir === 'desc' ? 'asc' : 'desc';

  return (
    <Link
      href={href(basePath, params, { sort: field, dir: nextDir, page: undefined })}
      className={`hover:text-ink ${align === 'right' ? 'text-right' : ''} ${active ? 'text-ink' : ''}`}
      aria-label={`${label} 기준 정렬`}
    >
      {label}
      <span aria-hidden className="ml-1 text-[9px]">
        {active ? (dir === 'desc' ? '▼' : '▲') : '↕'}
      </span>
    </Link>
  );
}

/**
 * 페이지 넘김.
 *
 * 앞뒤 두 쪽씩만 번호로 보이고 나머지는 줄인다. 37쪽짜리 목록에서 번호 37개를
 * 늘어놓으면 그것대로 읽을 수 없다.
 */
export function BoardPager({
  basePath, params, total, page, per,
}: {
  basePath: string;
  params: BoardParams;
  total: number;
  page: number;
  per: number;
}) {
  const lastPage = Math.max(1, Math.ceil(total / per));
  const from = total === 0 ? 0 : (page - 1) * per + 1;
  const to = Math.min(total, page * per);

  const nums: (number | '…')[] = [];
  for (let p = 1; p <= lastPage; p++) {
    if (p === 1 || p === lastPage || Math.abs(p - page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }

  const link = (p: number, label: string, disabled = false) =>
    disabled ? (
      <span key={label} className="addr px-2 py-1 text-[12px] text-ink-3/50">{label}</span>
    ) : (
      <Link
        key={label}
        href={href(basePath, params, { page: p === 1 ? undefined : String(p) })}
        className="addr px-2 py-1 text-[12px] text-ink-2 hover:text-ink"
      >
        {label}
      </Link>
    );

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
      <span className="addr tnum text-[11px] text-ink-3">
        {total.toLocaleString()}건 중 {from.toLocaleString()}–{to.toLocaleString()}
      </span>

      {lastPage > 1 && (
        <nav className="flex flex-wrap items-center gap-0.5" aria-label="쪽 넘기기">
          {link(1, '«', page === 1)}
          {link(page - 1, '‹', page === 1)}
          {nums.map((n, i) =>
            n === '…' ? (
              <span key={`gap${i}`} className="px-1 text-[12px] text-ink-3">…</span>
            ) : n === page ? (
              <span
                key={n}
                aria-current="page"
                className="addr border border-measure bg-measure px-2 py-1 text-[12px] text-white"
              >
                {n}
              </span>
            ) : (
              <Link
                key={n}
                href={href(basePath, params, { page: n === 1 ? undefined : String(n) })}
                className="addr border border-rule px-2 py-1 text-[12px] text-ink-2 hover:bg-measure-soft"
              >
                {n}
              </Link>
            ),
          )}
          {link(page + 1, '›', page === lastPage)}
          {link(lastPage, '»', page === lastPage)}
        </nav>
      )}
    </div>
  );
}
