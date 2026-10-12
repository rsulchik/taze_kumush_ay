/**
 * Проверка офлайн-логики без браузера и без интернета:
 *   node scripts/offline-smoke.mjs   (или: bun run test:offline)
 *
 * Подменяет supabase-js и IndexedDB на версии в памяти (см. scripts/offline-smoke/*.ts)
 * и прогоняет сценарии: пропала связь во время сохранения, отправка очереди,
 * «битая» запись не блокирует остальные, продажа офлайн, локальные правки поверх
 * данных сервера, смена схемы (колонка quantity).
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(root, "src");
const outDir = join(root, "node_modules/.cache/offline-smoke");
const outFile = join(outDir, "bundle.mjs");

const stubPlugin = {
  name: "offline-smoke-stubs",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^@\/integrations\/supabase\/client$/ }, () => ({
      path: join(root, "scripts/offline-smoke/stub-supabase.ts"),
    }));
    buildApi.onResolve({ filter: /^idb-keyval$/ }, () => ({
      path: join(root, "scripts/offline-smoke/stub-idb.ts"),
    }));
    buildApi.onResolve({ filter: /^@\// }, async (args) => {
      const resolved = await buildApi.resolve("./" + args.path.slice(2), {
        resolveDir: SRC,
        kind: args.kind,
      });
      if (resolved.errors.length) return { errors: resolved.errors };
      return { path: resolved.path };
    });
  },
};

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "scripts/offline-smoke/run.ts")],
  bundle: true,
  outfile: outFile,
  format: "esm",
  platform: "node",
  target: "node20",
  nodePaths: [join(root, "node_modules")],
  plugins: [stubPlugin],
  logLevel: "warning",
});

await import(pathToFileURL(outFile).href + "?t=" + Date.now());
