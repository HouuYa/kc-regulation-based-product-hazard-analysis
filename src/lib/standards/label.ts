/**
 * 안전기준을 화면에 어떻게 부를 것인가 — 한 곳에서 정한다
 *
 * 왜 필요한가 (담당자 지적, 2026-09-09)
 *   "안전기준 담당자는 품목별로 여러 사람이 나눠 맡고 있어서, 자기 품목군이
 *   아니면 다른 품목에 대해선 일반인보다도 모르는 경우가 많다."
 *   그런 사람이 「KC 60335-2-17」만 보고 무엇을 검수할 수는 없다. 화면 어디서든
 *   번호 옆에 품목명이 함께 나와야 하고, 그 이름이 어디서 온 것인지도 밝혀야 한다.
 *
 * 이름의 출처는 셋이고 정확도가 다르다
 *   item_name   파일명 괄호에서 뽑은 품목명 — 부속서 계열. 문서 자체의 이름이라 확실하다.
 *   title_ko    문서 안 표제 — 전기용품 계열. 「제2-15부: 액체 가열용 전기기기의
 *               개별요구사항」처럼 부 번호와 상투구가 붙어 있어 그대로 쓰면 읽기 나쁘다.
 *   sub_items   품목→기준 대응표에서 온 세부품목 — AI 가 이어 붙인 미검수분이 섞여 있다.
 *               그래서 이것으로 이름을 지을 때는 화면에서 「검수 전」임을 함께 밝힌다.
 *
 * 지어내지 않는다. 셋 다 없으면 null 을 돌려주고, 화면은 「명칭 확인 필요」로 표시해
 * 담당자가 채울 일감으로 남긴다. 실측(2026-09-09) 76건 중 2건이 그렇다
 * (KC 60884-2-5 · KC 62133-2).
 */

export type ItemGroup = '전기용품' | '생활용품' | '어린이제품' | '기타';

/** 담당자가 늘 이 순서로 말한다 — 전기 · 생활 · 어린이 */
export const GROUP_ORDER: ItemGroup[] = ['전기용품', '생활용품', '어린이제품', '기타'];

export const GROUP_TONE: Record<ItemGroup, string> = {
  전기용품: 'border-measure text-measure',
  생활용품: 'border-rule text-ink-2',
  어린이제품: 'border-caution text-caution',
  기타: 'border-rule text-ink-3',
};

export function asGroup(v: string | null | undefined): ItemGroup {
  return GROUP_ORDER.includes(v as ItemGroup) ? (v as ItemGroup) : '기타';
}

/** 대분류를 무엇을 보고 정했는지 — 화면이 근거를 밝힐 수 있게 */
export const GROUP_SOURCE_NOTE: Record<string, string> = {
  TAXONOMY: '담당자 품목표의 대응에서',
  SCHEME: '인증 구분(전기용품·안전확인 등)에서 추정',
  NAME: '기준 이름에 어린이·유아·아동이 들어가 추정',
  UNKNOWN: '근거 없음',
};

/**
 * 「제2-15부: 액체 가열용 전기기기의 개별요구사항」 → 「액체 가열용 전기기기」
 *
 * 부 번호는 기준 번호에 이미 들어 있고(KC 60335-2-15), 「개별요구사항」은 모든
 * 제2부에 똑같이 붙는 상투구다. 둘 다 지우면 남는 것이 품목명이다.
 * 지우고 나서 남는 게 없으면 원문을 그대로 돌려준다 — 짧게 만들자고 이름을 없애지 않는다.
 */
export function shortTitle(titleKo: string | null | undefined): string | null {
  const raw = titleKo?.trim();
  if (!raw) return null;
  const cut = raw
    .replace(/^제\s*[\d\-­–—]+\s*부\s*[:：]?\s*/, '')
    .replace(/\s*(에 대한)?\s*개별\s*요구\s*사항\s*$/, '')
    .replace(/\s*[-–—]\s*개별요구사항\s*$/, '')
    .replace(/[,·\s]+$/, '')
    .trim();
  return cut.length >= 2 ? cut : raw;
}

export interface StandardNameSource {
  display_name: string;
  item_name?: string | null;
  title_ko?: string | null;
  sub_items?: string[] | null;
}

export interface StandardName {
  /** 화면에서 앞에 크게 내보내는 이름. 없으면 null */
  name: string | null;
  /** 기준 번호 — 항상 함께 보인다 */
  no: string;
  /** 이름을 어디서 가져왔는가 */
  from: 'item_name' | 'title_ko' | 'sub_items' | null;
}

export function standardName(s: StandardNameSource): StandardName {
  const no = s.display_name;
  const item = s.item_name?.trim();
  if (item) return { name: item, no, from: 'item_name' };

  const title = shortTitle(s.title_ko);
  if (title) return { name: title, no, from: 'title_ko' };

  const subs = (s.sub_items ?? []).map((x) => x.trim()).filter(Boolean);
  if (subs.length > 0) return { name: subs.slice(0, 2).join(', '), no, from: 'sub_items' };

  return { name: null, no, from: null };
}

/** 「전기요 (KC 60335-2-17)」 — 한 줄로 쓸 자리(본문 문장 안 등)에서 */
export function standardOneLine(s: StandardNameSource): string {
  const { name, no } = standardName(s);
  return name ? `${name} (${no})` : no;
}

/** 가나다 정렬. 한글 정렬은 DB 로캘에 기대지 않고 화면에서 한다 */
export function byKoreanName(a: StandardNameSource, b: StandardNameSource): number {
  const an = standardName(a).name ?? a.display_name;
  const bn = standardName(b).name ?? b.display_name;
  return an.localeCompare(bn, 'ko') || a.display_name.localeCompare(b.display_name, 'ko');
}

/* ──────────────────────────────────────────────────────────────────────────
   인증구분 — 대분류와는 별개의 축이다 (058, 담당자 지적)

   대분류가 「어느 법의 어느 품목군인가」라면, 인증구분은 「시장에 내보내기 전에
   무엇을 거쳐야 하는가」다. 둘은 서로를 결정하지 않는다 — 같은 전기용품 안에도
   안전인증 품목과 공급자적합성확인 품목이 함께 있다.

   부담이 큰 순서로 적는다. 담당자가 늘 이 순서로 말하고, 화면에서도 무거운 것이
   먼저 보이는 편이 낫다.
   ────────────────────────────────────────────────────────────────────────── */
export const CERT_TYPE_ORDER = [
  '안전인증',
  '안전확인',
  '공급자적합성확인',
  '안전기준준수',
  '안전성검사',
] as const;

export type CertType = (typeof CERT_TYPE_ORDER)[number];

/** 처음 보는 사람을 위한 한 줄 설명 — 화면 도움말에 그대로 쓴다 */
export const CERT_TYPE_NOTE: Record<string, string> = {
  안전인증: '인증기관의 제품시험과 공장심사를 받아야 판다',
  안전확인: '지정시험기관 시험성적서를 받아 신고하고 판다',
  공급자적합성확인: '제조·수입자가 스스로 확인하고 자료를 보관한다',
  안전기준준수: '기준만 지키면 되고 별도 절차는 없다',
  안전성검사: '사용 중인 제품을 주기적으로 검사받는다',
};

export function sortCertTypes(types: string[] | null | undefined): string[] {
  const list = (types ?? []).filter(Boolean);
  return [...new Set(list)].sort(
    (a, b) =>
      (CERT_TYPE_ORDER.indexOf(a as CertType) + 1 || 99) -
      (CERT_TYPE_ORDER.indexOf(b as CertType) + 1 || 99),
  );
}

export const CERT_SOURCE_NOTE: Record<string, string> = {
  FILENAME: '기준 문서 이름에서',
  TAXONOMY: '담당자 품목표에서',
  MANUAL: '담당자가 직접 지정',
};
