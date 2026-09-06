/**
 * 품목 확정 (v0.7 §3.2 "품목과 적용기준을 먼저 결정한다")
 *
 * 사건의 품목명을 받아 적용할 기준 세트를 정한다. 순서가 이렇게 되어야 하는 이유는
 * v0.7 이 한 문장으로 정리했다 — "위해요인 코드가 같아도 제품이 다르면 관련 시험이
 * 다르다." 코드로 먼저 검색하면 유아용 의자 사고에 전기다리미 조항이 섞인다.
 *
 * 두 경로로 찾는다.
 *   1) 등록된 품목 이름·별칭과 맞춰 본다 (어린이제품 33종)
 *   2) 못 찾으면 각 기준의 적용범위 원문을 한국어 전문검색으로 뒤진다
 *      KC 60335 계열은 파일명에 품목이 없어 1)로는 절대 찾을 수 없다.
 *      대신 적용범위가 "직물용 전기 스티머", "전기 튀김기, 전기 프라이팬" 처럼
 *      정확히 적고 있다.
 *
 * 못 찾으면 null 을 돌려준다. 억지로 고르지 않는다 — v0.7 은 품목이 불명확하면
 * 전 품목 검색을 자동 실행하지 말고 SCOPE_UNRESOLVED 로 보내라고 명시했다.
 */

import { getDb } from '../db';
import { resolveScopeSemantically } from './scope-semantic';

export interface ResolvedScope {
  productScopeId: number | null;
  scopeName: string;
  /** 이 품목에 적용되는 기준 id */
  standardIds: number[];
  standardCount: number;
  /** 왜 이 품목·기준으로 봤는가. 화면과 감사에 그대로 쓴다 */
  evidence: string;
  method: '용어 사전' | '검색어 사전' | '품목명 일치' | '별칭 일치' | '적용범위 검색' | '적용범위 의미 검색';
}

/** "전지_보조배터리" → ["전지", "보조배터리"] 처럼 후보를 넓힌다 */
function variants(itemName: string): string[] {
  const cleaned = itemName.replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = cleaned.split(/[\s,·/]+/).filter((p) => p.length >= 2);
  return [...new Set([cleaned, ...parts])];
}

/**
 * IEC 계열 기준의 제1부를 적용 세트에 더한다.
 *
 * KC 60335-2-98(가습기)의 조항 본문은 대부분 "제1부의 이 항목을 적용한다" 이다.
 * 제2-x부는 독립된 기준이 아니라 제1부의 개정문이기 때문이다. 실제로 세어 보면
 * 제2-x부가 제1부로 명시 위임한 조항이 2~33% 이고, 요구사항 자체의 양이 다르다.
 *
 *   KC 60335-2-98  요구사항  54개
 *   KC 60335-1     요구사항 395개
 *
 * 제1부를 빼고 검색하면 담당자는 요구사항의 대부분을 보지 못한다. 어린이제품에서
 * 부속서에 공통안전기준을 함께 묶는 것과 같은 구조다(standard_applicability 의
 * COMMON). 전기용품은 적용범위 검색으로 찾으므로 그 묶음이 없어 여기서 만든다.
 */
async function withGeneralPart(standardIds: number[]): Promise<number[]> {
  if (standardIds.length === 0) return standardIds;
  const db = getDb();
  const rows = await db<{ id: number; display_name: string }[]>`
    select id, display_name from public.standard where id = any(${standardIds}::bigint[])
  `;

  // "KC 60335-2-98" → 계열 "60335" → 제1부 "60335-1"
  const wanted = new Set<string>();
  for (const r of rows) {
    const m = r.display_name.match(/\b(\d{4,5})-2-\d+/);
    if (m) wanted.add(`${m[1]}-1`);
  }
  if (wanted.size === 0) return standardIds;

  // display_name 앞의 "KC " 를 떼고 번호만 맞춘다
  const parts = await db<{ id: number }[]>`
    select id from public.standard
    where is_current
      and regexp_replace(display_name, '^[^0-9]*', '') = any (${[...wanted]}::text[])
  `;
  // Number() 로 맞춰 둔다. postgres.js 가 bigint 를 문자열로 주므로 숫자와 문자열이
  // 섞이면 같은 기준이 Set 안에 두 번 들어간다.
  return [...new Set([...standardIds.map(Number), ...parts.map((p) => Number(p.id))])];
}

export async function resolveProductScope(
  itemName: string,
  /** 사건 서술. 있으면 의미 검색의 신호가 훨씬 좋아진다 — 품목 이름만으로는 짧다 */
  narrative?: string | null,
): Promise<ResolvedScope | null> {
  const db = getDb();
  const cands = variants(itemName);

  /*
    ── 0) 용어 사전 (042) ────────────────────────────────────────────────

    가장 먼저 본다. 담당자가 사고조사에서 정한 대응이 여기 있고, 사람이 정한 것을
    두고 기계가 다시 고를 이유가 없다. 조회 한 번이라 공짜이고, 같은 품목에 늘
    같은 기준이 붙는다 — 의미 검색은 모델이 흔들리면 결과도 흔들린다.

    반려된 대응은 쓰지 않는다. 담당자가 아니라고 한 것을 계속 쓰면 검수가 뜻이 없다.

    LLM 제안만 확정 전에는 쓰지 않는다 (2026-09-05)
      의미 검색(SEMANTIC)은 미검수라도 쓴다. 근거가 기준 **자신의 적용범위 원문**과의
      유사도이기 때문이다 — 기준이 스스로 무엇을 다루는지 적어 놓은 것에 기댄다.

      LLM 제안은 다르다. 애초에 적용범위 원문이 비어 있어서 물어본 것이라(등기구 3종이
      그랬다) 조항 제목과 모델의 일반 지식으로 미룬 것이다. 근거가 한 겹 얕다.
      품목이 틀리면 엉뚱한 기준의 시험이 나오고, 그것은 조용히 틀리는 종류의 고장이라
      사람이 한 번은 봐야 한다.
  */
  const dictHits = await db<{ id: number; display_name: string; source: string; review_status: string }[]>`
    select s.id, s.display_name, t.source, t.review_status
    from public.scope_term t
    join public.standard s on s.id = t.standard_id
    where t.term_key = public.scope_term_key(${itemName})
      and t.review_status <> 'rejected'
      and (t.source <> 'LLM' or t.review_status = 'approved')
      and s.is_current
    order by case t.source when 'EXPERT' then 1 else 2 end, s.display_name
  `;

  if (dictHits.length > 0) {
    const ids = await withGeneralPart(dictHits.map((h) => h.id));
    const expert = dictHits.filter((h) => h.source === 'EXPERT').length;
    const unreviewed = dictHits.filter((h) => h.review_status === 'auto_unreviewed').length;
    return {
      productScopeId: null,
      scopeName: itemName,
      standardIds: ids,
      standardCount: ids.length,
      evidence:
        `용어 사전 — "${itemName}" → ${dictHits.map((h) => h.display_name).join(', ')}` +
        (expert > 0 ? ` (담당자 확정 ${expert}건)` : '') +
        (unreviewed > 0 ? ` · 미검수 ${unreviewed}건 포함` : '') +
        (ids.length > dictHits.length ? ` · 제1부 ${ids.length - dictHits.length}건 포함` : ''),
      method: '용어 사전',
    };
  }

  /*
    ── 검색어 사전으로 법정 품목을 거쳐 간다 (2026-09-06) ─────────────────

    사고보고서는 담당자가 쓰는 글이라 법정어가 84% 지만, 해외 리콜 1,553종은 6%만
    법정어와 맞는다("토끼 나무 기차"). 그 간극을 메우려고 만든 사전이 item_keyword 다.

      일상어 → item_keyword → 법정 품목 → product_taxonomy → 부속서 기준

    안전하게 쓰기 위한 조건 셋. 하나라도 어기면 엉뚱한 기준이 붙는다.

    1) 정확 일치만 쓴다
       부분 일치는 쓰지 않는다. 실제로 "고압세척기"가 진공청소기에 붙어 있고,
       "세척기" 같은 조각말은 식기세척기까지 끌어온다.

    2) 여러 품목에 걸친 말은 쓰지 않는다
       검색어 5,982개 중 600개가 두 품목 이상에 붙어 있다. 어느 쪽인지 정할 수 없으면
       고르지 않는다 — 담당자가 화면에서 판단할 일이다(/keywords 「손볼 곳」).

    3) 확정된 것만 쓴다
       AI 제안(source='LLM')은 검수를 통과해야 한다. scope_term 의 LLM 제안과 같은 규칙이다.

    제외어(item_keyword_stopword)는 협회가 정한 「일일동향보고 검색 제외어」다.
    위해유형 이름처럼 품목이 아닌 말이 섞여 들어오면 엉뚱한 품목에 걸린다.
  */
  const viaKeyword = await db<{ id: number; display_name: string; target: string }[]>`
    with hit as (
      select k.item_group, coalesce(k.sub_item, k.item, '') target
      from public.item_keyword k
      where k.keyword_key = public.scope_term_key(${itemName})
        and k.review_status = 'approved'
        and not exists (
          select 1 from public.item_keyword_stopword w where w.word_key = k.keyword_key)
        -- 여러 품목에 걸친 말은 자동으로 쓰지 않는다
        and (
          select count(distinct coalesce(k2.sub_item, k2.item, ''))
          from public.item_keyword k2
          where k2.keyword_key = k.keyword_key and k2.review_status <> 'rejected'
        ) = 1
    )
    /*
      법정 품목에서 기준으로 가는 길이 둘이다.

      ① 기준의 품목명과 맞는 것 — 부속서 33종 중 32종이 이렇게 이어진다
      ② 대응표(taxonomy_standard) — 적용범위·제목을 뜻으로 견주어 만든 것(049)

      전기용품 43종은 품목명이 비어 있어 ①로는 닿지 못한다. 그 자리가 ②다.
      ②는 **확정된 것만** 쓴다 — 품목이 틀리면 엉뚱한 기준의 시험이 근거로 제시된다.
    */
    , linked as (
      select distinct s.id, s.display_name, hit.target
      from hit
      join public.product_taxonomy t
        on t.item_group = hit.item_group
       and hit.target in (t.item, t.sub_item, t.sub_sub_item)
      join public.standard s
        on s.is_current and s.item_name is not null
       and public.scope_term_key(s.item_name) in (
             public.scope_term_key(t.item),
             public.scope_term_key(coalesce(t.sub_item, '')),
             public.scope_term_key(coalesce(t.sub_sub_item, '')))

      union

      select distinct s.id, s.display_name, hit.target
      from hit
      join public.taxonomy_standard x
        on x.item_group = hit.item_group
       and hit.target in (x.item, x.sub_item)
       and x.review_status = 'approved'
      join public.standard s on s.id = x.standard_id and s.is_current
    )
    select id, display_name, target from linked order by display_name
  `;

  if (viaKeyword.length > 0) {
    const ids = await withGeneralPart(viaKeyword.map((h) => h.id));
    return {
      productScopeId: null,
      scopeName: viaKeyword[0].target,
      standardIds: ids,
      standardCount: ids.length,
      evidence:
        `검색어 사전 — "${itemName}" → 법정 품목 "${viaKeyword[0].target}" → ` +
        viaKeyword.map((h) => h.display_name).join(', ') +
        (ids.length > viaKeyword.length ? ` · 제1부 ${ids.length - viaKeyword.length}건 포함` : ''),
      method: '검색어 사전',
    };
  }

  // ── 1) 등록된 품목 (이름 또는 별칭) ───────────────────────────────────
  const [exact] = await db<{ id: number; name: string }[]>`
    select id, name from public.product_scope
    where name = any (${cands}::text[])
       or aliases && ${cands}::text[]
    limit 1
  `;

  if (exact) {
    const stds = await db<{ id: number; relation: string; display_name: string }[]>`
      select s.id, a.relation, s.display_name
      from public.standard_applicability a
      join public.standard s on s.id = a.standard_id
      where a.product_scope_id = ${exact.id} and s.is_current
      order by case a.relation when 'ANNEX' then 1 when 'COMMON' then 2 else 3 end
    `;
    const annex = stds.filter((s) => s.relation === 'ANNEX').length;
    const common = stds.filter((s) => s.relation === 'COMMON').length;
    return {
      productScopeId: exact.id,
      scopeName: exact.name,
      standardIds: stds.map((s) => s.id),
      standardCount: stds.length,
      evidence: `등록된 품목 "${exact.name}" — 부속서 ${annex}건 + 공통안전기준 ${common}건`,
      method: exact.name === itemName.trim() ? '품목명 일치' : '별칭 일치',
    };
  }

  // ── 2) 적용범위 원문 검색 ────────────────────────────────────────────
  //
  // PGroonga 로 찾는다. 조사가 붙어도 잡아야 하기 때문이다("가습기의", "가습기를").
  // 여러 기준이 걸리면 전부 적용 후보로 둔다 — 하나로 좁히는 것은 담당자의 몫이고,
  // 시스템이 임의로 고르면 시험 항목을 놓친다.
  const hits = await db<{ id: number; display_name: string; snippet: string }[]>`
    select s.id, s.display_name,
           substring(s.scope_text from 1 for 120) as snippet
    from public.standard s
    where s.is_current
      and s.scope_text is not null
      and s.scope_text operator(extensions.&@~) ${cands.join(' OR ')}
    limit 10
  `;

  /*
    ── 3) 뜻으로 찾기 (2026-09-04 추가) ──────────────────────────────────

    글자 검색이 못 잡으면 의미로 찾는다. 실측으로 드러난 간극 때문이다 —
    기준의 적용범위는 법령 용어를, 사고보고서는 일상 용어를 쓴다.

      전기요     ← KC 60335-2-17 은 "전기 담요, 패드들, 의류" 라고 쓴다
      전기레인지  ← KC 60335-2-6 은 "거치형 조리레인지, 호브, 오븐" 이라고 쓴다

    사고보고서 70건에 돌려 보니 이 두 경로로 품목이 붙은 것이 7건(10%)뿐이었다.
    의미 검색 + 모델 확인을 붙이니 사람이 지목한 기준을 10건 중 8건 맞혔다
    (scope-semantic.ts 주석에 실측이 있다).

    여기서도 제1부를 함께 넣는다 — KC 60335-2-23 을 골랐다면 요구사항의 대부분은
    제1부에 있고, 실제로 담당자도 두 기준을 함께 적었다(엑셀 55건 중 17건이 2종 이상).
  */
  if (hits.length === 0) {
    const semantic = await resolveScopeSemantically(itemName, narrative);
    if (!semantic) return null;

    const ids = await withGeneralPart([semantic.standardId]);

    /*
      찾아낸 대응을 사전에 쌓는다. 미검수로 넣으므로 담당자가 확인하기 전까지는
      "AI 가 이렇게 봤다"는 표시가 붙은 채로 쓰인다.

      다음부터 같은 품목은 AI 를 부르지 않는다 — 한 번 정해진 대응은 지식이고,
      지식은 저장해야 공짜가 되고 항상 같아진다. 저장에 실패해도 이번 결과는
      그대로 쓴다. 사전은 거들 뿐이고 없어도 동작해야 한다.
    */
    try {
      await db`
        insert into public.scope_term
          (term, term_key, standard_id, source, evidence, confidence)
        values (${itemName}, public.scope_term_key(${itemName}), ${semantic.standardId},
                'SEMANTIC', ${semantic.reasoning.slice(0, 1000)}, ${semantic.confidence})
        on conflict (term_key, standard_id) do nothing
      `;
    } catch (e) {
      console.warn(`용어 사전 저장 실패 ("${itemName}"):`, e instanceof Error ? e.message : e);
    }

    return {
      // 아직 품목으로 등록하지 않는다. 담당자가 확인한 뒤 등록하는 것이 순서다.
      productScopeId: null,
      scopeName: itemName,
      standardIds: ids,
      standardCount: ids.length,
      evidence:
        `적용범위 의미 검색 — ${semantic.displayName} (확신 ${semantic.confidence.toFixed(2)}, ` +
        `후보 ${semantic.candidateCount}종 중) · ${semantic.reasoning}` +
        (ids.length > 1 ? ` · 제1부 ${ids.length - 1}건 포함` : ''),
      method: '적용범위 의미 검색',
    };
  }

  const withParts = await withGeneralPart(hits.map((h) => h.id));

  return {
    // 아직 품목으로 등록하지 않는다. 담당자가 확인한 뒤 등록하는 것이 순서다.
    productScopeId: null,
    scopeName: itemName,
    standardIds: withParts,
    standardCount: withParts.length,
    evidence:
      `적용범위 원문 검색으로 ${hits.length}건` +
      (withParts.length > hits.length ? ` + 제1부 ${withParts.length - hits.length}건` : '') + ' — ' +
      hits.slice(0, 3).map((h) => h.display_name).join(', ') +
      (hits.length > 3 ? ` 외 ${hits.length - 3}건` : ''),
    method: '적용범위 검색',
  };
}

/**
 * 분석에 쓸 기준 id 를 돌려준다.
 *
 * 확정된 품목이 있으면 그 적용기준 세트를, 없으면 사건에 남은 검색 결과를 쓴다.
 * 둘 다 없으면 빈 배열 — 호출자가 SCOPE_UNRESOLVED 로 처리한다.
 */
export async function standardsForCase(caseId: number): Promise<number[]> {
  const db = getDb();

  const [ev] = await db<{ product_scope_id: number | null; item_name: string | null }[]>`
    select product_scope_id, item_name from public.case_event where id = ${caseId}
  `;
  if (!ev) return [];

  if (ev.product_scope_id) {
    const rows = await db<{ id: number }[]>`
      select s.id from public.standard_applicability a
      join public.standard s on s.id = a.standard_id
      where a.product_scope_id = ${ev.product_scope_id} and s.is_current
    `;
    return withGeneralPart(rows.map((r) => Number(r.id)));
  }

  // 품목이 등록되지 않은 전기용품 등 — 적용범위 검색으로 그때그때 찾는다
  if (ev.item_name) {
    const resolved = await resolveProductScope(ev.item_name);
    if (resolved) return resolved.standardIds;
  }
  return [];
}
