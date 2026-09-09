import { classifyProduct } from '@/lib/gpc/classify';
import { DEFAULT_GPC_CANDIDATE_COUNT } from '@/lib/gpc/assign';

export const dynamic = 'force-dynamic';

/**
 * POST /api/gpc/classify — 제품명·설명을 주면 GPC 코드를 판정해 돌려준다
 *
 * 왜 라우트로 여나 (담당자 요청, 2026-09-09)
 *   "만들어진 GPC 부여가 다른 곳도 사용할 수 있도록 해 주세요."
 *   지금까지 이 판정은 우리 배치 안에서만 돌았다. 협회의 다른 시스템(n8n 워크플로,
 *   리콜 등록 화면 등)이 같은 판정을 쓰려면 로직을 각자 복사하는 수밖에 없었고,
 *   그러면 프롬프트가 갈라져 같은 제품에 다른 코드가 붙는다.
 *
 * 입력 이름을 협회 워크플로에 맞춘다
 *   「(GS1) [한국리콜__OECD] OECD GPC RAG」의 웹훅이 받는 것과 같은 이름을 쓴다 —
 *   `product_name`, `product_description`. 받는 쪽이 우리 이름을 새로 배우지 않아도
 *   된다. 그 워크플로를 이 주소로 갈아 끼우기만 하면 된다.
 *
 * 돌려주는 것이 그쪽보다 둘 더 많다
 *   그쪽은 골라 낸 코드와 `search_strategy_description`(말로 적은 근거)을 준다.
 *   우리는 거기에 둘을 얹는다.
 *
 *   첫째, **실제로 보낸 질의문과 실제 후보 목록.** 모델이 적은 설명은 틀릴 수 있지만
 *   질의문과 후보는 사실이라, 받는 쪽이 판정을 되짚을 수 있다.
 *
 *   둘째, **그 코드가 국내에서 무엇을 뜻하는지**(`domestic`). 표준 제품분류체계
 *   (K-GPC)는 GPC 브릭에 속성(사용 연령·재질)을 더해 대분류·인증구분·법정 품목을
 *   정하는 체계다. 담당자가 실제로 알고 싶은 것은 「10002225」가 아니라 「이건
 *   어린이제품이고 안전확인 대상인가」다. 다만 속성은 우리가 좁히지 않는다 —
 *   갈리는 갈래를 모두 보여 주고 무엇이 그것을 가르는지 적는다.
 *
 * 계층은 우리가 채운다
 *   모델에게 "이건 Brick이고 그 상위는 무엇"까지 자기보고하게 하지 않는다.
 *   고른 코드가 후보 목록의 어느 계위인지, 그 위가 무엇인지는 서버가 판정해 채운다
 *   (verify.ts resolveHierarchy). 그래서 계위와 상위 코드가 어긋날 수 없다.
 *
 * 인증은 미들웨어가 맡는다 — /api/jobs/ 를 뺀 모든 경로에 Basic 인증이 걸린다.
 */

interface Body {
  product_name?: unknown;
  product_description?: unknown;
  /** 후보를 몇 개까지 볼 것인가. 기본 15 — 좁히면 정답이 후보 밖으로 밀린다 */
  candidate_count?: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return Response.json({ error: 'JSON 본문을 읽지 못했습니다.' }, { status: 400 });
  }

  const productName = typeof body.product_name === 'string' ? body.product_name.trim() : '';
  const productDescription =
    typeof body.product_description === 'string' ? body.product_description.trim() : '';

  if (!productName && !productDescription) {
    return Response.json(
      { error: 'product_name 또는 product_description 중 하나는 있어야 합니다.' },
      { status: 400 },
    );
  }

  const n = Number(body.candidate_count);
  const candidateCount =
    Number.isInteger(n) && n >= 1 && n <= 30 ? n : DEFAULT_GPC_CANDIDATE_COUNT;

  try {
    const { verification: v, candidates, queryText, domestic } = await classifyProduct({
      name: productName || productDescription,
      context: productDescription || productName,
      candidateCount,
      // 이 조회는 어디에도 저장되지 않지만 이력에는 남긴다 —
      // 밖에서 무엇을 얼마나 물어보는지 모르면 비용도 품질도 관리할 수 없다
      subject: { type: 'ADHOC', key: productName || '(제품명 없음)', label: productName || null },
    });

    return Response.json({
      /*
        어느 계위까지 좁혔는가. BRICK 이 가장 아래이고, 그 위에서 멈췄다는 것은
        「GPC 에 없다」가 아니라 「후보가 갈려 더 좁히지 못했다」는 뜻이다.
        NONE 은 후보 중 맞는 것이 하나도 없다고 판단한 경우다.
      */
      level: v.level,
      brick_code: v.brickCode,
      brick_name: v.brickTitle,
      class_code: v.classCode,
      class_name: v.classTitle,
      family_code: v.familyCode,
      family_name: v.familyTitle,
      segment_code: v.segmentCode,
      segment_name: v.segmentTitle,
      confidence: v.confidenceScore,
      /** 왜 그 코드를(또는 상위 계위를) 골랐는지 */
      reasoning: v.reasoning,
      /** 무엇으로 찾았는지 — 벡터 색인에 실제로 보낸 문장 */
      query_text: queryText,
      /** 그때 실제로 나온 후보. 판정을 되짚는 재료다 */
      candidates: candidates.map((c) => ({
        rank: c.rank,
        brick_code: c.brickCode,
        brick_name: c.brickTitle,
        class_code: c.classCode,
        class_name: c.classTitle,
        family_code: c.familyCode,
        family_name: c.familyTitle,
        segment_code: c.segmentCode,
        segment_name: c.segmentTitle,
        similarity: c.similarity,
      })),
      /*
        이 코드가 국내에서 무엇을 뜻하는가 (K-GPC).
        routes 가 여럿이면 사용 연령·재질 같은 속성이 갈래를 가른다는 뜻이고,
        그 속성은 서류에 없는 일이 많아 담당자가 확정해야 한다.
      */
      domestic: domestic && {
        brick_code: domestic.brickCode,
        brick_title: domestic.brickTitle,
        groups_split: domestic.groupsSplit,
        certs_split: domestic.certsSplit,
        note: domestic.note,
        routes: domestic.routes.map((r) => ({
          item_group: r.itemGroup,
          cert_scheme: r.certScheme,
          item: r.item,
          sub_item: r.subItem,
        })),
      },
      model: v.model,
    });
  } catch (e) {
    console.error('GPC 판정 실패:', e);
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
