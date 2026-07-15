/**
 * MultiFactorConfluenceRule -- Synthesizes confluence when >=2 independent ICT signal domains
 * align in the same direction simultaneously.
 *
 * In ICT methodology, a "confluent setup" has multiple independent signals agreeing on direction:
 * e.g. BOS (bullish) + FVG (bullish) + Order Block (bullish) = high-conviction bullish confluence.
 * Each additional aligned signal raises conviction and score.
 *
 * Since RuleExecutionPipeline does not share inter-rule outputs (all rules receive the same
 * inputs independently), this rule re-derives each of the 6 directional PHP rules' trigger
 * conditions from the same Evidence, ConfidenceScore, and ReasoningContext those rules receive.
 *
 * Signal domains (one per directional PHP rule):
 *   1. STRUCTURE_CONTINUATION  -- context.latestBos direction
 *   2. STRUCTURE_REVERSAL      -- context.latestChoch / latestMss direction
 *   3. BLOCK_REACTION          -- BLOCK_ZONE evidence (strength >= ICT_BLOCK_THRESHOLD)
 *   4. LIQUIDITY_SWEEP         -- LIQUIDITY_EVENT+SWEEP or EQUAL_EXTREMA+EQUAL_HIGHS/LOWS
 *   5. INEFFICIENCY_FILL       -- PRICE_INEFFICIENCY+FVG direction
 *   6. DISPLACEMENT_FOLLOW     -- DISPLACEMENT+IMPULSIVE direction
 *
 * Confluence condition: dominated direction (strictly more signals in one direction) has
 * >= MIN_CONFLUENCE_COUNT (2) aligned signals.
 *
 * Score: 65 (base for 2 signals) + 10 per additional aligned signal, capped at 90.
 *
 * Category: assigned from highest-priority signal among the aligned set (ICT structural
 * priority: REVERSAL > CONTINUATION > DISPLACEMENT > BLOCK > SWEEP > INEFFICIENCY).
 * No HypothesisCategory.CONFLUENCE exists in the current type system.
 *
 * Architectural gaps -- RuleExecutionPipeline does not share inter-rule outputs:
 *   1. Confluence is re-derived from Evidence/Context rather than actual PHP rule outputs.
 *      If any downstream rule logic changes, this rule must be updated in parallel.
 *   2. Context-based signals (STRUCTURE_CONTINUATION, STRUCTURE_REVERSAL) derive from context
 *      summaries (latestBos, latestChoch, latestMss), not Evidence objects. These signals
 *      contribute no evidence IDs to supportingEvidenceIds.
 *   3. There is no HypothesisCategory.CONFLUENCE in the type system -- category is assigned
 *      from the highest-priority aligned signal.
 *   4. Tie-break scenarios for per-evidence direction detection may diverge subtly from
 *      individual rules when they run the identical tie-break path independently.
 */
import { generateHypothesisId } from '../../../../utils/generateId.js';
import { EvidenceType } from '../../../../reasoning/types/Evidence.js';
import { EvidenceTag } from '../../../../reasoning/types/EvidenceTag.js';
import { HypothesisCategory } from '../../../types/HypothesisCategory.js';
import type { IProfessionalHypothesisRule } from '../contracts/IProfessionalHypothesisRule.js';
import type { Evidence, EvidenceDirection } from '../../../../reasoning/types/Evidence.js';
import type { ConfidenceScore } from '../../../../reasoning/types/ConfidenceScore.js';
import type { ReasoningContext } from '../../../../reasoning/types/ReasoningContext.js';
import type { HypothesisProviderSeriesInfo } from '../../../contracts/IHypothesisProvider.js';
import type { Hypothesis, ReasoningTraceEntry } from '../../../types/Hypothesis.js';

const MIN_CONFLUENCE_COUNT = 2;
// Mirrors BlockReactionRule: ICTHypothesisMapper HYPOTHESIS_THRESHOLD = 65.
const ICT_BLOCK_THRESHOLD  = 65;

// Score: 65 for 2 aligned signals, +10 per additional, capped at 90.
function confluenceScore(count: number): number {
  return Math.min(90, 65 + (count - 2) * 10);
}

// ICT structural priority for category assignment.
// When multiple signals are aligned, the highest-priority signal's category is used.
const SIGNAL_PRIORITY: ReadonlyArray<{ name: string; category: HypothesisCategory }> = [
  { name: 'STRUCTURE_REVERSAL',     category: HypothesisCategory.STRUCTURE_REVERSAL    },
  { name: 'STRUCTURE_CONTINUATION', category: HypothesisCategory.STRUCTURE_CONTINUATION },
  { name: 'DISPLACEMENT_FOLLOW',    category: HypothesisCategory.DISPLACEMENT_FOLLOW   },
  { name: 'BLOCK_REACTION',         category: HypothesisCategory.BLOCK_REACTION        },
  { name: 'LIQUIDITY_SWEEP',        category: HypothesisCategory.LIQUIDITY_SWEEP       },
  { name: 'INEFFICIENCY_FILL',      category: HypothesisCategory.INEFFICIENCY_FILL     },
];

interface SignalDetection {
  readonly name: string;
  readonly direction: EvidenceDirection;
  readonly evidenceIds: ReadonlyArray<string>;
}

export class MultiFactorConfluenceRule implements IProfessionalHypothesisRule {
  readonly ruleName = 'MultiFactorConfluenceRule';

  evaluate(
    evidence: ReadonlyArray<Evidence>,
    confidence: ConfidenceScore,
    context: ReasoningContext,
    barTime: Date,
    seriesInfo: HypothesisProviderSeriesInfo,
  ): ReadonlyArray<Hypothesis> {
    const allSignals = this.detectSignals(evidence, confidence, context);

    const bullish = allSignals.filter(s => s.direction === 'bullish');
    const bearish = allSignals.filter(s => s.direction === 'bearish');

    const aligned: ReadonlyArray<SignalDetection> =
      bullish.length > bearish.length && bullish.length >= MIN_CONFLUENCE_COUNT ? bullish :
      bearish.length > bullish.length && bearish.length >= MIN_CONFLUENCE_COUNT ? bearish :
      [];

    if (aligned.length === 0) return [];

    const confluenceDir = aligned[0]!.direction as 'bullish' | 'bearish';
    const count         = aligned.length;
    const score         = confluenceScore(count);
    const label         = confluenceDir === 'bullish' ? 'Bullish' : 'Bearish';

    // Category from the highest-priority signal in the aligned set.
    const alignedNames = new Set(aligned.map(s => s.name));
    const primary = SIGNAL_PRIORITY.find(sp => alignedNames.has(sp.name));
    const category = primary?.category ?? HypothesisCategory.STRUCTURE_CONTINUATION;

    // Supporting evidence IDs from all aligned signals (deduplicated).
    const supportingIds = [...new Set(aligned.flatMap(s => s.evidenceIds))];
    const signalNames   = aligned.map(s => s.name);

    const extraSignals = count - 2;
    const extraDesc = extraSignals === 0
      ? 'no extra signals'
      : `${extraSignals} extra signal${extraSignals === 1 ? '' : 's'}`;

    const trace: ReasoningTraceEntry[] = [
      {
        step: 1,
        description: `Detected ${count} aligned ${label.toLowerCase()} signals: ${signalNames.join(', ')}`,
        evidenceIds: supportingIds,
      },
      {
        step: 2,
        description: `Multi-factor confluence score: ${score} (base 65 + ${extraSignals * 10} from ${extraDesc}, capped at 90)`,
        evidenceIds: [],
      },
    ];

    return [{
      id:        generateHypothesisId(),
      name:      `Multi-Factor Confluence - ${label} (${count})`,
      category,
      direction: confluenceDir,
      confidence: {
        score,
        supportStrength:    score / 100,  // ICT: signal.strength / 100
        oppositionStrength: 0,             // ICT: always 0
        completeness:       1,             // ICT: always 1
      },
      supportingEvidenceIds: supportingIds,
      opposingEvidenceIds:   [],
      missingEvidence:       [],
      preconditions: [
        `${count} aligned ${label.toLowerCase()} PHP-domain signals: ${signalNames.join(', ')}`,
      ],
      invalidations: [
        { condition: 'Opposing structure break (BOS, CHOCH, or MSS) invalidates the directional bias', evidenceType: EvidenceType.STRUCTURE_BREAK },
        { condition: 'Aligned signal count drops below minimum confluence threshold', evidenceType: null },
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
        confluenceCount:      count,
        confluenceDirection:  confluenceDir,
        alignedSignals:       signalNames,
        opposingSignalCount:  allSignals.length - count,
        totalSignalsDetected: allSignals.length,
        // Architectural gaps vs ICT (RuleExecutionPipeline does not share inter-rule outputs):
        // - Re-detects trigger conditions rather than reading actual PHP rule outputs
        // - STRUCTURE_CONTINUATION and STRUCTURE_REVERSAL signals carry no evidence IDs (context-only)
        // - Category reflects highest-priority aligned signal; no HypothesisCategory.CONFLUENCE exists
      },
    }];
  }

  // Re-derives each rule's triggering conditions from the same Evidence+Context inputs.
  // RuleExecutionPipeline provides no inter-rule access -- outputs cannot be shared directly.
  private detectSignals(
    evidence: ReadonlyArray<Evidence>,
    confidence: ConfidenceScore,
    context: ReasoningContext,
  ): SignalDetection[] {
    const signals: SignalDetection[] = [];

    // 1. StructureContinuationRule: fires when context.latestBos !== null
    if (context.latestBos !== null) {
      signals.push({
        name:        'STRUCTURE_CONTINUATION',
        direction:   context.latestBos.direction,
        evidenceIds: [],  // architectural gap: BOS is a context summary, not an Evidence object
      });
    }

    // 2. StructureReversalRule: fires when latestChoch or latestMss is present
    if (context.latestChoch !== null || context.latestMss !== null) {
      const src = context.latestChoch ?? context.latestMss!;
      signals.push({
        name:        'STRUCTURE_REVERSAL',
        direction:   src.direction,
        evidenceIds: [],  // architectural gap: CHOCH/MSS is a context summary, not an Evidence object
      });
    }

    // 3. BlockReactionRule: BLOCK_ZONE evidence with strength >= ICT_BLOCK_THRESHOLD
    const blockEvidence = evidence.filter(
      e => e.type === EvidenceType.BLOCK_ZONE && e.strength >= ICT_BLOCK_THRESHOLD,
    );
    if (blockEvidence.length > 0) {
      const bBull = blockEvidence.filter(e => e.direction === 'bullish');
      const bBear = blockEvidence.filter(e => e.direction === 'bearish');
      const blockDir: EvidenceDirection =
        bBull.length > bBear.length ? 'bullish' :
        bBear.length > bBull.length ? 'bearish' :
        confidence.bullishScore >= confidence.bearishScore ? 'bullish' : 'bearish';
      const aligned = blockEvidence.filter(e => e.direction === blockDir);
      if (aligned.length > 0) {
        signals.push({ name: 'BLOCK_REACTION', direction: blockDir, evidenceIds: aligned.map(e => e.id) });
      }
    }

    // 4. LiquiditySweepRule: LIQUIDITY_EVENT+SWEEP (priority) or EQUAL_EXTREMA+EQUAL_HIGHS/LOWS
    const sweepEvidence = evidence.filter(
      e => e.type === EvidenceType.LIQUIDITY_EVENT && e.tags.includes(EvidenceTag.SWEEP),
    );
    const equalEvidence = evidence.filter(
      e => e.type === EvidenceType.EQUAL_EXTREMA &&
        (e.tags.includes(EvidenceTag.EQUAL_HIGHS) || e.tags.includes(EvidenceTag.EQUAL_LOWS)),
    );
    if (sweepEvidence.length > 0) {
      const buySide  = sweepEvidence.filter(e => e.tags.includes(EvidenceTag.BUY_SIDE));
      const sellSide = sweepEvidence.filter(e => e.tags.includes(EvidenceTag.SELL_SIDE));
      const sweepDir: EvidenceDirection =
        buySide.length > sellSide.length  ? 'bearish' :
        sellSide.length > buySide.length  ? 'bullish' :
        confidence.bearishScore >= confidence.bullishScore ? 'bearish' : 'bullish';
      const aligned = sweepDir === 'bearish' ? buySide : sellSide;
      signals.push({ name: 'LIQUIDITY_SWEEP', direction: sweepDir, evidenceIds: aligned.map(e => e.id) });
    } else if (equalEvidence.length > 0) {
      const eqHighs = equalEvidence.filter(e => e.tags.includes(EvidenceTag.EQUAL_HIGHS));
      const eqLows  = equalEvidence.filter(e => e.tags.includes(EvidenceTag.EQUAL_LOWS));
      const equalDir: EvidenceDirection =
        eqHighs.length > eqLows.length  ? 'bearish' :
        eqLows.length > eqHighs.length  ? 'bullish' :
        confidence.bearishScore >= confidence.bullishScore ? 'bearish' : 'bullish';
      const aligned = equalDir === 'bearish' ? eqHighs : eqLows;
      signals.push({ name: 'LIQUIDITY_SWEEP', direction: equalDir, evidenceIds: aligned.map(e => e.id) });
    }

    // 5. InefficiencyFillRule: PRICE_INEFFICIENCY+FVG evidence
    const fvgEvidence = evidence.filter(
      e => e.type === EvidenceType.PRICE_INEFFICIENCY && e.tags.includes(EvidenceTag.FVG),
    );
    if (fvgEvidence.length > 0) {
      const fBull = fvgEvidence.filter(e => e.direction === 'bullish');
      const fBear = fvgEvidence.filter(e => e.direction === 'bearish');
      const fvgDir: EvidenceDirection =
        fBull.length > fBear.length ? 'bullish' :
        fBear.length > fBull.length ? 'bearish' :
        confidence.bullishScore >= confidence.bearishScore ? 'bullish' : 'bearish';
      const aligned = fvgEvidence.filter(e => e.direction === fvgDir);
      if (aligned.length > 0) {
        signals.push({ name: 'INEFFICIENCY_FILL', direction: fvgDir, evidenceIds: aligned.map(e => e.id) });
      }
    }

    // 6. DisplacementRule: DISPLACEMENT+IMPULSIVE evidence
    const dispEvidence = evidence.filter(
      e => e.type === EvidenceType.DISPLACEMENT && e.tags.includes(EvidenceTag.IMPULSIVE),
    );
    if (dispEvidence.length > 0) {
      const dBull = dispEvidence.filter(e => e.direction === 'bullish');
      const dBear = dispEvidence.filter(e => e.direction === 'bearish');
      const dispDir: EvidenceDirection =
        dBull.length > dBear.length ? 'bullish' :
        dBear.length > dBull.length ? 'bearish' :
        confidence.bullishScore >= confidence.bearishScore ? 'bullish' : 'bearish';
      const aligned = dispEvidence.filter(e => e.direction === dispDir);
      if (aligned.length > 0) {
        signals.push({ name: 'DISPLACEMENT_FOLLOW', direction: dispDir, evidenceIds: aligned.map(e => e.id) });
      }
    }

    return signals;
  }
}
