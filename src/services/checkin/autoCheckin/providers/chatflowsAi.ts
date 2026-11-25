import {
  CHECK_IN_METHOD_AVAILABILITIES,
  CHECK_IN_METHOD_STATUS_OUTCOMES,
  CHECK_IN_METHOD_TODAY_STATUSES,
} from "~/constants/checkIn"
import {
  CHATFLOWS_AI_CHECK_IN_RESULT_KINDS,
  fetchChatflowsAiCheckInStatus,
  performChatflowsAiCheckIn,
} from "~/services/apiService/sub2api/checkin/chatflowsAiCheckIn"
import { CHATFLOWS_AI_CHECK_IN_ENDPOINT } from "~/services/apiService/sub2api/checkin/chatflowsAiCheckInProtocol"
import { getCheckInMethodUnknownReason } from "~/services/checkin/autoCheckin/errors"
import { detectWithStatusReadback } from "~/services/checkin/autoCheckin/providers/detection"
import { AUTO_CHECKIN_PROVIDER_FALLBACK_MESSAGE_KEYS } from "~/services/checkin/autoCheckin/providers/shared"
import type { SiteAccount } from "~/types"
import {
  AUTO_CHECKIN_SKIP_REASON,
  CHECKIN_RESULT_STATUS,
} from "~/types/autoCheckin"

import type {
  AutoCheckinProvider,
  AutoCheckinProviderReadContext,
} from "./contracts"
import {
  createSub2ApiCheckInMutationRequest,
  createSub2ApiCheckInReadRequest,
  failedSub2ApiCheckIn,
  getSub2ApiCheckInReadiness,
  mapSub2ApiCheckInMutationError,
  readUsdAwards,
  toSub2ApiCheckInStatus,
} from "./sub2apiShared"

/** Throws for unreadable status so discovery can classify the route's absence. */
const fetchStatus = async (context: AutoCheckinProviderReadContext) => {
  const status = await fetchChatflowsAiCheckInStatus(
    createSub2ApiCheckInReadRequest(context),
  )
  return toSub2ApiCheckInStatus(status, context.observedAt)
}

/** Selected status refresh reports failures as unknown, keeping the selection. */
const readStatus: NonNullable<AutoCheckinProvider["getStatus"]> = async (
  context,
) => {
  try {
    return await fetchStatus(context)
  } catch (error) {
    return {
      outcome: CHECK_IN_METHOD_STATUS_OUTCOMES.Unknown,
      reason: getCheckInMethodUnknownReason(error),
      attemptedAt: context.observedAt,
    }
  }
}

export const chatflowsAiProvider: AutoCheckinProvider = {
  requiresAuthoritativeStatusBeforeMutation: true,

  getReadiness: getSub2ApiCheckInReadiness,

  // Installations without the sidecar answer the Go default 404, which the
  // shared detector maps to unsupported.
  detect: (context) => detectWithStatusReadback(context, fetchStatus),

  getStatus: readStatus,

  async checkIn(account, context) {
    const status = context.statusProof
    if (
      status?.availability !== CHECK_IN_METHOD_AVAILABILITIES.Enabled ||
      status.today !== CHECK_IN_METHOD_TODAY_STATUSES.NotChecked
    ) {
      return failedSub2ApiCheckIn(AUTO_CHECKIN_SKIP_REASON.STATUS_UNAVAILABLE)
    }

    try {
      const result = await performChatflowsAiCheckIn(
        createSub2ApiCheckInMutationRequest(account as SiteAccount, context),
        { beforeRecoveredMutation: context.beforeRecoveredMutation },
      )
      switch (result.kind) {
        case CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied:
          return {
            status: CHECKIN_RESULT_STATUS.SUCCESS,
            messageKey:
              AUTO_CHECKIN_PROVIDER_FALLBACK_MESSAGE_KEYS.checkinSuccessful,
            // The page credits `amount` to the same Sub2API balance it shows
            // as "当前余额", which the Sub2API family reads as USD.
            awards: readUsdAwards(
              account as SiteAccount,
              result.data.rewardAmount,
              { operation: CHATFLOWS_AI_CHECK_IN_ENDPOINT, field: "amount" },
            ),
            data: result.data,
          }
        case CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.AlreadyChecked:
          return {
            status: CHECKIN_RESULT_STATUS.ALREADY_CHECKED,
            messageKey:
              AUTO_CHECKIN_PROVIDER_FALLBACK_MESSAGE_KEYS.alreadyCheckedToday,
          }
      }
    } catch (error) {
      return mapSub2ApiCheckInMutationError(
        error,
        context,
        account as SiteAccount,
      )
    }
  },
}
