/**
 * 요건 조항 ↔ 시험 조항을 제목으로 잇는다
 *
 *   npm run standards:link-tests            전부
 *   npm run standards:link-tests -- --dry   넣지 않고 무엇이 이어지는지만 본다
 *
 * 왜 필요한가
 *   분석 결과에서 조항은 찾아내는데 「그래서 어떤 시험을 의뢰하나」로 이어지지
 *   않는 일이 많았다. 실측으로 76종 중 33종이 시험방법 연결 0건이었다.
 *   그중에는 시험 조항이 68개나 있는데 연결이 하나도 없는 기준도 있었다
 *   (안전확인 부속서 74 가정용 미용기기).
 *
 *   지금까지 연결은 본문 참조(「5.9.2에 따라 시험한다」)와 표의 시험방법 열에서만
 *   만들었다. 그런데 부속서 계열은 요건과 시험을 **같은 제목으로 두 절에 나눠**
 *   적는 방식이 흔하다.
 *
 *       5.1 외장 온도            ← 요건 (얼마를 넘으면 안 되는가)
 *       6.2 외장 온도            ← 시험 (어떻게 재는가)
 *
 *   본문이 서로를 가리키지 않으므로 지금 규칙으로는 영영 이어지지 않는다.
 *   제목이 같다는 사실 자체가 근거다.
 *
 * 어디까지 잇고 어디서 멈추나 — 좁게 잡는다
 *   틀린 연결은 없는 연결보다 나쁘다. 담당자에게 엉뚱한 시험을 의뢰하게 만든다.
 *   그래서 아래를 모두 만족할 때만 잇는다.
 *     · 같은 기준, 같은 부(part)
 *     · 짧은 쪽 제목이 긴 쪽의 앞머리이고, 그 자리가 낱말 경계다
 *       (「작은 부품」 ↔ 「작은 부품 시험」 은 잇고, 「작은」 ↔ 「작은방」 은 안 잇는다)
 *     · 제목이 네 글자 이상이고 「시험방법·정의·일반」 같은 두루뭉술한 말이 아니다
 *     · 요건 쪽이 정의 절(3장 용어의 정의 등)에 들어 있지 않다
 *
 *   그래도 못 잇는 것이 남는다. KC 60335 계열은 요건과 시험이 아예 한 조항 안에
 *   같이 적혀 있어(「…을 초과하여서는 안 된다. 제어장치를 단락하여 시험한다」)
 *   나눌 짝 자체가 없다. 그것은 연결이 빠진 것이 아니라 그 계열의 서술 방식이다 —
 *   화면이 그렇게 말하게 하는 것이 맞지, 없는 짝을 지어낼 일이 아니다.
 */

import { getDb, closeDb } from '../src/lib/db';
// 규칙은 src/lib 로 옮겼다 — 병행 점검(070)이 같은 규칙으로 시험명을 조항에 맞춘다
import { STOP_TITLES as STOP, normTitle as norm, prefixMatch } from '../src/lib/standards/title-match';

interface Row {
  sid: number;
  std: string;
  id: number;
  marker: string;
  role: string;
  title: string;
  part: string | null;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const db = getDb();

  const rows = await db<Row[]>`
    select s.id as sid, s.display_name as std, c.id, c.marker,
           c.clause_role as role, coalesce(c.title_raw, '') as title, c.part
    from public.clause c
    join public.standard s on s.id = c.standard_id
    where s.is_current and c.clause_role in ('REQUIREMENT', 'TEST_METHOD')
  `;

  /*
    정의 절을 걸러 낸다.

    파서가 「3.17 팽창 재료 — 물에 닿았을 때 부피가 팽창하는 재료」 같은 용어
    풀이를 요건으로 분류해 둔 것이 있다. 낱말풀이를 시험에 이으면 담당자는
    "이 정의를 시험하라는 건가" 하고 멈춘다. 최상위 절의 제목으로 판별한다.
  */
  const rootTitle = new Map<string, string>();
  for (const r of rows) {
    if (!r.marker.includes('.')) rootTitle.set(`${r.sid}|${r.part ?? ''}|${r.marker}`, norm(r.title));
  }
  const inDefinitionSection = (r: Row) => {
    const root = r.marker.split('.')[0];
    const t = rootTitle.get(`${r.sid}|${r.part ?? ''}|${root}`) ?? '';
    return /^정의|용어/.test(t);
  };

  const byStd = new Map<number, Row[]>();
  for (const r of rows) {
    const a = byStd.get(r.sid) ?? [];
    a.push(r);
    byStd.set(r.sid, a);
  }

  interface Pair { from: number; to: number; toMarker: string; evidence: string; std: string }
  const pairs: Pair[] = [];

  for (const [, list] of byStd) {
    const reqs = list.filter((r) => r.role === 'REQUIREMENT');
    const tests = list.filter((r) => r.role === 'TEST_METHOD');
    if (tests.length === 0) continue;

    for (const q of reqs) {
      const nq = norm(q.title);
      if (!nq || nq.length < 4 || STOP.has(nq)) continue;
      if (inDefinitionSection(q)) continue;

      /*
        짝이 여럿이면 공통 제목이 가장 긴 것 하나만 쓴다. 「날카로운 끝」이
        여러 시험 절에 걸릴 때, 가장 많이 겹치는 것이 그 요건의 시험이다.
      */
      let best: { t: Row; hit: string } | null = null;
      for (const t of tests) {
        if (t.part !== q.part) continue;
        const nt = norm(t.title);
        if (!nt || STOP.has(nt)) continue;
        const hit = prefixMatch(nq, nt);
        if (!hit) continue;
        if (!best || hit.length > best.hit.length) best = { t, hit };
      }
      if (!best) continue;

      pairs.push({
        from: q.id,
        to: best.t.id,
        toMarker: best.t.marker,
        evidence: `제목 일치: 「${best.hit}」 — 요건 ${q.marker} · 시험 ${best.t.marker}`,
        std: q.std,
      });
    }
  }

  // 이미 있는 연결은 다시 넣지 않는다
  const existing = new Set(
    (await db<{ f: number; t: number }[]>`
      select from_clause_id as f, to_clause_id as t from public.clause_link
      where link_type = 'TEST_METHOD' and to_clause_id is not null
    `).map((r) => `${r.f}|${r.t}`),
  );
  const fresh = pairs.filter((p) => !existing.has(`${p.from}|${p.to}`));

  const perStd = new Map<string, number>();
  for (const p of fresh) perStd.set(p.std, (perStd.get(p.std) ?? 0) + 1);

  console.log(`제목으로 이을 수 있는 짝 ${pairs.length}건 · 그중 새로 잇는 것 ${fresh.length}건`);
  for (const [k, v] of [...perStd].sort((a, b) => b[1] - a[1])) console.log(`  ${k}  ${v}`);

  if (dry) {
    console.log('\n(dry — 넣지 않았습니다)');
    await closeDb();
    return;
  }

  for (const p of fresh) {
    await db`
      insert into public.clause_link
        (from_clause_id, to_clause_id, to_marker, link_type, link_source, evidence_span)
      values (${p.from}, ${p.to}, ${p.toMarker}, 'TEST_METHOD', 'TITLE', ${p.evidence})
    `;
  }
  console.log(`\n${fresh.length}건을 넣었습니다.`);
  await closeDb();
}

main().catch((e) => { console.error(e); process.exit(1); });
