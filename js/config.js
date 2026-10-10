/* Public browser config only. Never put a Supabase service-role key here. */
const RELOOP_SUPABASE_URL = "https://tyenxtzigwdtuyuueukz.supabase.co";
const RELOOP_SUPABASE_KEY = "sb_publishable_tmXP9uW_woc6fmNf1E_SBQ_Sp5x8Vn5";
const RELOOP_SITE_URL = "https://johanrohith.me/mccreloop/";

window.reloop = window.reloop || {};
window.reloop.siteUrl = RELOOP_SITE_URL;
window.reloop.db = window.supabase.createClient(
  RELOOP_SUPABASE_URL,
  RELOOP_SUPABASE_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

window.reloop.getRedirectUrl = function () {
  const isAdminPage = window.location.pathname.endsWith("/admin.html");
  return RELOOP_SITE_URL + (isAdminPage ? "admin.html" : "");
};
