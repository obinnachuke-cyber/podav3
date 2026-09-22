/* ============================================================
   Supabase connection settings.
   Fill these two values in from your Supabase project:
     Project Settings → API → "Project URL" and "anon public" key.
   The anon key is safe to expose in client-side code; your data is
   protected by Row Level Security policies (see SUPABASE_SETUP.md).
   ============================================================ */
window.PODA_SUPABASE_URL = "https://ajurlpmzhrihvubdjuln.supabase.co";
window.PODA_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqdXJscG16aHJpaHZ1YmRqdWxuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODg5MDYsImV4cCI6MjA5NzM2NDkwNn0.HQyZnwEMZJUkpAQv9Z5uvyR9xHYks3BmgcIP3lwfpbg";

// Storage bucket that holds item photos (created in SUPABASE_SETUP.md).
window.PODA_IMAGE_BUCKET = "item-images";

// The admin account's email (from Supabase → Authentication → Users).
// This is NOT secret — it just lets the login screen show a single password
// box instead of asking for the email every time. Your password is still
// verified securely by Supabase.
window.PODA_ADMIN_EMAIL = "obinnachuke@gmail.com";

// —— Public contact (used by the "Buy — inquire" button and the Sell-to-Poda
// form). These are safe to expose. Change the email to wherever you want buyer
// enquiries and closet applications to land.
window.PODA_CONTACT_EMAIL = "twopoda@gmail.com";
window.PODA_INSTAGRAM = "podacapital";
