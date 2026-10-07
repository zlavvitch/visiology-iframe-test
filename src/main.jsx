import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

const CHANNEL = 'visiology-filter-test-v1';
const FILTER_GUID = '09712aeaff3e4d75955d1b9a0652c087';

function App() {
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(null);
  const [value, setValue] = useState('да');
  const [status, setStatus] = useState('Откройте дашборд.');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);
  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  const pendingRef = useRef(null);

  function log(message) {
    setEvents(previous => [{ time: new Date().toLocaleTimeString('ru-RU'), message }, ...previous].slice(0, 50));
  }

  function open(event) {
    event.preventDefault();
    try {
      const target = new URL(url.trim());
      if (target.protocol !== 'https:') throw new Error('Укажите полный адрес дашборда с https://.');
      if (target.username || target.password) throw new Error('Ссылка не должна содержать логин или пароль.');
      setError('');
      setReady(false);
      setStatus('Ждём принимающий код Visiology…');
      bridgeRef.current = null;
      setFrame({ url: target.href, origin: target.origin, session: crypto.randomUUID(), loadId: crypto.randomUUID() });
      log('Создан iframe. Начинаем проверку связи.');
    } catch (failure) {
      setError(failure instanceof TypeError ? 'Некорректный URL. Укажите полный адрес с https://.' : failure.message);
    }
  }

  useEffect(() => {
    if (!frame) return undefined;
    let connected = false;
    let attempts = 0;
    function ping() {
      if (connected) return;
      const target = iframeRef.current && iframeRef.current.contentWindow;
      if (target) target.postMessage({ channel: CHANNEL, type: 'HELLO', session: frame.session }, frame.origin);
      attempts += 1;
      if (attempts === 30) {
        setStatus('Нет ответа принимающего кода. Проверьте его установку и нажмите «Проверить связь».');
        log('За 30 секунд связь не подтверждена. Событие load не доказывает готовность дашборда.');
      }
    }
    function receive(event) {
      const data = event.data;
      if (event.origin !== frame.origin || !data || data.channel !== CHANNEL || data.session !== frame.session) return;
      // HELLO содержит случайный идентификатор, отправленный только origin iframe.
      // Ответ может прийти из вложенного окна виджета на том же origin.
      if (data.type === 'READY' && event.source && data.filterGuid === FILTER_GUID) {
        connected = true;
        bridgeRef.current = event.source;
        setReady(true);
        setStatus('Связь установлена. Можно передавать фильтр.');
        log('Принимающий код готов. Выбор в Visiology: ' + JSON.stringify(data.selected));
        return;
      }
      if (event.source !== bridgeRef.current) return;
      const pending = pendingRef.current;
      if (!pending || pending.requestId !== data.requestId) return;
      if (data.type !== 'RESULT' && data.type !== 'ERROR') return;
      clearTimeout(pending.timer);
      pendingRef.current = null;
      setBusy(false);
      if (data.type === 'RESULT') {
        setStatus(`Фильтр подтверждён: «${pending.value}». Проверьте пересчёт данных.`);
        log(`Visiology подтвердила выбор: ${JSON.stringify(data.selected)}${data.unchanged ? ' (уже было выбрано)' : ''}.`);
      } else {
        setStatus('Visiology не подтвердила применение фильтра.');
        log('Ошибка: ' + String(data.message).slice(0, 300));
      }
    }
    window.addEventListener('message', receive);
    ping();
    const interval = setInterval(ping, 1000);
    const stop = setTimeout(() => clearInterval(interval), 30000);
    return () => {
      window.removeEventListener('message', receive);
      clearInterval(interval);
      clearTimeout(stop);
      if (pendingRef.current) clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
      setBusy(false);
    };
  }, [frame]);

  function apply() {
    if (!frame || !ready || !bridgeRef.current || pendingRef.current) return;
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setBusy(false);
      setStatus('Нет подтверждения за 15 секунд. Проверьте фактический выбор в дашборде.');
      log('Время ожидания ответа истекло. Автоматический повтор не выполняется.');
    }, 15000);
    pendingRef.current = { requestId, timer, value };
    setBusy(true);
    setStatus(`Передаём «${value}»…`);
    bridgeRef.current.postMessage({ channel: CHANNEL, type: 'SET_FILTER', session: frame.session, requestId, value }, frame.origin);
    log(`Отправлено значение «${value}».`);
  }

  return <main>
    <header><span className="tag">ТЕСТ ИНТЕГРАЦИИ · ЭТАП 2</span><h1>Visiology внутри React</h1><p>Передача одиночного фильтра «да / нет» в авторизованный дашборд.</p></header>
    <section className="panel">
      <form onSubmit={open}>
        <label htmlFor="dashboard-url">Ссылка на тестовый дашборд</label>
        <div className="row"><input id="dashboard-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" autoComplete="off" /><button type="submit">Открыть дашборд</button></div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="hint">Сначала войдите в Visiology в отдельной вкладке этого браузера. Ссылка хранится только в памяти страницы.</p>
      {frame && <a href={frame.url} target="_blank" rel="noopener noreferrer">Открыть Visiology в отдельной вкладке</a>}
    </section>
    <section className="panel">
      <h2>Фильтр «да / нет»</h2>
      <label htmlFor="filter-value">Значение для передачи</label>
      <div className="row"><select id="filter-value" value={value} disabled={busy} onChange={event => setValue(event.target.value)}><option value="да">да</option><option value="нет">нет</option></select><button type="button" disabled={!ready || busy} onClick={apply}>Применить фильтр</button><button type="button" className="secondary" disabled={!frame || busy} onClick={() => { setReady(false); bridgeRef.current = null; setStatus('Повторная проверка связи…'); setFrame(previous => ({ ...previous, session: crypto.randomUUID() })); }}>Проверить связь</button></div>
      <p role="status">{status}</p>
      <p className="hint">Выберите «нет» → примените, затем «да» → примените, затем повторно «да». При открытии значение автоматически не передаётся.</p>
    </section>
    <section className="viewer" aria-label="Область дашборда">
      {frame ? <iframe ref={iframeRef} key={frame.loadId} src={frame.url} title="Тестовый дашборд Visiology" referrerPolicy="no-referrer" onLoad={() => { log('Событие iframe load. Ожидаем отдельного подтверждения связи.'); }} /> : <div className="placeholder">Вставьте ссылку и нажмите «Открыть дашборд».</div>}
    </section>
    <section className="panel"><h2>Журнал событий</h2><p className="hint">Подтверждение фильтра означает совпадение выбора в API. Завершение загрузки данных проверяйте по виджетам. Ошибки CSP и сети — в DevTools → Console / Network.</p><ol aria-live="polite">{events.map((entry, index) => <li key={index}><time>{entry.time}</time> {entry.message}</li>)}</ol>{events.length === 0 && <p className="hint">Событий пока нет.</p>}</section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
