import './styles/ui.css';
import { GameApp } from './app/GameApp';
import { registerServiceWorker } from './pwa/registerServiceWorker';

const app = new GameApp();

app
  .boot()
  .then(() => {
    registerServiceWorker((update) => app.shellUi.showUpdateToast(update));
  })
  .catch((error: unknown) => {
    console.error('[Silkbound] Не удалось запустить игру', error);
    const hint = document.getElementById('loading-hint');
    if (hint) {
      hint.textContent =
        error instanceof Error
          ? `Ошибка запуска: ${error.message}`
          : 'Не удалось запустить игру';
      hint.style.color = '#ff7a6a';
    }
  });

// Диагностический доступ из консоли разработчика.
(window as unknown as { silkbound?: GameApp }).silkbound = app;
