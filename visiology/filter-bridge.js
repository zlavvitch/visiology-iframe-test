// Вставьте этот код в редактор JavaScript отдельного служебного виджета
// на том же листе, что и проверяемый фильтр. Код фильтра заменять не нужно.
(function () {
    const USER_CONFIG = {
        allowedOrigin: 'https://visiology-iframe-test.vercel.app',
        filterGuid: '09712aeaff3e4d75955d1b9a0652c087',
        channel: 'visiology-filter-test-v1',
        listenerGuid: 'visiology-react-filter-test-loaded'
    };
    const STATE_KEY = '__visiologyReactFilterBridgeV1';
    const previous = window[STATE_KEY];
    if (previous && typeof previous.dispose === 'function') previous.dispose();

    const api = visApi();
    let ready = false;
    let disposed = false;
    let peer = null;
    let session = null;
    let busy = false;
    const listeners = [];
    const timers = new Set();

    function selected() {
        return api.getSelectedValues(USER_CONFIG.filterGuid);
    }
    function matches(values, value) {
        return Array.isArray(values) && values.length === 1 &&
            Array.isArray(values[0]) && values[0].length === 1 && values[0][0] === value;
    }
    function send(type, details) {
        if (disposed || !peer || !session) return;
        peer.postMessage(Object.assign({
            channel: USER_CONFIG.channel, type: type, session: session,
            filterGuid: USER_CONFIG.filterGuid
        }, details), USER_CONFIG.allowedOrigin);
    }
    function announce() {
        if (ready) send('READY', { selected: selected() });
    }
    function receive(event) {
        if (disposed || event.origin !== USER_CONFIG.allowedOrigin || !event.source) return;
        const data = event.data;
        if (!data || data.channel !== USER_CONFIG.channel || typeof data.session !== 'string' || data.session.length > 100) return;
        // Источник должен быть родителем одного из окон дашборда.
        const isHost = listeners.some(function (entry) { return event.source === entry.host; });
        if (!isHost) return;
        if (data.type === 'HELLO') {
            if (busy) return;
            peer = event.source;
            session = data.session;
            announce();
            return;
        }
        if (event.source !== peer || data.session !== session || data.type !== 'SET_FILTER') return;
        if (typeof data.requestId !== 'string' || data.requestId.length > 100) return;
        const requestId = data.requestId;
        const value = data.value;
        if (!ready || busy || (value !== 'да' && value !== 'нет')) {
            send('ERROR', { requestId: requestId, message: 'Фильтр не готов, занят или передано недопустимое значение.' });
            return;
        }
        try {
            if (matches(selected(), value)) {
                send('RESULT', { requestId: requestId, selected: selected(), unchanged: true });
                return;
            }
            busy = true;
            let finished = false;
            let timer = null;
            const finish = function (type, details) {
                if (finished || disposed) return;
                finished = true;
                busy = false;
                if (timer !== null) { clearTimeout(timer); timers.delete(timer); }
                send(type, Object.assign({ requestId: requestId }, details));
            };
            // Проверяем фактический выбор; callback сам по себе не гарантирует загрузку данных.
            const verify = function () {
                if (finished || disposed) return;
                try {
                    const actual = selected();
                    if (matches(actual, value)) finish('RESULT', { selected: actual, unchanged: false });
                } catch (failure) {
                    finish('ERROR', { message: failure.message });
                }
            };
            timer = setTimeout(function () {
                timers.delete(timer);
                verify();
                if (!finished) finish('ERROR', { message: 'За 10 секунд API не подтвердил требуемое значение.' });
            }, 10000);
            timers.add(timer);
            try {
                api.setFilterSelectedValues(USER_CONFIG.filterGuid, [[value]], verify);
                verify();
            } catch (failure) {
                finish('ERROR', { message: failure.message });
            }
        } catch (failure) {
            busy = false;
            send('ERROR', { requestId: requestId, message: failure.message });
        }
    }

    // Поддерживает прямой iframe и вложенные окна на том же origin.
    // При переходе на чужой origin обход останавливается.
    let current = window;
    while (true) {
        try {
            if (current.location.origin !== window.location.origin) break;
            current.addEventListener('message', receive);
            listeners.push({ target: current, host: current.parent });
            if (current.parent === current) break;
            current = current.parent;
        } catch (failure) { break; }
    }
    const state = {
        dispose: function () {
            disposed = true;
            listeners.forEach(function (entry) { entry.target.removeEventListener('message', receive); });
            timers.forEach(function (timer) { clearTimeout(timer); });
            timers.clear();
            window.removeEventListener('pagehide', state.dispose);
        }
    };
    window[STATE_KEY] = state;
    window.addEventListener('pagehide', state.dispose);
    api.onWidgetLoadedListener({
        guid: USER_CONFIG.listenerGuid,
        widgetGuid: USER_CONFIG.filterGuid
    }, function () {
        if (disposed) return;
        ready = true;
        announce();
    });
}());
