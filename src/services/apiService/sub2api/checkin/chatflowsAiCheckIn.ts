import { compareDecimal, parseDecimal } from "~/services/amounts/decimal"
import { executeAuthenticatedSub2ApiRequest } from "~/services/apiService/sub2api/auth/authLifecycle"
import {
  CHATFLOWS_AI_CHECK_IN_ENDPOINT,
  CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT,
} from "~/services/apiService/sub2api/checkin/chatflowsAiCheckInProtocol"
import { createCheckInCodeEnvelopeParser } from "~/services/apiService/sub2api/checkin/codeEnvelope"
import {
  executeSub2ApiCheckInWithRecovery,
  type Sub2ApiCheckInRecoveryOptions,
} from "~/services/apiService/sub2api/checkin/unauthorizedRecovery"
import { fetchApiResponse } from "~/services/apiTransport/request"
import type {
  ApiServiceRequest,
  ApiTransportResponse,
} from "~/services/apiTransport/type"

/**
 * ChatflowsAI's check-in page (`/checkin/`, source read 2026-11-18) sends the
 * Sub2API console's `auth_token` as a Bearer token to a sidecar service:
 *
 * - `GET  /api/checkin/status` returns `{ code, message, data }` with
 *   `can_checkin`, `period_key`, `next_reset_at`, `checked_in_at` and the
 *   account `balance`.
 * - `POST /api/checkin` (no body) answers `data.amount` on success, and HTTP
 *   409 or `code: 409` for a period that was already claimed.
 *
 * The page has no disabled state: `can_checkin: false` always renders
 * "本轮已签到" and disables the button. Other Sub2API installations answer
 * both paths with the Go default `404 page not found`, so availability is
 * decided by the status DTO rather than by the hostname.
 */

export const CHATFLOWS_AI_CHECK_IN_RESULT_KINDS = {
  Applied: "applied",
  AlreadyChecked: "already_checked",
} as const

export type ChatflowsAiCheckInResult =
  | {
      kind: typeof CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied
      data: { rewardAmount?: number | string }
    }
  | { kind: typeof CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.AlreadyChecked }

const { parseEnvelopeData, invalidResponse } =
  createCheckInCodeEnvelopeParser("ChatflowsAI")

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * `period_key` is the structural marker that separates this DTO from other
 * services on the same path; the page renders it as "本轮周期".
 */
export function parseChatflowsAiCheckInStatusResponse(
  response: ApiTransportResponse<unknown>,
): { enabled: boolean; checkedInToday: boolean } {
  const data = parseEnvelopeData(
    response,
    CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT,
  )
  if (
    typeof data.can_checkin !== "boolean" ||
    typeof data.period_key !== "string" ||
    !data.period_key.trim()
  ) {
    throw invalidResponse(CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT)
  }
  // The extension's "today" is the site's current period, which starts at
  // 12:00 Beijing time instead of local midnight.
  return { enabled: true, checkedInToday: !data.can_checkin }
}

/**
 * Accepts the page's own success and duplicate signals. A success without a
 * valid non-negative `amount` is still a granted period, just without an
 * authoritative reward.
 */
export function parseChatflowsAiCheckInMutationResponse(
  response: ApiTransportResponse<unknown>,
): ChatflowsAiCheckInResult {
  if (response.status === 409 || toRecord(response.body)?.code === 409) {
    return { kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.AlreadyChecked }
  }
  const data = parseEnvelopeData(response, CHATFLOWS_AI_CHECK_IN_ENDPOINT)
  const amount = parseDecimal(data.amount)
  return {
    kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied,
    data:
      amount !== undefined && compareDecimal(amount, "0") >= 0
        ? { rewardAmount: data.amount as number | string }
        : {},
  }
}

/**
 * Reads status as a passive probe: no token refresh and no browser recovery,
 * so discovery cannot issue credentials or open a login window.
 */
export async function fetchChatflowsAiCheckInStatus(
  request: ApiServiceRequest,
) {
  return executeAuthenticatedSub2ApiRequest(
    request,
    CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT,
    async (authenticated) => {
      const response = await fetchApiResponse<unknown>(authenticated, {
        endpoint: CHATFLOWS_AI_CHECK_IN_STATUS_ENDPOINT,
        options: { method: "GET", cache: "no-store" },
      })
      return parseChatflowsAiCheckInStatusResponse(response)
    },
    {
      proactiveRefresh: false,
      recoverMissingAccessToken: false,
      recoverUnauthorized: false,
    },
  )
}

/**
 * Submits once after the provider's authoritative status gate. Only
 * middleware-401 recovery may retry, behind the shared fresh-status gate; a
 * lost response is left to outer status reconciliation and never replayed.
 */
export async function performChatflowsAiCheckIn(
  request: ApiServiceRequest,
  options: Sub2ApiCheckInRecoveryOptions = {},
) {
  return executeSub2ApiCheckInWithRecovery(
    request,
    CHATFLOWS_AI_CHECK_IN_ENDPOINT,
    async (authenticated) => {
      const response = await fetchApiResponse<unknown>(authenticated, {
        endpoint: CHATFLOWS_AI_CHECK_IN_ENDPOINT,
        options: { method: "POST", cache: "no-store" },
      })
      return parseChatflowsAiCheckInMutationResponse(response)
    },
    fetchChatflowsAiCheckInStatus,
    options,
  )
}
