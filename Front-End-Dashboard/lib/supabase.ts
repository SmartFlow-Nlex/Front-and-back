import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qjbnilmopummgivymdiq.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFqYm5pbG1vcHVtbWdpdnltZGlxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNzAxNjYsImV4cCI6MjA5Nzk0NjE2Nn0.ue6leXwdj-dIFi5_TDWX7aCd4saywNOHG-UARLVOcvQ";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
