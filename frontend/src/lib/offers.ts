// VTO / PTO / OT / Leave slots on the server (/api/v1/scheduling/offers).
// Claims are written into the claimant's schedule by the backend, so after
// claiming or cancelling the day is pulled again (see refreshAfterClaim).
import type { QueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { SlotKind } from "@/lib/domain/slots"
import { pull } from "@/lib/scheduleSync"

export interface OfferClaim {
  id: string
  agent_key: string
  agent_name: string
  start: number
  end: number
  status: "filled" | "cancelled"
  created_at: string
}

export interface Offer {
  id: string
  plan_date: string
  queue_key: string
  queue_name: string
  kind: SlotKind
  start: number
  end: number
  capacity: number
  filled: number
  left: number
  channel: string | null
  status: "open" | "closed"
  note: string
  claims: OfferClaim[]
  mine: OfferClaim | null
}

export interface OfferInput {
  plan_date: string
  queue_key: string
  queue_name: string
  kind: SlotKind
  start: number
  end: number
  capacity: number
  eligible: string[] | null
  note?: string
}

export const OFFERS_KEY = ["offers"] as const

export async function fetchOffers(start: string, end: string): Promise<Offer[]> {
  return (await api.get("/scheduling/offers", { params: { start, end } })).data.data as Offer[]
}

export async function openOffers(items: OfferInput[], notify = true) {
  return (await api.post("/scheduling/offers", { items, notify })).data.data as { created: number; updated: number; notified: number; offers: Offer[] }
}

export async function patchOffer(id: string, patch: { capacity?: number; status?: "open" | "closed" }): Promise<Offer> {
  return (await api.patch(`/scheduling/offers/${id}`, patch)).data.data as Offer
}

export async function deleteOffer(id: string): Promise<void> {
  await api.delete(`/scheduling/offers/${id}`)
}

/** Take a slot — for yourself, or (staff) for `agentKey`. */
export async function claimOffer(id: string, agentKey?: string): Promise<Offer> {
  return (await api.post(`/scheduling/offers/${id}/claim`, agentKey ? { agent_key: agentKey } : {})).data.data as Offer
}

export async function cancelClaim(claimId: string): Promise<Offer> {
  return (await api.post(`/scheduling/offers/claims/${claimId}/cancel`)).data.data as Offer
}

/** A claim changed someone's schedule: refresh slots, the agent's list and the timeline. */
export async function refreshAfterClaim(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: OFFERS_KEY }),
    queryClient.invalidateQueries({ queryKey: ["my-schedule"] }),
    queryClient.invalidateQueries({ queryKey: ["schedule-range"] }),
    pull(),
  ])
}

export const errorText = (e: unknown) => (e as { message?: string })?.message ?? "Something went wrong"
