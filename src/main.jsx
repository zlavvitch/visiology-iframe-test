import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

function App() {
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(null);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);
  const [observed, setObserved] = useState(false);
  const iframeRef = useRef(null);

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
      setObserved(false);
      setFrame({ url: target.href, origin: target.origin, key: Date.now() });
      log('Создан iframe. Ожидаем загрузку.');
    } catch (failure) {
      setError(failure instanceof TypeError ? 'Некорректный URL. Укажите полный адрес с https://.' : failure.message);
    }
  }

  useEffect(() => {
    if (!frame) return undefined;
    function receive(event) {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== frame.origin) return;
      const type = event.data && typeof event.data === 'object' ? event.data.type : null;
      log(typeof type === 'string' ? `Получено сообщение: ${type.slice(0, 100)}` : 'Получено сообщение от iframe без поля type.');
    }
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frame]);

  return <main>
    <header><span className="tag">ТЕСТ ИНТЕГРАЦИИ · ЭТАП 1</span><h1>Visiology внутри React</h1><p>Проверка отображения дашборда без дополнительного входа.</p></header>
    <section className="panel">
      <form onSubmit={open}>
        <label htmlFor="dashboard-url">Ссылка на тестовый дашборд</label>
        <div className="row"><input id="dashboard-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…" autoComplete="off" /><button type="submit">Открыть дашборд</button></div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      <p className="hint">Ссылка хранится только в памяти страницы. Серверная отправка и аналитика не добавлены.</p>
      <div className="origin">Адрес стенда для настройки разрешения встраивания: <code>{window.location.origin}</code></div>
    </section>
    <section className="viewer" aria-label="Область дашборда">
      {frame ? <iframe ref={iframeRef} key={frame.key} src={frame.url} title="Тестовый дашборд Visiology" referrerPolicy="no-referrer" onLoad={() => log('Получено событие load. Оно не подтверждает успешное отображение или загрузку данных.')} /> : <div className="placeholder">Вставьте ссылку и нажмите «Открыть дашборд».</div>}
    </section>
    {frame && <section className="panel checks"><p>Проверьте содержимое iframe: виден ли дашборд и можно ли работать с ним без входа?</p><div className="row"><button type="button" onClick={() => { setObserved(true); log('Пользователь подтвердил: дашборд виден без входа.'); }}>Дашборд виден без входа</button><button type="button" className="secondary" onClick={() => log('Пользователь отметил проблему. Проверьте Console и Network в DevTools.')}>Есть проблема</button></div>{observed && <p className="success">Отображение подтверждено вручную. Передача фильтров ещё не проверена.</p>}</section>}
    <section className="panel"><h2>Журнал событий</h2><p className="hint">Браузер не позволяет стенду читать содержимое iframe другого origin. Ошибки CSP, сертификата и сети смотрите в F12 → Console / Network.</p><ol aria-live="polite">{events.map((entry, index) => <li key={index}><time>{entry.time}</time> {entry.message}</li>)}</ol>{events.length === 0 && <p className="hint">Событий пока нет.</p>}</section>
  </main>;
}

createRoot(document.getElementById('root')).render(<App />);
