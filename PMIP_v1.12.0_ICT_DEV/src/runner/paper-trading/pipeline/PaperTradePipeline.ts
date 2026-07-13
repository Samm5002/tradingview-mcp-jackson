import type { Decision } from '../../../decision/types/Decision.js';
import type { Opportunity } from '../../../opportunity/types/Opportunity.js';
import type { EnrichedBar } from '../../../types/Bar.js';
import type { ILearningRegistry } from '../../../learning/contracts/ILearningRegistry.js';
import type { OutcomeRecord } from '../../../learning/types/OutcomeRecord.js';
import type { IPaperTradeRegistry } from '../contracts/IPaperTradeRegistry.js';
import type { PaperTrade } from '../types/PaperTrade.js';
import type { TradeLifecycleEvent } from '../engines/TradeMonitor.js';
import type { TradeExplanation } from '../types/TradeExplanation.js';
import type { MarketEventArbiter } from '../engines/MarketEventArbiter.js';
import type { PortfolioAccount } from '../portfolio/PortfolioAccount.js';
import { PaperTradeEngine } from '../engines/PaperTradeEngine.js';
import { TradeMonitor } from '../engines/TradeMonitor.js';
import { OutcomeBuilder } from '../engines/OutcomeBuilder.js';
import { ExplanationBuilder } from '../engines/ExplanationBuilder.js';
import { TERMINAL_STATUSES } from '../types/PaperTrade.js';

// BOS, CHoCH, and MSS in either direction confirm that structure has shifted.
// Time alone must not reset the re-entry lock — only one of these can.
const STRUCTURE_UNLOCK_TYPES = new Set([
  'BULLISH_BOS_CONFIRMED',
  'BEARISH_BOS_CONFIRMED',
  'BULLISH_CHOCH_CONFIRMED',
  'BEARISH_CHOCH_CONFIRMED',
  'BULLISH_MSS_CONFIRMED',
  'BEARISH_MSS_CONFIRMED',
]);

export interface PaperTradeLifecycleEvent {
  readonly trade: PaperTrade;
  readonly eventType: TradeLifecycleEvent['type'] | 'TRADE_PENDING';
  readonly price: number | null;
}

export interface PaperTradePipelineInput {
  readonly newActDecisions: ReadonlyArray<Decision>;
  readonly allOpportunitiesById: ReadonlyMap<string, Opportunity>;
  readonly currentBar: EnrichedBar;
  readonly evidenceTypeById?: ReadonlyMap<string, string>;
}

/** Per-decision diagnostic trace — Sprint 33. Remove after investigation. */
export interface PaperTradeDecisionTrace {
  readonly decisionId: string;
  readonly symbol: string;
  readonly opportunityId: string;
  readonly activeSymbolsBefore: ReadonlyArray<string>;
  readonly activeSymbolsAfter: ReadonlyArray<string>;
  readonly createdTradeId: string | null;
  readonly blocked: boolean;
  readonly blockReason: 'ACTIVE_TRADE' | 'LOCK' | 'MISSING_OPPORTUNITY' | 'MARKET_EVENT' | 'INSUFFICIENT_BALANCE' | null;
}

export interface PaperTradePipelineResult {
  readonly newTrades: ReadonlyArray<PaperTrade>;
  readonly lifecycleEvents: ReadonlyArray<PaperTradeLifecycleEvent>;
  readonly newOutcomes: ReadonlyArray<OutcomeRecord>;
  readonly newExplanations: ReadonlyArray<TradeExplanation>;
  /** ACT decisions skipped because an active trade already exists for this symbol. */
  readonly blockedByActiveTrade: number;
  /** ACT decisions skipped because the re-entry lock is active (waiting for BOS/CHoCH/MSS). */
  readonly blockedByLock: number;
  /**
   * ACT decisions queued into the market event arbiter for next-bar selection.
   * These are not blocked permanently — the best one will be approved next bar.
   */
  readonly blockedByMarketEvent: number;
  /** ACT decisions rejected because free margin was insufficient to open a new position. */
  readonly blockedByInsufficientBalance: number;
  /** Per-decision trace for diagnostics (Sprint 33). Remove after investigation. */
  readonly decisionTraces: ReadonlyArray<PaperTradeDecisionTrace>;
}

export class PaperTradePipeline {
  private readonly monitor = new TradeMonitor();
  private readonly outcomeBuilder = new OutcomeBuilder();
  private readonly explanationBuilder = new ExplanationBuilder();
  // Set to the bar openTime when a trade reaches a terminal status.
  // Cleared only when a BOS, CHoCH, or MSS appears on a *subsequent* bar.
  private _lockedSinceBarTime: Date | null = null;

  constructor(
    private readonly engine: PaperTradeEngine,
    private readonly registry: IPaperTradeRegistry,
    private readonly learningRegistry: ILearningRegistry,
    private readonly symbol: string,
    private readonly arbiter?: MarketEventArbiter | null,
    private readonly portfolio?: PortfolioAccount | null,
  ) {
    this._lockedSinceBarTime = registry.getLockBarTime();
  }

  process(input: PaperTradePipelineInput): PaperTradePipelineResult {
    const newTrades: PaperTrade[] = [];
    const lifecycleEvents: PaperTradeLifecycleEvent[] = [];
    const newOutcomes: OutcomeRecord[] = [];
    const newExplanations: TradeExplanation[] = [];
    const decisionTraces: PaperTradeDecisionTrace[] = [];
    let blockedByActiveTrade = 0;
    let blockedByLock = 0;
    let blockedByMarketEvent = 0;
    let blockedByInsufficientBalance = 0;

    // Update portfolio's last-known price for unrealized P&L tracking.
    this.portfolio?.updatePrice(this.symbol, input.currentBar.close);

    // Clear the re-entry lock if this is a subsequent bar that contains structure evidence.
    if (this._lockedSinceBarTime !== null &&
        input.currentBar.openTime > this._lockedSinceBarTime &&
        input.evidenceTypeById !== undefined &&
        [...input.evidenceTypeById.values()].some(t => STRUCTURE_UNLOCK_TYPES.has(t))) {
      this._lockedSinceBarTime = null;
      this.registry.setLockBarTime(null);
    }

    // Advance the arbiter to the current bar — settles the previous bar if not already settled.
    this.arbiter?.advance(input.currentBar.openTime);

    // Claim any decisions approved by the market event arbiter from the previous bar.
    // Created before monitoring so the current bar immediately checks for fills.
    if (this.arbiter != null) {
      const approved = this.arbiter.claimApproved(this.symbol);
      if (approved !== null) {
        for (const decision of approved.decisions) {
          const active = this.registry.getActive();
          if (active.some(t => t.symbol === decision.symbol)) { blockedByActiveTrade++; continue; }
          if (this._lockedSinceBarTime !== null) { blockedByLock++; continue; }
          const opp = approved.opportunityMap.get(decision.opportunityId);
          if (opp === undefined) continue;
          const allocation = this.portfolio?.allocate(approved.bar.close) ?? undefined;
          if (this.portfolio !== null && this.portfolio !== undefined && allocation === undefined) {
            decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore: active.map(t => t.symbol), activeSymbolsAfter: active.map(t => t.symbol), createdTradeId: null, blocked: true, blockReason: 'INSUFFICIENT_BALANCE' });
            blockedByInsufficientBalance++;
            continue;
          }
          const trade = this.engine.create(decision, opp, approved.bar, approved.evidenceTypeById, allocation);
          if (trade !== null) {
            if (allocation !== undefined) this.portfolio!.confirmTrade(trade.id, trade.symbol, trade.direction, allocation);
            this.registry.register(trade);
            newTrades.push(trade);
            lifecycleEvents.push({ trade, eventType: 'TRADE_PENDING', price: trade.entryPrice });
          }
        }
      }
    }

    // Monitor existing active trades against current bar (before creating new ones)
    for (const trade of this.registry.getActive()) {
      const result = this.monitor.monitor(trade, input.currentBar);
      if (result.lifecycleEvents.length > 0) {
        this.registry.update(result.updatedTrade);
        for (const ev of result.lifecycleEvents) {
          lifecycleEvents.push({ trade: result.updatedTrade, eventType: ev.type, price: ev.price });
          if (ev.type === 'TRADE_FILLED' && ev.price !== null) {
            this.portfolio?.onFilled(result.updatedTrade.id, ev.price);
          }
        }
        if (TERMINAL_STATUSES.has(result.updatedTrade.status)) {
          this._lockedSinceBarTime = input.currentBar.openTime;
          this.registry.setLockBarTime(input.currentBar.openTime);
          if (result.updatedTrade.status === 'EXPIRED') {
            this.portfolio?.cancel(result.updatedTrade.id);
          } else if (result.updatedTrade.profitLoss !== null && result.updatedTrade.positionSize !== null) {
            this.portfolio?.settle(result.updatedTrade.id, result.updatedTrade.profitLoss);
          }
          const outcome = this.outcomeBuilder.build(result.updatedTrade);
          if (outcome !== null) {
            this.learningRegistry.registerOutcome(outcome);
            newOutcomes.push(outcome);
          }
          const explanation = this.explanationBuilder.build(result.updatedTrade);
          if (explanation !== null) {
            this.learningRegistry.registerExplanation(explanation);
            newExplanations.push(explanation);
          }
        }
      }
    }

    // Process new ACT decisions from the current bar.
    // With arbiter: submit for market event ranking (trade created next bar).
    // Without arbiter: create trades immediately (original behavior).
    for (const decision of input.newActDecisions) {
      const activeBefore = this.registry.getActive();
      const activeSymbolsBefore = activeBefore.map(t => t.symbol);
      const opp = input.allOpportunitiesById.get(decision.opportunityId);
      if (opp === undefined) {
        decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: activeSymbolsBefore, createdTradeId: null, blocked: true, blockReason: 'MISSING_OPPORTUNITY' });
        continue;
      }
      if (activeBefore.some(t => t.symbol === decision.symbol)) {
        decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: activeSymbolsBefore, createdTradeId: null, blocked: true, blockReason: 'ACTIVE_TRADE' });
        blockedByActiveTrade++;
        continue;
      }
      if (this._lockedSinceBarTime !== null) {
        decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: activeSymbolsBefore, createdTradeId: null, blocked: true, blockReason: 'LOCK' });
        blockedByLock++;
        continue;
      }

      if (this.arbiter != null) {
        // Submit to market event arbiter — best quality symbol is approved next bar.
        this.arbiter.submit(
          input.currentBar.openTime,
          this.symbol,
          [decision],
          input.allOpportunitiesById,
          input.evidenceTypeById,
          input.currentBar,
          decision.qualitySnapshot.score,
        );
        decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: activeSymbolsBefore, createdTradeId: null, blocked: true, blockReason: 'MARKET_EVENT' });
        blockedByMarketEvent++;
      } else {
        // No arbiter — create trade immediately (used in tests and legacy wiring).
        const allocation = this.portfolio?.allocate(input.currentBar.close) ?? undefined;
        if (this.portfolio !== null && this.portfolio !== undefined && allocation === undefined) {
          decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: activeSymbolsBefore, createdTradeId: null, blocked: true, blockReason: 'INSUFFICIENT_BALANCE' });
          blockedByInsufficientBalance++;
          continue;
        }
        const trade = this.engine.create(decision, opp, input.currentBar, input.evidenceTypeById, allocation);
        if (trade !== null) {
          if (allocation !== undefined) this.portfolio!.confirmTrade(trade.id, trade.symbol, trade.direction, allocation);
          this.registry.register(trade);
          newTrades.push(trade);
          lifecycleEvents.push({ trade, eventType: 'TRADE_PENDING', price: trade.entryPrice });
        }
        decisionTraces.push({ decisionId: decision.id, symbol: decision.symbol, opportunityId: decision.opportunityId, activeSymbolsBefore, activeSymbolsAfter: this.registry.getActive().map(t => t.symbol), createdTradeId: trade !== null ? trade.id : null, blocked: false, blockReason: null });
      }
    }

    return { newTrades, lifecycleEvents, newOutcomes, newExplanations, blockedByActiveTrade, blockedByLock, blockedByMarketEvent, blockedByInsufficientBalance, decisionTraces };
  }
}
