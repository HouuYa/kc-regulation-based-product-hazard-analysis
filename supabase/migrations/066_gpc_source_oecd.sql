/*
  리콜 원본이 준 품목분류 코드의 출처를 OECD 로 바꾼다 (066)

  담당자 판단이다. 065 에서 우리는 이 코드를 SOURCE_AI(리콜 원본 시스템이 부여)로
  넣었는데, 담당자가 "OECD 로 넣기" 라고 지시했다. 앞선 설명이 근거다.

    "OECD 포털이 보내는 segment/family/class/brick 코드는 각 나라들이 OECD 포털에
     등록할 때 사용하는 코드로 신빙성이 매우 높습니다."

  담당자가 이 자료의 유통 경로를 아는 쪽이므로 그 판단을 따른다.

  ── 다만 우리가 관찰한 반대 근거를 그대로 남긴다 ─────────────────────────
  나중에 이 값을 의심할 일이 생기면 되짚을 수 있어야 하고, 되돌릴 수 있어야 한다.
  실측(2026-09-09, 승인·관리대상 2,356건):

    1) classification_method 가 전부 'ai_auto' 였다. 다른 값은 하나도 없었다.
    2) classification_confidence 에 0.75 같은 값이 들어 있었다 — 사람이나 규정이
       정한 코드에는 보통 확신도가 붙지 않는다.
    3) source_url 이 전부 각국 리콜 사이트였다. OECD 포털(globalrecalls.oecd.org)
       주소는 0건이다.
         FR 177 rappel.conso.gouv.fr      EU 918 ec.europa.eu
         EN 278 www.gov.uk               GE 255 www.baua.de
         US_CPSC 250 www.cpsc.gov        CN 180 www.samrdprc.org.cn
         AU 81 productsafety.gov.au      NZ 78 productsafety.govt.nz
         CA 67 recalls-rappels.canada.ca JP_RECALLPLUS 37 recall-plus.jp
         JP_METI 32 www.meti.go.jp       US_NHTSA 3 www.nhtsa.gov
    4) raw_data 에 _extract 구조가 들어 있었다 — 페이지에서 긁어 온 흔적이다.

  이 관찰만 보면 「각국 사이트에서 긁어 온 뒤 원본 시스템이 스스로 붙인 코드」로
  읽힌다. 담당자 판단과 다르므로 판단 쪽을 따르되 관찰을 지우지는 않는다.

  ── 되돌리는 법 ──────────────────────────────────────────────────────────
  update public.recall_cache set gpc_source = 'SOURCE_AI' where gpc_source = 'OECD';
  update public.case_event  set gpc_source = 'SOURCE_AI'
    where gpc_source = 'OECD' and id in (select case_id from public.recall_cache);

  ── 확인 방법 ────────────────────────────────────────────────────────────
  원본 시스템이 OECD 신고값을 어디에 두는지 확인되면 이 추정이 필요 없어진다.
  코드는 이미 그렇게 짜여 있다 — src/lib/recall/load.ts 가 classification_method 를
  보고 'oecd'·'source'·'registered' 이면 OECD 로, 아니면 SOURCE_AI 로 넣는다.
  066 은 그 판정을 담당자 지시로 덮어쓰는 한 번의 조치다.
*/

update public.recall_cache
set gpc_source = 'OECD'
where gpc_code is not null and gpc_source = 'SOURCE_AI';

-- 사람이 확정해 둔 값은 건드리지 않는다
update public.case_event e
set gpc_source = 'OECD'
from public.recall_cache c
where c.case_id = e.id
  and c.gpc_source = 'OECD'
  and e.gpc_source = 'SOURCE_AI';

update public.gpc_assignment
set source = 'OECD'
where source = 'SOURCE_AI';
