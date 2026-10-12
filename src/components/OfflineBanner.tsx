import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, RefreshCw, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOnlineStatus } from "@/lib/offline/network";
import { getQueue } from "@/lib/offline/queue";
import { readOfflineMeta } from "@/lib/offline/storage";
import { syncNow } from "@/lib/offline/sync";

export function OfflineBanner() {
  const online = useOnlineStatus();
  const qc = useQueryClient();
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [meta, setMeta] = useState(readOfflineMeta());

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const q = await getQueue();
      if (!alive) return;
      setPending(q.length);
      setMeta(readOfflineMeta());
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [online]);

  if (online && pending === 0) return null;

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncNow(qc);
      setPending((await getQueue()).length);
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
          {online ? <Wifi className="h-4 w-4 shrink-0" /> : <CloudOff className="h-4 w-4 shrink-0" />}
          <span>
            {online
              ? `Есть ${pending} изм. для синхронизации с сервером`
              : "Офлайн-режим: данные и фото из локального кэша. Новые изделия и операции сохранятся и отправятся при сети."}
            {meta.lastSyncAt && online === false ? (
              <span className="ml-1 opacity-80">
                · обновлено {new Date(meta.lastSyncAt).toLocaleString()}
              </span>
            ) : null}
          </span>
        </div>
        {online && pending > 0 ? (
          <Button size="sm" variant="outline" className="h-8" disabled={syncing} onClick={() => void handleSync()}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Синхронизация..." : "Синхронизировать"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
