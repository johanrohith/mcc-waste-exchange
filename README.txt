MCC WASTE EXCHANGE — PUBLISHABLE BUILD

FILES
index.html  — public MCC Waste Exchange portal
admin.html  — administrator dashboard
ADMIN_SETUP.sql — one-time Supabase database upgrade

BEFORE DEPLOYING
1. Confirm the original items table and item-images bucket/policies were created.
2. Run ADMIN_SETUP.sql once in Supabase SQL Editor.
3. Confirm Authentication > Users contains discordercool@gmail.com with a password.
4. Test admin.html login.

DEPLOYMENT
Upload the contents of this folder to a static web host.
The public site is the root page.
The admin dashboard is available at /admin.html.

SUPABASE
This build is connected to project:
https://tyenxtzigwdtuyuueukz.supabase.co

The browser app uses the Supabase publishable key. Never add a secret/service_role key to these files.
