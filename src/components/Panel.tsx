import Link from 'next/link';
import { GLOSSARY } from '@/lib/terms';

/**
 * 용어 풀이 — 화면 아래에 접어 둔다
 *
 * 담당자 지적: "전체적으로 이상한 표현 또는 이해가 어려운 단어/표현이 보입니다"
 *
 * 말 자체는 src/lib/terms.ts 에서 이미 담당자의 말로 바꿨다. 그래도 남는 것이
 * 있다 — "위해요인 코드"나 "재채점"처럼 이 업무에만 있는 개념은 아무리 쉽게 써도
 * 한 번은 설명이 필요하다. 그것을 본문에 늘어놓으면 화면이 설명서가 되므로,
 * 접어 두고 필요할 때 펼치게 한다.
 */
/**
 * 방금 누른 버튼이 무엇을 했는지 알려 주는 띠
 *
 * 클라이언트 자바스크립트 없이 간다 — 서버 액션이 결과 문장을 주소줄(?done=)에
 * 실어 되돌려 보내고 화면이 그것을 그린다. 이 프로젝트의 다른 화면들과 같은 방식이다.
 *
 * 이것이 없으면 생기는 일을 실제로 겪었다: 「분석 실행」을 눌렀는데 품목이
 * 확정되지 않아 분석이 만들어지지 않았고, 화면은 눌리기 전과 똑같아 보였다.
 * 아무 일도 일어나지 않은 것과 "일어났지만 결과가 없는 것"은 다르다.
 */
export function DoneBanner({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div className="mt-6 border-l-2 border-measure bg-measure-soft px-4 py-3 text-[13px] leading-relaxed text-ink-2">
      {message}
    </div>
  );
}

export function TermsNote() {
  return (
    <details className="mt-12 border-t border-rule pt-4">
      <summary className="cursor-pointer text-[12px] text-ink-3 hover:text-ink">
        이 화면에 나오는 말 풀이
      </summary>
      <dl className="mt-3 space-y-3">
        {GLOSSARY.map((t) => (
          <div key={t.word} className="border-t border-rule-soft pt-2.5">
            <dt className="text-[12px] font-medium">{t.word}</dt>
            <dd className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{t.meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * 업무 흐름 한 걸음
 *
 * who   이 걸음을 사람이 하는가 시스템이 하는가. 담당자가 가장 먼저 알고 싶은 것이
 *       "내가 지금 뭘 해야 하나"이므로, 기다리면 되는 걸음과 손을 대야 하는 걸음을
 *       눈으로 구별되게 한다.
 * note  그 걸음의 지금 상태(건수 등). 흐름도가 그림에 그치지 않고 현황판이 된다.
 * state 'here' 는 이 화면이 맡은 걸음. 앞뒤가 어디로 이어지는지 보이게 한다.
 */
export interface FlowStep {
  label: string;
  href?: string;
  who?: '사람' | '자동';
  note?: string;
  state?: 'done' | 'here' | 'todo';
}

/**
 * 업무 흐름 순서도 (담당자 요청, 2026-09-09)
 *
 * "각 페이지별 업무 흐름을 순서도 등 그래픽하게. 페이지가 길어질 수 있어 적당한
 *  크기로 명확하고 쉽게."
 *
 * 전에는 「기준 확인 → 조항 확인 → 시험방법 확인 → 분석에 사용」처럼 글자에
 * 화살표만 끼워 둔 줄이었다. 읽어야 알 수 있으니 사실상 아무도 안 읽는다.
 * 지금은 걸음마다 상자를 두고, 이 화면이 맡은 걸음을 굵게, 사람이 할 걸음을
 * 표시로 구별한다.
 *
 * 화면을 길게 만들지 않는다
 *   높이는 한 줄(약 4rem)로 묶고, 좁은 화면에서는 줄을 접지 않고 가로로 밀어
 *   본다. 접으면 화살표가 줄 앞머리로 가서 순서도가 아니라 낱말 목록이 된다.
 */
export function FlowChart({ steps }: { steps: FlowStep[] }) {
  return (
    <nav className="mt-5 overflow-x-auto border-y border-rule-soft py-3" aria-label="업무 흐름">
      <ol className="flex min-w-max items-stretch">
        {steps.map((step, index) => {
          const here = step.state === 'here';
          const done = step.state === 'done';
          const body = (
            <div
              className={`h-full min-w-[7.5rem] border px-2.5 py-1.5 ${
                here
                  ? 'border-ink bg-measure-soft'
                  : done
                    ? 'border-rule-soft bg-surface'
                    : 'border-rule-soft'
              }`}
            >
              <div className="flex items-baseline gap-1.5">
                <span className={`text-[12px] ${here ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                  {step.label}
                </span>
                {step.who === '사람' && (
                  <span className="border border-measure px-1 text-[9px] leading-tight text-measure">
                    사람
                  </span>
                )}
              </div>
              {step.note && (
                <div className="addr tnum mt-0.5 text-[10px] text-ink-3">{step.note}</div>
              )}
            </div>
          );
          return (
            <li key={step.label} className="flex items-stretch">
              {index > 0 && (
                <span className="flex items-center px-1.5 text-ink-3" aria-hidden="true">
                  →
                </span>
              )}
              {step.href ? (
                <Link href={step.href} className="block hover:opacity-80">{body}</Link>
              ) : (
                body
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** 화면 머리 — 라벨·제목·한 줄 설명. 화면마다 같은 자리에 같은 형태로 둔다 */
export function PageHead({
  label, title, lead, workflow,
}: {
  label: string;
  title: string;
  lead?: string;
  workflow?: FlowStep[];
}) {
  return (
    <header>
      <div className="label">{label}</div>
      <h1 className="mt-2 text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
      {lead && <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-2">{lead}</p>}
      {workflow && workflow.length > 0 && <FlowChart steps={workflow} />}
    </header>
  );
}

/**
 * 연결 실패 — 시스템이 잘못된 유일한 경우이므로 여기서만 적색을 쓴다.
 * 무엇이 잘못됐고 어떻게 고치는지 말한다. 사과하지 않는다.
 *
 * 원본 오류를 배포 환경에서는 감춘다
 *   postgres 연결 오류 문자열에는 접속 호스트·사용자·포트가 그대로 들어 있다.
 *   로컬에서는 그것이 곧 해결 단서지만, 배포된 사이트는 ID/PW 한 겹 뒤에 있을
 *   뿐이라 화면에 뿌릴 값이 아니다. 개발 중에만 보여 주고, 배포에서는 서버
 *   로그로만 남긴다.
 *
 * 안내 문구도 환경에 따라 다르다
 *   배포 사이트에는 .env.local 이 없다. 거기서 "그 파일을 채우세요"라고 하면
 *   담당자를 없는 파일로 보내게 된다.
 */
export function ConnectionError({ error }: { error: string }) {
  const isDev = process.env.NODE_ENV !== 'production';

  return (
    <section className="mt-8 border border-halt bg-halt-soft px-5 py-4">
      <div className="text-[13px] font-semibold text-halt">데이터베이스에 연결하지 못했습니다</div>

      {isDev ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
          <code className="addr">.env.local</code> 의 <code className="addr">DATABASE_URL</code> 을
          채우세요. Supabase 대시보드의 <span className="text-ink">Connect → Session pooler</span>{' '}
          연결 문자열입니다.
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-2">
          화면에 보이는 숫자는 지금 믿을 수 없습니다. 잠시 뒤 새로고침해 보시고, 계속
          같으면 Netlify 환경변수의 <code className="addr">DATABASE_URL</code> 과 Supabase
          프로젝트가 켜져 있는지 확인해야 합니다. 자세한 원인은 서버 기록에 남았습니다.
        </p>
      )}

      {isDev && (
        <pre className="addr mt-3 overflow-x-auto border border-rule bg-surface px-3 py-2 text-[11px] text-ink-2">
          {error}
        </pre>
      )}
    </section>
  );
}

/** 빈 화면은 안내가 아니라 다음 행동으로의 초대다 */
export function EmptyState({
  message, commands,
}: { message: string; commands?: Array<{ cmd: string; note: string }> }) {
  return (
    <section className="mt-8 border-t border-rule pt-6">
      <p className="text-[13px] text-ink-2">{message}</p>
      {commands?.length ? (
        <ol className="mt-3 space-y-2">
          {commands.map((c) => (
            <li key={c.cmd} className="text-[13px]">
              <code className="addr text-ink">{c.cmd}</code>
              <span className="ml-2 text-[12px] text-ink-3">{c.note}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function Row({ href, children }: { href?: string; children: React.ReactNode }) {
  const inner = (
    <div className="border-t border-rule py-3.5 transition-colors hover:bg-measure-soft/30">
      {children}
    </div>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}
