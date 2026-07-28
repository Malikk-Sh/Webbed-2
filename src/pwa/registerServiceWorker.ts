import { registerSW } from 'virtual:pwa-register';

/**
 * Регистрация service worker.
 *
 * Обновление никогда не применяется само: новая версия посреди комнаты
 * означала бы перезагрузку страницы во время прыжка. Игрок видит спокойное
 * уведомление и решает сам (раздел 35.3 ТЗ).
 */
export const registerServiceWorker = (onUpdateAvailable: (apply: () => void) => void): void => {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      onUpdateAvailable(() => void updateSW(true));
    },
    onOfflineReady() {
      console.info('[Silkbound] Игра готова к работе офлайн');
    },
    onRegisterError(error: unknown) {
      console.warn('[Silkbound] Service worker не зарегистрирован', error);
    },
  });
};
