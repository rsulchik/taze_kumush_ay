import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const SCHEMA_DOC = `
Схема базы данных (PostgreSQL, схема public):

categories(id uuid, name text)
  -- name: 'Кольца','Серьги','Цепочки','Браслеты','Подвески','Колье'

products(id uuid, title text, sku text, category_id uuid -> categories,
  size numeric (размер кольца, напр. 17.5),
  metal_type text ('Золото','Серебро','Платина','Палладий'),
  assay int (проба: 585, 750, 925, 950),
  total_weight numeric (общий вес в граммах),
  metal_weight numeric (чистый вес металла в граммах),
  price_per_gram numeric, cost_price numeric, sale_price numeric,
  status text ('в наличии','продано','на реставрации','списано'),
  quantity int (сколько штук в наличии, >= 0),
  created_at, updated_at)

gemstones(id uuid, product_id uuid -> products, stone_name text
  (напр. 'Бриллиант','Изумруд','Фианит','Сапфир'),
  carat_weight numeric (вес в каратах),
  cut_type text, quantity int)

transactions(id uuid, product_id uuid -> products,
  type text ('sale','consignment','return','write-off'),
  final_price numeric, employee_name text, created_at)

Используй ILIKE для текстовых сравнений (русский язык). Для "этот месяц" фильтруй
created_at >= date_trunc('month', now()).
`;

const SYSTEM = `Ты — ИИ-аналитик ювелирного магазина "Карат". Отвечай по-русски, кратко и по делу.
Когда нужна цифра — вызывай инструмент run_sql с одним SELECT-запросом к базе. После получения данных дай содержательный ответ с числами и единицами измерения (граммы, караты, рубли).
${SCHEMA_DOC}`;

const ChatInput = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).min(1),
});

export const askAnalyst = createServerFn({ method: "POST" })
  .inputValidator((input) => ChatInput.parse(input))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { reply: "LOVABLE_API_KEY не настроен.", sql: null, rows: null };

    const { runReadOnlySql } = await import("./sql-runner.server");

    const tools = [{
      type: "function",
      function: {
        name: "run_sql",
        description: "Выполнить один read-only SELECT-запрос к базе ювелирного магазина и получить JSON-массив строк.",
        parameters: {
          type: "object",
          properties: { sql: { type: "string", description: "Один PostgreSQL SELECT-запрос." } },
          required: ["sql"],
          additionalProperties: false,
        },
      },
    }];

    const messages: any[] = [
      { role: "system", content: SYSTEM },
      ...data.messages,
    ];

    let lastSql: string | null = null;
    let lastRows: any = null;

    for (let i = 0; i < 4; i++) {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages,
          tools,
        }),
      });
      if (res.status === 429) return { reply: "Превышен лимит запросов к ИИ, попробуйте через минуту.", sql: null, rows: null };
      if (res.status === 402) return { reply: "Закончились кредиты Lovable AI. Пополните в Settings → Workspace → Usage.", sql: null, rows: null };
      if (!res.ok) return { reply: `Ошибка ИИ: ${res.status}`, sql: null, rows: null };

      const json: any = await res.json();
      const msg = json.choices?.[0]?.message;
      if (!msg) return { reply: "Пустой ответ ИИ.", sql: null, rows: null };

      const toolCalls = msg.tool_calls;
      if (toolCalls && toolCalls.length > 0) {
        messages.push(msg);
        for (const tc of toolCalls) {
          if (tc.function?.name === "run_sql") {
            const args = JSON.parse(tc.function.arguments || "{}");
            lastSql = args.sql;
            const result = await runReadOnlySql(args.sql);
            lastRows = "rows" in result ? result.rows : null;
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify(result).slice(0, 8000),
            });
          }
        }
        continue;
      }

      return { reply: msg.content ?? "(нет ответа)", sql: lastSql, rows: lastRows };
    }
    return { reply: "Слишком много шагов рассуждения.", sql: lastSql, rows: lastRows };
  });
