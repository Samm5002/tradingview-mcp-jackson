/**
 * ConsolidationRule — Evidence-layer detection of ICT consolidation/range regime.
 *
 * ICT reference: a consolidation regime occurs when price is range-bound between equal highs
 * and equal lows, with balanced directional pressure and no dominant structural break.
 * Corresponds to HypothesisCategory.CONSOLIDATION.
 *
 * Two Evidence-layer triggers (evaluated in priority order):
 *
 *   1. Equal Extrema Compression (primary — direct ICT observation):
 *      EQUAL_EXTREMA+EQUAL_HIGHS and EQUAL_EXTREMA+EQUAL_LOWS evidence both present on the same bar.
 *      ICT meaning: buy stops accumulating above equal highs AND sell stops below equal lows
 *      simultaneously → price is trapped in a defined consolidation range. This is the only
 *      trigger with a direct structural observation; it does not depend on the confidence engine.
 *
 *   2. Evidence Conflict (secondary — confidence-engine proxy):
 *      confidence.conflictScore >= CONFLICT_THRESHOLD (0.6) AND evidenceCount >= MIN_EVIDENCE_COUNT (2).
 *      ICT meaning: balanced bullish and bearish pressure → no dominant directional order flow → ranging.
 *      conflictScore (0 = one-directional, 1 = maximally conflicted) is the Evidence-layer proxy
 *      for ICT's balanced order flow observation.
 *
 * Both triggers produce direction 'neutral' — consolidation is explicitly non-directional.
 * At most one CONSOLIDATION hypothesis is emitted per bar.
 *
 * Architectural gaps — OHLCV and bar-history data unavailable in the Evidence layer:
 *   1. ICT consolidation range identification requires bar-history window (ATR, range width
 *      relative to average spread). Evidence carries individual observations, not rolling statistics.
 *      The rule cannot verify that price action is actually "tight" or compressed.
 *   2. ICT consolidation box (priceHigh/priceLow boundaries) cannot be derived from Evidence alone.
 *      ReasoningContext provides latestExternalHigh/Low but these are swing extremes, not range edges.
 *   3. Equal extrema on different bars are not captured by single-bar Evidence sampling. If EQUAL_HIGHS
 *      and EQUAL_LOWS are observed on different bars (common in practice), the compression trigger
 *      will not fire even though the structural condition persists.
 *   4. conflictScore with evidenceCount < 4 may reflect thin evidence, not genuine range-bound structure.
 *      MIN_EVIDENCE_COUNT = 2 is the pragmatic minimum from the ConfidenceEngine design; a higher
 *      threshold would reduce false positives but would require more bars of accumulated evidence.
 */
import { generateHypothesisId } from '../../../../utils/generateId.js';
import { EvidenceType } from '../../../../reasoning/types/Evidence.js';
import { EvidenceTag } from '../../../../reasoning/types/EvidenceTag.js';
import { HypothesisCategory } from '../../../types/HypothesisCategory.js';
import type { IProfessionalHypothesisRule } from '../contracts/IProfessionalHypothesisRule.js';
import type { Evidence } from '../../../../reasoning/types/Evidence.js';
import type { ConfidenceScore } from '../../../../reasoning/types/ConfidenceScore.js';
import type { ReasoningContext } from '../../../../reasoning/types/ReasoningContext.js';
import type { HypothesisProviderSeriesInfo } from '../../../contracts/IHypothesisProvider.js';
import type { Hypothesis, ReasoningTraceEntry } from '../../../types/Hypothesis.js';

// conflictScore threshold for the evidence-conflict trigger.
// At 0.6 the directional split is at most 70/30, indicating no dominant directional pressure.
// Mirrors StructureBasedHypothesisProvider's >0.5 threshold, tightened to reduce false positives
// on thin evidence bars.
const CONFLICT_THRESHOLD = 0.6;

// Minimum evidenceCount for the conflict trigger to be meaningful.
// At 2, a single opposing piece produces conflictScore = 0.667 — the practical minimum
// for a conflict signal to carry any weight.
const MIN_EVIDENCE_COUNT = 2;

// Flat representative consolidation score.
// Lower than all directional rules (ICT signals: 65–100) to reflect the non-directional,
// regime-classification nature of this hypothesis — not a trading signal.
const ICT_CONSOLIDATION_SCORE = 55;

export class ConsolidationRule implements IProfessionalHypothesisRule {
  readonly ruleName = 'ConsolidationRule';

  evaluate(
    evidence: ReadonlyArray<Evidence>,
    confidence: ConfidenceScore,
    context: ReasoningContext,
    barTime: Date,
    seriesInfo: HypothesisProviderSeriesInfo,
  ): ReadonlyArray<Hypothesis> {
    // ── Trigger 1: Equal Extrema Compression (priority) ──────────────────────────
    // Both EQUAL_HIGHS and EQUAL_LOWS present on the same bar → price trapped in a range.
    // Note: EQUAL_EXTREMA evidence is also consumed by LiquiditySweepRule when only one
    // direction is dominant. Both rules may fire simultaneously — this is expected and correct.
    const equalHighsEvidence = evidence.filter(
      e => e.type === EvidenceType.EQUAL_EXTREMA && e.tags.includes(EvidenceTag.EQUAL_HIGHS),
    );
    const equalLowsEvidence = evidence.filter(
      e => e.type === EvidenceType.EQUAL_EXTREMA && e.tags.includes(EvidenceTag.EQUAL_LOWS),
    );
    const hasEqualCompression = equalHighsEvidence.length > 0 && equalLowsEvidence.length > 0;

    // ── Trigger 2: Evidence Conflict (secondary) ──────────────────────────────────
    // Balanced evidence pressure with sufficient count → no dominant directional flow.
    const hasConflict =
      confidence.conflictScore >= CONFLICT_THRESHOLD &&
      confidence.evidenceCount >= MIN_EVIDENCE_COUNT;

    if (!hasEqualCompression && !hasConflict) return [];

    const idsOf = (arr: ReadonlyArray<Evidence>): ReadonlyArray<string> => arr.map(e => e.id);

    // Equal extrema compression takes priority: it is a direct structural ICT observation.
    const subType = hasEqualCompression ? 'Equal Extrema Compression' : 'Evidence Conflict';
    const supportingEvidence: ReadonlyArray<Evidence> = hasEqualCompression
      ? [...equalHighsEvidence, ...equalLowsEvidence]
      : [...evidence];

    const trace: ReasoningTraceEntry[] = [
      {
        step: 1,
        description: hasEqualCompression
          ? 'Equal highs and equal lows both present — price compressed in consolidation range (EQUAL_EXTREMA + EQUAL_HIGHS / EQUAL_LOWS)'
          : `Evidence conflict signal (conflictScore=${confidence.conflictScore.toFixed(2)} >= ${CONFLICT_THRESHOLD}) — balanced directional pressure, no dominant flow`,
        evidenceIds: idsOf(supportingEvidence),
      },
    ];

    return [{
      id:       generateHypothesisId(),
      name:     `Consolidation - ${subType}`,
      category: HypothesisCategory.CONSOLIDATION,
      direction: 'neutral',
      confidence: {
        score:              ICT_CONSOLIDATION_SCORE,
        supportStrength:    ICT_CONSOLIDATION_SCORE / 100,
        oppositionStrength: 0,
        completeness:       1,
      },
      supportingEvidenceIds: idsOf(supportingEvidence),
      opposingEvidenceIds:   [],
      missingEvidence:       [],
      preconditions: hasEqualCompression
        ? ['Equal highs and equal lows simultaneously detected via EQUAL_EXTREMA evidence']
        : [`Evidence conflict detected: conflictScore=${confidence.conflictScore.toFixed(2)} (threshold ${CONFLICT_THRESHOLD}), evidenceCount=${confidence.evidenceCount}`],
      invalidations: [
        { condition: 'Structure break (BOS, CHOCH, or MSS) confirmed in either direction', evidenceType: EvidenceType.STRUCTURE_BREAK },
        { condition: 'Displacement candle breaks out of the consolidation range', evidenceType: EvidenceType.DISPLACEMENT },
      ],
      reasoningTrace:  trace,
      sourceProvider:  this.ruleName,
      providerVersion: '1.0.0',
      generatedAt:     new Date(),
      barTime,
      symbol:          seriesInfo.symbol,
      exchange:        seriesInfo.exchange,
      timeframe:       seriesInfo.timeframe,
      metadata: {
        subType,
        conflictScore:        confidence.conflictScore,
        evidenceCount:        confidence.evidenceCount,
        equalHighsCount:      equalHighsEvidence.length,
        equalLowsCount:       equalLowsEvidence.length,
        hasNoStructureBreaks: context.latestBos === null && context.latestChoch === null && context.latestMss === null,
        // Architectural gaps vs ICT (OHLCV and bar-history data unavailable):
        // - ICT consolidation range requires rolling ATR/range statistics → not computable here
        // - Equal extrema on different bars miss the compression trigger → single-bar limitation
        // - conflictScore with low evidenceCount may reflect thin data, not genuine ranging
        // - ICT consolidation box (priceHigh/priceLow) not derivable from Evidence layer
      },
    }];
  }
}