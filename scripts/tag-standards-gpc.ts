/**
 * KC안전기준(standard) GPC 코드 조회 + LLM 검증 (2026-09-02 착수 → 라운드 11 보강)
 *
 *   npm run standards:gpc -- --limit 5
 *
 * 조회+검증 오케스트레이션(후보 조회 → 없으면 NONE → 있으면 LLM 검증)은
 * case_event 쪽(scripts/load-cases.ts processPhotos)과 이제 findAndVerifyGpc()
 * (src/lib/gpc/assign.ts)로 완전히 공유한다(라운드 12 — 담당자가 "사고조사
 * GPC 부여에도 이 로직을 쓰냐"고 물어서 확인해 보니 아니었고, "최대한
 * 공유"하도록 리팩터링했다). 두 파이프라인이 다른 건 조회 입력을 무엇으로
 * 조합하는가뿐이다 — 여기는 아래 buildProductContext()가 기준 문서 필드를
 * 모으고, case_event 쪽은 사고사진 비전 분석 서술을 쓴다.
 *
 * 조회 입력 — "제공 정보는 그대로 두고" 나서 "최대한 제공"으로 방향이 바뀐 경위
 *   라운드 9: item_name + display_name(행정 분류명) → 5건 중 3건 오답.
 *   라운드 10: display_name 을 scope_text(적용범위 원문, 012_product_scope.sql)
 *     로 바꿈 → 0/5 정답에서 2/5 정답으로 개선됐지만, 남은 3건을 top-20 까지
 *     넓혀 보니 두 갈래로 갈렸다.
 *       ① 순위만 밀린 경우 — 정답이 후보 안에 있는데 1위가 아니다(예:
 *          "어린이용 물놀이기구"는 11위 "목욕/수영용 물놀이완구"가 정답에
 *          가까운데 1~3위는 무관한 "요실금 제품").
 *       ② 애초에 후보 안에 정답이 없는 경우 — 예초기 보호덮개·가죽제품처럼
 *          GPC 카탈로그에 대응 브릭이 없거나 KC기준이 여러 브릭에 걸친
 *          우산 카테고리(가죽제품의 "정의" 조항을 직접 읽어도 "가죽"이라는
 *          단어 자체가 없고 나이대만 규정한다 — 실측 확인).
 *   라운드 11: 담당자 지시로 (a) 조회 입력에 쓸 수 있는 컬럼을 다시 검토해
 *     scope_text 외에 clause_role='DEFINITION'(용어의 정의) 조항 본문과
 *     level_name='서문'(전문) 조항 본문을 추가로 모아 붙이고, (b) 후보를
 *     5개가 아니라 15개까지 넓혀 LLM(verifyGpcMatch)이 그 안에서 실제로
 *     맞는 것을 고르거나 'NONE'을 고르게 했다.
 *
 *     그런데 "가죽제품 = ② 카탈로그에 대응 브릭이 없다"는 판단은 실제로는
 *     틀렸다는 게 라운드 11 안에서 다시 확인됐다 — 원격 GPC 테이블(5,281건,
 *     로컬 참고 JSON은 100건짜리 샘플일 뿐이었다)을 직접 찾아보니 "가방"
 *     "벨트" "지갑" 브릭이 실제로 있었고, 표준 9의 6.2조(표시사항)에도
 *     "지갑류, 가방류, 벨트류, 신발류"라고 정확히 나열돼 있었다. 그런데도
 *     top-50까지 넓히고 그 문구를 조회 입력에 넣어도 이 임베딩 인덱스는
 *     "가방"·"지갑" 단어 하나만 조회해도 그 브릭을 못 찾을 만큼 근본적으로
 *     약했다(반면 "벨트"는 찾아졌다) — 이건 조회 입력의 문제가 아니라 이
 *     임베딩 인덱스 자체의 한계다.
 *
 *     그래서 이 협회가 실제로 운영 중인 해외리콜 OECD 파이프라인
 *     (docs/raw/OECD리콜등록/(GS1) [한국리콜__OECD] OECD GPC RAG.json,
 *     recalls_oecd_staging 저장)의 패턴을 그대로 재사용하기로 했다 — 그
 *     파이프라인도 같은 oecd_gpc_202405/match_documents_202405 를 쓰지만,
 *     Brick이 후보와 명확히 안 맞으면 NONE으로 포기하지 않고 Class→Family→
 *     Segment로 단계적으로 내려가며 답한다. verifyGpcMatch() 가 이제 이
 *     계층적 하향을 지원한다(src/lib/gpc/verify.ts) — "정확한 Brick은
 *     아니지만 이 대분류에는 속한다"는 정보가 아무것도 없는 것보다 낫다.
 *
 * item_name 이 null 인 표준(KC 60335-2-xx 류 베이스표준)은 대상에서 뺀다 —
 * 조회에 넣을 품목명 자체가 없다.
 *
 * --limit 을 필수로 둔 이유
 *   is_current 표준이 76건이라 전량을 돌리면 LLM 임베딩·검증 호출 비용이
 *   든다. CLAUDE.md §6 규칙대로 전량 배치는 사용자 승인 없이 조용히 돌리지
 *   않는다 — 실수로 --limit 을 빼면 즉시 에러로 멈추게 만들어 둔다.
 */

import { getDb, closeDb } from '../src/lib/db';
import { findAndVerifyGpc, DEFAULT_GPC_CANDIDATE_COUNT } from '../src/lib/gpc/assign';

/** 좁게 뽑으면(5개) 정답이 후보 밖으로 밀려날 수 있다(라운드 10 실측) — lookup.ts 공유 기본값 */
const CANDIDATE_COUNT = DEFAULT_GPC_CANDIDATE_COUNT;

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

interface StandardRow {
  id: number;
  item_name: string;
  display_name: string;
  cert_scheme: string | null;
  scope_text: string | null;
  preface: string | null;
  definitions: string | null;
}

/** 조회·검증에 넣을 서술 텍스트를 최대한 모아 조합한다(라운드 11, "정확성이 우선") */
function buildProductContext(s: StandardRow): string {
  return [
    `품목명: ${s.item_name}`,
    `기준명: ${s.display_name}`,
    s.cert_scheme ? `인증구분: ${s.cert_scheme}` : '',
    s.scope_text?.trim() ? `적용범위: ${s.scope_text.trim()}` : '',
    s.preface?.trim() ? `서문: ${s.preface.trim()}` : '',
    s.definitions?.trim() ? `용어의 정의: ${s.definitions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function main() {
  const limitArg = argValue('--limit');
  if (!limitArg) {
    throw new Error(
      '--limit 을 지정하세요 (전량 배치 방지). 예: npm run standards:gpc -- --limit 5',
    );
  }
  const limit = Number(limitArg);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit 값이 올바르지 않습니다: ${limitArg}`);
  }

  const db = getDb();
  const rows = await db<StandardRow[]>`
    select
      s.id, s.item_name, s.display_name, s.cert_scheme, s.scope_text,
      (select c.body from public.clause c
        where c.standard_id = s.id and c.level_name = '서문'
        order by c.order_index limit 1) as preface,
      (select string_agg(c.body, ' ' order by c.order_index) from public.clause c
        where c.standard_id = s.id and c.clause_role = 'DEFINITION') as definitions
    from public.standard s
    where s.is_current = true and s.item_name is not null and s.gpc_verification is null
    order by s.id
    limit ${limit}
  `;

  console.log(`대상 ${rows.length}건 (item_name 있고 아직 검증 전) — 후보 ${CANDIDATE_COUNT}개, LLM 검증 포함`);
  if (rows.length === 0) return;

  for (const s of rows) {
    try {
      const context = buildProductContext(s);
      const { candidates, verification } = await findAndVerifyGpc(s.item_name, context, CANDIDATE_COUNT, { standardId: Number(s.id) });
      const top = candidates[0] ?? null;

      await db`
        update public.standard
        set gpc_brick_code            = ${top?.brickCode ?? null},
            gpc_candidates            = ${db.json(candidates as never)},
            gpc_verified_level        = ${verification.level},
            gpc_verified_segment_code  = ${verification.segmentCode},
            gpc_verified_segment_title = ${verification.segmentTitle},
            gpc_verified_family_code  = ${verification.familyCode},
            gpc_verified_family_title  = ${verification.familyTitle},
            gpc_verified_class_code   = ${verification.classCode},
            gpc_verified_class_title   = ${verification.classTitle},
            gpc_verified_brick_code   = ${verification.brickCode},
            gpc_verified_brick_title   = ${verification.brickTitle},
            gpc_verification          = ${db.json(verification as never)}
        where id = ${s.id}
      `;

      const label =
        verification.level === 'NONE'
          ? 'NONE(맞는 후보 없음)'
          : `${verification.level} ${
              { BRICK: verification.brickCode, CLASS: verification.classCode, FAMILY: verification.familyCode, SEGMENT: verification.segmentCode }[
                verification.level
              ]
            } ${
              { BRICK: verification.brickTitle, CLASS: verification.classTitle, FAMILY: verification.familyTitle, SEGMENT: verification.segmentTitle }[
                verification.level
              ]
            }`;
      const embeddingLine = top ? `  임베딩 1위 : ${top.brickCode} ${top.brickTitle}\n` : '  임베딩 후보 없음\n';
      console.log(
        `${s.display_name} (${s.item_name})\n` +
          embeddingLine +
          `  LLM 검증   : ${label} (확신 ${verification.confidenceScore}) — ${verification.reasoning}`,
      );
    } catch (e) {
      console.warn(`실패 ${s.display_name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main()
  .catch((e) => {
    console.error('실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
