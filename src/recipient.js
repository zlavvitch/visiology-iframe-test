// Проверяем только доступное браузеру окно. Чужой DOM не читаем.
export function inspectRecipient(target, expectedOrigin) {
  if (!target) return 'missing';
  try {
    if (target.location.href === 'about:blank') return 'blank';
    return target.location.origin === expectedOrigin ? 'expected' : 'different';
  } catch (failure) {
    // SecurityError означает другой origin. Доставку по-прежнему
    // ограничивает точный targetOrigin в postMessage.
    if (failure && failure.name === 'SecurityError') return 'cross-origin';
    return 'unavailable';
  }
}
