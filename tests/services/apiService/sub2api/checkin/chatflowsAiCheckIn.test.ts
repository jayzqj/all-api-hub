import { beforeEach, describe, expect, it, vi } from "vitest"

import { recoverSub2ApiBrowserAuth } from "~/services/apiService/sub2api/auth/browserAuth"
import { refreshSub2ApiTokens } from "~/services/apiService/sub2api/auth/tokenRefresh"
import {
  CHATFLOWS_AI_CHECK_IN_RESULT_KINDS,
  fetchChatflowsAiCheckInStatus,
  parseChatflowsAiCheckInMutationResponse,
  parseChatflowsAiCheckInStatusResponse,
  performChatflowsAiCheckIn,
} from "~/services/apiService/sub2api/checkin/chatflowsAiCheckIn"
import { API_ERROR_CODES } from "~/services/apiTransport/errors"
import { fetchApiResponse } from "~/services/apiTransport/request"
import { API_DIRECT_REQUEST_REASONS } from "~/services/apiTransport/type"
import type {
  ApiServiceRequest,
  ApiTransportResponse,
} from "~/services/apiTransport/type"
import { AuthTypeEnum } from "~/types"

vi.mock(
  "~/services/apiService/sub2api/auth/browserAuth",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("~/services/apiService/sub2api/auth/browserAuth")
    >()),
    recoverSub2ApiBrowserAuth: vi.fn().mockResolvedValue(null),
  }),
)
vi.mock(
  "~/services/apiService/sub2api/auth/tokenRefresh",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("~/services/apiService/sub2api/auth/tokenRefresh")
    >()),
    refreshSub2ApiTokens: vi
      .fn()
      .mockRejectedValue(new Error("refresh unavailable")),
  }),
)

vi.mock("~/services/apiTransport/request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/services/apiTransport/request")>()),
  fetchApiResponse: vi.fn(),
}))

const response = (
  data: unknown,
  status = 200,
): ApiTransportResponse<unknown> => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {},
  body: { code: 0, message: "success", data },
})

const request: ApiServiceRequest = {
  directRequestReason: API_DIRECT_REQUEST_REASONS.Passive,
  baseUrl: "https://relay.example",
  auth: {
    authType: AuthTypeEnum.AccessToken,
    accessToken: "example-token",
    userId: "42",
  },
}

// Field names read by https://ai.chatflowsai.com/checkin/ (page source,
// 2026-11-18); values are illustrative.
const statusData = (overrides: Record<string, unknown> = {}) => ({
  balance: 12.5,
  can_checkin: true,
  period_key: "2026-11-18",
  next_reset_at: "2026-11-19T04:00:00Z",
  checked_in_at: null,
  ...overrides,
})

describe("ChatflowsAI check-in protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchApiResponse).mockReset()
  })

  it.each([
    [true, false],
    [false, true],
  ])(
    "maps can_checkin=%s to checkedInToday=%s",
    (canCheckIn, checkedInToday) => {
      expect(
        parseChatflowsAiCheckInStatusResponse(
          response(
            statusData({
              can_checkin: canCheckIn,
              checked_in_at: canCheckIn ? null : "2026-11-18T05:00:00Z",
            }),
          ),
        ),
      ).toEqual({ enabled: true, checkedInToday })
    },
  )

  it("follows the page when a claimed period has no checked_in_at", () => {
    expect(
      parseChatflowsAiCheckInStatusResponse(
        response(statusData({ can_checkin: false, checked_in_at: undefined })),
      ),
    ).toEqual({ enabled: true, checkedInToday: true })
  })

  it.each([
    null,
    [],
    {},
    { can_checkin: true },
    { period_key: "2026-11-18" },
    { can_checkin: "true", period_key: "2026-11-18" },
    { can_checkin: true, period_key: "" },
    { can_checkin: true, period_key: 20261118 },
  ])("rejects an invalid or sibling status DTO %j", (data) => {
    expect(() =>
      parseChatflowsAiCheckInStatusResponse(response(data)),
    ).toThrow()
  })

  it.each([401, 403, 404, 405, 500])(
    "preserves HTTP %s even with a non-JSON body",
    (status) => {
      expect(() =>
        parseChatflowsAiCheckInStatusResponse({
          ...response(null, status),
          body: "404 page not found",
        }),
      ).toThrow(expect.objectContaining({ statusCode: status }))
    },
  )

  it("classifies the sidecar's login envelope as HTTP 401", () => {
    // Observed without a valid token: HTTP 401 {"code": 401, "message": ...}.
    expect(() =>
      parseChatflowsAiCheckInStatusResponse({
        ...response(null, 401),
        body: { code: 401, message: "请先登录" },
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 401,
        code: API_ERROR_CODES.HTTP_401,
      }),
    )
  })

  it.each([
    { code: 0, message: "success" },
    { code: 0, message: "success", data: null },
    { code: 0, data: statusData() },
  ])("rejects a malformed envelope %j", (body) => {
    expect(() =>
      parseChatflowsAiCheckInStatusResponse({ ...response(null), body }),
    ).toThrow()
  })

  it.each([50, "50", 0, "0.5"])("reads the granted amount %s", (amount) => {
    expect(
      parseChatflowsAiCheckInMutationResponse(response({ amount })),
    ).toEqual({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied,
      data: { rewardAmount: amount },
    })
  })

  it.each([undefined, null, -1, "invalid", false])(
    "keeps a grant without a valid amount reward-free: %s",
    (amount) => {
      expect(
        parseChatflowsAiCheckInMutationResponse(response({ amount })),
      ).toEqual({ kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied, data: {} })
    },
  )

  it.each([
    { ...response(null, 409), body: { code: 409, message: "本轮已签到" } },
    { ...response(null, 409), body: "Conflict" },
    { ...response(null), body: { code: 409, message: "本轮已签到" } },
  ])("reads the page's duplicate signals as already checked", (duplicate) => {
    expect(parseChatflowsAiCheckInMutationResponse(duplicate)).toEqual({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.AlreadyChecked,
    })
  })

  it("reports another business code as an error, not a grant", () => {
    expect(() =>
      parseChatflowsAiCheckInMutationResponse({
        ...response(null),
        body: { code: 500, message: "签到失败" },
      }),
    ).toThrow(
      expect.objectContaining({
        code: API_ERROR_CODES.BUSINESS_ERROR,
        message: "签到失败",
      }),
    )
  })

  it("sends an authenticated uncached GET without a timezone", async () => {
    vi.mocked(fetchApiResponse).mockResolvedValue(
      response(statusData({ can_checkin: false })),
    )
    await expect(fetchChatflowsAiCheckInStatus(request)).resolves.toEqual({
      enabled: true,
      checkedInToday: true,
    })
    expect(fetchApiResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ accessToken: "example-token" }),
      }),
      {
        endpoint: "/api/checkin/status",
        options: { method: "GET", cache: "no-store" },
      },
    )
  })

  it.each([undefined, "example-refresh-token"])(
    "does not recover missing credentials during status discovery (refresh=%s)",
    async (refreshToken) => {
      vi.mocked(fetchApiResponse).mockResolvedValue(response(null, 401))
      await expect(
        fetchChatflowsAiCheckInStatus({
          ...request,
          auth: { ...request.auth!, accessToken: "", refreshToken },
        }),
      ).rejects.toMatchObject({ statusCode: 401 })
      expect(recoverSub2ApiBrowserAuth).not.toHaveBeenCalled()
      expect(refreshSub2ApiTokens).not.toHaveBeenCalled()
      expect(fetchApiResponse).not.toHaveBeenCalled()
    },
  )

  it("submits a single POST without a request body", async () => {
    vi.mocked(fetchApiResponse).mockResolvedValue(response({ amount: 50 }))
    await expect(performChatflowsAiCheckIn(request)).resolves.toEqual({
      kind: CHATFLOWS_AI_CHECK_IN_RESULT_KINDS.Applied,
      data: { rewardAmount: 50 },
    })
    expect(fetchApiResponse).toHaveBeenCalledTimes(1)
    expect(fetchApiResponse).toHaveBeenCalledWith(expect.anything(), {
      endpoint: "/api/checkin",
      options: { method: "POST", cache: "no-store" },
    })
  })

  it.each([fetchChatflowsAiCheckInStatus, performChatflowsAiCheckIn])(
    "does not repeat an unauthorized request",
    async (operation) => {
      vi.mocked(fetchApiResponse).mockResolvedValue({
        ok: false,
        status: 401,
        headers: {},
        body: { code: 401, message: "未登录或登录已过期" },
      })
      await expect(operation(request)).rejects.toMatchObject({
        statusCode: 401,
      })
      expect(fetchApiResponse).toHaveBeenCalledTimes(1)
    },
  )
})
