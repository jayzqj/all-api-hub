import { AUTO_CHECKIN_METHOD_IDS } from "~/constants/checkIn"
import { compareDecimal, parseDecimal } from "~/services/amounts/decimal"
import { executeAuthenticatedSub2ApiRequest } from "~/services/apiService/sub2api/auth/authLifecycle"
import { createCheckInCodeEnvelopeParser } from "~/services/apiService/sub2api/checkin/codeEnvelope"
import { ForeignCheckInContractError } from "~/services/apiService/sub2api/checkin/foreignCheckInContract"
import {
  classifySiblingStatusDto,
  SIBLING_DTO_VERDICTS,
} from "~/services/apiService/sub2api/checkin/siblingStatusContracts"
import {
  executeSub2ApiCheckInWithRecovery,
  type Sub2ApiCheckInRecoveryOptions,
} from "~/services/apiService/sub2api/checkin/unauthorizedRecovery"
import {
  createXingchiCheckInStatusEndpoint,
  resolveXingchiCheckInTimezone,
  XINGCHI_CHECK_IN_ENDPOINT,
} from "~/services/apiService/sub2api/checkin/xingchiCheckInProtocol"
import { fetchApiResponse } from "~/services/apiTransport/request"
import type {
  ApiServiceRequest,
  ApiTransportResponse,
} from "~/services/apiTransport/type"

/**
 * 星驰API's `UserDashboardCheckin` component (DashboardView chunk, read
 * 2026-11-18) uses the Bearer `auth_token` on one path:
 *
 * - `GET  /api/v1/user/checkin?timezone=<IANA>` returns `{ code, message,
 *   data }` with `enabled`, `claimed_today`, the configured `amount` and the
 *   `total_count`/`total_amount` totals. The card is hidden unless `enabled`.
 * - `POST /api/v1/user/checkin` (no body) answers `data.amount` with the
 *   refreshed `data.status`; a duplicate fails with
 *   `reason: "CHECKIN_ALREADY_CLAIMED"`.
 *
 * FreeAPI serves the same path with `checked_in_today`, so a FreeAPI DTO is a
 * recognized foreign contract here rather than an unknown probe.
 */

const XINGCHI_CHECK_IN_ALREADY_CLAIMED_REASON = "CHECKIN_ALREADY_CLAIMED"

export const XINGCHI_CHECK_IN_RESULT_KINDS = {
  Applied: "applied",
  AlreadyChecked: "already_checked",
} as const

export type XingchiCheckInResult =
  | {
      kind: typeof XINGCHI_CHECK_IN_RESULT_KINDS.Applied
      data: { rewardAmount?: number | string }
    }
  | { kind: typeof XINGCHI_CHECK_IN_RESULT_KINDS.AlreadyChecked }

const { parseEnvelopeData, invalidResponse } =
  createCheckInCodeEnvelopeParser("星驰API")

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** `claimed_today` is this deployment's own name for today's state. */
export function parseXingchiCheckInStatusResponse(
  response: ApiTransportResponse<unknown>,
): { enabled: boolean; checkedInToday: boolean } {
  const data = parseEnvelopeData(response, XINGCHI_CHECK_IN_ENDPOINT)
  if (
    !Object.hasOwn(data, "claimed_today") &&
    classifySiblingStatusDto(
      AUTO_CHECKIN_METHOD_IDS.XingchiDailyCheckIn,
      data,
    ) === SIBLING_DTO_VERDICTS.Foreign
  ) {
    throw new ForeignCheckInContractError(XINGCHI_CHECK_IN_ENDPOINT, data)
  }
  if (
    typeof data.enabled !== "boolean" ||
    typeof data.claimed_today !== "boolean"
  ) {
    throw invalidResponse(XINGCHI_CHECK_IN_ENDPOINT)
  }
  return { enabled: data.enabled, checkedInToday: data.claimed_today }
}

/**
 * Recognizes the dashboard's duplicate reason on any HTTP status. A success
 * without a valid non-negative `amount` is still a granted day, just without
 * an authoritative reward.
 */
export function parseXingchiCheckInMutationResponse(
  response: ApiTransportResponse<unknown>,
): XingchiCheckInResult {
  if (
    toRecord(response.body)?.reason === XINGCHI_CHECK_IN_ALREADY_CLAIMED_REASON
  ) {
    return { kind: XINGCHI_CHECK_IN_RESULT_KINDS.AlreadyChecked }
  }
  const data = parseEnvelopeData(response, XINGCHI_CHECK_IN_ENDPOINT)
  const amount = parseDecimal(data.amount)
  return {
    kind: XINGCHI_CHECK_IN_RESULT_KINDS.Applied,
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
export async function fetchXingchiCheckInStatus(
  request: ApiServiceRequest,
  timezone = resolveXingchiCheckInTimezone(),
) {
  return executeAuthenticatedSub2ApiRequest(
    request,
    XINGCHI_CHECK_IN_ENDPOINT,
    async (authenticated) => {
      const response = await fetchApiResponse<unknown>(authenticated, {
        endpoint: createXingchiCheckInStatusEndpoint(timezone),
        options: { method: "GET", cache: "no-store" },
      })
      return parseXingchiCheckInStatusResponse(response)
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
export async function performXingchiCheckIn(
  request: ApiServiceRequest,
  options: Sub2ApiCheckInRecoveryOptions = {},
) {
  return executeSub2ApiCheckInWithRecovery(
    request,
    XINGCHI_CHECK_IN_ENDPOINT,
    async (authenticated) => {
      const response = await fetchApiResponse<unknown>(authenticated, {
        endpoint: XINGCHI_CHECK_IN_ENDPOINT,
        options: { method: "POST", cache: "no-store" },
      })
      return parseXingchiCheckInMutationResponse(response)
    },
    (recovered) => fetchXingchiCheckInStatus(recovered),
    options,
  )
}
