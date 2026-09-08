/*
  제목이 같다는 사실도 연결의 근거가 된다 (063)

  지금까지 요건↔시험 연결은 두 가지 근거로만 만들었다.
    TEXT   본문이 다른 조항을 가리킨다 — 「5.9.2에 따라 시험한다」
    TABLE  표의 시험방법 열이 조항을 지목한다

  그런데 실측으로 76종 중 33종이 연결 0건이었다. 시험 조항이 68개나 있는데
  연결이 하나도 없는 기준도 있었다(안전확인 부속서 74 가정용 미용기기).
  들여다보니 부속서 계열은 요건과 시험을 **같은 제목으로 두 절에 나눠** 적는다.

      5.1 외장 온도       ← 요건 (얼마를 넘으면 안 되는가)
      6.2 외장 온도       ← 시험 (어떻게 재는가)

  본문이 서로를 가리키지 않으니 지금 규칙으로는 영영 이어지지 않는다.
  제목이 같다는 것 자체가 근거이므로 세 번째 출처를 만든다.

  왜 출처를 나눠 두는가
    근거가 다르면 믿을 정도도 다르다. 본문 참조는 문서가 직접 말한 것이고,
    제목 일치는 우리가 규칙으로 유추한 것이다. 나중에 이 규칙이 틀린 것으로
    드러나면 link_source='TITLE' 만 골라 되돌릴 수 있어야 한다.
    evidence_span 에는 어떤 제목이 겹쳐서 이었는지 남긴다.
*/

alter table public.clause_link
  drop constraint if exists clause_link_link_source_check;

alter table public.clause_link
  add constraint clause_link_link_source_check
    check (link_source in ('TABLE', 'TEXT', 'TITLE'));

comment on column public.clause_link.link_source is
  '연결의 근거 — TEXT(본문이 가리킴) · TABLE(표의 시험방법 열) · TITLE(요건과 시험의 제목이 같음, 063)';
