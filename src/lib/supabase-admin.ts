import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * service_roleキーを使うサーバー専用クライアント。RLSをバイパスするため、
 * Route Handler・スクリプト以外からは絶対にimportしない。
 * このシステムにはブラウザから使う画面がないので、NEXT_PUBLIC_ の変数は持たない。
 */
let cachedClient: SupabaseClient | null = null;

export function createAdminClient(): SupabaseClient {
  if (!cachedClient) {
    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません（.env.local を確認してください）");
    }
    // ダッシュボードから「…supabase.co/rest/v1/」ごとコピーしても動くよう、オリジンだけを使う
    cachedClient = createClient(new URL(url).origin, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cachedClient;
}
