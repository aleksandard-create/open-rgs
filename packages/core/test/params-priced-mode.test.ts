// Proposal: a params-priced mode. A mode may price a round from the round's
// own params (`priceOf(params)`), so a game whose stake depends on the
// player's choices (a bet per reel, say) needs one mode, not one per
// combination. The server computes the price from the intent; the client
// never sends an amount (guarantee 4), and the math still never sees money
// (guarantee 3).

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type ComplexMath,
  type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class RecordingPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  calls: { kind: string; bet: number; priceMultiplier: number; win?: number }[] = [];
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.calls.push({ kind: "settle", bet: req.bet, priceMultiplier: req.priceMultiplier ?? 1, win: req.win });
    this.balance = this.balance - req.bet * (req.priceMultiplier ?? 1) + req.win;
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.calls.push({ kind: "open", bet: req.bet, priceMultiplier: req.priceMultiplier ?? 1 });
    this.balance -= req.bet * (req.priceMultiplier ?? 1);
    return { roundId: `r${++this.seq}`, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

// Pays 1x what was paid, whatever the reels: the test is about the price.
const evenMath: SimpleMath = { kind: "simple", name: "even", version: "1", rtp: 1, play: () => ({ multiplier: 1, ops: [], type: "win" }) };
const seenParams: unknown[] = [];
const watchingMath: SimpleMath = {
  kind: "simple", name: "watch", version: "1", rtp: 1,
  play: (_carry, ctx) => { seenParams.push(ctx); return { multiplier: 0, ops: [], type: "loss" }; },
};
const complexMath: ComplexMath = {
  kind: "complex", name: "cx", version: "1", rtp: 1,
  open: () => ({ state: { o: 1 }, ops: [], awaiting: { type: "pick" } }),
  step: (state) => ({ state, ops: [] }),
  isTerminal: () => false,
  close: () => ({ multiplier: 0, ops: [], type: "close" }),
};

/** A bet per reel: each chosen reel costs 0.2 of the base bet. */
function reelPrice(params: Readonly<Record<string, unknown>> | undefined): number {
  const reels = params?.["reels"];
  if (!Array.isArray(reels) || reels.length === 0 || reels.length > 5) throw new Error("reels must list 1 to 5 reels");
  if (!reels.every((r) => Number.isInteger(r) && r >= 0 && r < 5) || new Set(reels).size !== reels.length) {
    throw new Error("each reel is a distinct index 0..4");
  }
  return (reels.length * 2) / 10; // decimal-exact, as a stakeMultiplier is
}

function setup(priceOf: GamePriceOf = reelPrice, math: SimpleMath = evenMath) {
  const platform = new RecordingPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: {
      base: { math: evenMath, stakeMultiplier: 1 },
      reels: { math, stakeMultiplier: 1, priceOf },
      cxReels: { math: complexMath, stakeMultiplier: 1, priceOf },
    },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}
type GamePriceOf = (params: Readonly<Record<string, unknown>> | undefined) => number;

async function failure(fn: () => Promise<unknown>): Promise<RGSError> {
  try { await fn(); throw new Error("expected throw"); }
  catch (e) { return e as RGSError; }
}

describe("params-priced mode (proposal)", () => {
  test("the stake comes from the round's params: three reels cost 0.6 of the bet", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "pp-three" }, conn);
    const res = await orch.spin({ mode: "reels", params: { reels: [0, 2, 4] } }, conn);
    expect(platform.calls[0]).toMatchObject({ kind: "settle", bet: 100, priceMultiplier: 0.6 });
    // Win = multiplier x what was paid (100 x 0.6), not x the base bet.
    expect(platform.calls[0]!.win).toBe(60);
    expect(res.balance).toBe(100_000);
  });

  test("one mode serves every combination", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "pp-many" }, conn);
    await orch.spin({ mode: "reels", params: { reels: [1] } }, conn);
    await orch.spin({ mode: "reels", params: { reels: [0, 1, 2, 3, 4] } }, conn);
    expect(platform.calls.map((c) => c.priceMultiplier)).toEqual([0.2, 1]);
  });

  test("params the price refuses fail closed before any money moves", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "pp-bad" }, conn);
    for (const params of [undefined, { reels: [] }, { reels: [0, 0] }, { reels: [9] }]) {
      const e = await failure(() => orch.spin({ mode: "reels", ...(params ? { params } : {}) }, conn));
      expect(e).toBeInstanceOf(RGSError);
      expect(e.code).toBe("INVALID_BET");
    }
    expect(platform.calls).toEqual([]);
  });

  test("a price that is not a finite non-negative number fails closed", async () => {
    for (const bad of [NaN, Infinity, -0.2]) {
      const { orch, platform, conn } = setup(() => bad);
      await orch.init({ sid: `pp-num-${String(bad)}` }, conn);
      const e = await failure(() => orch.spin({ mode: "reels", params: { reels: [0] } }, conn));
      expect(e.code).toBe("INVALID_BET");
      expect(platform.calls).toEqual([]);
    }
  });

  test("the balance check uses the computed price", async () => {
    const { orch, platform, conn } = setup((p) => (p?.["big"] ? 2_000 : 0.2));
    await orch.init({ sid: "pp-balance" }, conn);
    const e = await failure(() => orch.spin({ mode: "reels", params: { big: true } }, conn));
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(platform.calls).toEqual([]);
  });

  test("the math sees the params but no money", async () => {
    seenParams.length = 0;
    const { orch, conn } = setup(reelPrice, watchingMath);
    await orch.init({ sid: "pp-blind" }, conn);
    await orch.spin({ mode: "reels", params: { reels: [3] } }, conn);
    const ctx = seenParams[0] as Record<string, unknown>;
    expect(ctx["params"]).toEqual({ reels: [3] });
    expect(JSON.stringify(ctx)).not.toContain("balance");
  });

  test("a complex round opens at the computed price", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "pp-cx" }, conn);
    await orch.openRound({ mode: "cxReels", params: { reels: [0, 1] } }, conn);
    expect(platform.calls[0]).toMatchObject({ kind: "open", bet: 100, priceMultiplier: 0.4 });
  });

  test("a mode without priceOf keeps its fixed stakeMultiplier", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "pp-fixed" }, conn);
    await orch.spin({ mode: "base", params: { reels: [0] } }, conn);
    expect(platform.calls[0]!.priceMultiplier).toBe(1);
  });

  test("the client catalog says the mode is priced by its params", async () => {
    const { orch, conn } = setup();
    const init = await orch.init({ sid: "pp-catalog" }, conn);
    const reels = init.modes?.find((m) => m.id === "reels");
    expect(reels).toMatchObject({ id: "reels", pricedByParams: true });
    expect(init.modes?.find((m) => m.id === "base")?.pricedByParams).toBeUndefined();
  });
});
