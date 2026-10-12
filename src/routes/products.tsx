import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { fetchProductsFull, fetchProductsGemstones } from "@/lib/catalog";
import { deleteProductOfflineAware } from "@/lib/offline/mutations";
import { fmtMoney, fmtWeight, fmtCarat } from "@/lib/format";
import { matchesProductSearch } from "@/lib/product-search";
import { getProductStock } from "@/lib/product-stock";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { Gem, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AddProductDialog, EditProductDialog } from "@/components/AddProductDialog";

export const Route = createFileRoute("/products")({
  component: ProductsPage,
});

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return "неизвестная ошибка";
}

function ProductsPage() {
  const [q, setQ] = useState("");
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["products-full"],
    queryFn: fetchProductsFull,
    retry: (failureCount, err) => failureCount < 1 && !/statement timeout|canceling statement/i.test(getErrorMessage(err)),
  });

  const hasProducts = (data?.length ?? 0) > 0;

  const productsSorted = useMemo(() => {
    const items = data ?? [];
    return [...items].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [data]);

  const { data: gemstones = [] } = useQuery({
    queryKey: ["products-gemstones"],
    enabled: productsSorted.length > 0,
    queryFn: () => fetchProductsGemstones(qc),
    retry: 1,
  });

  const gemstonesByProductId = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const g of gemstones) {
      const pid = (g as any).product_id;
      if (!pid) continue;
      if (!map[pid]) map[pid] = [];
      map[pid].push(g);
    }
    return map;
  }, [gemstones]);

  const productsWithGemstones = useMemo(
    () => productsSorted.map((p: any) => ({ ...p, gemstones: gemstonesByProductId[p.id] ?? [] })),
    [productsSorted, gemstonesByProductId]
  );

  const filtered = productsWithGemstones.filter((p: any) => matchesProductSearch(p, q));

  return (
    <div className="space-y-6 p-6 md:p-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl">Harytlaryň sanawy</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} изделий
            {isFetching && !isPending ? " · обновление с сервера..." : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Gözleg: SKU, kod ýa-da ady..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
          />
          <AddProductDialog />
        </div>
      </header>

      {isPending && !hasProducts ? (
        <div className="text-muted-foreground">Загрузка...</div>
      ) : isError && !hasProducts ? (
        <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">
            Не удалось загрузить каталог: {getErrorMessage(error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Повторная загрузка..." : "Повторить"}
          </Button>
        </div>
      ) : (
        <>
          {isError && hasProducts && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
              Serwerdan tazelenip bilmedi ({getErrorMessage(error)}). Yatda saklanan maglumatlary galdy.
              <Button variant="link" className="h-auto p-0 pl-2" onClick={() => refetch()} disabled={isFetching}>
                Повторить
              </Button>
            </div>
          )}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p: any) => (
              <JewelryCard key={p.id} product={p} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function JewelryCard({ product: p }: { product: any }) {
  const qc = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remove = useMutation({
    mutationFn: async () => deleteProductOfflineAware(qc, p),
    onSuccess: (result) => {
      setConfirmOpen(false);
      if (!result.offline) {
        qc.invalidateQueries({ queryKey: ["products-full"] });
        qc.invalidateQueries({ queryKey: ["products-gemstones"] });
      }
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(result.offline ? "Удалено офлайн — синхронизируется при сети" : "Изделие удалено");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusColor: Record<string, string> = {
    "в наличии": "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200",
    "продано": "bg-muted text-muted-foreground",
    "на реставрации": "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200",
    "списано": "bg-destructive/15 text-destructive",
  };
  return (
    <Card className="overflow-hidden transition hover:shadow-md">
      <div className="flex aspect-square items-center justify-center overflow-hidden bg-gradient-to-br from-accent to-secondary">
        {p.image_url ? (
          <img src={p.image_url} alt={p.title} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <Gem className="h-16 w-16 text-gold opacity-60" />
        )}
      </div>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium leading-tight">{p.title}</h3>
          <Badge className={statusColor[p.status]} variant="secondary">{p.status}</Badge>
        </div>
        <div className="font-mono text-xs text-muted-foreground">{p.sku}</div>

        {p._pending && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-900 dark:text-amber-200">
            Сохранено локально — отправится при связи
          </div>
        )}

        <div className="rounded-md border bg-muted/30 p-3 text-xs">
          <div className="mb-2 font-semibold uppercase tracking-wider text-muted-foreground">Harydyň pasporty</div>
          <Row label="В наличии" value={`${getProductStock(p)} шт.`} />
          <Row label="Kategoriýa" value={p.categories?.name ?? "—"} />
          <Row label="Metall" value={`${p.metal_type} ${p.assay}°`} />
          {p.size && <Row label="Razmery" value={String(p.size)} />}
          <Row label="Umumy agramy" value={fmtWeight(p.total_weight)} />
          <Row label="Arassa agramy" value={fmtWeight(p.metal_weight)} />
          {p.gemstones && p.gemstones.length > 0 && (
            <div className="mt-2 border-t pt-2">
              <div className="mb-1 text-muted-foreground">Daşlar:</div>
              {p.gemstones.map((g: any) => (
                <Row key={g.id} label={`${g.stone_name} ×${g.quantity}`} value={fmtCarat(g.carat_weight)} />
              ))}
            </div>
          )}
        </div>

        <div className="flex items-end justify-between pt-1">
          <div className="text-xs text-muted-foreground">Baha</div>
          <div className="font-serif text-lg">{fmtMoney(p.sale_price)}</div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 h-4 w-4" />
            Изменить
          </Button>
          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="flex-1 text-destructive hover:text-destructive">
                <Trash2 className="mr-1.5 h-4 w-4" />
                Удалить
              </Button>
            </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Удалить изделие?</AlertDialogTitle>
              <AlertDialogDescription>
                «{p.title}» ({p.sku}) будет удалено без возможности восстановления. Связанные камни
                удалятся; в операциях ссылка на товар обнулится.
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

        <EditProductDialog product={p} open={editOpen} onOpenChange={setEditOpen} />
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
