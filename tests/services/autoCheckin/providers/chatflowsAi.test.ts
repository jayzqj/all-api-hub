import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  AUTO_CHECKIN_METHOD_IDS,
  CHECK_IN_METHOD_AVAILABILITIES,
  CHECK_IN_METHOD_STATUS_OUTCOMES,
  CHECK_IN_METHOD_TODAY_STATUSES,
} from "~/constants/checkIn"
import { SITE_TYPES } from "~/constants/siteType"
import {
  CHATFLOWS_AI_CHECK_IN_RESULT_KINDS,
  fetchChatflowsAiCheckInStatus,
  performChatflowsAiCheckIn,
} from "~/services/apiService/sub2api/checkin/chatflowsAiCheckIn"
import { ApiError } from "~/services/apiTransport/errors"
import { executeSelectedCheckIn } from "~/services/checkin/autoCheckin/methods"
import { autoCheckinMethodRegistry } from "~/services/checkin/autoCheckin/providers"
import { chatflowsAiProvider } from "~/services/checkin/autoCheckin/providers/chatflowsAi"
import { getCheckInMethodPresentationMetadata } from "~/services/checkin/autoCheckin/providers/registry"
import { PROTECTION_BYPASS_USER_COMMANDS } from "~/services/protectionBypass/contracts"
import { AuthTypeEnum } from "~/types"
import { CHECKIN_RESULT_STATUS } from "~/types/autoCheckin"
import { TEMP_WINDOW_REQUEST_SOURCES } from "~/types/tempWindowFetch"
import { userCommandExecution } from "~~/tests/services/protectionBypass/fixtures"
import { createAutoCheckinMutationLifecycle } from "~~/tests/test-utils/autoCheckin"
import { buildSiteAccount } from "~~/tests/test-utils/factories"

vi.mock(
  "~/services/apiService/sub2api/checkin/chatflowsAiCheckIn",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("~/services/apiService/sub2api/checkin/chatflowsAiCheckIn")
      >()
    return {
      ...actual,
      fetchChatflowsAiCheckInStatus: vi.fn(),
      performChatflowsAiCheckIn: vi.fn(),
    }
  },
)

const METHOD_ID = AUTO_CHECKIN_METHOD_IDS.ChatflowsAiDailyCheckIn
const SITE_URL = "https://ai.chatflowsai.com"

const createAccount = (automaticExecutionEnabled = true) =>
  buildSiteAccount({
    id: "chatflowsai-account",
    site_url: SITE_URL,
    site_type: SITE_TYPES.SUB2API,
    authType: AuthTypeEnum.AccessToken,
    account_info: {
      id: "42",
      username: "Example User",
      access_token: "example-access-token",
      quota: 0,
      today_quota_consumption: 0,
      today_prompt_tokens: 0,
      today_completion_tokens: 0,
      today_requests_count: 0,
      today_income: 0,
    },
    checkIn: {
      automaticExecutionEnabled,
      methodKnowledge: {
        methods: {
          [METHOD_ID]: {
            detection: {
              outcome: "matched",
              evidence: { source: "probe", observedAt: 100 },
            },
          },
        },
      },
      selection: { mode: "automatic", methodId: METHOD_ID },
    },
  })

const executionContext = () => ({
  tempWindowRequestSource: TEMP_WINDOW_REQUEST_SOURCES.Background,
  protectionBypassExecution: userCommandExecution(
    PROTECTION_BYPASS_USER_COMMANDS.ManualCheckin,
  ),
})

const notCheckedStatus = {
  outcome: CHECK_IN_METHOD_STATUS_OUTCOMES.Known,
  availability: CHECK_IN_METHOD_AVAILABILITIES.Enabled,
  today: CHECK_IN_METHOD_TODAY_STATUSES.NotChecked,
  evidence: { source: "probe" as const, observedAt: 200 },
}

describe("ChatflowsAI check-in integration", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchChatflowsAiCheckInStatus).mockResolvedValue({
      enabled: true,
      checkedInToday: false,
    })
    vi.mocked(performChatflowsAiCheckIn).mockResolvedValue({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied,
      data: { rewardAmount: 50 },
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it("presents the method with the ChatflowsAI source", () => {
    expect(getCheckInMethodPresentationMetadata(METHOD_ID)).toMatchObject({
      kind: "daily",
      sourceName: "ChatflowsAI",
      sourceNameKey: "methods.sources.chatflowsAi",
    })
  })

  it("offers discovery for every Sub2API origin", () => {
    for (const origin of [SITE_URL, "https://other.example", undefined]) {
      expect(
        autoCheckinMethodRegistry
          .getCandidates(SITE_TYPES.SUB2API, origin)
          .map((candidate) => candidate.id),
      ).toContain(METHOD_ID)
    }
  })

  it.each([SITE_TYPES.NEW_API, SITE_TYPES.VELOERA])(
    "limits the candidate to Sub2API accounts: %s",
    (siteType) => {
      expect(
        autoCheckinMethodRegistry
          .getCandidates(siteType, SITE_URL)
          .map((candidate) => candidate.id),
      ).not.toContain(METHOD_ID)
    },
  )

  it("requires account credentials", () => {
    const account = createAccount()
    account.account_info.access_token = ""
    expect(chatflowsAiProvider.getReadiness?.(account)).toMatchObject({
      ready: false,
    })
  })

  it.each([
    [false, CHECK_IN_METHOD_TODAY_STATUSES.NotChecked],
    [true, CHECK_IN_METHOD_TODAY_STATUSES.Checked],
  ])(
    "takes a status DTO as read-only discovery evidence (checked=%s)",
    async (checkedInToday, today) => {
      vi.mocked(fetchChatflowsAiCheckInStatus).mockResolvedValue({
        enabled: true,
        checkedInToday,
      })
      await expect(
        chatflowsAiProvider.detect?.({
          account: createAccount(),
          observedAt: 200,
        }),
      ).resolves.toMatchObject({
        detection: { outcome: "matched" },
        status: { availability: CHECK_IN_METHOD_AVAILABILITIES.Enabled, today },
      })
      expect(performChatflowsAiCheckIn).not.toHaveBeenCalled()
    },
  )

  it("treats an installation without the sidecar as unsupported", async () => {
    vi.mocked(fetchChatflowsAiCheckInStatus).mockRejectedValue(
      new ApiError("404 page not found", 404),
    )
    await expect(
      chatflowsAiProvider.detect?.({
        account: createAccount(),
        observedAt: 200,
      }),
    ).resolves.toMatchObject({ outcome: "unsupported" })
  })

  it.each([
    new ApiError("ChatflowsAI daily check-in request failed", 401),
    new ApiError("ChatflowsAI daily check-in request failed", 500),
    new ApiError("Invalid ChatflowsAI daily check-in response"),
    new TypeError("Failed to fetch"),
  ])("keeps an unreadable probe unknown", async (error) => {
    vi.mocked(fetchChatflowsAiCheckInStatus).mockRejectedValue(error)
    await expect(
      chatflowsAiProvider.detect?.({
        account: createAccount(),
        observedAt: 200,
      }),
    ).resolves.toMatchObject({ outcome: "unknown" })
  })

  it("keeps the selection while a status refresh fails", async () => {
    vi.mocked(fetchChatflowsAiCheckInStatus).mockRejectedValue(
      new TypeError("Failed to fetch"),
    )
    await expect(
      chatflowsAiProvider.getStatus?.({
        account: createAccount(),
        observedAt: 200,
      }),
    ).resolves.toMatchObject({
      outcome: CHECK_IN_METHOD_STATUS_OUTCOMES.Unknown,
      reason: "network",
    })
  })

  it("blocks direct submission without authoritative status proof", async () => {
    await expect(
      chatflowsAiProvider.checkIn(createAccount(), executionContext()),
    ).resolves.toMatchObject({ reasonCode: "status_unavailable" })
    expect(performChatflowsAiCheckIn).not.toHaveBeenCalled()
  })

  it("does not submit when the current period is already claimed", async () => {
    vi.mocked(fetchChatflowsAiCheckInStatus).mockResolvedValue({
      enabled: true,
      checkedInToday: true,
    })
    await executeSelectedCheckIn({
      account: createAccount(),
      globalAutomaticExecutionEnabled: true,
      context: executionContext(),
    })
    expect(performChatflowsAiCheckIn).not.toHaveBeenCalled()
  })

  it("submits once when the period is open", async () => {
    await expect(
      executeSelectedCheckIn({
        account: createAccount(),
        globalAutomaticExecutionEnabled: true,
        context: executionContext(),
      }),
    ).resolves.toMatchObject({ kind: "executed" })
    expect(performChatflowsAiCheckIn).toHaveBeenCalledOnce()
  })

  it("reports the granted amount as a USD balance award", async () => {
    await expect(
      chatflowsAiProvider.checkIn(createAccount(), {
        ...executionContext(),
        statusProof: notCheckedStatus,
      }),
    ).resolves.toMatchObject({
      status: CHECKIN_RESULT_STATUS.SUCCESS,
      awards: [
        {
          asset: { kind: "currency", code: "USD" },
          amount: {
            status: "known",
            value: "50",
            source: { inputs: ["amount"] },
          },
        },
      ],
    })
  })

  it("keeps a grant without an authoritative amount reward-free", async () => {
    vi.mocked(performChatflowsAiCheckIn).mockResolvedValue({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied,
      data: {},
    })
    const result = await chatflowsAiProvider.checkIn(createAccount(), {
      ...executionContext(),
      statusProof: notCheckedStatus,
    })
    expect(result.status).toBe(CHECKIN_RESULT_STATUS.SUCCESS)
    expect(result).not.toHaveProperty("reward")
    expect(result.awards ?? []).toEqual([])
  })

  it("maps the duplicate response to already checked", async () => {
    vi.mocked(performChatflowsAiCheckIn).mockResolvedValue({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.AlreadyChecked,
    })
    await expect(
      chatflowsAiProvider.checkIn(createAccount(), {
        ...executionContext(),
        statusProof: notCheckedStatus,
      }),
    ).resolves.toMatchObject({
      status: CHECKIN_RESULT_STATUS.ALREADY_CHECKED,
    })
  })

  it.each([
    [401, "authentication_required"],
    [404, "method_unsupported"],
  ])("classifies a failed submission HTTP %s", async (status, reasonCode) => {
    vi.mocked(performChatflowsAiCheckIn).mockRejectedValue(
      new ApiError("ChatflowsAI daily check-in failed", status),
    )
    await expect(
      chatflowsAiProvider.checkIn(createAccount(), {
        ...executionContext(),
        statusProof: notCheckedStatus,
      }),
    ).resolves.toMatchObject({
      status: CHECKIN_RESULT_STATUS.FAILED,
      reasonCode,
    })
  })

  it("marks a dispatched malformed or lost response uncertain", async () => {
    const mutationLifecycle = createAutoCheckinMutationLifecycle()
    mutationLifecycle.onDispatch()
    vi.mocked(performChatflowsAiCheckIn).mockRejectedValue(
      new Error("Invalid ChatflowsAI daily check-in response"),
    )
    await expect(
      chatflowsAiProvider.checkIn(createAccount(), {
        ...executionContext(),
        statusProof: notCheckedStatus,
        mutationLifecycle,
      }),
    ).resolves.toMatchObject({ status: CHECKIN_RESULT_STATUS.UNCERTAIN })
  })

  it.each([true, false])(
    "reconciles a lost response without replay (checked=%s)",
    async (checkedInToday) => {
      let answered = false
      vi.mocked(fetchChatflowsAiCheckInStatus).mockImplementation(async () => ({
        enabled: true,
        checkedInToday: answered ? checkedInToday : false,
      }))
      vi.mocked(performChatflowsAiCheckIn).mockImplementationOnce(
        async (request) => {
          answered = true
          request.observer?.onDispatch()
          throw new TypeError("Failed to fetch")
        },
      )
      const result = await executeSelectedCheckIn({
        account: createAccount(),
        globalAutomaticExecutionEnabled: true,
        context: executionContext(),
      })
      expect(result).toMatchObject({
        kind: "executed",
        retryable: !checkedInToday,
      })
      expect(performChatflowsAiCheckIn).toHaveBeenCalledOnce()
      expect(
        vi.mocked(fetchChatflowsAiCheckInStatus).mock.calls.length,
      ).toBeGreaterThanOrEqual(2)
    },
  )
})
