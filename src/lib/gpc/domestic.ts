/**
 * GPC 브릭 → 국내 안전관리 되짚기 (K-GPC)
 *
 * 무엇을 알게 됐나 (docs/용어/표준제품분류체계_K-GPC.md, 2026-09-09)
 *   국표원의 「표준 제품분류체계」는 GS1 의 GPC 를 그대로 쓰는 것이 아니라,
 *   GPC 브릭에 **속성(Attribute)** 축을 더해 국내 안전관리제도에 맞춘 것이다.
 *   그래서 브릭 하나가 속성에 따라 서로 다른 인증구분으로 갈린다.
 *
 *     베개 (브릭 10002225)
 *       성인용        → 생활용품 / 가정용 섬유제품   / 안전기준준수
 *       만3~13세      → 어린이제품 / 아동용 섬유제품 / 공급자적합성확인
 *       만3세 미만    → 어린이제품 / 유아용 섬유제품 / 안전확인
 *
 * 이것이 「GPC 로는 기준을 고르지 않는다」의 정확한 이유다
 *   전에는 "GPC 는 유통 분류이고 KC 는 위해 분류라 축이 다르다"고만 적었다.
 *   실제는 한 걸음 더 구체적이다 — **브릭만으로는 못 고르지만, 브릭 + 속성이면
 *   대분류·인증구분·법정 품목까지 정해진다.** 그리고 그 속성(사용 연령·재질)은
 *   서류에 안 적혀 있는 일이 많아 사람이 확정해야 한다. 우리가 이미 만들어 둔
 *   「어린이제품인가」 확정 칸(case_event.child_product_check, 055)이 바로 그
 *   속성을 사람에게 받는 자리다.
 *
 * 우리 표가 곧 그 대응표다
 *   협회 「품목별 세분류 매칭 DB」를 옮겨 놓은 public.product_taxonomy 에
 *   브릭 코드 764종 · 2,148행이 들어 있고, 각 행에 대분류(item_group)와
 *   인증구분(cert_scheme)이 붙어 있다. 새로 만들 것이 없고 되짚기만 하면 된다.
 *
 * 무엇을 하지 않나
 *   속성값(연령·재질)을 우리가 추정해 하나로 좁히지 않는다. 갈리는 갈래를 모두
 *   보여 주고 「무엇이 이것을 가르는가」를 함께 적는다. 좁히는 것은 사람의 일이다 —
 *   유아용을 성인용으로 잘못 좁히면 안전확인 대상을 안전기준준수로 낮춰 보게 된다.
 */

import { getDb } from '../db';

export interface DomesticRoute {
  itemGroup: string;
  certScheme: string;
  item: string;
  subItem: string | null;
}

export interface DomesticLookup {
  brickCode: string;
  brickTitle: string | null;
  routes: DomesticRoute[];
  /** 대분류가 둘 이상으로 갈리는가 (전기용품이면서 어린이제품인 식) */
  groupsSplit: boolean;
  /** 인증구분이 둘 이상으로 갈리는가 — 갈리면 속성을 사람이 정해야 한다 */
  certsSplit: boolean;
  /** 화면에 그대로 쓸 한 문장 */
  note: string;
}

/**
 * 브릭 코드로 국내 안전관리 갈래를 찾는다.
 *
 * 브릭이 우리 품목표에 없으면 routes 가 빈 배열이다. 그것은 「안전관리 대상이
 * 아니다」가 아니라 「우리 품목표에 아직 없다」는 뜻이므로 note 에 그렇게 적는다.
 * 품목표는 협회가 준 2,148행이고 국내 안전관리 대상 전부가 아니다.
 */
export async function lookupDomestic(brickCode: string): Promise<DomesticLookup> {
  const db = getDb();
  const rows = await db<{
    item_group: string; cert_scheme: string; item: string; sub_item: string | null;
    brick_title: string | null;
  }[]>`
    select distinct item_group, cert_scheme, item,
           -- 품목명 자리에 숫자만 든 행이 원본 엑셀에서 넘어와 있다(060 과 같은 건).
           -- 「256」을 세부품목으로 내보내면 담당자가 무엇을 보라는 것인지 알 수 없다
           nullif(case when sub_item ~ '^[0-9[:space:],.]+$' then '' else sub_item end, '') as sub_item,
           brick_title
    from public.product_taxonomy
    where brick_code = ${brickCode}
      and nullif(btrim(item_group), '') is not null
      and nullif(btrim(cert_scheme), '') is not null
    order by item_group, cert_scheme, item, sub_item
  `;

  const routes: DomesticRoute[] = rows.map((r) => ({
    itemGroup: r.item_group,
    certScheme: r.cert_scheme,
    item: r.item,
    subItem: r.sub_item,
  }));

  const groups = new Set(routes.map((r) => r.itemGroup));
  const certs = new Set(routes.map((r) => r.certScheme));

  let note: string;
  if (routes.length === 0) {
    note = '이 브릭은 협회 품목표에 없습니다 — 안전관리 대상이 아니라는 뜻이 아니라, 우리가 가진 대응표에 아직 없다는 뜻입니다.';
  } else if (certs.size === 1 && groups.size === 1) {
    note = `이 브릭은 ${[...groups][0]} · ${[...certs][0]} 한 갈래로만 이어집니다.`;
  } else {
    // 무엇이 갈리는지만 적는다. 「인증구분 1가지로 갈립니다」는 말이 안 된다
    const what = [
      groups.size > 1 ? `대분류 ${groups.size}가지` : '',
      certs.size > 1 ? `인증구분 ${certs.size}가지` : '',
    ].filter(Boolean).join(' · ');
    note =
      `이 브릭은 ${what}로 갈립니다. ` +
      '어느 쪽인지는 사용 연령·재질 같은 속성이 가르고, 그 속성은 서류에 없는 일이 많아 담당자가 확정해야 합니다.';
  }

  return {
    brickCode,
    brickTitle: rows[0]?.brick_title ?? null,
    routes,
    groupsSplit: groups.size > 1,
    certsSplit: certs.size > 1,
    note,
  };
}
