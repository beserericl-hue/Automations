import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '../config/supabase';
import { useAuth } from './AuthContext';

interface UserProfile {
  id: string;
  user_id: string; // phone number — the key for all V2 tables
  phone_number: string;
  display_name: string | null;
  email: string | null;
  bcc_email: string | null;
  preferences: Record<string, unknown>;
  role: string;
  isAdmin: boolean;
}

interface UserContextType {
  profile: UserProfile | null;
  loading: boolean;
  needsOnboarding: boolean;
  refreshProfile: () => Promise<void>;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function UserProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  const fetchProfile = async () => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      setNeedsOnboarding(false);
      return;
    }

    const { data, error } = await supabase
      .from('users_v2')
      .select('*')
      .eq('supabase_auth_uid', user.id)
      .maybeSingle();

    if (error) {
      console.error('Error fetching user profile:', error);
      setProfile(null);
      setNeedsOnboarding(true);
      setLoading(false);
      return;
    }

    if (!data) {
      // Auth exists but no users_v2 row — needs onboarding
      setNeedsOnboarding(true);
      setProfile(null);
      setLoading(false);
      return;
    }

    setProfile({
      id: data.id,
      user_id: data.user_id,
      phone_number: data.phone_number,
      display_name: data.display_name,
      email: data.email,
      bcc_email: data.bcc_email,
      preferences: data.preferences || {},
      role: data.role || 'user',
      isAdmin: data.role === 'admin',
    });
    setNeedsOnboarding(false);
    setLoading(false);
  };

  useEffect(() => {
    if (!authLoading) {
      fetchProfile();
    }
  }, [user, authLoading]);

  return (
    <UserContext.Provider
      value={{ profile, loading, needsOnboarding, refreshProfile: fetchProfile }}
    >
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}
