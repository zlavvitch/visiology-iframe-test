/*
 * Технический виджет Visiology для проекта «Дашборд Мэра».
 * Разместить на листе со всеми настроенными фильтрами и сохранить дашборд.
 * Скрипт не выполняет вход, не выдаёт права и не меняет CSP.
 * Обмен: HELLO → READY → SET_FILTERS → RESULT / ERROR.
 * Фильтры задаются по именам из USER_CONFIG.filters, а не по входящим GUID.
 * Весь набор проверяется до установки. Применение последовательное,
 * НЕ атомарное: при ошибке уже применённые фильтры автоматически не откатываются.
 */
(function () {
    // 1. Настройки. Заглушку origin обязательно заменить.
    const USER_CONFIG = {
        allowedOrigin: 'https://visiology-iframe-test.vercel.app',
        channel: 'visiology-filter-test-v1',
        confirmationTimeoutMs: 10000,
        listenerGuid: 'visiology-react-filter-test-loaded',
        defaultFilterId: 'hospitals',
        filters: {
            dates: {
                guid: '49649e68eaaf4b37a20a88a9f33681b3',
                mode: 'date', allowedValues: null, allowClear: true,
                useTime: true // Сохраняем переданные границы суток с точностью до мс.
            },
            hospitals: {
                guid: 'e2fed87a050646b4a405891db926f42a',
                mode: 'multiple', allowedValues: ['ГКБ 1', 'ГКБ 15'], allowClear: true
            }
        }
    };
    const STATE_KEY = '__visiologyReactFilterBridge';
    const oldVersion = window.__visiologyReactFilterBridgeV1;
    if (oldVersion && typeof oldVersion.dispose === 'function') oldVersion.dispose();
    const previous = window[STATE_KEY];
    if (previous && typeof previous.dispose === 'function') previous.dispose();

    const api = visApi();
    const filterIds = Object.keys(USER_CONFIG.filters);
    const loaded = Object.create(null);
    const listeners = [];
    let disposed = false;
    let peer = null; // Окно отправителя. session ниже — метка обмена, не авторизация.
    let session = null;
    let busy = false; // Одна команда с набором фильтров; параллельная будет отклонена.
    let activeTimer = null;
    let pollTimer = null;
    let setupError = null;
    const owns = function (object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    };
    const validId = function (value) {
        return typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
    };
    const isReady = function () {
        return !setupError && filterIds.length > 0 && filterIds.every(function (id) { return loaded[id]; });
    };
    function stopTimer() {
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        if (activeTimer !== null) { clearTimeout(activeTimer); activeTimer = null; }
    }
    function selected(id) {
        return api.getSelectedValues(USER_CONFIG.filters[id].guid);
    }
    // Формат стандартного фильтра — [[значение], [значение]].
    // Для multiple сравниваем набор значений без учёта порядка.
    function matches(actual, values, id) {
        if (USER_CONFIG.filters[id].mode === 'date') {
            if (!Array.isArray(actual)) return false;
            // В разных версиях API даты могут быть плоским массивом или строкой матрицы.
            const flat = [].concat.apply([], actual);
            if (flat.length !== values.length) return false;
            return flat.every(function (value, index) {
                if (!(value instanceof Date) && typeof value !== 'string') return false;
                return new Date(value).getTime() === new Date(values[index]).getTime();
            });
        }
        if (!Array.isArray(actual) || actual.length !== values.length) return false;
        if (!actual.every(function (row) {
            return Array.isArray(row) && row.length === 1 && typeof row[0] === 'string';
        })) return false;
        const left = actual.map(function (row) { return row[0]; }).sort();
        const right = values.slice().sort();
        return left.every(function (value, index) { return value === right[index]; });
    }
    function send(type, details) {
        if (disposed || !peer || !session) return;
        peer.postMessage(Object.assign({
            channel: USER_CONFIG.channel, type: type, session: session
        }, details), USER_CONFIG.allowedOrigin);
    }
    function announce() {
        if (!peer || !session || disposed || busy) return;
        if (setupError) { send('ERROR', { code: 'SETUP_ERROR', message: setupError }); return; }
        if (!isReady()) return;
        try {
            const filters = Object.create(null);
            filterIds.forEach(function (id) {
                const config = USER_CONFIG.filters[id];
                filters[id] = { guid: config.guid, mode: config.mode, selected: selected(id) };
            });
            const defaultConfig = USER_CONFIG.filters[USER_CONFIG.defaultFilterId];
            send('READY', {
                filters: filters,
                // Эти два поля сохранены для прежнего отправителя с одним фильтром.
                filterGuid: defaultConfig.guid,
                selected: filters[USER_CONFIG.defaultFilterId].selected
            });
        } catch (failure) {
            send('ERROR', { code: 'READ_ERROR', message: failure.message });
        }
    }
    // 2. Проверка ВСЕГО набора до первого изменения фильтра.
    // Неизвестные имена, дубли и недопустимые значения отклоняют всю команду.
    function validate(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('filters должен быть объектом.');
        const requestedIds = Object.keys(input);
        if (requestedIds.length === 0) throw new Error('Передан пустой набор фильтров.');
        requestedIds.forEach(function (id) {
            if (!owns(USER_CONFIG.filters, id)) throw new Error('Неизвестный фильтр: ' + id);
        });
        // Порядок задаётся конфигом Visiology, а не порядком полей сообщения.
        return filterIds.filter(function (id) { return owns(input, id); }).map(function (id) {
            const config = USER_CONFIG.filters[id];
            const values = input[id];
            if (!Array.isArray(values)) throw new Error(id + ': ожидается массив строк.');
            if (values.length === 0 && !config.allowClear) throw new Error(id + ': пустой выбор запрещён.');
            if (config.mode === 'date') {
                if (values.length > 2) throw new Error(id + ': нужны одна или две даты.');
                if (!values.every(function (value) {
                    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
                        Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
                })) throw new Error(id + ': ожидаются корректные ISO-даты UTC.');
                if (values.length === 2 && Date.parse(values[0]) > Date.parse(values[1])) throw new Error(id + ': начало позже конца.');
            }
            if (config.mode === 'single' && values.length > 1) throw new Error(id + ': разрешён только одиночный выбор.');
            if (!values.every(function (value) { return typeof value === 'string'; })) throw new Error(id + ': значения должны быть строками.');
            if (values.some(function (value, index) { return values.indexOf(value) !== index; })) throw new Error(id + ': повторяющиеся значения.');
            if (config.allowedValues !== null && values.some(function (value) {
                return config.allowedValues.indexOf(value) === -1;
            })) throw new Error(id + ': недопустимое значение.');
            return { id: id, values: values.slice() };
        });
    }
    // 3. Последовательное применение. Данные виджетов могут пересчитываться
    // после каждого фильтра; API не используется как транзакция всего набора.
    function applyFilters(items, requestId, legacy) {
        busy = true;
        let completed = false;
        const results = Object.create(null);
        const appliedFilterIds = []; // Подтверждённые фильтры, в том числе уже выбранные.
        let index = 0;
        function finish(type, details) {
            if (completed || disposed) return;
            completed = true;
            busy = false;
            stopTimer();
            send(type, Object.assign({ requestId: requestId, results: results, appliedFilterIds: appliedFilterIds.slice() }, details));
        }
        function next() {
            if (completed || disposed) return;
            if (index === items.length) {
                // Другой фильтр мог сбросить предыдущий через настроенные влияния.
                // Перед общим RESULT повторно проверяем весь запрошенный набор.
                for (let checkIndex = 0; checkIndex < items.length; checkIndex += 1) {
                    const checked = items[checkIndex];
                    try {
                        const finalValues = selected(checked.id);
                        if (!matches(finalValues, checked.values, checked.id)) {
                            finish('ERROR', { failedFilterId: checked.id, partial: true, message: 'Итоговый выбор изменился после применения других фильтров. Проверьте влияния.' });
                            return;
                        }
                        results[checked.id].selected = finalValues;
                    } catch (failure) {
                        finish('ERROR', { failedFilterId: checked.id, partial: true, message: failure.message });
                        return;
                    }
                }
                const details = legacy ? results[USER_CONFIG.defaultFilterId] : {};
                finish('RESULT', details);
                return;
            }
            const item = items[index];
            let stepDone = false;
            function fail(message) {
                if (stepDone || completed || disposed) return;
                stepDone = true;
                finish('ERROR', {
                    failedFilterId: item.id,
                    message: message,
                    // Ошибочный фильтр мог изменить выбор до ошибки/тайм-аута.
                    // appliedFilterIds не означает, что остальные гарантированно не менялись.
                    requested: item.values,
                    observed: (function () { try { return selected(item.id); } catch (failure) { return String(failure.message); } }()),
                    partial: appliedFilterIds.length > 0
                });
            }
            function succeed(actual, unchanged) {
                if (stepDone || completed || disposed) return;
                stepDone = true;
                stopTimer();
                results[item.id] = { selected: actual, unchanged: unchanged };
                appliedFilterIds.push(item.id);
                index += 1;
                next();
            }
            function verify() {
                if (stepDone || completed || disposed) return;
                try {
                    const actual = selected(item.id);
                    if (matches(actual, item.values, item.id)) succeed(actual, false);
                } catch (failure) { fail(failure.message); }
            }
            try {
                const currentValues = selected(item.id);
                if (matches(currentValues, item.values, item.id)) { succeed(currentValues, true); return; }
                activeTimer = setTimeout(function () {
                    activeTimer = null;
                    verify();
                    if (!stepDone) fail('API не подтвердил выбор за отведённое время.');
                }, USER_CONFIG.confirmationTimeoutMs);
                // Ограниченное ожидание фактического выбора: у метода дат нет callback.
                pollTimer = setInterval(verify, 200);
                const config = USER_CONFIG.filters[item.id];
                if (config.mode === 'date') {
                    api.setDateFilterSelectedValues(config.guid,
                        item.values.map(function (value) { return new Date(value); }), config.useTime);
                } else {
                    api.setFilterSelectedValues(config.guid,
                        item.values.map(function (value) { return [value]; }), verify);
                }
                verify();
            } catch (failure) { fail(failure.message); }
        }
        next();
    }
    // 4. Сообщения только от разрешённого родительского окна и текущего обмена.
    function receive(event) {
        if (disposed || event.origin !== USER_CONFIG.allowedOrigin || !event.source) return;
        const data = event.data;
        if (!data || data.channel !== USER_CONFIG.channel || !validId(data.session)) return;
        if (!listeners.some(function (entry) { return event.source === entry.host; })) return;
        if (data.type === 'HELLO') {
            if (busy) return; // Не менять окно и session во время применения набора.
            peer = event.source;
            session = data.session;
            announce();
            return;
        }
        if (event.source !== peer || data.session !== session || !validId(data.requestId)) return;
        if (data.type !== 'SET_FILTERS' && data.type !== 'SET_FILTER') return;
        if (!isReady() || busy) {
            send('ERROR', { requestId: data.requestId, message: setupError || 'Фильтры не готовы или предыдущая команда ещё выполняется.', appliedFilterIds: [] });
            return;
        }
        try {
            const legacy = data.type === 'SET_FILTER';
            const input = legacy ? Object.create(null) : data.filters;
            if (legacy) input[USER_CONFIG.defaultFilterId] = [data.value];
            const items = validate(input);
            applyFilters(items, data.requestId, legacy);
        } catch (failure) {
            send('ERROR', { requestId: data.requestId, message: failure.message, appliedFilterIds: [] });
        }
    }
    // 5. Вложенные окна того же origin. На границе другого origin обход прекращается.
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
    // 6. Очистка предотвращает дубли после повторного запуска.
    // Тайм-аут или dispose не отменяет API и не откатывает значения.
    const state = {
        dispose: function () {
            disposed = true;
            stopTimer();
            listeners.forEach(function (entry) { entry.target.removeEventListener('message', receive); });
            window.removeEventListener('pagehide', state.dispose);
        }
    };
    window[STATE_KEY] = state;
    window.addEventListener('pagehide', state.dispose);
    // 7. READY только после загрузки ВСЕХ настроенных фильтров на этом листе.
    // Имена подписок разные для каждого фильтра; повторный запуск использует те же.
    try {
        if (!filterIds.length || !owns(USER_CONFIG.filters, USER_CONFIG.defaultFilterId)) throw new Error('Проверьте filters и defaultFilterId.');
        if (!Number.isFinite(USER_CONFIG.confirmationTimeoutMs) || USER_CONFIG.confirmationTimeoutMs <= 0) throw new Error('Некорректное время ожидания.');
        const guids = [];
        filterIds.forEach(function (id) {
            const config = USER_CONFIG.filters[id];
            if (!config || typeof config.guid !== 'string' || !/^[a-f0-9]{32}$|^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(config.guid)) throw new Error(id + ': укажите настоящий GUID.');
            if (guids.indexOf(config.guid.toLowerCase().replace(/-/g, '')) !== -1) throw new Error(id + ': GUID уже настроен.');
            guids.push(config.guid.toLowerCase().replace(/-/g, ''));
            if (config.mode !== 'single' && config.mode !== 'multiple' && config.mode !== 'date') throw new Error(id + ': неизвестный mode.');
            if (config.allowedValues !== null && (!Array.isArray(config.allowedValues) || !config.allowedValues.every(function (value) { return typeof value === 'string'; }))) throw new Error(id + ': проверьте allowedValues.');
        });
        filterIds.forEach(function (id) {
            api.onWidgetLoadedListener({ guid: USER_CONFIG.listenerGuid + '-' + id, widgetGuid: USER_CONFIG.filters[id].guid }, function () {
                if (disposed) return;
                loaded[id] = true;
                announce();
            });
        });
    } catch (failure) {
        setupError = failure.message;
        announce();
    }
}());
