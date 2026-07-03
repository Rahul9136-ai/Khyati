import axios from "axios"

/**
 * Central HTTP client. Injects the bearer token on every request; on a 401 it
 * transparently rotates the refresh token once and retries. Rejections are
 * normalised to the backend's error envelope (plus HTTP status).
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
})

export interface ApiError {
  code: string
  message: string
  status?: number
  details?: unknown
}

const ACCESS_KEY = "ff.access"
const REFRESH_KEY = "ff.refresh"

export const tokenStore = {
  get access() {
    return localStorage.getItem(ACCESS_KEY)
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY)
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access)
    localStorage.setItem(REFRESH_KEY, refresh)
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY)
    localStorage.removeItem(REFRESH_KEY)
  },
}

/** Called when the session is irrecoverably lost (refresh failed). */
let onSessionExpired: (() => void) | null = null
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn
}

api.interceptors.request.use((config) => {
  const token = tokenStore.access
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

let refreshing: Promise<string> | null = null

async function rotateRefreshToken(): Promise<string> {
  const refresh = tokenStore.refresh
  if (!refresh) throw new Error("no refresh token")
  // raw axios: must not recurse through the api interceptors
  const res = await axios.post(`${api.defaults.baseURL}/auth/refresh`, {
    refresh_token: refresh,
  })
  const pair = res.data.data as { access_token: string; refresh_token: string }
  tokenStore.set(pair.access_token, pair.refresh_token)
  return pair.access_token
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const status: number | undefined = error.response?.status
    const original = error.config ?? {}

    if (status === 401 && !original._retried && tokenStore.refresh) {
      original._retried = true
      try {
        refreshing = refreshing ?? rotateRefreshToken()
        const access = await refreshing
        refreshing = null
        original.headers = { ...original.headers, Authorization: `Bearer ${access}` }
        return api(original)
      } catch {
        refreshing = null
        tokenStore.clear()
        onSessionExpired?.()
      }
    }

    const envelope = error.response?.data?.error as ApiError | undefined
    return Promise.reject({
      ...(envelope ?? { code: "network_error", message: error.message }),
      status,
    } satisfies ApiError)
  },
)
