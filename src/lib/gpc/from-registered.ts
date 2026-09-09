/**
 * 이미 신고된 품목분류 코드를 그대로 읽는다 — AI 를 부르지 않는다 (065)
 *
 * 왜 필요한가 (담당자 지적, 2026-09-09)
 *   "OECD 포털이 보내는 segment/family/class/brick 코드는 각 나라들이 OECD 포털에
 *    등록할 때 사용하는 코드로 신빙성이 매우 높습니다."
 *
 *   맞는 말이고, 우리가 그것을 버리고 있었다. 원본에 코드가 와 있는데도 읽지 않고
 *   필요할 때마다 우리 AI 로 다시 붙였다. 신고된 값을 놔두고 추정한 셈이고,
 *   값도 시간도 낭비였다.
 *
 * OECD 등록 규약 (원자료로 확인)
 *   docs/raw/OECD리콜등록/supabase/recalls_oecd_staging_rows.sql 안의 신고 XML 100건에서
 *   product_code 블록의 실제 모양을 셌다.
 *
 *     <product_code>
 *       <publication>2024-05-01</publication>
 *       <brick>10001840</brick>
 *     </product_code>
 *
 *     <product_code>
 *       <publication>2024-05-01</publication>
 *       <segment>71000000</segment><family>71020000</family><class>71020100</class>
 *     </product_code>
 *
 *   태그 분포 publication 100 · brick 84 · segment 16 · family 14 · class 6.
 *   **등록국이 좁힌 만큼만 채운다.** 브릭까지 못 좁히면 세그먼트나 패밀리에서 멈추고,
 *   아무것도 못 정하면 publication 만 남는다. 우리 계위 모델(BRICK/CLASS/FAMILY/
 *   SEGMENT/NONE)과 같은 규약이라 그대로 받아 쓸 수 있다.
 *
 * 계위를 코드 모양으로 짐작하지 않는다
 *   브릭 코드는 상위 코드의 접두를 따르지 않는다(청소제품 47100000 아래의
 *   석회제거제가 10000442 다 — docs/wiki/개념/GPC/표준제품분류체계_K-GPC.md §2).
 *   그래서 「8자리 중 뒤 네 자리가 0이면 패밀리」 같은 규칙을 쓸 수 없다.
 *   우리 카탈로그(gpc_brick)에서 그 코드가 어느 칸에 있는지 찾아 판정한다.
 *
 *   실측(2026-09-09): 원본이 준 코드 348종 중 341종은 브릭, 나머지는 클래스·패밀리
 *   모양이었다. 모양만 보고 전부 브릭으로 넣었으면 7종이 조용히 틀렸을 것이다.
 */

import { getDb } from '../db';
import type { GpcVerification } from './verify';
import type { GpcSource } from './provenance';

export interface RegisteredCodes {
  brick?: string | null;
  class?: string | null;
  family?: string | null;
  segment?: string | null;
  /** GPC 판. 판이 다르면 같은 번호가 다른 뜻일 수 있다 */
  publication?: string | null;
}

/**
 * OECD 신고 XML 의 product_code 블록에서 코드를 뽑는다.
 *
 * 정규식으로 읽는다. XML 파서를 새로 들이지 않는 것은 이 저장소가 xlsx 를 zip+XML
 * 직접 파싱으로 읽는 것과 같은 이유다(CLAUDE.md §10) — 태그 다섯 개를 읽자고
 * 의존성을 늘리지 않는다. 네임스페이스 접두가 붙어도 걸리도록 뒤에서 맞춘다.
 */
export function parseOecdProductCode(xml: string): RegisteredCodes | null {
  const block = /<product_code>([\s\S]*?)<\/product_code>/i.exec(xml);
  if (!block) return null;
  const body = block[1];
  const pick = (tag: string): string | null => {
    const m = new RegExp(`<(?:\\w+:)?${tag}>\\s*([^<]*?)\\s*</(?:\\w+:)?${tag}>`, 'i').exec(body);
    const v = m?.[1]?.trim();
    return v ? v : null;
  };
  return {
    brick: pick('brick'),
    class: pick('class'),
    family: pick('family'),
    segment: pick('segment'),
    publication: pick('publication'),
  };
}

/**
 * 신고된 코드를 우리 판정 모양으로 바꾼다. AI 호출이 없다.
 *
 * 가장 깊은 코드를 계위로 삼고, 그 위 계층은 카탈로그에서 채운다 — 신고서가
 * 상위를 안 적었어도 우리가 채울 수 있고, 적었더라도 카탈로그 값을 쓴다
 * (신고서의 상위 코드와 카탈로그가 어긋나면 카탈로그가 맞다고 본다. 상위는
 * 브릭이 정해지면 따라오는 값이라 신고자가 손으로 적을 이유가 없다).
 *
 * 카탈로그에서 코드를 못 찾으면 level 을 'NONE' 으로 두고 reasoning 에 그 사실을
 * 적는다. 지어내지 않는다 — 다른 판(publication)의 코드일 수 있다.
 */
export async function verificationFromRegistered(
  codes: RegisteredCodes,
  source: GpcSource,
): Promise<GpcVerification | null> {
  const wanted = [
    { level: 'BRICK' as const, code: codes.brick },
    { level: 'CLASS' as const, code: codes.class },
    { level: 'FAMILY' as const, code: codes.family },
    { level: 'SEGMENT' as const, code: codes.segment },
  ].filter((x) => x.code);
  if (wanted.length === 0) return null;

  const db = getDb();
  const empty = {
    segmentCode: null, segmentTitle: null,
    familyCode: null, familyTitle: null,
    classCode: null, classTitle: null,
    brickCode: null, brickTitle: null,
  };
  const base = {
    confidenceScore: 1,
    model: '',
    candidateCount: 0,
  };

  for (const { level, code } of wanted) {
    const col = level === 'BRICK' ? 'brick_code'
      : level === 'CLASS' ? 'class_code'
        : level === 'FAMILY' ? 'family_code' : 'segment_code';

    const [row] = await db<{
      brick_code: string; brick_title_ko: string | null; brick_title_en: string | null;
      class_code: string; class_title_ko: string | null; class_title_en: string | null;
      family_code: string; family_title_ko: string | null; family_title_en: string | null;
      segment_code: string; segment_title_ko: string | null; segment_title_en: string | null;
    }[]>`
      select brick_code, brick_title_ko, brick_title_en,
             class_code, class_title_ko, class_title_en,
             family_code, family_title_ko, family_title_en,
             segment_code, segment_title_ko, segment_title_en
      from public.gpc_brick
      where ${db.unsafe(col)} = ${code as string}
      limit 1
    `;
    if (!row) continue;

    const ko = (k: string | null, en: string | null) => k ?? en ?? null;
    const upper = {
      segmentCode: row.segment_code, segmentTitle: ko(row.segment_title_ko, row.segment_title_en),
      familyCode: row.family_code, familyTitle: ko(row.family_title_ko, row.family_title_en),
      classCode: row.class_code, classTitle: ko(row.class_title_ko, row.class_title_en),
    };

    if (level === 'BRICK') {
      return {
        ...base, level, ...upper,
        brickCode: row.brick_code, brickTitle: ko(row.brick_title_ko, row.brick_title_en),
        reasoning: `${source === 'OECD' ? '등록국이 OECD 포털에 신고한' : '리콜 원본 시스템이 부여한'} 브릭 코드 ${code} 를 그대로 읽었습니다. 상위 계층은 GPC 카탈로그에서 채웠습니다.`,
      };
    }
    if (level === 'CLASS') {
      return {
        ...base, level, ...upper, brickCode: null, brickTitle: null,
        reasoning: `신고된 코드 ${code} 는 클래스 계위입니다 — 등록국이 브릭까지 좁히지 않았습니다.`,
      };
    }
    if (level === 'FAMILY') {
      return {
        ...base, level,
        segmentCode: upper.segmentCode, segmentTitle: upper.segmentTitle,
        familyCode: upper.familyCode, familyTitle: upper.familyTitle,
        classCode: null, classTitle: null, brickCode: null, brickTitle: null,
        reasoning: `신고된 코드 ${code} 는 패밀리 계위입니다 — 등록국이 그 아래로 좁히지 않았습니다.`,
      };
    }
    return {
      ...base, level,
      segmentCode: upper.segmentCode, segmentTitle: upper.segmentTitle,
      familyCode: null, familyTitle: null, classCode: null, classTitle: null,
      brickCode: null, brickTitle: null,
      reasoning: `신고된 코드 ${code} 는 세그먼트 계위입니다 — 등록국이 그 아래로 좁히지 않았습니다.`,
    };
  }

  // 신고된 코드가 우리 카탈로그에 없다. 다른 판의 코드일 수 있으므로 그렇게 적는다
  return {
    ...base, level: 'NONE', ...empty,
    confidenceScore: 0,
    reasoning:
      `신고된 코드(${wanted.map((w) => w.code).join(', ')})를 우리 GPC 카탈로그에서 찾지 못했습니다. ` +
      (codes.publication ? `신고서의 판은 ${codes.publication} 입니다. ` : '') +
      '판이 다르면 같은 번호가 없거나 다른 뜻일 수 있습니다.',
  };
}
