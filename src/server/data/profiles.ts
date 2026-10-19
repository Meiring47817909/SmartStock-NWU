import 'server-only'
import { eq } from 'drizzle-orm'
import type { Ctx } from '@/server/context'
import { toIso } from '@/server/db/client'
import { profiles, staff } from '@/server/db/schema'
import type { Profile, StaffMember } from '@/types/database'

/**
 * The signed-in user's own `profiles` row and the `staff` row linked to their Firebase uid (if any).
 * Either can be null: a lending-portal borrower has no profile, and a BICS admin may have no staff row.
 * Only ever reads rows for `ctx.caller.uid`.
 */
export async function getMe(ctx: Ctx): Promise<{ profile: Profile | null; staff: StaffMember | null }> {
  const uid = ctx.caller.uid
  if (!uid) return { profile: null, staff: null }

  const [profileRow] = await ctx.db.select().from(profiles).where(eq(profiles.uid, uid)).limit(1)
  const [staffRow] = await ctx.db.select().from(staff).where(eq(staff.uid, uid)).limit(1)

  return {
    profile: profileRow
      ? {
          id: profileRow.uid,
          full_name: profileRow.full_name,
          role: profileRow.role,
          created_at: toIso(profileRow.created_at) as string,
        }
      : null,
    // StaffMember.id is typed `number` in src/types/database.ts but ids are strings (20-character keys
    // from newId).
    staff: staffRow
      ? ({
          id: staffRow.id,
          name: staffRow.name,
          surname: staffRow.surname,
          full_name: staffRow.full_name,
          email: staffRow.email,
          department: staffRow.department,
          card_uid: staffRow.card_uid,
          is_active: staffRow.is_active,
          uid: staffRow.uid,
          is_admin_account: staffRow.is_admin_account,
          created_at: toIso(staffRow.created_at) as string,
          updated_at: toIso(staffRow.updated_at) as string,
        } as unknown as StaffMember)
      : null,
  }
}

/** Set the caller's own `profiles.full_name` (the name the sidebar, transactions and audit entries show). Null when they have no profile. */
export async function setOwnProfileName(ctx: Ctx, fullName: string): Promise<string | null> {
  const uid = ctx.caller.uid
  if (!uid) return null
  const [row] = await ctx.db.update(profiles).set({ full_name: fullName }).where(eq(profiles.uid, uid)).returning({ full_name: profiles.full_name })
  return row?.full_name ?? null
}
