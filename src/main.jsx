import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { inspectRecipient } from './recipient.js';

const CHANNEL = 'visiology-filter-test-v1';
const FILTERS = { dates: '49649e68eaaf4b37a20a88a9f33681b3', hospitals: 'e2fed87a050646b4a405891db926f42a' };
const DEFAULT_DATES = ['2026-03-15T21:00:00.000Z', '2026-10-12T20:59:59.999Z'];

function App() {
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(null);
  const [dateMode, setDateMode] = useState('range');
  const [from, setFrom] = useState('2026-03-16');
  const [to, setTo] = useState('2026-10-12');
  const [hospitals, setHospitals] = useState(['ГКБ 1', 'ГКБ 15']);
  const [status, setStatus] = useState('Откройте дашборд.');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);
  const iframeRef = useRef(null);
  const bridgeRef = useRef(null);
  const pendingRef = useRef(null);
  const instanceRef = useRef(null);
  const recoverRef = useRef(null);

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
    let lastRecipientState = null;
    let lastIssue = null;
    function ping() {
      const target = iframeRef.current && iframeRef.current.contentWindow;
      const recipientState = inspectRecipient(target, frame.origin);
      if (recipientState === 'expected' || recipientState === 'cross-origin') {
        target.postMessage({ channel: CHANNEL, type: 'HELLO', session: frame.session }, frame.origin);
      } else if (recipientState !== lastRecipientState) {
        setStatus('Ждём перехода iframe на сервер Visiology…');
        log(recipientState === 'blank'
          ? 'Iframe ещё содержит начальную пустую страницу. Сообщения пока не отправляются.'
          : 'Iframe ещё не находится на ожидаемом сервере. Проверьте загрузку, CSP и перенаправления.');
      }
      lastRecipientState = recipientState;
      if (!connected) attempts += 1;
      if (!connected && attempts === 30) {
        setStatus(recipientState === 'blank' || recipientState === 'different'
          ? 'Iframe не перешёл на сервер Visiology. Проверьте Console и Network.'
          : 'Нет ответа принимающего кода. Проверьте его установку и нажмите «Проверить связь».');
        log('За 30 секунд связь не подтверждена. Проверьте содержимое iframe и ошибки браузера.');
      }
    }
    function receive(event) {
      const data = event.data;
      if (event.origin !== frame.origin || !data || data.channel !== CHANNEL || data.session !== frame.session) return;
      // HELLO содержит случайный идентификатор, отправленный только origin iframe.
      // Ответ может прийти из вложенного окна виджета на том же origin.
      if (data.type === 'READY' && event.source && data.filters && Object.keys(FILTERS).every(id => data.filters[id] && data.filters[id].guid === FILTERS[id])) {
        // Новая копия обработчика означает, что прежний результат неизвестен.
        // Повторно SET_FILTERS автоматически не отправляем.
        const pending = pendingRef.current;
        const changed = instanceRef.current !== data.instanceId || bridgeRef.current !== event.source;
        const shouldLog = !connected || changed;
        if (pending && changed) {
          clearTimeout(pending.timer);
          pendingRef.current = null;
          setBusy(false);
          setStatus('Обработчик перезапущен. Связь восстановлена; проверьте фактический выбор.');
          log('Ожидание прервано перезапуском. Команда не повторялась. Выбор: ' + JSON.stringify(data.filters));
        } else if (shouldLog && !pending) {
          setStatus('Связь установлена. Можно передавать фильтры.');
        }
        connected = true;
        attempts = 0;
        lastIssue = null;
        instanceRef.current = data.instanceId;
        bridgeRef.current = event.source;
        setReady(true);
        if (shouldLog) log('Принимающий код готов. Выбор в Visiology: ' + JSON.stringify(data.filters));
        return;
      }
      if (!connected && (data.type === 'READY' || data.type === 'ERROR')) {
        setStatus('Нужен новый код виджета и оба фильтра на открытом листе.');
        const issue = data.type === 'ERROR' ? String(data.message) : 'Состав фильтров в READY не совпадает с тестом: ' + JSON.stringify(data.filters);
        if (issue !== lastIssue) log(issue);
        lastIssue = issue;
        return;
      }
      if (event.source !== bridgeRef.current) return;
      const pending = pendingRef.current;
      if (!pending || pending.requestId !== data.requestId) return;
      if (data.instanceId !== instanceRef.current) return;
      if (data.type !== 'RESULT' && data.type !== 'ERROR') return;
      clearTimeout(pending.timer);
      pendingRef.current = null;
      setBusy(false);
      if (data.type === 'RESULT') {
        setStatus('Выбор подтверждён через API. Проверьте календарь и пересчёт данных.');
        log('Подтверждение: ' + JSON.stringify(data.results));
      } else {
        setStatus('Visiology не подтвердила применение фильтра.');
        log('Ошибка: ' + JSON.stringify(data));
      }
    }
    recoverRef.current = function () { connected = false; attempts = 0; bridgeRef.current = null; setReady(false); ping(); };
    window.addEventListener('message', receive);
    ping();
    const interval = setInterval(ping, 1000);
    // HELLO продолжает работать после READY: восстанавливает связь при перезапуске виджета.
    return () => {
      window.removeEventListener('message', receive);
      clearInterval(interval);
      recoverRef.current = null;
      if (pendingRef.current) clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
      setBusy(false);
    };
  }, [frame]);

  function apply(scope = 'all', reset = false, defaults = false) {
    if (!frame || !ready || !bridgeRef.current || pendingRef.current) return;
    let filters;
    try {
      filters = {};
      if (scope !== 'hospitals') {
        if (!reset && !defaults && (!from || (dateMode === 'range' && (!to || from > to)))) throw new Error('Проверьте даты начала и конца.');
        filters.dates = reset ? [] : defaults ? DEFAULT_DATES.slice() : dateMode === 'single'
          ? [new Date(from + 'T00:00:00.000+03:00').toISOString()]
          : [new Date(from + 'T00:00:00.000+03:00').toISOString(), new Date(to + 'T23:59:59.999+03:00').toISOString()];
      }
      if (scope !== 'dates') filters.hospitals = reset ? [] : defaults ? ['ГКБ 1', 'ГКБ 15'] : hospitals;
      if (!reset && filters.hospitals && !filters.hospitals.length) throw new Error('Выберите ГКБ или используйте кнопку сброса.');
    } catch (failure) { setError(failure.message); return; }
    setError('');
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setBusy(false);
      setReady(false);
      setStatus('Нет подтверждения. Восстанавливаем связь; проверьте фактический выбор.');
      log('Истёк срок ожидания. Восстанавливаем только связь, без повторной установки фильтров.');
      if (recoverRef.current) recoverRef.current();
    }, 25000);
    pendingRef.current = { requestId, timer };
    setBusy(true);
    setStatus('Применяем выбранные фильтры…');
    try {
      bridgeRef.current.postMessage({ channel: CHANNEL, type: 'SET_FILTERS', session: frame.session, requestId, filters }, frame.origin);
      log('Отправлено: ' + JSON.stringify(filters));
    } catch (failure) {
      clearTimeout(timer); pendingRef.current = null; setBusy(false); setError(failure.message);
    }
  }

  return <main>
    <header><span className="tag">ТЕСТ ИНТЕГРАЦИИ · ДАТЫ И ГКБ</span><h1>Visiology внутри React</h1><p>Проверка двух фильтров по отдельности и вместе. Даты передаются по московскому времени.</p></header>
    <section className="panel">
      <form onSubmit={open}>
        <label htmlFor="dashboard-url">Ссылка на тестовый дашборд</label>
        <div className="row"><input id="dashboard-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" autoComplete="off" /><button type="submit" disabled={busy}>Открыть дашборд</button></div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="hint">Сначала войдите в Visiology в отдельной вкладке этого браузера. Ссылка хранится только в памяти страницы.</p>
      {frame && <a href={frame.url} target="_blank" rel="noopener noreferrer">Открыть Visiology в отдельной вкладке</a>}
    </section>
    <section className="panel">
      <h2>Даты и ГКБ</h2>
      <fieldset>
        <legend>Фильтр дат</legend>
        <div className="row">
          <label>Режим<select value={dateMode} onChange={e => setDateMode(e.target.value)}><option value="range">Диапазон</option><option value="single">Одна дата</option></select></label>
          <label>Начало / дата<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          {dateMode === 'range' && <label>Конец<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>}
        </div>
        <button disabled={!ready || busy} onClick={() => apply('dates')}>Применить даты</button>{' '}
        <button className="secondary" disabled={!ready || busy} onClick={() => apply('dates', true)}>Сбросить даты</button>
      </fieldset>
      <fieldset>
        <legend>ГКБ: выберите одну или обе</legend>
        {['ГКБ 1', 'ГКБ 15'].map(name => <label key={name}><input style={{minWidth: 0}} type="checkbox" checked={hospitals.includes(name)} onChange={e => setHospitals(previous => e.target.checked ? [...previous, name] : previous.filter(value => value !== name))} /> {name}</label>)}
        <button disabled={!ready || busy} onClick={() => apply('hospitals')}>Применить ГКБ</button>{' '}
        <button className="secondary" disabled={!ready || busy} onClick={() => apply('hospitals', true)}>Сбросить ГКБ</button>
      </fieldset>
      <div className="row">
        <button disabled={!ready || busy} onClick={() => apply()}>Применить оба фильтра</button>
        <button disabled={!ready || busy} onClick={() => { setFrom('2026-03-16'); setTo('2026-10-12'); setDateMode('range'); setHospitals(['ГКБ 1', 'ГКБ 15']); apply('all', false, true); }}>Восстановить исходные значения</button>
        <button className="secondary" disabled={!frame || busy} onClick={() => { setReady(false); bridgeRef.current = null; setStatus('Повторная проверка связи…'); setFrame(previous => ({ ...previous, session: crypto.randomUUID() })); }}>Проверить связь</button>
      </div>
      <p role="status">{status}</p>
      <p className="hint">Одна дата проверяется через [Date]. Если календарь или данные ведут себя иначе, проверьте диапазон с одинаковыми датами начала и конца. При открытии значения автоматически не отправляются.</p>
    </section>
    <section className="viewer" aria-label="Область дашборда">
      {frame ? <iframe ref={iframeRef} key={frame.loadId} src={frame.url} title="Тестовый дашборд Visiology" referrerPolicy="no-referrer" onLoad={() => { log('Событие iframe load. Ожидаем отдельного подтверждения связи.'); }} /> : <div className="placeholder">Вставьте ссылку и нажмите «Открыть дашборд».</div>}
    </section>
    <section className="panel"><h2>Журнал событий</h2><p className="hint">Подтверждение фильтра означает совпадение выбора в API. Завершение загрузки данных проверяйте по виджетам. Ошибки CSP и сети — в DevTools → Console / Network.</p><ol aria-live="polite">{events.map((entry, index) => <li key={index}><time>{entry.time}</time> {entry.message}</li>)}</ol>{events.length === 0 && <p className="hint">Событий пока нет.</p>}</section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
