/**
 * Тонкая обёртка над IndexedDB со страховкой на localStorage.
 *
 * В приватном режиме Safari и в некоторых встроенных браузерах IndexedDB
 * открывается, но падает при первой записи, поэтому запасной путь обязателен:
 * потеря настроек не должна ронять игру.
 */

const DB_NAME = 'silkbound';
const DB_VERSION = 1;
const STORES = ['settings', 'progress', 'diagnostics'] as const;

export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;

const openDatabase = (): Promise<IDBDatabase | null> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      // Некоторые браузеры не вызывают ни один из обработчиков.
      setTimeout(() => finish(null), 2500);
    } catch {
      finish(null);
    }
  });

  return dbPromise;
};

const localKey = (store: StoreName, key: string) => `silkbound:${store}:${key}`;

const readLocal = <T>(store: StoreName, key: string): T | null => {
  try {
    const raw = localStorage.getItem(localKey(store, key));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};

const writeLocal = (store: StoreName, key: string, value: unknown): void => {
  try {
    localStorage.setItem(localKey(store, key), JSON.stringify(value));
  } catch {
    /* Приватный режим или переполненное хранилище — молча пропускаем. */
  }
};

export const readRecord = async <T>(store: StoreName, key: string): Promise<T | null> => {
  const db = await openDatabase();
  if (!db) return readLocal<T>(store, key);

  return new Promise<T | null>((resolve) => {
    try {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result as T) ?? readLocal<T>(store, key));
      request.onerror = () => resolve(readLocal<T>(store, key));
    } catch {
      resolve(readLocal<T>(store, key));
    }
  });
};

export const writeRecord = async (
  store: StoreName,
  key: string,
  value: unknown,
): Promise<void> => {
  // Дублируем в localStorage: он читается синхронно при первом кадре загрузки.
  writeLocal(store, key, value);

  const db = await openDatabase();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
};

/** Синхронное чтение для стартового кадра (масштаб интерфейса, качество). */
export const readRecordSync = <T>(store: StoreName, key: string): T | null =>
  readLocal<T>(store, key);
