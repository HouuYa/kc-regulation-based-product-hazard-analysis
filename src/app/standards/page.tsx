import Link from 'next/link';
import { getDb } from '@/lib/db';
import { PageHead, ConnectionError, EmptyState, Row, TermsNote } from '@/components/Panel';
import { StatusBar } from '@/components/StatusBar';
import { PageToc, type TocItem } from '@/components/PageToc';
import {
  GROUP_ORDER, GROUP_SOURCE_NOTE, CERT_TYPE_NOTE, CERT_SOURCE_NOTE,
  asGroup, standardName, byKoreanName, sortCertTypes, CERT_TYPE_ORDER,
  type ItemGroup,
} from '@/lib/standards/label';

export const dynamic = 'force-dynamic';

const STANDARDS_TOC: TocItem[] = [
  { id: 'standards-status', label: '준비 상태' },
  { id: 'standards-electric', label: '전기용품' },
  { id: 'standards-living', label: '생활용품' },
  { id: 'standards-child', label: '어린이제품' },
];

const GROUP_ANCHOR: Record<ItemGroup, string> = {
  전기용품: 'standards-electric',
  생활용품: 'standards-living',
  어린이제품: 'standards-child',
  기타: 'standards-etc',
};

/**
 * 안전기준 적재 현황
 *
 * 담당자가 여기서 알아야 하는 것은 "이 기준으로 분석해도 되는가"다.
 * 조항 수만으로는 알 수 없고, 위해요인 코드와 시험방법 연결이 함께 있어야 한다.
 * 시험방법 연결이 없으면 관련 조항을 찾아도 어떤 시험을 의뢰할지 잇지 못한다.
 *
 * 이름을 보여 주는 순서 (담당자 요청: "KC 60335-1라고만 쓰지 말고 명칭도")
 *   title_ko    문서 안에서 뽑은 한글 표제 — 전기용품 계열 40건
 *   item_name   파일명 괄호에서 뽑은 품목명 — 부속서 계열
 *   둘 다 없으면 번호만 나온다. 없는 이름을 지어내지는 않는다.
 */

interface StandardRow {
  id: number;
  display_name: string;
  title_ko: string | null;
  cert_scheme: string | null;
  item_name: string | null;
  total_pages: number | null;
  /** 전기용품 · 생활용품 · 어린이제품 · 기타 (057 뷰가 정한다) */
  item_group: string;
  /** 대분류를 무엇을 보고 정했는가 — TAXONOMY · SCHEME · NAME */
  item_group_source: string;
  /** 인증구분 — 대분류와 별개의 축이다(058). 기준 하나가 여러 구분에 걸릴 수 있다 */
  cert_types: string[] | null;
  cert_type_source: string | null;
  /** 품목표의 상위 품목·세부품목. 미검수분이 섞여 있어 화면에서 그렇게 밝힌다 */
  items: string[] | null;
  sub_items: string[] | null;
  /** 품목→기준 대응 건수와 그중 확정된 건수 */
  link_count: number;
  approved_count: number;
  clauses: number;
  tagged: number;
  embedded: number;
  test_links: number;
  /** 이 기준에 따로 있는 시험 조항 수. 연결이 왜 없는지 가르는 열쇠다 */
  test_clauses: number;
  unresolved: number;
  conditions: number;
}

interface Summary {
  standards: number;
  clauses: number;
  tagged: number;
  /** 코드를 붙일 수 있는 조항 수 — 요건 조항이면서 본문이 있는 것 */
  taggable: number;
  embedded: number;
  embeddable: number;
  testLinks: number;
  conditions: number;
  unresolved: number;
  /** 아직 사람이 확인하지 않은 코드가 붙은 조항 수 (037) */
  unreviewedClauses: number;
  /** 요건 조항이 아닌데 코드가 붙어 있는 조항 수. 있으면 화면이 밝힌다 */
  taggedOutside: number;
}

/** 표 머리글과 각 줄이 같은 칸 배분을 쓴다. 한 곳에서 정의해 어긋나지 않게 한다 */
const GRID = 'grid grid-cols-[1fr_repeat(5,minmax(52px,auto))] gap-3';

export default async function StandardsPage() {
  let rows: StandardRow[] = [];
  let summary: Summary | null = null;
  let error: string | null = null;

  try {
    const db = getDb();

    /*
      상단 숫자와 아래 목록의 분모를 맞춘다 (02_1차 보완 및 구현 설계서 §4.5)

      목록은 is_current 인 기준만 보여 주는데, 상단 집계는 조항·태그·임베딩·시험
      연결·허용치를 표 전체에서 세고 있었다. 지금은 개정판이 없어서 두 숫자가 같지만,
      같은 기준의 새 판이 하나라도 들어오면 상단 합계가 목록 합계보다 커진다.
      담당자는 그것을 "목록에 안 보이는 자료가 있다"로 읽게 된다.

      그래서 전부 현재 판 조인을 거치게 했다. 유일한 예외는 standards 자체로,
      그것은 원래부터 is_current 를 세고 있었다.
    */
    const summaryQuery = db<Summary[]>`
      select
        (select count(*)::int from public.standard where is_current)                          as standards,
        (select count(*)::int from public.clause c
          join public.standard s on s.id = c.standard_id where s.is_current)                  as clauses,
        -- 분자는 반드시 분모 안에서 센다 (2026-09-09 배포 화면에서 발견)
        -- 전에는 「코드가 붙은 조항 전부」를 세고 분모는 「코드를 붙이는 요건 조항」이라
        -- 6,400 / 6,392 처럼 분자가 분모보다 큰 값이 화면에 떴다. 요건이 아닌 조항
        -- 8건에도 코드가 붙어 있어서다. 100%를 넘는 비율은 숫자 전체를 못 믿게 만든다.
        (select count(distinct t.clause_id)::int from public.clause_tag t
          join public.clause c on c.id = t.clause_id
          join public.standard s on s.id = c.standard_id
          where s.is_current and c.clause_role = 'REQUIREMENT'
            and length(btrim(c.body)) >= 15)                                                  as tagged,
        -- 요건이 아닌데 코드가 붙은 것. 0 이 아니면 화면이 그 사실을 밝힌다
        (select count(distinct t.clause_id)::int from public.clause_tag t
          join public.clause c on c.id = t.clause_id
          join public.standard s on s.id = c.standard_id
          where s.is_current and not (c.clause_role = 'REQUIREMENT'
            and length(btrim(c.body)) >= 15))                                                 as "taggedOutside",
        -- 코드를 붙이는 대상은 "요건" 조항뿐이다(v0.7 §5.3). 정의·적용범위·시험방법에
        -- 코드를 붙이면 아무것도 요구하지 않는 문장이 진짜 요건과 같은 자격으로
        -- 검색에 걸린다. 본문이 거의 없는 조각도 제외한다.
        (select count(*)::int from public.clause c2
          join public.standard s2 on s2.id = c2.standard_id
          where s2.is_current and c2.clause_role = 'REQUIREMENT'
            and length(btrim(c2.body)) >= 15)                                                as taggable,
        (select count(*)::int from public.clause c
          join public.standard s on s.id = c.standard_id
          where s.is_current and c.embedding is not null)                                     as embedded,
        (select count(*)::int from public.clause c
          join public.standard s on s.id = c.standard_id
          where s.is_current and c.search_text is not null
            and length(btrim(c.search_text)) > 0)                                             as embeddable,
        (select count(*)::int from public.clause_link l
          join public.clause c on c.id = l.from_clause_id
          join public.standard s on s.id = c.standard_id
          where s.is_current and l.link_type = 'TEST_METHOD' and l.to_clause_id is not null)   as "testLinks",
        (select count(*)::int from public.test_condition tc
          join public.clause c on c.id = tc.clause_id
          join public.standard s on s.id = c.standard_id where s.is_current)                  as conditions,
        (select count(*)::int from public.clause_link l
          join public.clause c on c.id = l.from_clause_id
          join public.standard s on s.id = c.standard_id
          where s.is_current and l.to_clause_id is null)                                      as unresolved,
        (select count(distinct t.clause_id)::int from public.clause_tag t
          join public.clause c on c.id = t.clause_id
          join public.standard s on s.id = c.standard_id
          where s.is_current and t.review_status = 'auto_unreviewed')                          as "unreviewedClauses"
    `;

    const rowsQuery = db<StandardRow[]>`
      select
        s.id, s.display_name, s.title_ko, s.cert_scheme, s.item_name, s.total_pages,
        s.item_group, s.item_group_source, s.cert_types, s.cert_type_source,
        s.items, s.sub_items, s.link_count, s.approved_count,
        count(c.id)::int as clauses,
        count(*) filter (where exists (
          select 1 from public.clause_tag t where t.clause_id = c.id))::int as tagged,
        count(*) filter (where c.embedding is not null)::int as embedded,
        (select count(*)::int from public.clause_link l
          join public.clause fc on fc.id = l.from_clause_id
          where fc.standard_id = s.id and l.link_type = 'TEST_METHOD'
            and l.to_clause_id is not null) as test_links,
        (select count(*)::int from public.clause c3
          where c3.standard_id = s.id and c3.clause_role = 'TEST_METHOD') as test_clauses,
        (select count(*)::int from public.clause_link l
          join public.clause fc on fc.id = l.from_clause_id
          where fc.standard_id = s.id and l.to_clause_id is null) as unresolved,
        (select count(*)::int from public.test_condition tc
          join public.clause cc on cc.id = tc.clause_id
          where cc.standard_id = s.id) as conditions
      from public.standard_view s
      left join public.clause c on c.standard_id = s.id
      where s.is_current
      group by s.id, s.display_name, s.title_ko, s.cert_scheme, s.item_name,
               s.total_pages, s.item_group, s.item_group_source, s.cert_types,
               s.cert_type_source, s.items, s.sub_items, s.link_count, s.approved_count
    `;

    // 두 조회는 서로의 결과를 쓰지 않는다. 함께 보내면 느린 쪽만큼만 기다린다(§4.1)
    const [[sum], list] = await Promise.all([summaryQuery, rowsQuery]);
    summary = sum;
    rows = list;
  } catch (e) {
    console.error('안전기준 화면 조회 실패:', e);
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_10rem]">
      <div>
      <PageHead
        label="1 · 안전기준"
        title="들여온 기준과 준비 상태"
        lead="기준을 확인하고, 조항과 시험방법이 분석에 쓸 수 있는 상태인지 봅니다."
        /*
          이 화면이 맡은 일의 순서 (담당자 요청, 2026-09-09)
          숫자를 함께 실어 흐름도가 현황판을 겸하게 한다 — 어디서 막혀 있는지가
          그림에서 바로 보여야 한다.
        */
        workflow={summary ? [
          { label: '기준 들여오기', who: '사람', note: `${summary.standards}종`, state: 'done' },
          { label: '조항으로 나누기', note: `${summary.clauses.toLocaleString()}개`, state: 'done' },
          {
            label: '코드 붙이기',
            note: `${summary.tagged.toLocaleString()} / ${summary.taggable.toLocaleString()}`,
            state: summary.tagged >= summary.taggable ? 'done' : 'here',
          },
          {
            label: '뜻 검색 준비',
            note: `${summary.embedded.toLocaleString()} / ${summary.embeddable.toLocaleString()}`,
            state: summary.embedded >= summary.embeddable ? 'done' : 'here',
          },
          {
            label: '코드 검수',
            who: '사람',
            href: '/standards/review',
            note: summary.unreviewedClauses > 0 ? `대기 ${summary.unreviewedClauses.toLocaleString()}` : '끝',
            state: summary.unreviewedClauses > 0 ? 'here' : 'done',
          },
          { label: '분석에 사용', href: '/accidents', note: `시험연결 ${summary.testLinks.toLocaleString()}`, state: 'todo' },
        ] : undefined}
      />

      {error && <ConnectionError error={error} />}

      {/*
        검수 화면으로 가는 길 (037)

        코드 검수는 이 화면의 숫자와 이어져 있다 — 확정한 코드만 근거등급 A 로
        제시되고, 검색 스위치를 켤 수 있게 된다. 그런데 검수 화면이 아무 데서도
        보이지 않으면 담당자는 그런 화면이 있는 줄도 모른다. 실제로 그 화면이
        없던 동안 조항 태그가 100% 미검수로 남아 있었다.
      */}
      {summary && summary.unreviewedClauses > 0 && (
        <div className="mt-8 border border-caution bg-caution-soft px-4 py-3">
          <div className="text-[13px] font-semibold text-caution">
            사람이 확인하지 않은 코드가 있습니다
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
            조항{' '}
            <span className="addr tnum text-ink">
              {summary.unreviewedClauses.toLocaleString()}개
            </span>
            의 위해요인 코드를 AI가 붙인 뒤 아직 아무도 확인하지 않았습니다. 확인해야
            분석 결과에서 근거등급 A로 제시되고, 「검수 확정분만 사용」 설정을 켤 수 있습니다.
          </p>
          <div className="mt-3">
            <Link
              href="/standards/review"
              className="inline-block border border-caution bg-caution px-4 py-2 text-[13px] font-medium text-white hover:opacity-85"
            >
              코드 검수하러 가기
            </Link>
          </div>
        </div>
      )}

      {summary && (
        <div id="standards-status" className="scroll-mt-8">
        <StatusBar
          items={[
            { label: '기준 문서', value: summary.standards, note: '지금 쓰고 있는 안전기준' },
            { label: '조항', value: summary.clauses, note: '검색이 걸리는 가장 작은 덩어리입니다. 조항 하나가 한 덩어리' },
            {
              label: '위해요인 코드', value: summary.tagged, of: summary.taggable,
              note: `오른쪽 수는 코드를 붙이는 요건 조항만 센 것입니다. 정의·적용범위·시험방법 ${(summary.clauses - summary.taggable).toLocaleString()}건에는 코드를 붙이지 않습니다${summary.taggedOutside > 0 ? `. 요건이 아닌데 코드가 붙은 조항이 ${summary.taggedOutside}건 따로 있습니다` : ''}`,
            },
            {
              label: '의미 검색 준비', value: summary.embedded, of: summary.embeddable,
              note: '뜻으로 찾으려면 검색용 문장이 먼저 있어야 합니다. 오른쪽 수는 그 문장이 있는 조항입니다',
            },
            {
              label: '시험방법 연결', value: summary.testLinks,
              note: '이 요건을 어느 시험으로 확인하는지 조항끼리 이어 둔 것',
            },
            {
              label: '시험 항목·허용치', value: summary.conditions,
              note: '기준 표에서 뽑아낸 수치. 예: 납 90 mg/kg 이하',
            },
            {
              label: '다른 기준 참조', value: summary.unresolved,
              note: '가리키는 조항이 다른 기준에 있습니다. KC 60335 계열이 제1부를 가리키는 경우입니다',
            },
          ]}
        />
        </div>
      )}

      {/*
        처음 보는 사람을 위한 두 축 설명 (담당자 지적, 2026-09-09)

        "안전기준 담당자는 품목별로 나뉘어 있어, 자기 품목군이 아니면 다른 품목에
        대해선 일반인보다도 잘 모르는 경우가 많다." 그래서 화면이 쓰는 낱말을
        화면 안에서 설명한다. 밖의 문서로 미루면 아무도 안 본다.

        대분류와 인증구분은 서로를 결정하지 않는 별개의 축이다(058). 같은 전기용품
        안에도 안전인증 품목과 공급자적합성확인 품목이 함께 있다.
      */}
      {rows.length > 0 && (
        <details className="mt-6 border border-rule-soft">
          <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-ink-2">
            이 화면의 낱말 — <span className="text-ink">대분류</span>와{' '}
            <span className="text-ink">인증구분</span>은 다른 것입니다
          </summary>
          <div className="border-t border-rule-soft px-4 py-3.5 text-[12px] leading-relaxed text-ink-2">
            <p>
              <span className="text-ink">대분류</span>는 어느 법의 어느 품목군인가입니다 —
              전기용품 · 생활용품 · 어린이제품. 목록을 이 셋으로 나눠 두었습니다.
            </p>
            <p className="mt-2">
              <span className="text-ink">인증구분</span>은 팔기 전에 무엇을 거쳐야 하는가입니다.
              대분류와 서로를 결정하지 않습니다 — 같은 전기용품 안에도 안전인증 품목과
              공급자적합성확인 품목이 함께 있습니다. 기준 하나가 여러 구분에 걸리기도 합니다.
            </p>
            <ul className="mt-2.5 space-y-1">
              {CERT_TYPE_ORDER.map((c) => (
                <li key={c}>
                  <span className="text-ink">{c}</span>
                  <span className="text-ink-3"> — {CERT_TYPE_NOTE[c]}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2.5 text-[11px] text-ink-3">
              품목명 옆에{' '}
              <span className="text-caution">품목표에서 따옴 · 검수 전</span> 이 붙은 것은,
              담당자 품목표를 AI 가 이어 붙인 뒤 아직 아무도 확인하지 않은 이름입니다.
              근거 자료는 docs/raw/제품안전법제도/안전기준목록조사 취합(전기 생활 어린이).xlsx 입니다.
            </p>
          </div>
        </details>
      )}

      {!error && rows.length === 0 && (
        <EmptyState
          message="아직 들여온 기준이 없습니다."
          commands={[
            { cmd: 'npm run standards:inspect', note: '넣기 전에 읽어들인 결과를 먼저 봅니다' },
            { cmd: 'npm run standards:load -- --only "부속서 8"', note: '기준 하나만 넣습니다' },
            { cmd: 'npm run standards:load', note: 'KC안전기준/ 폴더에 있는 것을 모두 넣습니다' },
          ]}
        />
      )}

      {/*
        대분류로 나눠 보여 준다 (담당자 요청, 2026-09-09)

        "전기/생활/어린이는 대분류로 무조건 구분하여 정렬될 수 있도록. 왜냐하면
        KC안전기준, 용어 리스트 등이 너무 많음." 76건을 한 줄로 늘어놓으면 자기
        품목군을 찾는 데만 시간이 든다. 담당자는 대개 한 대분류만 맡으므로,
        나머지 둘은 접어 둘 수 있어야 한다.

        정렬은 번호가 아니라 품목명 가나다순이다 — 담당자는 품목으로 찾지
        번호로 찾지 않는다. 한글 정렬은 DB 로캘에 기대지 않고 화면에서 한다.
      */}
      {rows.length > 0 && GROUP_ORDER.map((group) => {
        const inGroup = rows.filter((r) => asGroup(r.item_group) === group).sort(byKoreanName);
        if (inGroup.length === 0) return null;
        const needName = inGroup.filter((r) => standardName(r).name === null).length;
        return (
          <section
            key={group}
            id={GROUP_ANCHOR[group]}
            className="mt-10 scroll-mt-8"
          >
            <details open>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 border-b-2 border-ink py-2">
                <span className="text-[15px] font-semibold">{group}</span>
                <span className="addr tnum text-[12px] text-ink-3">{inGroup.length}종</span>
                {needName > 0 && (
                  <span className="text-[11px] text-caution">명칭 확인 필요 {needName}건</span>
                )}
                <span className="ml-auto text-[11px] text-ink-3">눌러서 접기</span>
              </summary>

              {/* 머리글 고정(담당자 요청) — 아래로 훑다 보면 어느 숫자가 무슨 칸인지 잊는다 */}
              <div className={`label sticky top-0 z-10 border-b border-rule bg-paper pt-3 pb-2 ${GRID}`}>
                <span>품목 · 기준</span>
                <span className="text-right">조항</span>
                <span className="text-right">코드</span>
                <span className="text-right">의미검색</span>
                <span className="text-right">시험연결</span>
                <span className="text-right">허용치</span>
              </div>

              {inGroup.map((r) => {
                const notReady = r.tagged === 0 || r.test_links === 0;
                const { name, from } = standardName(r);
                const certs = sortCertTypes(r.cert_types);
                /* 세부품목은 대응표에서 온 것이라 미검수분이 섞여 있다. 몇 개만 보이고
                   나머지는 숫자로 알린다 — KC 62368-1 은 75개다. */
                const subs = (r.sub_items ?? []).filter(Boolean);
                const shown = subs.slice(0, 6);
                return (
                  <Row key={r.id}>
                    <div className={`items-baseline ${GRID}`}>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          {name ? (
                            <span className="text-[14px] font-semibold">{name}</span>
                          ) : (
                            <span className="text-[13px] font-semibold text-caution">
                              명칭 확인 필요
                            </span>
                          )}
                          <span className="addr text-[12px] text-ink-2">{r.display_name}</span>
                          {(from === 'sub_items' || from === 'items') && (
                            <span className="text-[10px] text-caution">품목표에서 따옴 · 검수 전</span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-ink-3">
                          {certs.length > 0 ? (
                            <span title={certs.map((c) => `${c} — ${CERT_TYPE_NOTE[c] ?? ''}`).join(' / ')}>
                              {certs.join(' · ')}
                            </span>
                          ) : (
                            <span className="text-caution">인증구분 미상</span>
                          )}
                          {r.total_pages ? ` · ${r.total_pages}쪽` : ''}
                          {r.cert_type_source && r.cert_type_source !== 'MANUAL' && (
                            <span> ({CERT_SOURCE_NOTE[r.cert_type_source]})</span>
                          )}
                          {r.item_group_source !== 'TAXONOMY' && (
                            <span> · 대분류는 {GROUP_SOURCE_NOTE[r.item_group_source]}</span>
                          )}
                          {r.unresolved > 0 && (
                            <span className="text-caution"> · 다른 기준 참조 {r.unresolved}</span>
                          )}
                        </div>
                        {shown.length > 0 && (
                          <div className="mt-1 text-[11px] leading-relaxed text-ink-2">
                            <span className="text-ink-3">이 기준이 걸리는 품목 </span>
                            {shown.join(' · ')}
                            {subs.length > shown.length && (
                              <span className="text-ink-3"> 외 {subs.length - shown.length}종</span>
                            )}
                            {r.approved_count === 0 && (
                              <span className="text-caution"> — 아직 아무도 확인하지 않음</span>
                            )}
                          </div>
                        )}
                        {shown.length === 0 && (
                          <div className="mt-1 text-[11px] text-caution">
                            품목 대응이 없습니다 —{' '}
                            <Link href="/terms" className="underline decoration-rule underline-offset-2">
                              품목 용어 사전
                            </Link>
                            에서 이어 주면 이 기준이 분석에 걸립니다.
                          </div>
                        )}
                      </div>
                      <span className="addr tnum text-right text-[13px]">{r.clauses}</span>
                      <span className={`addr tnum text-right text-[13px] ${r.tagged ? '' : 'text-caution'}`}>
                        {r.tagged}
                      </span>
                      <span className={`addr tnum text-right text-[13px] ${r.embedded ? '' : 'text-ink-3'}`}>
                        {r.embedded}
                      </span>
                      <span className={`addr tnum text-right text-[13px] ${r.test_links ? '' : 'text-caution'}`}>
                        {r.test_links}
                      </span>
                      <span className="addr tnum text-right text-[13px] text-ink-2">{r.conditions}</span>
                    </div>
                    {notReady && (
                      <div className="mt-1.5 text-[11px] leading-snug text-caution">
                        {r.tagged === 0 &&
                          '위해요인 코드가 없어 코드로 찾는 방식이 작동하지 않습니다. 뜻이 비슷한 문장을 찾는 방식만 남습니다. '}
                        {/*
                          「연결이 없다」를 한 문장으로 뭉뚱그리면 안 된다 (2026-09-09)

                          KC 60335 계열은 요건과 시험을 한 조항 안에 함께 적는다
                          (「…을 초과하여서는 안 된다. 제어장치를 단락하여 시험한다」).
                          그런 기준에 「어떤 시험을 의뢰해야 하는지 알려 드리지 못합니다」라고
                          적으면 사실과 다르다 — 조항 자체에 시험이 적혀 있다.
                          이을 짝이 없는 것과, 짝이 있는데 못 이은 것은 다르다.
                        */}
                        {r.test_links === 0 && r.test_clauses < 3 && (
                          <span className="text-ink-3">
                            이 기준은 요건과 시험을 한 조항에 함께 적습니다. 따로 이을 시험 조항이
                            없으니 조항 본문을 그대로 보시면 됩니다.
                          </span>
                        )}
                        {r.test_links === 0 && r.test_clauses >= 3 &&
                          `시험 조항이 ${r.test_clauses}개 있는데 요건과 이어지지 않았습니다. 관련 조항은 찾을 수 있지만 어떤 시험을 의뢰해야 하는지까지는 알려 드리지 못합니다.`}
                      </div>
                    )}
                  </Row>
                );
              })}
            </details>
          </section>
        );
      })}

      <TermsNote />
      </div>
      <PageToc items={STANDARDS_TOC} />
      </div>
    </div>
  );
}
