import { api } from '@/lib/api/client'
import type { Profile, StaffMember } from '@/types/database'

/** The signed-in user's own profile and linked staff record; either is null when there is none. */
export function loadMe(): Promise<{ profile: Profile | null; staff: StaffMember | null }> {
  return api('GET', '/api/me')
}
