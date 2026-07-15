import type { IBarPipelineProcessor } from './contracts/IBarPipelineProcessor.js';
import type { EnrichedBar } from '../types/Bar.js';
import type { BarPipelineResult } from './types/BarPipelineResult.js';
import type { ILogger } from '../platform/logging/ILogger.js';
import type { IMetricsCollector } from '../platform/metrics/IMetricsCollector.js';
import type { PlatformConfig } from '../platform/config/types/PlatformConfig.js';
import type { ProviderConfig } from '../sdk/types/ProviderConfig.js';
import type { SeriesKey } from '../contracts/IActiveExtremumCache.js';
import type { OhlcvBar } from '../learning/types/OhlcvBar.js';
import type { Exchange } from '../types/Exchange.js';
import type { Timeframe } from '../types/Timeframe.js';
import type { IDecisionRegistry } from '../decision/contracts/IDecisionRegistry.js';
import type { IOpportunityRegistry } from '../opportunity/contracts/IOpportunityRegistry.js';
import type { IHypothesisRegistry } from '../hypothesis/contracts/IHypothesisRegistry.js';
import type { IPolicyRegistry } from '../policy/contracts/IPolicyRegistry.js';
import type { IReasoningRegistry } from '../reasoning/contracts/IReasoningRegistry.js';
import type { IProvider } from '../sdk/contracts/IProvider.js';
import type { PresentationEvent } from '../presentation/types/PresentationEvent.js';
import { IngestionPipeline } from '../pipeline/IngestionPipeline.js';
import { ReasoningPipeline } from '../reasoning/pipeline/ReasoningPipeline.js';
import { HypothesisPipeline } from '../hypothesis/pipeline/HypothesisPipeline.js';
import type { IHypothesisProvider, HypothesisProviderSeriesInfo } from '../hypothesis/contracts/IHypothesisProvider.js';
import { PolicyPipeline } from '../policy/pipeline/PolicyPipeline.js';
import { OpportunityPipeline } from '../opportunity/pipeline/OpportunityPipeline.js';
import { DecisionPipeline } from '../decision/pipeline/DecisionPipeline.js';
import { ProviderOrchestrator } from '../orchestrator/ProviderOrchestrator.js';
import { IntegrationHarness } from '../integration/IntegrationHarness.js';
import { ProviderContext } from '../sdk/context/ProviderContext.js';
import { PresentationPipeline } from '../presentation/pipeline/PresentationPipeline.js';
import { PaperTradePipeline } from './paper-trading/pipeline/PaperTradePipeline.js';
import { generatePresentationEventId } from '../utils/generateId.js';
import type { PaperTradeLifecycleEvent } from './paper-trading/pipeline/PaperTradePipeline.js';
import type { PipelineDiagnostics } from './diagnostics/PipelineDiagnostics.js';
import type { ICTDryRunObserver } from './diagnostics/ICTDryRunObserver.js';
import type { ShadowValidator } from './diagnostics/ShadowValidator.js';

export interface BarPipelineProcessorDeps {
  // Pipeline stages
  readonly ingestionPipeline: IngestionPipeline;
  readonly orchestrator: ProviderOrchestrator;
  readonly integrationHarness: IntegrationHarness;
  readonly reasoningPipeline: ReasoningPipeline;
  readonly hypothesisPipeline: HypothesisPipeline;
  readonly policyPipeline: PolicyPipeline;
  readonly opportunityPipeline: OpportunityPipeline;
  readonly decisionPipeline: DecisionPipeline;
  readonly presentationPipeline: PresentationPipeline;
  /** Optional Paper Trading pipeline. Enabled only when PaperTradeConfig.enabled is true. */
  readonly paperTradePipeline?: PaperTradePipeline;
  // Registries for ProviderContext (read-only access)
  readonly decisionRegistry: IDecisionRegistry;
  readonly opportunityRegistry: IOpportunityRegistry;
  readonly hypothesisRegistry: IHypothesisRegistry;
  readonly policyRegistry: IPolicyRegistry;
  readonly reasoningRegistry: IReasoningRegistry;
  // Platform
  readonly logger: ILogger;
  readonly metrics: IMetricsCollector;
  readonly platformConfig: PlatformConfig;
  readonly providerConfig: ProviderConfig;
  // Series identity
  readonly symbol: string;
  readonly exchange: Exchange;
  readonly timeframe: Timeframe;
  /** Optional pipeline diagnostics collector. When provided, live bars are recorded. */
  readonly diagnostics?: PipelineDiagnostics;
  /** Optional ICT dry-run observer. When provided, ICT detection runs on every live bar
   *  for diagnostic logging only — output never enters the main pipeline. */
  readonly ictObserver?: ICTDryRunObserver;
  /** Optional professional hypothesis provider. Runs in parallel with the existing hypothesis
   *  pipeline after the Reasoning Layer. Its output is logged for comparison only —
   *  never enters Policy, Opportunity, or Decision. */
  readonly professionalHypothesisProvider?: IHypothesisProvider;
  /** Optional shadow validator. When provided, compares PHP vs existing hypothesis output
   *  on every live bar. Observation only — no behavioral effect. */
  readonly shadowValidator?: ShadowValidator;
}

function isBarConsumer(p: IProvider): p is IProvider & { updateBars(bars: ReadonlyArray<OhlcvBar>): void } {
  return typeof (p as unknown as Record<string, unknown>)['updateBars'] === 'function';
}

const TIMEFRAME_MS: Partial<Record<string, number>> = {
  '1': 60_000, '3': 180_000, '5': 300_000, '15': 900_000, '30': 1_800_000,
  '60': 3_600_000, '120': 7_200_000, '240': 14_400_000, '360': 21_600_000,
  '720': 43_200_000, 'D': 86_400_000, 'W': 604_800_000,
};

/**
 * Format a price with adaptive decimal precision so small prices are never
 * rounded to zero. Thresholds are chosen to cover the full range of USDT
 * perpetual futures prices on BingX:
 *   >= 1000  → 2 decimals  (BTC, large-cap)
 *   >= 1     → 4 decimals  (SOL, LINK, mid-cap)
 *   >= 0.01  → 6 decimals  (small-cap alts, BOME-class)
 *   < 0.01   → 8 decimals  (micro-cap, sub-cent tokens)
 * Trailing zeros are stripped; thousands separator applied to integer part only.
 */
export function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  const fixed = n.toFixed(decimals)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  const dotIdx = fixed.indexOf('.');
  if (dotIdx === -1) {
    return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  const intPart = fixed.slice(0, dotIdx).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${intPart}${fixed.slice(dotIdx)}`;
}

function fmtDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function buildTradeEvent(ev: PaperTradeLifecycleEvent): PresentationEvent {
  const { trade, eventType, price } = ev;
  const priceStr = price !== null ? fmtPrice(price) : '';
  // trade.profitLoss is a raw price delta (price units). Convert to dollar P&L for display.
  const dollarPnL = trade.profitLoss !== null && trade.positionSize !== null
    ? trade.profitLoss * trade.positionSize
    : null;
  const pnlStr = dollarPnL !== null
    ? (dollarPnL >= 0 ? `+$${dollarPnL.toFixed(2)}` : `-$${Math.abs(dollarPnL).toFixed(2)}`)
    : '';
  const resultStr = trade.status === 'CLOSED_PROFIT' ? 'PROFIT' : trade.status === 'STOP_LOSS' ? 'LOSS' : '';
  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  const fmtRR = (tp: number): string => {
    if (risk === 0) return '1:?';
    return `1:${(Math.abs(tp - trade.entryPrice) / risk).toFixed(1)}`;
  };
  const durationMs = trade.exitAt !== null
    ? trade.exitAt.getTime() - (trade.filledAt ?? trade.createdAt).getTime()
    : null;
  const tradeDuration = durationMs !== null ? fmtDuration(durationMs) : '';
  // pnlPct: prefer margin-based % (dollarPnL / margin), fall back to price-based for pre-portfolio trades
  const pnlPct = dollarPnL !== null && trade.marginUsed !== null && trade.marginUsed !== 0
    ? ((dollarPnL / trade.marginUsed) * 100 >= 0 ? '+' : '') +
      ((dollarPnL / trade.marginUsed) * 100).toFixed(2) + '%'
    : trade.profitLoss !== null && trade.filledPrice !== null && trade.filledPrice !== 0
      ? ((trade.profitLoss / trade.filledPrice) * 100 >= 0 ? '+' : '') +
        ((trade.profitLoss / trade.filledPrice) * 100).toFixed(2) + '%'
      : '';
  const baseAsset = trade.symbol.includes('-') ? trade.symbol.slice(0, trade.symbol.indexOf('-')) : trade.symbol;
  const meta: Record<string, string> = {
    direction: trade.direction,
    entryPrice: fmtPrice(trade.entryPrice),
    stopLoss: fmtPrice(trade.stopLoss),
    tp1: fmtPrice(trade.tp1),
    rrTp1: fmtRR(trade.tp1),
    filledPrice: trade.filledPrice !== null ? fmtPrice(trade.filledPrice) : '',
    exitPrice: trade.exitPrice !== null ? fmtPrice(trade.exitPrice) : '',
    profitLoss: pnlStr,
    pnlPct,
    tradeDuration,
    result: resultStr,
    qualityScore: trade.qualityScore.toFixed(0),
    marginUsed: trade.marginUsed !== null ? `$${trade.marginUsed.toFixed(2)}` : '',
    positionStr: trade.positionSize !== null ? `${fmtPrice(trade.positionSize)} ${baseAsset}` : '',
  };
  return {
    id: generatePresentationEventId(),
    schema: '1.0.0',
    eventType,
    occurredAt: new Date(),
    symbol: trade.symbol,
    exchange: trade.exchange,
    timeframe: trade.timeframe,
    payload: {
      title: `${eventType} — ${trade.symbol} ${trade.direction}`,
      summary: `${trade.direction} ${trade.symbol} @ ${fmtPrice(trade.entryPrice)} | ${priceStr}`,
      details: `Trade ID: ${trade.id} | Status: ${trade.status}`,
      tags: [trade.symbol, trade.direction, trade.timeframe],
      metadata: meta,
    },
    sourceId: trade.id,
    sourceType: 'TRADE',
    priority: eventType === 'TRADE_PENDING' || eventType === 'TRADE_FILLED' ? 'HIGH' : 'MEDIUM',
  };
}

function toOhlcvBars(bars: ReadonlyArray<EnrichedBar>): ReadonlyArray<OhlcvBar> {
  return bars.map(b => ({
    barTime: b.openTime,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    symbol: b.symbol,
    exchange: b.exchange,
    timeframe: b.timeframe,
  }));
}

/**
 * Processes one enriched bar through the complete PMIP pipeline:
 * Observation → Providers → Integration → Reasoning → Hypothesis →
 * Policy → Opportunity → Decision → Presentation.
 *
 * Holds all pipeline component references for one (symbol, exchange, timeframe) series.
 */
export class BarPipelineProcessor implements IBarPipelineProcessor {
  private readonly key: SeriesKey;
  private _barWindow: ReadonlyArray<EnrichedBar> = [];
  private _barCount = 0;
  // True after the first call to _run(). Ensures orchestrator.initializeAll() is
  // called exactly once per series, before any executeAll() invocation.
  private _providersInitialized = false;

  constructor(private readonly deps: BarPipelineProcessorDeps) {
    this.key = { symbol: deps.symbol, exchange: deps.exchange, timeframe: deps.timeframe };
  }

  async warmup(bars: ReadonlyArray<EnrichedBar>): Promise<void> {
    // A-003: grow the bar window incrementally so each warmup bar sees only its own
    // history and not future bars (look-ahead prevention).
    for (let i = 0; i < bars.length; i++) {
      this._barWindow = bars.slice(Math.max(0, i - 249), i + 1);
      await this._run(bars[i]!, true);
    }
  }

  async processBar(bar: EnrichedBar): Promise<BarPipelineResult> {
    this._barWindow = [...this._barWindow, bar].slice(-250);
    this._barCount++;
    if (this._barCount % 50 === 0) {
      const tfMs = TIMEFRAME_MS[this.deps.timeframe] ?? 60_000;
      const cutoffBarTime = new Date(bar.openTime.getTime() - 500 * tfMs);
      this.deps.opportunityRegistry.compact(cutoffBarTime);
      this.deps.decisionRegistry.compact(cutoffBarTime);
      this.deps.reasoningRegistry.compact(cutoffBarTime);
      this.deps.ingestionPipeline.compact(cutoffBarTime);
    }
    return this._run(bar, false);
  }

  private async _run(bar: EnrichedBar, isWarmup: boolean): Promise<BarPipelineResult> {
    const t0 = Date.now();
    const { deps } = this;
    try {

    // Step 1: Observation pipeline (ADR-012 order — must complete before providers execute)
    await deps.ingestionPipeline.processBar(bar);

    // Step 2: Push bar window to bar-consuming providers
    const ohlcvBars = toOhlcvBars(this._barWindow);

    // ICT dry-run observation (Phase 2) — isolation guaranteed: engine.detect() returns
    // raw RawICTSignal primitives only; no Evidence/Hypothesis objects are created here.
    if (!isWarmup && deps.ictObserver !== undefined) {
      deps.ictObserver.observe(ohlcvBars, deps.symbol, deps.timeframe, bar.openTime, deps.logger);
    }

    for (const provider of deps.orchestrator.getRegistry().getAll()) {
      if (isBarConsumer(provider)) {
        provider.updateBars(ohlcvBars);
      }
    }

    // Step 3: Build ProviderContext from settled registries
    const providerContext = new ProviderContext({
      symbol: deps.symbol,
      exchange: deps.exchange,
      timeframe: deps.timeframe,
      currentBarTime: bar.openTime,
      decisionRegistry: deps.decisionRegistry,
      opportunityRegistry: deps.opportunityRegistry,
      hypothesisRegistry: deps.hypothesisRegistry,
      policyRegistry: deps.policyRegistry,
      reasoningRegistry: deps.reasoningRegistry,
      logger: deps.logger,
      metrics: deps.metrics,
      platformConfig: deps.platformConfig,
      providerConfig: deps.providerConfig,
    });

    // Step 4: Execute all registered providers
    // Initialize providers once on the first bar so they transition from
    // UNINITIALIZED → ACTIVE before executeAll() runs. Without this, the
    // orchestrator unconditionally skips every provider on every bar.
    if (!this._providersInitialized) {
      this._providersInitialized = true;
      await deps.orchestrator.initializeAll(providerContext);
    }
    const orchResult = await deps.orchestrator.executeAll(providerContext);

    // Step 5: Extract Evidence and Hypotheses from provider results (ADR-012)
    const integration = deps.integrationHarness.extract(orchResult);

    // Step 6: Reasoning — merge observation + provider evidence (ADR-012 additive)
    const reasoningResult = deps.reasoningPipeline.flushBar(
      this.key, bar.openTime, integration.evidence,
    );

    // Step 7: Hypothesis — merge internal + provider hypotheses through ConflictResolver
    const hypothesisResult = deps.hypothesisPipeline.process(
      reasoningResult, integration.hypotheses,
    );

    // Step 7b: Professional hypothesis — observation only, never enters Policy
    let professionalHypothesesCount = 0;
    if (!isWarmup && deps.professionalHypothesisProvider !== undefined) {
      const seriesInfo: HypothesisProviderSeriesInfo = {
        symbol: deps.symbol, exchange: deps.exchange, timeframe: deps.timeframe,
      };
      const professionalHypotheses = deps.professionalHypothesisProvider.generateHypotheses(
        reasoningResult.evidence,
        reasoningResult.confidence,
        reasoningResult.context,
        bar.openTime,
        seriesInfo,
      );
      professionalHypothesesCount = professionalHypotheses.length;
      if (professionalHypothesesCount > 0) {
        const categories = [...new Set(professionalHypotheses.map(h => h.category))].join(',');
        deps.logger.info(
          `[PROF/HYP] count=${professionalHypothesesCount} categories=${categories} existingCount=${hypothesisResult.hypotheses.length}`,
        );
      }
      // Shadow Validation: compare PHP vs StructureBasedHypothesisProvider only (excludes ICT externals)
      if (deps.shadowValidator !== undefined) {
        const internalHypotheses = hypothesisResult.hypotheses.filter(
          h => h.sourceProvider === 'StructureBasedProvider',
        );
        deps.shadowValidator.compareBar(
          deps.symbol,
          deps.timeframe,
          bar.openTime,
          internalHypotheses,
          professionalHypotheses,
        );
      }
    }

    // Step 8: Policy
    const policyResult = deps.policyPipeline.process(
      hypothesisResult, reasoningResult.confidence, reasoningResult.context,
    );

    // Step 9: Opportunity — capture previous state to detect newly created opportunities
    const prevActiveOpps   = deps.opportunityRegistry.getActive(this.key);
    const prevOppIds       = new Set(prevActiveOpps.map(o => o.id));
    const prevFormingOpps  = prevActiveOpps.filter(o => o.status === 'FORMING');
    const prevFormingIds   = new Set(prevFormingOpps.map(o => o.id));
    const activeOpportunities = deps.opportunityPipeline.process(
      policyResult, hypothesisResult, reasoningResult.confidence,
      reasoningResult.context, reasoningResult.id,
    );

    if (!isWarmup) {
      const activeOppIds  = new Set(activeOpportunities.map(o => o.id));
      const newOpps       = activeOpportunities.filter(o => !prevOppIds.has(o.id));
      const confirmedOpps = activeOpportunities.filter(o => o.status === 'ACTIVE' && prevFormingIds.has(o.id));
      const expiredOpps   = prevFormingOpps.filter(o => !activeOppIds.has(o.id));

      for (const opp of newOpps) {
        deps.logger.warn(`[OPP/CREATED] oppId=${opp.id} direction=${opp.direction} category=${opp.category}`);
      }
      for (const opp of confirmedOpps) {
        deps.logger.warn(`[OPP/CONFIRMED] oppId=${opp.id} direction=${opp.direction} category=${opp.category}`);
      }
      for (const opp of expiredOpps) {
        const hasQualified = policyResult.qualifiedHypothesisIds.length > 0;
        if (!hasQualified) {
          deps.logger.warn(`[OPP/EXPIRED] oppId=${opp.id} direction=${opp.direction} reason=NO_QUALIFIED_HYPOTHESIS`);
        } else {
          const oppDir = opp.direction;
          const bosList   = reasoningResult.evidence.filter(e => e.observationType.includes('BOS')  && e.direction !== oppDir && e.direction !== 'neutral');
          const mssList   = reasoningResult.evidence.filter(e => e.observationType.includes('MSS')  && e.direction !== oppDir && e.direction !== 'neutral');
          const chochList = reasoningResult.evidence.filter(e => e.observationType.includes('CHOCH') && e.direction !== oppDir && e.direction !== 'neutral');
          const parts: string[] = [];
          if (mssList.length   > 0) parts.push(`OPP_MSS`);
          if (bosList.length   > 0) parts.push(`OPP_BOS`);
          if (chochList.length > 0) parts.push(`OPP_CHOCH`);
          deps.logger.warn(`[OPP/EXPIRED] oppId=${opp.id} direction=${opp.direction} reason=${parts.length > 0 ? parts.join('+') : 'REGIME_OTHER'}`);
        }
      }
    }

    // Step 10: Decision — capture previous state to detect newly created decisions
    const prevOpen = deps.decisionRegistry.getOpen(this.key);
    const prevDecisionIds = new Set(prevOpen.map(d => d.id));
    const decisionResult = deps.decisionPipeline.process(
      activeOpportunities, policyResult, hypothesisResult,
      reasoningResult.confidence, reasoningResult.context,
    );
    const openDecisions = decisionResult.openDecisions;
    const newDecisions = openDecisions.filter(d => !prevDecisionIds.has(d.id));
    const newOpportunities = activeOpportunities.filter(o => !prevOppIds.has(o.id));

    // Collect pending activations from policy evaluations for L-002
    const pendingActivations: import('../learning/pipeline/LearningPipeline.js').PendingComponentActivation[] = [];
    for (const decision of newDecisions) {
      for (const hypId of decision.supportingHypothesisIds) {
        for (const ev of policyResult.evaluations) {
          if (ev.hypothesisId === hypId) {
            pendingActivations.push({
              decisionId: decision.id,
              componentName: ev.policyId,
              componentType: 'POLICY_EVALUATOR',
              activated: ev.qualified,
            });
          }
        }
      }
    }

    // Step 10.5: Paper Trading (suppressed during warmup — same policy as Presentation)
    const tradeEvents: PresentationEvent[] = [];
    let blockedByActiveTrade = 0;
    let blockedByLock = 0;
    let newActDecisions: typeof openDecisions = [];
    let newTradesCreated = 0;
    if (!isWarmup && deps.paperTradePipeline !== undefined) {
      // Submit all currently-open ACT decisions every live bar so that non-winners
      // from a previous arbiter batch can re-compete on subsequent bars. This also
      // eliminates the warmup-promotion flood: warmup ACT decisions enter the pool
      // naturally on the first live bar alongside any new live-bar ACT decisions.
      newActDecisions = openDecisions.filter(d => d.decisionType === 'ACT');
      const allOpportunitiesById = new Map(activeOpportunities.map(o => [o.id, o]));
      const evidenceTypeById = new Map<string, string>(
        reasoningResult.evidence.map(e => [e.id, e.observationType]),
      );
      const tradeResult = deps.paperTradePipeline.process({
        newActDecisions,
        allOpportunitiesById,
        currentBar: bar,
        evidenceTypeById,
      });
      blockedByActiveTrade = tradeResult.blockedByActiveTrade;
      blockedByLock = tradeResult.blockedByLock;
      newTradesCreated = tradeResult.newTrades.length;
      for (const ev of tradeResult.lifecycleEvents) {
        tradeEvents.push(buildTradeEvent(ev));
      }
      // DIAG Sprint-33: log per-decision outcomes and lifecycle events. Remove after investigation.
      for (const trace of tradeResult.decisionTraces) {
        const ab = trace.activeSymbolsBefore.join(',') || '∅';
        if (trace.blocked) {
          deps.logger.warn(`[DIAG/ACT] BLOCKED symbol=${trace.symbol} decisionId=${trace.decisionId} oppId=${trace.opportunityId} reason=${trace.blockReason} activeBefore=[${ab}]`);
        } else {
          const aa = trace.activeSymbolsAfter.join(',') || '∅';
          deps.logger.warn(`[DIAG/ACT] CREATED symbol=${trace.symbol} decisionId=${trace.decisionId} oppId=${trace.opportunityId} tradeId=${trace.createdTradeId ?? 'null'} activeBefore=[${ab}] activeAfter=[${aa}]`);
        }
      }
      for (const ev of tradeResult.lifecycleEvents) {
        const src = ev.eventType === 'TRADE_PENDING' ? 'CREATION' : 'MONITOR';
        deps.logger.warn(`[DIAG/TRADE-EVENT] eventType=${ev.eventType} tradeId=${ev.trade.id} symbol=${ev.trade.symbol} status=${ev.trade.status} source=${src}`);
      }
    }

    // Step 11: Presentation (suppressed during warmup — no notifications for historical bars)
    if (!isWarmup) {
      await deps.presentationPipeline.process({
        newDecisions,
        retractedDecisionIds: [],
        supersededDecisionIds: [],
        newOpportunities,
        activatedOpportunityIds: [],
        expiredOpportunityIds: [],
        invalidatedOpportunityIds: [],
        newResearchDocuments: [],
        newPerformanceReports: [],
        reportRequest: null,
        ...(tradeEvents.length > 0 ? { additionalEvents: tradeEvents } : {}),
      });
    }

    // Diagnostic recording — live bars only, read-only, no threshold changes
    if (!isWarmup && deps.diagnostics !== undefined) {
      const qualifiedSet = new Set(policyResult.qualifiedHypothesisIds);
      const policyRejectionsByRule: Record<string, number> = {};
      const policyRejectionsByEvaluator: Record<string, number> = {};
      for (const ev of policyResult.evaluations) {
        if (qualifiedSet.has(ev.hypothesisId)) continue;
        if (ev.qualified) continue;
        policyRejectionsByEvaluator[ev.policyId] = (policyRejectionsByEvaluator[ev.policyId] ?? 0) + 1;
        for (const rule of ev.failedRules) {
          policyRejectionsByRule[rule.ruleId] = (policyRejectionsByRule[rule.ruleId] ?? 0) + 1;
        }
      }

      const decisionsByType: Record<string, number> = {};
      const nonActReasons: Record<string, number> = {};
      let qualityBlockedWait = { count: 0, scoreSum: 0, evComplSum: 0, hypoAgrSum: 0, ctxRichSum: 0, conflictPenSum: 0, policyStrSum: 0 };
      let ruleDowngradedWait = { count: 0, scoreSum: 0, evComplSum: 0, hypoAgrSum: 0, ctxRichSum: 0, conflictPenSum: 0, policyStrSum: 0 };
      for (const d of newDecisions) {
        decisionsByType[d.decisionType] = (decisionsByType[d.decisionType] ?? 0) + 1;
        if (d.decisionType !== 'ACT') {
          if (d.trace.initialDecisionType !== 'ACT') {
            const key = `QualityThreshold→${d.trace.initialDecisionType}`;
            nonActReasons[key] = (nonActReasons[key] ?? 0) + 1;
          }
          for (const entry of d.trace.entries) {
            if (entry.action === 'downgrade') {
              nonActReasons[entry.ruleName] = (nonActReasons[entry.ruleName] ?? 0) + 1;
            }
          }
        }
        if (d.decisionType === 'WAIT') {
          const q = d.qualitySnapshot;
          const bucket = d.trace.initialDecisionType !== 'ACT' ? 'qb' : 'rd';
          const target = bucket === 'qb' ? qualityBlockedWait : ruleDowngradedWait;
          target.count++;
          target.scoreSum += q.score;
          target.evComplSum += q.evidenceCompleteness;
          target.hypoAgrSum += q.hypothesisAgreement;
          target.ctxRichSum += q.contextRichness;
          target.conflictPenSum += q.conflictPenalty;
          target.policyStrSum += q.policyStrength;
        }
      }

      deps.diagnostics.record({
        evidenceCount: reasoningResult.evidence.length,
        hypothesesTotal: hypothesisResult.hypotheses.length,
        hypothesesQualified: policyResult.qualifiedHypothesisIds.length,
        policyRejectedTotal: hypothesisResult.hypotheses.length - policyResult.qualifiedHypothesisIds.length,
        policyRejectionsByRule,
        policyRejectionsByEvaluator,
        newOpportunityCount: newOpportunities.length,
        formingCount: activeOpportunities.filter(o => o.status === 'FORMING').length,
        activeCount: activeOpportunities.filter(o => o.status === 'ACTIVE').length,
        conflictFlaggedCount: activeOpportunities.filter(o => o.conflictGroupId !== null).length,
        newDecisionCount: newDecisions.length,
        decisionsByType,
        nonActReasons,
        qualityBlockedWait,
        ruleDowngradedWait,
        actDecisionsReceived: newActDecisions.length,
        newTradesCreated,
        blockedByActiveTrade,
        blockedByLock,
      });
    }

    deps.metrics.increment('runner.bars_processed', 1, {
      symbol: deps.symbol,
      timeframe: deps.timeframe,
    });
    if (newDecisions.length > 0) {
      deps.metrics.increment('runner.decisions_produced', newDecisions.length, {
        symbol: deps.symbol,
        timeframe: deps.timeframe,
      });
    }

    return {
      barTime: bar.openTime,
      symbol: deps.symbol,
      exchange: deps.exchange,
      timeframe: deps.timeframe,
      evidenceCount: reasoningResult.evidence.length,
      hypothesesCount: hypothesisResult.hypotheses.length,
      professionalHypothesesCount,
      activeOpportunities,
      openDecisions,
      newDecisions,
      pendingActivations,
      processingMs: Date.now() - t0,
    };

    } catch (err) {
      deps.logger.error(
        `[BarPipelineProcessor] Unhandled error on bar ${bar.openTime.toISOString()} ` +
        `symbol=${deps.symbol} timeframe=${deps.timeframe}`,
        err instanceof Error ? err : null,
      );
      return {
        barTime: bar.openTime,
        symbol: deps.symbol,
        exchange: deps.exchange,
        timeframe: deps.timeframe,
        evidenceCount: 0,
        hypothesesCount: 0,
        professionalHypothesesCount: 0,
        activeOpportunities: deps.opportunityRegistry.getActive(this.key),
        openDecisions: deps.decisionRegistry.getOpen(this.key),
        newDecisions: [],
        pendingActivations: [],
        processingMs: Date.now() - t0,
      };
    }
  }
}
