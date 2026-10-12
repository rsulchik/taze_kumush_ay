import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { askAnalyst } from "@/lib/analyst.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, Send, Database, User } from "lucide-react";

export const Route = createFileRoute("/ai")({
  component: AiPage,
});

const QUICK = [
  "Какой общий вес золота 585 пробы сейчас в магазине?",
  "Топ-3 категорий по выручке за этот месяц",
  "Какие размеры колец сейчас в дефиците (меньше 2 шт)?",
  "Суммарная стоимость изделий с бриллиантами на витрине",
  "Средняя маржинальность по серьгам",
  "Сколько изделий каждого металла в наличии",
];

type Msg = { role: "user" | "assistant"; content: string; sql?: string | null; rows?: any };

function AiPage() {
  const ask = useServerFn(askAnalyst);
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Здравствуйте! Я аналитик магазина «Карат». Задайте вопрос по складу, продажам или маржинальности — или выберите быстрый отчёт ниже." },
  ]);
  const [input, setInput] = useState("");

  const m = useMutation({
    mutationFn: async (text: string) => {
      const history = [...messages, { role: "user" as const, content: text }];
      const res = await ask({
        data: { messages: history.map((x) => ({ role: x.role, content: x.content })) },
      });
      return res;
    },
    onSuccess: (res) => {
      setMessages((prev) => [...prev, { role: "assistant", content: res.reply, sql: res.sql, rows: res.rows }]);
    },
  });

  const send = (text: string) => {
    if (!text.trim() || m.isPending) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    m.mutate(text);
  };

  return (
    <div className="flex h-screen flex-col p-6 md:p-10">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 font-serif text-3xl">
          <Sparkles className="h-7 w-7 text-gold" /> AI Аналитика
        </h1>
        <p className="text-sm text-muted-foreground">ИИ переводит ваши вопросы в SQL-запросы к базе магазина</p>
      </header>

      <div className="mb-4 flex flex-wrap gap-2">
        {QUICK.map((q) => (
          <Button key={q} variant="outline" size="sm" onClick={() => send(q)} disabled={m.isPending}>
            {q}
          </Button>
        ))}
      </div>

      <Card className="flex flex-1 flex-col overflow-hidden">
        <CardContent className="flex-1 space-y-4 overflow-y-auto p-6">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : ""}`}>
              {msg.role === "assistant" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold text-gold-foreground">
                  <Sparkles className="h-4 w-4" />
                </div>
              )}
              <div className={`max-w-2xl space-y-2 ${msg.role === "user" ? "" : ""}`}>
                <div className={`rounded-lg px-4 py-2.5 text-sm ${msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                  {msg.content}
                </div>
                {msg.sql && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      <Database className="mr-1 inline h-3 w-3" /> SQL-запрос ({msg.rows?.length ?? 0} строк)
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-card p-3 font-mono text-[11px]">{msg.sql}</pre>
                  </details>
                )}
              </div>
              {msg.role === "user" && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <User className="h-4 w-4" />
                </div>
              )}
            </div>
          ))}
          {m.isPending && (
            <div className="flex gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold text-gold-foreground">
                <Sparkles className="h-4 w-4 animate-pulse" />
              </div>
              <div className="rounded-lg bg-muted px-4 py-2.5 text-sm text-muted-foreground">Анализирую данные...</div>
            </div>
          )}
        </CardContent>
        <div className="border-t p-3">
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="flex gap-2"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Спросите что угодно о магазине..."
              disabled={m.isPending}
            />
            <Button type="submit" disabled={m.isPending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
