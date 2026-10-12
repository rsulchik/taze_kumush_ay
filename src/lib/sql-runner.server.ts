// Server-only SQL runner: read-only, single SELECT statement, via service role.
// Used by the AI analytics server function.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|comment)\b/i;

export async function runReadOnlySql(sql: string): Promise<{ rows: any[] } | { error: string }> {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^\s*(with|select)\b/i.test(trimmed)) {
    return { error: "Только SELECT/WITH запросы разрешены." };
  }
  if (FORBIDDEN.test(trimmed)) {
    return { error: "Запрос содержит запрещённые операции." };
  }
  if (trimmed.includes(";")) {
    return { error: "Разрешён только один запрос." };
  }

  // Use Postgres via supabaseAdmin RPC. Since we don't have a generic RPC,
  // run via the REST sql endpoint using the service role. Supabase exposes
  // `postgrest` only; for arbitrary SQL we call the SQL API.
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/exec_readonly_sql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: trimmed }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `SQL error: ${text}` };
  }
  const rows = await res.json();
  // Ensure supabaseAdmin import is preserved (used elsewhere via this module)
  void supabaseAdmin;
  return { rows: Array.isArray(rows) ? rows.slice(0, 200) : [rows] };
}
