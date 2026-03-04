import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Only create the client if we have the credentials to avoid crashing on load
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials missing. Auth and Hi-Scores will be disabled. Ensure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.');
}

// Table Schema for 'hiscores':
// create table hiscores (
//   id uuid default gen_random_uuid() primary key,
//   fecha_hora timestamptz default now(),
//   ip inet,
//   mail text,
//   user_id uuid references auth.users(id),
//   nivel int4,
//   puntos int4
// );
// 
// RLS Policies:
// alter table hiscores enable row level security;
// create policy "Allow anonymous inserts" on hiscores for insert with check (true);
// create policy "Allow everyone to read" on hiscores for select using (true);

export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey) 
  : null;
