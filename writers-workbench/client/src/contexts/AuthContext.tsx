import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../config/supabase';

/**
 * Passwordless auth. There is no password anywhere in this product: a user types
 * their email, receives a 6-digit code, and types that.
 *
 * `requestCode` and `verifyCode` go to OUR server rather than straight to
 * Supabase, because the code is minted, hashed, rate-limited and emailed through
 * Postal there. What comes back is a genuine Supabase session, which is handed to
 * `supabase.auth.setSession` — so from this point on every existing consumer
 * (the `session.access_token` sent to the API, the SSE `?token=`, onAuthStateChange)
 * behaves exactly as it did under password login.
 */
interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** Ask for a code. Resolves whether or not the address has an account — the
   *  server deliberately gives the same answer either way, so the UI must not
   *  draw any conclusion from it. */
  requestCode: (email: string) => Promise<void>;
  /** Exchange a code for a session. Throws with a readable message when the code
   *  is wrong, used or expired. */
  verifyCode: (email: string, code: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface OtpResponse {
  success?: boolean;
  access_token?: string;
  refresh_token?: string;
  error?: { code?: string; message?: string };
}

async function postJson(path: string, body: unknown): Promise<OtpResponse> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload: OtpResponse = {};
  try {
    payload = (await res.json()) as OtpResponse;
  } catch {
    // A non-JSON body (a proxy error page, say) must still produce a usable message.
  }
  if (!res.ok || payload.success === false) {
    throw new Error(payload.error?.message || `Sign-in failed (${res.status})`);
  }
  return payload;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const requestCode = async (email: string) => {
    await postJson('/api/auth/otp/request', { email });
  };

  const verifyCode = async (email: string, code: string) => {
    const data = await postJson('/api/auth/otp/verify', { email, code });
    if (!data.access_token || !data.refresh_token) {
      throw new Error('Sign-in failed: no session was returned');
    }
    // setSession persists it the same way signInWithPassword did and fires
    // onAuthStateChange, which is what flips the app out of the login screen.
    const { error } = await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });
    if (error) throw error;
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  };

  const signOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return (
    <AuthContext.Provider
      value={{ session, user, loading, requestCode, verifyCode, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
