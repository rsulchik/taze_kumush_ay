import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addCategoryOfflineAware, saveProductOfflineAware } from "@/lib/offline/mutations";
import { isBrowserOnline } from "@/lib/offline/network";
import { loadLocalCategories, saveLocalCategories } from "@/lib/offline/local-db";
import { validateProductImage } from "@/lib/product-image";
import { getProductStock } from "@/lib/product-stock";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ImagePlus, Plus, X } from "lucide-react";

const METALS = ["Золото", "Серебро", "Платина", "Палладий"] as const;
const STATUSES = ["в наличии", "продано", "на реставрации", "списано"];

const emptyForm = {
  title: "",
  sku: "",
  category_id: "",
  metal_type: "Золото",
  assay: "585",
  size: "",
  total_weight: "",
  metal_weight: "",
  cost_price: "",
  sale_price: "",
  status: "в наличии",
  quantity: "1",
  description: "",
};

type ProductRecord = {
  id: string;
  title: string;
  sku: string;
  category_id: string | null;
  metal_type: string;
  assay: number;
  size: number | null;
  total_weight: number;
  metal_weight: number;
  cost_price: number | null;
  sale_price: number;
  status: string;
  description?: string | null;
  image_url: string | null;
  quantity?: number | null;
  price_per_gram?: number | null;
};

function productToForm(p: ProductRecord) {
  return {
    title: p.title,
    sku: p.sku,
    category_id: p.category_id ?? "",
    metal_type: p.metal_type,
    assay: String(p.assay),
    size: p.size != null ? String(p.size) : "",
    total_weight: String(p.total_weight),
    metal_weight: String(p.metal_weight),
    cost_price: p.cost_price != null ? String(p.cost_price) : "",
    sale_price: String(p.sale_price),
    status: p.status,
    quantity: String(getProductStock(p)),
    description: p.description ?? "",
  };
}

type ProductFormDialogProps = {
  product?: ProductRecord;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: React.ReactNode;
};

export function AddProductDialog() {
  return <ProductFormDialog />;
}

export function EditProductDialog({
  product,
  open,
  onOpenChange,
}: {
  product: ProductRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <ProductFormDialog product={product} open={open} onOpenChange={onOpenChange} />;
}

function ProductFormDialog({ product, open: controlledOpen, onOpenChange, trigger }: ProductFormDialogProps) {
  const isEdit = !!product;
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [form, setForm] = useState(emptyForm);
  const [newCat, setNewCat] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [initialImageUrl, setInitialImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null);
      return;
    }
    const url = URL.createObjectURL(imageFile);
    setImagePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  const { data: cats } = useQuery({
    queryKey: ["categories"],
    queryFn: async () => {
      if (!isBrowserOnline()) {
        return (await loadLocalCategories<any[]>()) ?? [];
      }
      try {
        const { data, error } = await supabase.from("categories").select("*").order("name");
        if (error) throw error;
        const rows = data ?? [];
        await saveLocalCategories(rows);
        return rows;
      } catch {
        return (await loadLocalCategories<any[]>()) ?? [];
      }
    },
  });

  useEffect(() => {
    if (open && product) {
      setForm(productToForm(product));
      setInitialImageUrl(product.image_url);
      setImagePreview(product.image_url);
      setImageFile(null);
      setNewCat("");
      if (fileInputRef.current) fileInputRef.current.value = "";

      if (product.description != null) {
        setForm((prev) => ({ ...prev, description: product.description ?? "" }));
      }

      if (isBrowserOnline()) {
        void supabase
          .from("products")
          .select("description")
          .eq("id", product.id)
          .single()
          .then(({ data, error }) => {
            if (error || !data) return;
            setForm((prev) => ({ ...prev, description: data.description ?? "" }));
          });
      }
    }
  }, [open, product]);

  const resetForm = () => {
    setForm(emptyForm);
    setImageFile(null);
    setImagePreview(null);
    setInitialImageUrl(null);
    setNewCat("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next && !isEdit) resetForm();
    if (!next && isEdit) {
      setImageFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const pickImage = (file: File | null) => {
    if (!file) {
      setImageFile(null);
      return;
    }
    const err = validateProductImage(file);
    if (err) {
      toast.error(err);
      return;
    }
    setImageFile(file);
  };

  const addCat = useMutation({
    mutationFn: async (name: string) => addCategoryOfflineAware(qc, name),
    onSuccess: (result) => {
      setForm((f) => ({ ...f, category_id: result.category.id }));
      setNewCat("");
      toast.success(result.offline ? "Категория сохранена офлайн" : "Категория добавлена");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const save = useMutation({
    mutationFn: async () =>
      saveProductOfflineAware(qc, {
        isEdit,
        productId: product?.id,
        initialImageUrl,
        form,
        imageFile,
        imagePreview,
      }),
    onSuccess: (result) => {
      if (!result.offline) {
        qc.invalidateQueries({ queryKey: ["products-full"] });
        qc.invalidateQueries({ queryKey: ["products-gemstones"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      } else {
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      }
      toast.success(
        result.offline
          ? isEdit
            ? "Изделие обновлено офлайн — синхронизируется при сети"
            : "Изделие сохранено офлайн — синхронизируется при сети"
          : isEdit
            ? "Изделие обновлено"
            : "Изделие добавлено",
      );
      handleOpenChange(false);
      if (!isEdit) resetForm();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const defaultTrigger = (
    <Button>
      <Plus className="mr-1 h-4 w-4" /> Новое изделие
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {trigger !== undefined ? (
        trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null
      ) : !isEdit ? (
        <DialogTrigger asChild>{defaultTrigger}</DialogTrigger>
      ) : null}
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Редактировать изделие" : "Новое ювелирное изделие"}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Фото" className="col-span-2">
            <div className="flex flex-wrap items-start gap-4">
              <div className="relative flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
                {imagePreview ? (
                  <>
                    <img src={imagePreview} alt="Превью" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded-full bg-background/90 p-1 shadow"
                      onClick={() => {
                        pickImage(null);
                        setImagePreview(null);
                      }}
                      aria-label="Удалить фото"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : (
                  <ImagePlus className="h-10 w-10 text-muted-foreground/50" />
                )}
              </div>
              <div className="space-y-2">
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="max-w-xs cursor-pointer"
                  onChange={(e) => pickImage(e.target.files?.[0] ?? null)}
                />
                <p className="text-xs text-muted-foreground">JPEG, PNG, WebP или GIF, до 5 МБ</p>
              </div>
            </div>
          </Field>

          <Field label="Название*" className="col-span-2">
            <Input value={form.title} onChange={f("title")} />
          </Field>
          <Field label="Артикул (SKU)*">
            <Input value={form.sku} onChange={f("sku")} placeholder="К-585-001" />
          </Field>
          <Field label="Статус">
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Количество в наличии*">
            <Input
              type="number"
              min={0}
              step={1}
              value={form.quantity}
              onChange={f("quantity")}
              placeholder="1"
            />
          </Field>

          <Field label="Категория" className="col-span-2">
            <div className="flex gap-2">
              <Select value={form.category_id} onValueChange={(v) => setForm({ ...form, category_id: v })}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Выберите..." />
                </SelectTrigger>
                <SelectContent>
                  {(cats ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="новая категория"
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                className="w-48"
              />
              <Button
                type="button"
                variant="outline"
                disabled={!newCat.trim() || addCat.isPending}
                onClick={() => addCat.mutate(newCat.trim())}
              >
                +
              </Button>
            </div>
          </Field>

          <Field label="Металл">
            <Select value={form.metal_type} onValueChange={(v) => setForm({ ...form, metal_type: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METALS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="proba*">
            <Input type="number" value={form.assay} onChange={f("assay")} placeholder="585" />
          </Field>

          <Field label="Razmer">
            <Input type="number" step="0.5" value={form.size} onChange={f("size")} placeholder="17.5" />
          </Field>
          <Field label="Umumy agramy, gr*">
            <Input type="number" step="0.01" value={form.total_weight} onChange={f("total_weight")} />
          </Field>
          <Field label="arassa metall, g*">
            <Input type="number" step="0.01" value={form.metal_weight} onChange={f("metal_weight")} />
          </Field>
          <Field label="Satyn alynan baha, tmt">
            <Input type="number" step="0.01" value={form.cost_price} onChange={f("cost_price")} />
          </Field>
          <Field label="Satylan baha, tmt*">
            <Input type="number" step="0.01" value={form.sale_price} onChange={f("sale_price")} />
          </Field>

          <Field label="Düzümi" className="col-span-2">
            <Textarea value={form.description} onChange={f("description")} rows={2} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Отмена
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              !form.title ||
              !form.sku ||
              !form.total_weight ||
              !form.metal_weight ||
              !form.sale_price ||
              !form.quantity
            }
          >
            {save.isPending ? "Сохранение..." : isEdit ? "Сохранить изменения" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
