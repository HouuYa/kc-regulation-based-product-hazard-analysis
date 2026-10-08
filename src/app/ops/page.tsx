import { redirect } from 'next/navigation';

/**
 * 옛 주소 — 운영 화면은 관리 화면(/admin)의 「상태·알림」·「자동 작업」 탭으로 들어갔다 (P3-6).
 *
 * 즐겨찾기나 텔레그램 메시지에 남은 /ops 링크가 끊기지 않게 기본 탭으로 보낸다.
 */
export default function OpsRedirect() {
  redirect('/admin');
}
