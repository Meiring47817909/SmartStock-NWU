import { route } from '@/server/http'
import { getMe } from '@/server/data/profiles'

// The signed-in user's own profile and linked staff record (sign-in contexts and the login page).
export const GET = route('signed-in', async (ctx) => getMe(ctx))
