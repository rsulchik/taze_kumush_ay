import { useEffect, useState } from "react";

export function isBrowserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
    return String(msg ?? "");
  }
  return String(error ?? "");
}

const TRANSIENT_MESSAGE =
  /statement timeout|canceling statement|failed to fetch|fetch failed|networkerror|network error|load failed|err_(internet|network|connection|name|address|connection_refused|connection_reset)|econnreset|econnrefused|econnaborted|etimedout|socket hang up|aborted|timed? ?out|bad gateway|gateway time-?out|service unavailable|502|503|504/i;

/**
 * true = ошибка похожа на проблему связи (или сервер не успел ответить) — операцию
 * имеет смысл сохранить в офлайн-очередь и повторить позже.
 *
 * false = это ответ сервера (нарушение constraint, RLS, неверные данные) — повтор
 * не поможет, нужно показать ошибку пользователю.
 */
export function isNetworkError(error: unknown): boolean {
  if (error == null) return false;
  if (!isBrowserOnline()) return true;

  const message = errorMessage(error);
  if (TRANSIENT_MESSAGE.test(message)) return true;

  // supabase-js отдаёт такие ошибки как PostgrestError с текстом "TypeError: Failed to fetch"
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) return true;

  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as Error).name)
      : "";
  if (/AbortError|TimeoutError|NetworkError/i.test(name)) return true;

  // Ответ Postgres/PostgREST — это точно не проблема сети.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code === "string" && code.length > 0) return false;

  return false;
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(isBrowserOnline());
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  return online;
}

export function onConnectivityChange(cb: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const on = () => cb(true);
  const off = () => cb(false);
  window.addEventListener("online", on);
  window.addEventListener("offline", off);
  return () => {
    window.removeEventListener("online", on);
    window.removeEventListener("offline", off);
  };
}
