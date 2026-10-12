import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { saveTransactionOfflineAware } from "@/lib/offline/mutations";
import { matchesProductSearch } from "@/lib/product-search";
import { fetchProductsForPicker, getProductStock } from "@/lib/product-stock";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Check, Plus, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

const TYPES = [
  { v: "sale", l: "Продажа" },
  { v: "return", l: "Возврат" },
  { v: "write-off", l: "Списание" },
  { v: "consignment", l: "Комиссия" },
];

const MAX_RESULTS = 80;

export function AddTransactionDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [form, setForm] = useState({ product_id: "", type: "sale", final_price: "", employee_name: "", notes: "" });

  const {
    data: products,
    isLoading: productsLoading,
    isError: productsError,
  } = useQuery({
    queryKey: ["products-min"],
    queryFn: fetchProductsForPicker,
    enabled: open,
  });

  const save = useMutation({
    mutationFn: async () => saveTransactionOfflineAware(qc, form),
    onSuccess: (result) => {
      if (!result.offline) {
        qc.invalidateQueries({ queryKey: ["transactions"] });
        qc.invalidateQueries({ queryKey: ["products-full"] });
        qc.invalidateQueries({ queryKey: ["products-min"] });
      }
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(
        result.offline
          ? "Операция сохранена офлайн — синхронизируется при сети"
          : "Операция добавлена",
      );
      setOpen(false);
      resetForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const productList = products ?? [];
  const selectedProduct = productList.find((p) => p.id === form.product_id);

  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return [];
    return productList.filter((p) => matchesProductSearch(p, productSearch)).slice(0, MAX_RESULTS);
  }, [productList, productSearch]);

  const resetForm = () => {
    setForm({ product_id: "", type: "sale", final_price: "", employee_name: "", notes: "" });
    setProductSearch("");
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) resetForm();
  };

  const selectProduct = (p: (typeof productList)[number]) => {
    setForm({
      ...form,
      product_id: p.id,
      final_price: p.sale_price?.toString() ?? form.final_price,
    });
    setProductSearch("");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Täze operasiýa
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Täze operasiýa</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Тип</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-[200]">
                {TYPES.map((t) => (
                  <SelectItem key={t.v} value={t.v}>
                    {t.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Изделие</Label>

            {selectedProduct && (
              <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug">
                    {selectedProduct.sku} — {selectedProduct.title}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {getProductStock(selectedProduct)} шт. · {selectedProduct.status}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label="Снять выбор"
                  onClick={() => setForm({ ...form, product_id: "" })}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            )}

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Gözleg: SKU, kod ýa-da ady..."
                className="pl-9"
                disabled={productsLoading || productsError || productList.length === 0}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>

            {productsLoading && <p className="text-xs text-muted-foreground">Katalog ýüklenýär...</p>}
            {productsError && (
              <p className="text-xs text-destructive">Katalog ýüklenmedi. Sahypany täzeläň.</p>
            )}
            {!productsLoading && !productsError && productList.length === 0 && (
              <p className="text-xs text-muted-foreground">Haryt ýok — katalogda goşuň.</p>
            )}

            {!productsLoading && productSearch.trim() && (
              <div className="max-h-52 overflow-y-auto rounded-md border bg-card">
                {filteredProducts.length === 0 ? (
                  <p className="p-4 text-center text-sm text-muted-foreground">Haryt tapylmady</p>
                ) : (
                  <ul className="divide-y">
                    {filteredProducts.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className={cn(
                            "flex w-full flex-col gap-0.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent",
                            form.product_id === p.id && "bg-accent",
                          )}
                          onClick={() => selectProduct(p)}
                        >
                          <span className="font-medium leading-snug">
                            {p.sku} — {p.title}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {getProductStock(p)} шт. · {p.status}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {filteredProducts.length >= MAX_RESULTS && (
                  <p className="border-t p-2 text-center text-xs text-muted-foreground">
                    Ilkinji {MAX_RESULTS} netije. Has takyk gözleg ediň.
                  </p>
                )}
              </div>
            )}

            {!productSearch.trim() && !selectedProduct && productList.length > 0 && (
              <p className="text-xs text-muted-foreground">
                SKU ýa-da harydyň adyny ýazyň ({productList.length} haryt katalogda).
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Baha, tmt*</Label>
              <Input
                type="number"
                step="0.01"
                value={form.final_price}
                onChange={(e) => setForm({ ...form, final_price: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Сотрудник</Label>
              <Input
                value={form.employee_name}
                onChange={(e) => setForm({ ...form, employee_name: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Заметки</Label>
            <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !form.final_price}>
            {save.isPending ? "Сохранение..." : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
