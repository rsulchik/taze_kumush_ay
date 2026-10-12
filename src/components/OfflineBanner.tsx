import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CloudOff, RefreshCw, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnlineStatus } from "@/lib/offline/network";
import {
  getQueue,
  getQueueSnapshot,
  removeOps,
  subscribeQueue,
  type PendingOp,
} from "@/lib/offline/queue";
import { readOfflineMeta } from "@/lib/offline/storage";
import { syncNow } from "@/lib/offline/sync";

export function OfflineBanner() {
  const online = useOnlineStatus();
  const qc = useQueryClient();
  const [ops, setOps] = useState<readonly PendingOp[]>(() => getQueueSnapshot());
  const [syncing, setSyncing] = useState(false);
  const [meta, setMeta] = useState(readOfflineMeta());

  useEffect(() => {
    const unsubscribe = subscribeQueue(setOps);
    void getQueue().then(setOps);
    return unsubscribe;
  }, []);

  useEffect(() => {
    const refresh = () => setMeta(readOfflineMeta());
    refresh();
    const id = window.setInterval(refresh, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
    };
  }, [online]);

  const failed = ops.filter((op) => op.blockedAt);
  const pending = ops.length;
  const lastError = meta.lastError ?? failed[failed.length - 1]?.lastError ?? null;

  if (online && pending === 0) return null;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncNow(qc, { retryBlocked: true });
      setMeta(readOfflineMeta());
    } finally {
      setSyncing(false);
    }
  };

  const handleSkipFailed = async () => {
    const confirmed = window.confirm(
      `Не удалось отправить на сервер: ${failed.length} изм.\n` +
        "Пропустить их? Локальные правки из этих изменений будут потеряны, " +
        "данные подтянутся с сервера.",
    );
    if (!confirmed) return;
    setSyncing(true);
    try {
      await removeOps((op) => !!op.blockedAt);
      await syncNow(qc, { retryBlocked: true });
      setMeta(readOfflineMeta());
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className={
        online
          ? "border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100"
          : "border-b border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-950 dark:text-sky-100"
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {online ? (
            <Wifi className="h-4 w-4 shrink-0" />
          ) : (
            <CloudOff className="h-4 w-4 shrink-0" />
          )}
          <span>
            {online
              ? `Есть ${pending} изм. для синхронизации с сервером`
              : "Офлайн-режим: данные и фото из локального кэша. Новые изделия и операции сохранятся и отправятся при сети."}
            {!online && meta.lastSyncAt ? (
              <span className="ml-1 opacity-80">
                · обновлено {new Date(meta.lastSyncAt).toLocaleString()}
              </span>
            ) : null}
          </span>
        </div>
        {online && pending > 0 ? (
          <div className="flex items-center gap-2">
            {failed.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={syncing}
                onClick={() => void handleSkipFailed()}
              >
                Пропустить неудачные
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={syncing}
              onClick={() => void handleSync()}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Синхронизация..." : "Синхронизировать"}
            </Button>
          </div>
        ) : null}
      </div>

      {online && failed.length > 0 && lastError && (
        <div className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-900/90 dark:text-amber-200/90">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="break-words">
            Не отправлено {failed.length} изм.: {lastError}
          </span>
        </div>
      )}
    </div>
  );
}
