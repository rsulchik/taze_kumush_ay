import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { loadLocalTransactions, saveLocalTransactions, applyPendingTransactionOps } from "@/lib/offline/local-db";
import { deleteTransactionOfflineAware } from "@/lib/offline/mutations";
import { isBrowserOnline } from "@/lib/offline/network";
import { fmtMoney, fmtDate } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AddTransactionDialog } from "@/components/AddTransactionDialog";

export const Route = createFileRoute("/transactions")({
  component: TxPage,
});

const typeLabel: Record<string, string> = {
  sale: "Продажа",
  consignment: "Комиссия",
  return: "Возврат",
  "write-off": "Списание",
};


function TxPage() {
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["transactions"],
    queryFn: async () => {
      if (!isBrowserOnline()) {
        return (await loadLocalTransactions<any[]>()) ?? [];
      }
      try {
        const { data, error } = await supabase
          .from("transactions")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(100);
        if (error) throw error;
        // Не отправленные офлайн операции остаются видимыми поверх ответа сервера.
        const rows = await applyPendingTransactionOps(data ?? []);
        await saveLocalTransactions(rows);
        return rows;
      } catch (err) {
        const local = await loadLocalTransactions<any[]>();
        if (local?.length) return local;
        throw err;
      }
    },
    retry: 1,
  });

  const hasTx = (data?.length ?? 0) > 0;

  return (
    <div className="space-y-6 p-6 md:p-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">Satylan harytlar</h1>
          <p className="text-sm text-muted-foreground">Soňky 100 sany operasiýalar</p>
        </div>
        <AddTransactionDialog />
      </header>
      <Card>
        <CardHeader><CardTitle>Hasabat</CardTitle></CardHeader>
        <CardContent>
          {isPending && !hasTx ? (
            <div className="text-muted-foreground">Загрузка...</div>
          ) : isError && !hasTx ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                Не удалось загрузить операции: {error instanceof Error ? error.message : "неизвестная ошибка"}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                Повторить
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {isError && hasTx && (
                <p className="py-2 text-xs text-amber-800 dark:text-amber-200">
                  Сервер недоступен — показаны сохранённые операции.
                </p>
              )}
              {(data ?? []).map((t: any) => (
                <TransactionRow key={t.id} transaction={t} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TransactionRow({ transaction: t }: { transaction: any }) {
  const qc = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const label = typeLabel[t.type] ?? t.type;

  const remove = useMutation({
    mutationFn: async () => deleteTransactionOfflineAware(qc, t),
    onSuccess: (result) => {
      setConfirmOpen(false);
      if (!result.offline) {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["products-full"] });
        qc.invalidateQueries({ queryKey: ["products-min"] });
      }
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(result.offline ? "Удалено офлайн — синхронизируется при сети" : "Операция удалена");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <Badge variant="secondary">{label}</Badge>
        {t._pending && (
          <Badge variant="outline" className="ml-2 border-amber-500/40 text-[10px] text-amber-900 dark:text-amber-200">
            не отправлено
          </Badge>
        )}
        <span className="ml-3 text-sm text-muted-foreground">{t.employee_name ?? "—"}</span>
        {t.notes && <p className="mt-1 truncate text-xs text-muted-foreground">{t.notes}</p>}
      </div>
      <div className="flex items-center gap-3 sm:gap-6">
        <span className="text-xs text-muted-foreground">{fmtDate(t.created_at)}</span>
        <span className="w-28 text-right font-mono font-medium">{fmtMoney(t.final_price)}</span>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground hover:text-destructive">
              <Trash2 className="h-4 w-4" />
              <span className="sr-only">Удалить</span>
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить операцию?</AlertDialogTitle>
              <AlertDialogDescription>
                {label} на {fmtMoney(t.final_price)} от {fmtDate(t.created_at)} будет удалена без
                восстановления.
                {t.product_id && t.type !== "consignment"
                  ? " Остаток связанного изделия будет скорректирован."
                  : null}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={remove.isPending}
                onClick={(e) => {
                  e.preventDefault();
                  remove.mutate();
                }}
              >
                {remove.isPending ? "Удаление..." : "Удалить"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
