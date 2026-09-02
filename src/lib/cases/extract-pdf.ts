/**
 * L0 — 사고보고서 PDF 텍스트 추출 (설계문서 §4.2 L0, §8.1)
 *
 * 주된 실패 모드는 두 가지다.
 *   1) 표·서식이 깨져 문장이 뒤엉킨다 → 추출 결과를 화면에 그대로 노출해
 *      담당자가 눈으로 확인한다. 시스템이 조용히 넘어가지 않는다.
 *   2) 스캔본이라 텍스트 레이어가 없다 → 추출 글자 수가 0에 가까우면 그렇게 판정하고
 *      오류로 돌린다. 설계문서 0.3 가정3 이 "스캔본이면 OCR 단계 추가"라고 남겨 둔
 *      분기의 실측 지점이다(결정항목 12).
 *
 * 개인정보 (v0.7 §0.2 필수 수정사항)
 *   "외부 전송 전 비식별 검증·차단·격리 절차를 명시" 하라는 지적을 반영해,
 *   추출 직후 후보를 탐지하고 외부 LLM 호출 전에 막는다. 업로드된 파일이
 *   이미 비식별 처리됐다는 전제(결정 6번)를 믿기만 하면 안 되기 때문이다.
 */

import { extractImages, extractText, getDocumentProxy } from 'unpdf';
import sharp from 'sharp';

export interface ExtractResult {
  text: string;
  pageCount: number;
  charCount: number;
  /** 텍스트 레이어가 없는 스캔본으로 보이는가 */
  looksScanned: boolean;
  /** 발견된 개인정보 후보. 비어 있지 않으면 외부 전송을 막는다 */
  piiFindings: PiiFinding[];
}

export interface PiiFinding {
  kind: '주민등록번호' | '전화번호' | '이메일' | '계좌번호' | '카드번호';
  sample: string;
  count: number;
}

/** 페이지당 이 글자 수 미만이면 텍스트 레이어가 없는 것으로 본다 */
const SCANNED_CHARS_PER_PAGE = 50;

/**
 * 개인정보 후보 탐지.
 *
 * 완벽한 탐지가 목적이 아니다. 명백한 것을 놓치지 않는 것이 목적이다.
 * 걸리면 사람이 확인하게 만들고, 확인 전에는 외부로 내보내지 않는다.
 */
const PII_PATTERNS: Array<{ kind: PiiFinding['kind']; re: RegExp; minDigits?: number }> = [
  // 주민등록번호 — 생년월일 6자리 + 성별코드로 시작하는 7자리
  { kind: '주민등록번호', re: /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/g },
  { kind: '전화번호',     re: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g },
  { kind: '이메일',       re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g },
  { kind: '카드번호',     re: /\b(?:\d{4}[-\s]){3}\d{4}\b/g },
  {
    kind: '계좌번호',
    re: /\b\d{2,3}[-]\d{2,6}[-]\d{2,6}(?:[-]\d{1,6})?\b/g,
    // 사고조사보고서는 접수일자를 "25-11-24"(YY-MM-DD) 형태로 적는다. 이 모양이
    // 계좌번호 패턴에 그대로 걸린다 — 실제로 (25)48·(26)1 두 건에서 확인된 오탐이다.
    // 국내 계좌번호는 하이픈을 뺀 총 자릿수가 10~14 자리라 6자리 날짜와는 확실히
    // 구분되므로, 총 자릿수로 걸러낸다(형태소 분석 없이 자릿수만으로 충분).
    minDigits: 9,
  },
];

/** 값 자체를 로그에 남기지 않는다. 앞뒤만 남기고 가린다 */
function mask(s: string): string {
  if (s.length <= 4) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(Math.max(1, s.length - 4)) + s.slice(-2);
}

export function detectPii(text: string): PiiFinding[] {
  const out: PiiFinding[] = [];
  // 앞선 패턴이 잡은 구간은 지우고 넘긴다.
  // 그러지 않으면 전화번호가 계좌번호 패턴에도 걸려 같은 값이 두 번 보고된다.
  // 패턴 순서가 곧 우선순위이므로 구체적인 것부터 둔다.
  let remaining = text;

  for (const { kind, re, minDigits } of PII_PATTERNS) {
    re.lastIndex = 0;
    const hits: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(remaining)) !== null) {
      if (minDigits && m[0].replace(/\D/g, '').length < minDigits) continue;
      hits.push(m[0]);
    }
    if (!hits.length) continue;
    out.push({ kind, sample: mask(hits[0]), count: hits.length });
    for (const h of hits) remaining = remaining.replace(h, ' ');
  }
  return out;
}

export interface ExtractedPhoto {
  pageNumber: number;
  jpeg: Buffer;
  width: number;
  height: number;
}

/**
 * 가로·세로 둘 다 이 값 이상인 삽입 이미지만 사진으로 본다.
 *
 * 실물 5건으로 재 봤다(2026-09-02). 작은 서식·직인 이미지는 여러 건에서
 * 정확히 같은 크기(247×248)로 반복돼 사고 증거가 아님을 알 수 있었고,
 * 실제 사고 사진은 300~1000px 대였다. 완벽히 가르지는 못하므로(예: 247×248도
 * 통과할 수 있다) 애매한 것은 걸러내지 않고 비전 LLM에게 판단(`is_relevant_photo`)을
 * 맡긴다 — 놓치는 쪽보다 더 보내는 쪽이 안전하다.
 */
const MIN_PHOTO_DIMENSION = 200;

/** 사고보고서 PDF에서 삽입 사진을 뽑아 JPEG로 인코딩한다. 페이지 렌더링이 아니라
 *  PDF 안에 실제로 들어있는 이미지 오브젝트만 가져온다 — 표·텍스트는 안 섞인다 */
export async function extractPhotos(bytes: Uint8Array): Promise<ExtractedPhoto[]> {
  const doc = await getDocumentProxy(bytes);
  const out: ExtractedPhoto[] = [];

  for (let page = 1; page <= doc.numPages; page++) {
    const images = await extractImages(doc, page);
    for (const img of images) {
      if (img.width < MIN_PHOTO_DIMENSION || img.height < MIN_PHOTO_DIMENSION) continue;
      const jpeg = await sharp(img.data, {
        raw: { width: img.width, height: img.height, channels: img.channels },
      })
        .jpeg({ quality: 85 })
        .toBuffer();
      out.push({ pageNumber: page, jpeg, width: img.width, height: img.height });
    }
  }
  return out;
}

export async function extractPdf(bytes: Uint8Array): Promise<ExtractResult> {
  const doc = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(doc, { mergePages: true });

  const merged = Array.isArray(text) ? text.join('\n') : text;
  const charCount = merged.replace(/\s/g, '').length;

  return {
    text: merged,
    pageCount: totalPages,
    charCount,
    looksScanned: totalPages > 0 && charCount / totalPages < SCANNED_CHARS_PER_PAGE,
    piiFindings: detectPii(merged),
  };
}

/**
 * 외부 LLM 으로 보내도 되는지 판정한다.
 *
 * 설계문서 1.3.4 는 "개인정보 포함 가능성이 있어 비식별 처리 후 파일 전달" 이라
 * 적었지만, 그 전제가 지켜졌는지 확인하는 절차는 없었다.
 * v0.7 §0.2 가 지적한 구멍이 이것이고, 이 함수가 그 자리다.
 */
export function assertSafeForExternalLlm(result: ExtractResult): void {
  if (result.piiFindings.length === 0) return;
  const summary = result.piiFindings
    .map((f) => `${f.kind} ${f.count}건(예: ${f.sample})`)
    .join(', ');
  throw new Error(
    `개인정보로 보이는 값이 발견되어 외부 LLM 전송을 중단했습니다: ${summary}\n` +
      '비식별 처리 후 다시 업로드하거나, 담당자가 확인한 뒤 강제 진행 옵션을 사용하세요.',
  );
}
