import { beforeEach, describe, expect, it, vi } from "vitest"

import { recoverSub2ApiBrowserAuth } from "~/services/apiService/sub2api/auth/browserAuth"
import { refreshSub2ApiTokens } from "~/services/apiService/sub2api/auth/tokenRefresh"
import { ForeignCheckInContractError } from "~/services/apiService/sub2api/checkin/foreignCheckInContract"
import { parseFreeApiDailyCheckInStatusResponse } from "~/services/apiService/sub2api/checkin/freeApiCheckIn"
import {
  fetchXingchiCheckInStatus,
  parseXingchiCheckInMutationResponse,
  parseXingchiCheckInStatusResponse,
  performXingchiCheckIn,
  XINGCHI_CHECK_IN_RESULT_KINDS,
} from "~/services/apiService/sub2api/checkin/xingchiCheckIn"
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

// Field names read by https://xingchiapi.com's UserDashboardCheckin component
// (DashboardView chunk, 2026-11-18); values are illustrative.
const statusData = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  claimed_today: false,
  amount: 300,
  total_count: 2,
  total_amount: 600,
  ...overrides,
})

// FreeAPI serves the same path with this DTO (freeapi.site, 2026-10-16).
const freeApiStatusData = {
  enabled: true,
  checked_in_today: false,
  min_amount: 1,
  max_amount: 999,
}

describe("星驰API check-in protocol", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchApiResponse).mockReset()
  })

  it.each([
    [false, false],
    [true, true],
  ])(
    "maps claimed_today=%s to checkedInToday=%s",
    (claimedToday, checkedInToday) => {
      expect(
        parseXingchiCheckInStatusResponse(
          response(statusData({ claimed_today: claimedToday })),
        ),
      ).toEqual({ enabled: true, checkedInToday })
    },
  )

  it("reports a disabled dashboard check-in as disabled", () => {
    expect(
      parseXingchiCheckInStatusResponse(
        response(statusData({ enabled: false })),
      ),
    ).toEqual({ enabled: false, checkedInToday: false })
  })

  it("reads FreeAPI's DTO on the shared path as a foreign contract", () => {
    expect(() =>
      parseXingchiCheckInStatusResponse(response(freeApiStatusData)),
    ).toThrow(ForeignCheckInContractError)
  })

  it("lets FreeAPI read this deployment's DTO as a foreign contract", () => {
    expect(() =>
      parseFreeApiDailyCheckInStatusResponse(response(statusData())),
    ).toThrow(ForeignCheckInContractError)
  })

  it.each([
    null,
    [],
    {},
    { enabled: true },
    { claimed_today: false },
    { enabled: "true", claimed_today: false },
    { enabled: true, claimed_today: 0 },
    { enabled: true, checked_in_today: false },
  ])("keeps an invalid or unrecognized status DTO inconclusive %j", (data) => {
    expect(() => parseXingchiCheckInStatusResponse(response(data))).toThrow(
      expect.not.objectContaining({ name: "ForeignCheckInContractError" }),
    )
  })

  it.each([401, 403, 404, 405, 500])(
    "preserves HTTP %s even with a non-JSON body",
    (status) => {
      expect(() =>
        parseXingchiCheckInStatusResponse({
          ...response(null, status),
          body: "404 page not found",
        }),
      ).toThrow(expect.objectContaining({ statusCode: status }))
    },
  )

  it("classifies the invalid-token envelope as HTTP 401", () => {
    // Observed with an invalid Bearer token on 2026-11-18.
    expect(() =>
      parseXingchiCheckInStatusResponse({
        ...response(null, 401),
        body: { code: "INVALID_TOKEN", message: "Invalid token" },
      }),
    ).toThrow(
      expect.objectContaining({
        statusCode: 401,
        code: API_ERROR_CODES.HTTP_401,
        upstreamCode: "INVALID_TOKEN",
      }),
    )
  })

  it.each([300, "300", 0, "0.5"])("reads the granted amount %s", (amount) => {
    expect(
      parseXingchiCheckInMutationResponse(
        response({ amount, status: statusData({ claimed_today: true }) }),
      ),
    ).toEqual({
      kind: XINGCHI_CHECK_IN_RESULT_KINDS.Applied,
      data: { rewardAmount: amount },
    })
  })

  it.each([undefined, null, -1, "invalid", false])(
    "keeps a grant without a valid amount reward-free: %s",
    (amount) => {
      expect(parseXingchiCheckInMutationResponse(response({ amount }))).toEqual(
        { kind: XINGCHI_CHECK_IN_RESULT_KINDS.Applied, data: {} },
      )
    },
  )

  it.each([409, 400, 200])(
    "reads the dashboard's duplicate reason on HTTP %s as already checked",
    (status) => {
      expect(
        parseXingchiCheckInMutationResponse({
          ...response(null, status),
          body: {
            code: status,
            message: "今日已签到",
            reason: "CHECKIN_ALREADY_CLAIMED",
          },
        }),
      ).toEqual({ kind: XINGCHI_CHECK_IN_RESULT_KINDS.AlreadyChecked })
    },
  )

  it("does not treat another failure as a duplicate", () => {
    expect(() =>
      parseXingchiCheckInMutationResponse({
        ...response(null, 409),
        body: { code: 409, message: "conflict", reason: "OTHER" },
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }))
  })

  it("sends an authenticated uncached GET with the browser timezone", async () => {
    vi.mocked(fetchApiResponse).mockResolvedValue(
      response(statusData({ claimed_today: true })),
    )
    await expect(
      fetchXingchiCheckInStatus(request, "Asia/Shanghai"),
    ).resolves.toEqual({ enabled: true, checkedInToday: true })
    expect(fetchApiResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ accessToken: "example-token" }),
      }),
      {
        endpoint: "/api/v1/user/checkin?timezone=Asia%2FShanghai",
        options: { method: "GET", cache: "no-store" },
      },
    )
  })

  it.each([undefined, "example-refresh-token"])(
    "does not recover missing credentials during status discovery (refresh=%s)",
    async (refreshToken) => {
      vi.mocked(fetchApiResponse).mockResolvedValue(response(null, 401))
      await expect(
        fetchXingchiCheckInStatus({
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
    vi.mocked(fetchApiResponse).mockResolvedValue(response({ amount: 300 }))
    await expect(performXingchiCheckIn(request)).resolves.toEqual({
      kind: XINGCHI_CHECK_IN_RESULT_KINDS.Applied,
      data: { rewardAmount: 300 },
    })
    expect(fetchApiResponse).toHaveBeenCalledTimes(1)
    expect(fetchApiResponse).toHaveBeenCalledWith(expect.anything(), {
      endpoint: "/api/v1/user/checkin",
      options: { method: "POST", cache: "no-store" },
    })
  })

  it.each([
    (r: ApiServiceRequest) => fetchXingchiCheckInStatus(r),
    (r: ApiServiceRequest) => performXingchiCheckIn(r),
  ])("does not repeat an unauthorized request", async (operation) => {
    vi.mocked(fetchApiResponse).mockResolvedValue({
      ok: false,
      status: 401,
      headers: {},
      body: { code: "INVALID_TOKEN", message: "Invalid token" },
    })
    await expect(operation(request)).rejects.toMatchObject({
      statusCode: 401,
    })
    expect(fetchApiResponse).toHaveBeenCalledTimes(1)
  })
})
