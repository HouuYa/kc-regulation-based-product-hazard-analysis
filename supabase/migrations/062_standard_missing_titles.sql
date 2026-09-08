/*
  이름이 비어 있던 안전기준 두 종을 채운다 (062)

  배포 화면에서 「명칭 확인 필요」로 뜨던 둘이다. 파일명에 품목명이 없고
  (「42. KC 60884-2-5_result.json」) 문서 표제 파싱도 비어서, 담당자에게는
  번호만 보였다. 자기 품목군이 아니면 번호만으로는 아무것도 알 수 없다.

  지어내지 않고 문서 자신이 적어 놓은 말을 옮겼다. 근거를 함께 남긴다.

  KC 62133-2
    표지 원문: "KC 62133-2 전기용품안전기준 휴대기기용 밀폐 리튬이차전지 안전"
    적용범위(1절): "…비산성 전해액을 포함한 휴대형 밀폐 이차 리튬 단전지 및
    전지의 안전한 작동을 위한 요구사항 및 시험에 대하여 규정한다"
    → 표지의 한글 표제를 그대로 쓴다.

  KC 60884-2-5
    표지가 영문뿐이다: "Plugs and Socket-outlets for household and similar
    purposes Part 2-5 : Particular requirements for Adaptors"
    적용범위(1절): "…교류용 어댑터에만 적용한다"
    정의(3.101): "어댑터 — 이동형 접속 기구류에서 하나의 플러그 부분과 하나 이상의
    콘센트 부분을 조립하여 일체화한 구조로 된 것"
    → 같은 계열의 형제 기준이 「제2-1부:퓨즈형 플러그의 개별요구사항」처럼
      적혀 있으므로 그 형식을 따른다.

  왜 화면이 아니라 데이터를 고치나
    이름은 화면 열 곳에서 쓰인다. 화면마다 예외를 두면 한 곳을 고칠 때 나머지가
    어긋난다. 값이 하나뿐인 사실은 값이 있는 자리에 둔다.
*/

update public.standard
set title_ko = '휴대기기용 밀폐 리튬이차전지 안전'
where display_name = 'KC 62133-2' and nullif(btrim(title_ko), '') is null;

update public.standard
set title_ko = '제2-5부: 어댑터의 개별 요구사항'
where display_name = 'KC 60884-2-5' and nullif(btrim(title_ko), '') is null;
