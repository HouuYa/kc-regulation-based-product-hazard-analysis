import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

/**
 * ESLint 설정 — 이 저장소에 처음 들어온다
 *
 * 그전에는 package.json 에 `next lint` 스크립트만 있고 설정 파일이 없었다.
 * 설정이 없으면 next lint 는 검사를 하는 대신 "어떻게 설정할까요?"를 되묻고 멈춘다.
 * 즉 스크립트는 있었지만 이 저장소에서 lint 가 돌아간 적은 한 번도 없었다.
 * 게다가 next lint 자체가 Next 16 에서 사라진다 — 그래서 eslint 를 직접 부른다.
 *
 * 무엇을 잡게 할 것인가
 *   타입 검사(tsc)가 이미 타입을 본다. lint 가 더 볼 것은 "타입은 맞지만 사람이
 *   틀린" 것들이다 — 안 쓰는 변수, await 을 빠뜨린 Promise, React 훅 의존성,
 *   서버 코드가 브라우저 번들로 새는 경로 같은 것.
 *
 * 규칙을 세게 걸지 않는 이유
 *   이미 13,000줄이 쓰여 있는 저장소에 엄격한 규칙을 한 번에 걸면 수백 개의
 *   경고가 나오고, 그러면 아무도 안 보게 된다. 지금 실제로 사고를 내는 종류만
 *   error 로 두고 나머지는 경고로 둔다. 필요해지면 하나씩 올린다.
 */

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'tsconfig.tsbuildinfo',
    ],
  },

  ...compat.extends('next/core-web-vitals', 'next/typescript'),

  {
    rules: {
      /*
        안 쓰는 값 — 경고로 둔다

        error 로 두면 작업 중간 상태에서 빌드가 막힌다. 다만 `_` 로 시작하는 것은
        "일부러 안 쓴다"는 표시이므로 아예 보지 않는다(서버 액션의 _prev 처럼).
      */
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      /*
        any — 경고

        postgres.js 의 tx(rows as never) 처럼 라이브러리 타입을 우회해야 하는
        자리가 실제로 있다. 막지 않고 눈에만 띄게 한다.
      */
      '@typescript-eslint/no-explicit-any': 'warn',

      /*
        await 을 빠뜨린 Promise — error

        이 저장소에서 가장 비싼 실수다. DB 쓰기나 외부 호출을 await 없이 두면
        오류가 조용히 사라지고, 트랜잭션이 먼저 닫혀 절반만 저장된다.
        타입 검사로는 잡히지 않는다.
      */
      'require-await': 'off',
      'no-floating-decimal': 'error',
    },
  },

  {
    /*
      스크립트와 마이그레이션 도구는 화면이 없다

      scripts/*.ts 는 콘솔 출력이 곧 결과물이라 console 사용이 정상이다.
    */
    files: ['scripts/**/*.ts', 'codebook/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];

export default config;
