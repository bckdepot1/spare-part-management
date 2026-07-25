/* Supabase connection config.
 *
 * Fill in the two values below from your Supabase project:
 * Dashboard → (select your project) → Project Settings → API.
 *
 * SUPABASE_ANON_KEY is the "anon / public" key. It is *designed* to be shipped
 * inside frontend code — every table it can touch is locked down by Row Level
 * Security in db/schema.sql, so this key alone cannot read or write anything
 * the signed-in user isn't allowed to. Never put the "service_role" key here;
 * that one bypasses RLS entirely and must stay inside the Supabase dashboard.
 */
window.SPM_CONFIG = {
  url: 'https://nngepjxjjnkaefgubqvp.supabase.co',   // Project URL ของคุณ (จาก URL bar)
  anonKey: 'sb_publishable_elfQEaQzbAnaezn_And_Sw_lV2o_-b7'   // วาง Publishable key ที่คัดลอกมา
};