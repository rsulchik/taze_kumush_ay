import { supabase } from "@/integrations/supabase/client";

export const PRODUCT_IMAGES_BUCKET = "product-images";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export function validateProductImage(file: File): string | null {
  if (!ALLOWED_TYPES.has(file.type)) {
    return "Допустимы только JPEG, PNG, WebP или GIF.";
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return "Файл больше 5 МБ.";
  }
  return null;
}

function sanitizePathPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, "-")
    .replace(/-+/g, "-")
    .slice(0, 48) || "product";
}

export async function uploadProductImage(file: File, sku: string): Promise<string> {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "jpg";
  const path = `${sanitizePathPart(sku)}-${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: file.type,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(PRODUCT_IMAGES_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export function compressImageToDataUrl(
  file: File,
  maxDim = 1200,
  quality = 0.82,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Не удалось обработать изображение."));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
      resolve(canvas.toDataURL(mime, quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать изображение."));
    };
    img.src = url;
  });
}

export function getStoragePathFromProductImageUrl(imageUrl: string | null): string | null {
  if (!imageUrl || imageUrl.startsWith("data:")) return null;
  const marker = `/storage/v1/object/public/${PRODUCT_IMAGES_BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(imageUrl.slice(idx + marker.length).split("?")[0]!);
}

export async function deleteProductImageFromStorage(imageUrl: string | null): Promise<void> {
  const path = getStoragePathFromProductImageUrl(imageUrl);
  if (!path) return;
  const { error } = await supabase.storage.from(PRODUCT_IMAGES_BUCKET).remove([path]);
  if (error) console.warn("[product-image] delete failed:", error.message);
}

/** Upload to Storage; if bucket is missing, store a compressed data URL in image_url. */
export async function resolveProductImageUrl(file: File, sku: string): Promise<string> {
  try {
    return await uploadProductImage(file, sku);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const bucketMissing =
      /bucket|not found|does not exist|row-level security/i.test(message);
    if (!bucketMissing) throw err;

    const dataUrl = await compressImageToDataUrl(file);
    if (dataUrl.length > 700_000) {
      throw new Error("Фото слишком большое. Уменьшите размер или настройте Storage в Supabase.");
    }
    return dataUrl;
  }
}
