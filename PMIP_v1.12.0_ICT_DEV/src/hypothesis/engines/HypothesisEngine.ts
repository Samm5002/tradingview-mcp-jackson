import { generateHypothesisResultId } from '../../utils/generateId.js';
import { DEFAULT_EVIDENCE_WEIGHTS } from '../../reasoning/types/EvidenceWeightConfig.js';
import type { IHypothesisEngine, HypothesisEngineSeriesInfo } from '../contracts/IHypothesisEngine.js';
import type { IHypothesisProvider } from '../contracts/IHypothesisProvider.js';
import type { IConflictResolver } from '../contracts/IConflictResolver.js';
import type { Evidence } from '../../reasoning/types/Evidence.js';
import type { ConfidenceScore } from '../../reasoning/types/ConfidenceScore.js';
import type { ReasoningContext } from '../../reasoning/types/ReasoningContext.js';
import type { Hypothesis } from '../types/Hypothesis.js';
import type { HypothesisResult } from '../types/HypothesisResult.js';

const HYPOTHESIS_SCHEMA_VERSION = '1.0.0';

export class HypothesisEngine implements IHypothesisEngine {
  constructor(
    private readonly providers: ReadonlyArray<IHypothesisProvider>,
    private readonly conflictResolver: IConflictResolver,
  ) {}

  evaluate(
    evidence: ReadonlyArray<Evidence>,
    confidence: ConfidenceScore,
    context: ReasoningContext,
    seriesInfo: HypothesisEngineSeriesInfo,
    externalHypotheses: ReadonlyArray<Hypothesis> = [],
  ): HypothesisResult {
    const seriesProviderInfo = {
      symbol:    seriesInfo.symbol,
      exchange:  seriesInfo.exchange as string,
      timeframe: seriesInfo.timeframe as string,
    };

    const internalHypotheses = this.providers.flatMap(provider =>
      provider.generateHypotheses(evidence, confidence, context, seriesInfo.barTime, seriesProviderInfo),
    );

    const enrichedExternals = externalHypotheses.length > 0
      ? externalHypotheses.map(h => this._enrich(h, evidence, confidence))
      : [];

    // Merge enriched external hypotheses with internally-generated ones before
    // conflict resolution so the ConflictResolver sees the full picture.
    const allHypotheses = enrichedExternals.length > 0
      ? [...internalHypotheses, ...enrichedExternals]
      : internalHypotheses;

    const resolution = this.conflictResolver.resolve(allHypotheses);

    return {
      id:                      generateHypothesisResultId(),
      schema:                  HYPOTHESIS_SCHEMA_VERSION,
      symbol:                  seriesInfo.symbol,
      exchange:                seriesInfo.exchange,
      timeframe:               seriesInfo.timeframe,
      barTime:                 seriesInfo.barTime,
      computedAt:              new Date(),
      hypotheses:              allHypotheses,
      resolution,
      sourceReasoningResultId: seriesInfo.sourceReasoningResultId,
    };
  }

  /**
   * Enriches an external (provider-generated) hypothesis with evidence-grounded scores,
   * excluding the hypothesis's own provider's evidence to prevent circular self-scoring.
   *
   * Directional (bullish/bearish): score, supportStrength, oppositionStrength,
   * completeness, and evidence ID arrays are recomputed from external evidence only,
   * using DEFAULT_EVIDENCE_WEIGHTS for the weighted directional score computation.
   *
   * Indeterminate: neutral external evidence populates supporting IDs and supportStrength;
   * score is left unchanged because no directional score can be derived.
   */
  private _enrich(
    h: Hypothesis,
    evidence: ReadonlyArray<Evidence>,
    confidence: ConfidenceScore,
  ): Hypothesis {
    // Structural observation evidence (no sourceProvider in metadata) is always
    // included. The hypothesis's own provider's evidence is excluded to prevent
    // the provider from self-scoring via the evidence it just emitted.
    const external = evidence.filter(
      e => e.metadata['sourceProvider'] === undefined ||
           e.metadata['sourceProvider'] !== h.sourceProvider,
    );

    if (h.direction === 'bullish' || h.direction === 'bearish') {
      const oppDir     = h.direction === 'bullish' ? 'bearish' : 'bullish';
      const supporting = external.filter(e => e.direction === h.direction);
      const opposing   = external.filter(e => e.direction === oppDir);

      let extBullishWeight = 0;
      let extBearishWeight = 0;
      for (const e of external) {
        const w = DEFAULT_EVIDENCE_WEIGHTS[e.type] ?? 0.5;
        if (e.direction === 'bullish')      extBullishWeight += w;
        else if (e.direction === 'bearish') extBearishWeight += w;
      }

      const extDirectional = extBullishWeight + extBearishWeight;
      const dirWeight      = h.direction === 'bullish' ? extBullishWeight : extBearishWeight;
      const rawScore       = extDirectional === 0 ? 0 : (dirWeight / extDirectional) * 100;

      const sCount = supporting.length;
      const oCount = opposing.length;

      return {
        ...h,
        supportingEvidenceIds: supporting.map(e => e.id),
        opposingEvidenceIds:   opposing.map(e => e.id),
        confidence: {
          ...h.confidence,
          score:              Math.max(5, Math.min(95, rawScore)),
          supportStrength:    sCount,
          oppositionStrength: oCount,
          completeness:       sCount / Math.max(1, sCount + oCount),
        },
      };
    }

    // Indeterminate: neutral external evidence populates supporting IDs;
    // completeness reflects overall market conflict; score is unchanged.
    const neutral = external.filter(e => e.direction === 'neutral');
    return {
      ...h,
      supportingEvidenceIds: neutral.map(e => e.id),
      opposingEvidenceIds:   [],
      confidence: {
        ...h.confidence,
        supportStrength:    neutral.length,
        oppositionStrength: 0,
        completeness:       confidence.conflictScore,
      },
    };
  }
}