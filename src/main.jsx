import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { inspectRecipient } from './recipient.js';

const CHANNEL = 'visiology-filter-test-v1';
const FILTERS = {"med_org": "34ed3988cfdd4498a73ef184ba8e9cd8", "doctors": "ec500187479f4be3b4ff67ff87cb2950", "positions": "18221ff86f214933af675eae17ee83f2", "months": "470ae632a05c455ea79715236b4a195b", "dates": "c7e385e7d084417a891099e3c5a79d8d"};
const MODES = { med_org: 'single', doctors: 'single', positions: 'single', months: 'single', dates: 'date' };
const DEFAULT_DATES = ['2026-07-31T21:00:00.000Z', '2026-09-30T20:59:59.999Z'];
const DEFAULT_VALUES = { med_org: [], doctors: ['Абакарова А. Г.'], positions: ['Врач-терапевт участковый'], months: ['2026-09-01T00:00:00Z'], dates: DEFAULT_DATES };

function App() {
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(null);
  const [dateMode, setDateMode] = useState('range');
  const [from, setFrom] = useState('2026-08-01');
  const [to, setTo] = useState('2026-09-30');
  const [textValues, setTextValues] = useState({ med_org: '', doctors: 'Абакарова А. Г.', positions: 'Врач-терапевт участковый' });
  const [month, setMonth] = useState('2026-09');
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
    let heardBridge = false;
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
        setStatus(heardBridge ? 'Код виджета отвечает, но готовность фильтров не подтверждена. Смотрите журнал.' : recipientState === 'blank' || recipientState === 'different'
          ? 'Iframe не перешёл на сервер Visiology. Проверьте Console и Network.'
          : 'Нет ответа принимающего кода. Проверьте его установку и нажмите «Проверить связь».');
        log(heardBridge ? 'За 30 секунд фильтры не готовы. Код виджета отвечает; список ожидания — в журнале.' : 'За 30 секунд нет ответа кода виджета. Проверьте его установку, allowedOrigin и ошибки Console.');
      }
    }
    function receive(event) {
      const data = event.data;
      if (event.origin !== frame.origin || !data || data.channel !== CHANNEL || data.session !== frame.session) return;
      if (data.type === 'WAITING' && event.source && !connected) {
        heardBridge = true;
        const issue = 'Код виджета отвечает. Ожидаем события загрузки: ' + JSON.stringify(data.waitingFor) + '; загружены: ' + JSON.stringify(data.loadedFilterIds);
        setStatus('Связь с кодом есть. Ожидаем готовность фильтров.');
        if (issue !== lastIssue) log(issue);
        lastIssue = issue;
        return;
      }
      // HELLO содержит случайный идентификатор, отправленный только origin iframe.
      // Ответ может прийти из вложенного окна виджета на том же origin.
      if (data.type === 'READY' && event.source && data.filters && Object.keys(data.filters).length === Object.keys(FILTERS).length && Object.keys(FILTERS).every(id => data.filters[id] && data.filters[id].guid === FILTERS[id] && data.filters[id].mode === MODES[id])) {
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
        setStatus('Нужен новый код виджета и все пять фильтров на открытом листе.');
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
      const ids = scope === 'all' ? Object.keys(FILTERS) : [scope];
      ids.forEach(id => {
        if (defaults) { filters[id] = DEFAULT_VALUES[id].slice(); return; }
        if (reset) { filters[id] = []; return; }
        if (id === 'dates') {
          if (!from || (dateMode === 'range' && (!to || from > to))) throw new Error('Проверьте даты начала и конца.');
          filters.dates = dateMode === 'single'
            ? [new Date(from + 'T00:00:00.000+03:00').toISOString()]
            : [new Date(from + 'T00:00:00.000+03:00').toISOString(), new Date(to + 'T23:59:59.999+03:00').toISOString()];
        } else if (id === 'months') {
          if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Выберите месяц.');
          filters.months = [month + '-01T00:00:00Z'];
        } else {
          const value = textValues[id].trim();
          if (!value && id !== 'med_org') throw new Error('Укажите значение: ' + id);
          filters[id] = value ? [value] : [];
        }
      });
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
    }, Object.keys(filters).length * 10000 + 5000);
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
    <header><span className="tag">ТЕСТ ИНТЕГРАЦИИ · ПЯТЬ ФИЛЬТРОВ</span><h1>Visiology внутри React</h1><p>МО, врач, должность, месячный период и даты — по отдельности и вместе.</p></header>
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
      <h2>Фильтры дашборда</h2>
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
      {[
        ['med_org', 'Фильтр МО'], ['doctors', 'Фильтр врач'], ['positions', 'Фильтр должность']
      ].map(([id, label]) => <fieldset key={id}>
        <legend>{label}</legend>
        <label>Точное значение из Visiology<input type="text" value={textValues[id]} placeholder={id === 'med_org' ? 'Все (пустое поле)' : ''} onChange={e => setTextValues(previous => ({ ...previous, [id]: e.target.value }))} /></label>
        <button disabled={!ready || busy} onClick={() => apply(id)}>Применить</button>
        {id === 'med_org' && <button className="secondary" disabled={!ready || busy} onClick={() => { setTextValues(previous => ({ ...previous, med_org: '' })); apply('med_org', true); }}>Все МО</button>}
      </fieldset>)}
      <fieldset>
        <legend>Фильтр период главный</legend>
        <label>Месяц<input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
        <button disabled={!ready || busy} onClick={() => apply('months')}>Применить месяц</button>
        <p className="hint">Обычный фильтр: передаётся строковый ключ месяца, например 2026-09-01T00:00:00Z.</p>
      </fieldset>
      <div className="row">
        <button disabled={!ready || busy} onClick={() => apply()}>Применить все пять фильтров</button>
        <button disabled={!ready || busy} onClick={() => { setFrom('2026-08-01'); setTo('2026-09-30'); setDateMode('range'); setMonth('2026-09'); setTextValues({ med_org: '', doctors: 'Абакарова А. Г.', positions: 'Врач-терапевт участковый' }); apply('all', false, true); }}>Восстановить исходные значения</button>
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
