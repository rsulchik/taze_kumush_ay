import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchDashboard, getErrorMessage } from "@/lib/dashboard";
import { fmtMoney, fmtWeight } from "@/lib/format";
import { getProductStock } from "@/lib/product-stock";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Coins, Gem, Package, TrendingUp } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, LineChart, Line, CartesianGrid } from "recharts";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchDashboard(qc),
    retry: (failureCount, err) =>
      failureCount < 1 && !/statement timeout|canceling statement/i.test(getErrorMessage(err)),
  });

  const hasData = !!data;

  if (isPending && !hasData) {
    return <div className="p-8 text-muted-foreground">Загрузка...</div>;
  }

  if (isError && !hasData) {
    return (
      <div className="space-y-3 p-8">
        <p className="text-sm text-destructive">
          Не удалось загрузить статистику: {getErrorMessage(error)}
        </p>
        <Button type="button" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? "Загрузка..." : "Повторить"}
        </Button>
      </div>
    );
  }

  if (!data) {
    return <div className="p-8 text-muted-foreground">Загрузка...</div>;
  }

  const products = data.products;
  const txs = data.txs;

  const qty = getProductStock;
  const totalValue = products.reduce((s, p) => s + Number(p.sale_price || 0) * qty(p), 0);
  const totalItems = products.reduce((s, p) => s + qty(p), 0);
  const byMetal: Record<string, number> = {};
  products.forEach((p) => {
    const k = `${p.metal_type} ${p.assay}`;
    byMetal[k] = (byMetal[k] || 0) + Number(p.metal_weight || 0) * qty(p);
  });
  const monthRevenue = txs.filter((t) => t.type === "sale").reduce((s, t) => s + Number(t.final_price), 0);

  const salesByDay: Record<string, number> = {};
  txs.filter((t) => t.type === "sale").forEach((t) => {
    const d = new Date(t.created_at).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    salesByDay[d] = (salesByDay[d] || 0) + Number(t.final_price);
  });
  const salesData = Object.entries(salesByDay).map(([date, value]) => ({ date, value })).reverse();

  const byCat: Record<string, number> = {};
  products.forEach((p) => {
    const name = p.categories?.name ?? "Без категории";
    byCat[name] = (byCat[name] || 0) + qty(p);
  });
  const catData = Object.entries(byCat).map(([name, count]) => ({ name, count }));

  return (
    <div className="space-y-6 p-6 md:p-10">
      <header>
        <h1 className="font-serif text-3xl">Statistika</h1>
        <p className="text-sm text-muted-foreground">
          Skladyn we satuwyn 30 gunlik statistikasy
          {isFetching && !isPending ? " · обновление..." : ""}
        </p>
      </header>

      {isError && hasData && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          Не удалось обновить с сервера ({getErrorMessage(error)}). Показаны сохранённые данные.
          <Button variant="link" className="h-auto p-0 pl-2" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? "Загрузка..." : "Повторить"}
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric icon={Coins} label="Magazynyn umumy bahasy" value={fmtMoney(totalValue)} />
        <Metric icon={Package} label="Harydyn sanawy" value={totalItems.toString()} />
        <Metric icon={TrendingUp} label="30 gunlik girdeji" value={fmtMoney(monthRevenue)} />
        <Metric icon={Gem} label="kategoriyalar sanawy" value={Object.keys(byCat).length.toString()} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Gunler boyunca satuwlar</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={salesData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" stroke="var(--color-muted-foreground)" fontSize={12} />
                <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }} />
                <Line type="monotone" dataKey="value" stroke="var(--color-gold)" strokeWidth={2} dot={{ fill: "var(--color-gold)" }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Skladdaky metallar</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(byMetal).map(([k, w]) => (
              <div key={k} className="flex items-center justify-between border-b pb-2 last:border-0">
                <span className="text-sm">{k}</span>
                <span className="font-mono text-sm font-medium">{fmtWeight(w)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Изделия по категориям</CardTitle></CardHeader>
        <CardContent className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={catData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis dataKey="name" stroke="var(--color-muted-foreground)" fontSize={12} />
              <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
              <Tooltip contentStyle={{ background: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 8 }} />
              <Bar dataKey="count" fill="var(--color-gold)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Link to="/products" className="text-sm text-muted-foreground hover:text-foreground">Перейти к каталогу →</Link>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-xl font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}
