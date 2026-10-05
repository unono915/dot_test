import { useEffect, useState } from 'react';
import type { AppInfo } from '../main/ipc/contract';

type State = { kind: 'loading' } | { kind: 'ready'; info: AppInfo } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    window.schoolAsset.getAppInfo().then(
      (result) => {
        if (!active) return;
        setState(result.ok ? { kind: 'ready', info: result.data } : { kind: 'error', message: result.error.message });
      },
      () => active && setState({ kind: 'error', message: '프로그램 정보를 불러오지 못했습니다.' }),
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="shell">
      <h1>학교 정보자산 관리</h1>
      <p className="notice">
        개발 중인 기반 화면입니다. 업무 기능은 아직 제공하지 않습니다. 모든 자료는 이 PC에만 저장되며 외부로 전송하지 않습니다.
      </p>
      <section aria-labelledby="about-heading" className="card">
        <h2 id="about-heading">프로그램 정보</h2>
        {state.kind === 'loading' && <p role="status">불러오는 중…</p>}
        {state.kind === 'error' && <p role="alert">{state.message}</p>}
        {state.kind === 'ready' && (
          <dl>
            <dt>버전</dt>
            <dd data-testid="app-version">{state.info.version}</dd>
            <dt>Electron</dt>
            <dd>{state.info.electron}</dd>
            <dt>SQLite</dt>
            <dd data-testid="sqlite-version">{state.info.sqlite}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}
