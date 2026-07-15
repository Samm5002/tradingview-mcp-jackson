/**
 * @file ConsolidationRuleParity.test.ts
 *
 * Verifies ConsolidationRule as the Evidence-layer implementation of the ICT consolidation
 * regime (HypothesisCategory.CONSOLIDATION).
 *
 * Two triggers under test:
 *   1. Equal Extrema Compression (primary): EQUAL_EXTREMA+EQUAL_HIGHS AND EQUAL_EXTREMA+EQUAL_LOWS
 *      both present on the same bar â€” price compressed in a consolidation range.
 *   2. Evidence Conflict (secondary): conflictScore >= 0.6 AND evidenceCount >= 2 â€”
 *      balanced directional pressure with no dominant flow.
 *
 * Documented architectural gaps:
 *   - ICT consolidation range requires rolling OHLCV statistics (ATR, range width) â€” not in Evidence layer
 *   - Equal extrema arriving on different bars miss the compression trigger (single-bar sampling)
 *   - conflictScore with evidenceCount < 4 may reflect thin data, not genuine consolidation
 *   - ICT consolidation box pricing (priceHigh/priceLow) not derivable from Evidence layer alone
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConsolidationRule }               from '../../../../src/hypothesis/providers/professional/rules/ConsolidationRule.js';
import { StructureBasedHypothesisProvider } from '../../../../src/hypothesis/providers/StructureBasedHypothesisProvider.js';
import { HypothesisCategory }              from '../../../../src/hypothesis/types/HypothesisCategory.js';
import { EvidenceType }                    from '../../../../src/reasoning/types/Evidence.js';
import { EvidenceTag }                     from '../../../../src/reasoning/types/EvidenceTag.js';
import type { Evidence, EvidenceDirection } from '../../../../src/reasoning/types/Evidence.js';
import type { ConfidenceScore }            from '../../../../src/reasoning/types/ConfidenceScore.js';
import type { ReasoningContext, BreakSummary } from '../../../../src/reasoning/types/ReasoningContext.js';
import type { HypothesisProviderSeriesInfo } from '../../../../src/hypothesis/contracts/IHypothesisProvider.js';

// â”€â”€â”€ Fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeEvidence(
  type: EvidenceType,
  direction: EvidenceDirection,
  tags: EvidenceTag[] = [],
  id = `evd_${type}`,
  strength = 50,
): Evidence {
  return {
    id, type, direction,
    observationId: `obs_${id}`,
    observationType: 'BAR_CLOSED',
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
    barTime:    new Date('2026-01-01T00:00:00Z'),
    detectedAt: new Date('2026-01-01T00:00:00Z'),
    strength,
    tags,
    metadata: {},
  };
}

function makeEqualHighs(id: string): Evidence {
  return makeEvidence(EvidenceType.EQUAL_EXTREMA, 'neutral', [EvidenceTag.EQUAL_HIGHS], id);
}

function makeEqualLows(id: string): Evidence {
  return makeEvidence(EvidenceType.EQUAL_EXTREMA, 'neutral', [EvidenceTag.EQUAL_LOWS], id);
}

function makeStructureBreak(direction: EvidenceDirection, id: string): Evidence {
  return makeEvidence(EvidenceType.STRUCTURE_BREAK, direction, [EvidenceTag.BOS], id);
}

function makeDisplacementEv(direction: EvidenceDirection, id: string): Evidence {
  return makeEvidence(EvidenceType.DISPLACEMENT, direction, [EvidenceTag.IMPULSIVE], id);
}

function makeBreak(direction: EvidenceDirection, obsId: string): BreakSummary {
  return {
    obsId,
    observationType: direction === 'bullish' ? 'BULLISH_BOS_CONFIRMED' : 'BEARISH_BOS_CONFIRMED',
    direction,
    barTime: new Date('2026-01-01T00:00:00Z'),
    brokenPrice: direction === 'bullish' ? 49900 : 50100,
  };
}

// â”€â”€â”€ Confidence fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CONFLICTED_CONFIDENCE: ConfidenceScore = {
  bullishScore: 40, bearishScore: 60, netScore: -20, conflictScore: 0.8,
  totalWeight: 5, bullishWeight: 2, bearishWeight: 3, neutralWeight: 0,
  evidenceCount: 5, bullishCount: 2, bearishCount: 3, neutralCount: 0,
};

const THRESHOLD_CONFIDENCE: ConfidenceScore = {
  bullishScore: 40, bearishScore: 60, netScore: -20, conflictScore: 0.6,
  totalWeight: 5, bullishWeight: 2, bearishWeight: 3, neutralWeight: 0,
  evidenceCount: 2, bullishCount: 1, bearishCount: 1, neutralCount: 0,
};

const BELOW_THRESHOLD_CONFIDENCE: ConfidenceScore = {
  bullishScore: 41, bearishScore: 59, netScore: -18, conflictScore: 0.59,
  totalWeight: 5, bullishWeight: 2.95, bearishWeight: 2.05, neutralWeight: 0,
  evidenceCount: 5, bullishCount: 3, bearishCount: 2, neutralCount: 0,
};

const THIN_CONFLICT_CONFIDENCE: ConfidenceScore = {
  bullishScore: 50, bearishScore: 50, netScore: 0, conflictScore: 1.0,
  totalWeight: 2, bullishWeight: 1, bearishWeight: 1, neutralWeight: 0,
  evidenceCount: 1, bullishCount: 1, bearishCount: 0, neutralCount: 0,
};

const BULLISH_CONFIDENCE: ConfidenceScore = {
  bullishScore: 80, bearishScore: 20, netScore: 60, conflictScore: 0.4,
  totalWeight: 5, bullishWeight: 4, bearishWeight: 1, neutralWeight: 0,
  evidenceCount: 5, bullishCount: 4, bearishCount: 1, neutralCount: 0,
};

const ZERO_CONFIDENCE: ConfidenceScore = {
  bullishScore: 0, bearishScore: 0, netScore: 0, conflictScore: 0,
  totalWeight: 0, bullishWeight: 0, bearishWeight: 0, neutralWeight: 0,
  evidenceCount: 0, bullishCount: 0, bearishCount: 0, neutralCount: 0,
};

// â”€â”€â”€ Context fixtures â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function makeEmptyContext(): ReasoningContext {
  return {
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
    barTime: new Date('2026-01-01T00:00:00Z'),
    latestExternalHigh: null, latestExternalLow: null,
    latestInternalHigh: null, latestInternalLow: null,
    latestBos: null, latestChoch: null, latestMss: null,
    activeFvgs: [], activeOrderBlocks: [],
    activeBuySidePools: [], activeSellSidePools: [],
  };
}

// â”€â”€â”€ Test helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SERIES_INFO: HypothesisProviderSeriesInfo = { symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h' };
const BAR_TIME = new Date('2026-01-01T00:00:00Z');

const RULE     = new ConsolidationRule();
const EXISTING = new StructureBasedHypothesisProvider();

const EQ_HIGH = () => makeEqualHighs('evd_eq_high');
const EQ_LOW  = () => makeEqualLows('evd_eq_low');

function ruleResult(ev: ReadonlyArray<Evidence>, conf: ConfidenceScore, ctx: ReasoningContext) {
  return RULE.evaluate(ev, conf, ctx, BAR_TIME, SERIES_INFO)[0];
}

// â”€â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('ConsolidationRule', () => {

  describe('rule contract', () => {
    it('ruleName === ConsolidationRule', () => {
      assert.equal(RULE.ruleName, 'ConsolidationRule');
    });

    it('no evidence, zero confidence returns []', () => {
      const result = RULE.evaluate([], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.equal(result.length, 0);
    });

    it('no triggers met returns []', () => {
      const result = RULE.evaluate(
        [makeStructureBreak('bullish', 'ev1')], BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO,
      );
      assert.equal(result.length, 0);
    });

    it('equal highs + equal lows returns exactly 1 hypothesis', () => {
      const result = RULE.evaluate([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.equal(result.length, 1);
    });

    it('conflict signal returns exactly 1 hypothesis', () => {
      const result = RULE.evaluate([], CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.equal(result.length, 1);
    });

    it('returns an array', () => {
      assert.ok(Array.isArray(RULE.evaluate([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO)));
    });
  });

  describe('Trigger 1: Equal Extrema Compression', () => {
    it('both equal highs and equal lows fires', () => {
      assert.equal(RULE.evaluate([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('equal highs only does not trigger compression', () => {
      assert.equal(RULE.evaluate([EQ_HIGH()], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('equal lows only does not trigger compression', () => {
      assert.equal(RULE.evaluate([EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('EQUAL_EXTREMA without EQUAL_HIGHS or EQUAL_LOWS tag does not trigger', () => {
      const ev = makeEvidence(EvidenceType.EQUAL_EXTREMA, 'neutral', [], 'ev_notag');
      assert.equal(RULE.evaluate([ev], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('multiple equal highs + one equal low fires', () => {
      const ev = [makeEqualHighs('h1'), makeEqualHighs('h2'), makeEqualLows('l1')];
      assert.equal(RULE.evaluate(ev, ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('compression name contains "Equal Extrema Compression"', () => {
      const h = ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.name.includes('Equal Extrema Compression'), `got: ${h!.name}`);
    });

    it('compression supportingEvidenceIds includes equal highs ID', () => {
      const high = makeEqualHighs('high_ev');
      const h = ruleResult([high, EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.supportingEvidenceIds.includes('high_ev'));
    });

    it('compression supportingEvidenceIds includes equal lows ID', () => {
      const low = makeEqualLows('low_ev');
      const h = ruleResult([EQ_HIGH(), low], ZERO_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.supportingEvidenceIds.includes('low_ev'));
    });

    it('compression supportingEvidenceIds excludes unrelated evidence', () => {
      const sb = makeStructureBreak('bullish', 'unrelated_sb');
      const h = ruleResult([EQ_HIGH(), EQ_LOW(), sb], ZERO_CONFIDENCE, makeEmptyContext());
      assert.ok(!h!.supportingEvidenceIds.includes('unrelated_sb'));
    });

    it('compression takes priority over conflict when both triggers met', () => {
      const h = ruleResult([EQ_HIGH(), EQ_LOW()], CONFLICTED_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.name.includes('Equal Extrema Compression'), `got: ${h!.name}`);
    });
  });

  describe('Trigger 2: Evidence Conflict', () => {
    it('conflictScore >= 0.6 and evidenceCount >= 2 fires', () => {
      assert.equal(RULE.evaluate([], CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('conflictScore exactly 0.6 fires (inclusive threshold)', () => {
      assert.equal(RULE.evaluate([], THRESHOLD_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('conflictScore = 0.59 does not fire', () => {
      assert.equal(RULE.evaluate([], BELOW_THRESHOLD_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('conflictScore >= 0.6 but evidenceCount = 1 does not fire', () => {
      assert.equal(RULE.evaluate([], THIN_CONFLICT_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('directional confidence (conflictScore = 0.4) does not fire', () => {
      assert.equal(RULE.evaluate([], BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('conflict name contains "Evidence Conflict"', () => {
      const h = ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.name.includes('Evidence Conflict'), `got: ${h!.name}`);
    });

    it('conflict supportingEvidenceIds includes all provided evidence IDs', () => {
      const ev = [makeStructureBreak('bullish', 'ev_bull'), makeStructureBreak('bearish', 'ev_bear')];
      const h = ruleResult(ev, CONFLICTED_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.supportingEvidenceIds.includes('ev_bull'));
      assert.ok(h!.supportingEvidenceIds.includes('ev_bear'));
    });
  });

  describe('direction', () => {
    it('compression trigger direction = neutral', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.direction, 'neutral');
    });

    it('conflict trigger direction = neutral', () => {
      assert.equal(ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.direction, 'neutral');
    });

    it('direction is always neutral regardless of confidence bias', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], BULLISH_CONFIDENCE, makeEmptyContext())!.direction, 'neutral');
    });
  });

  describe('category', () => {
    it('compression trigger category = CONSOLIDATION', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.category, HypothesisCategory.CONSOLIDATION);
    });

    it('conflict trigger category = CONSOLIDATION', () => {
      assert.equal(ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.category, HypothesisCategory.CONSOLIDATION);
    });
  });

  describe('name format', () => {
    it('compression: "Consolidation - Equal Extrema Compression"', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.name, 'Consolidation - Equal Extrema Compression');
    });

    it('conflict: "Consolidation - Evidence Conflict"', () => {
      assert.equal(ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.name, 'Consolidation - Evidence Conflict');
    });

    it('name always starts with "Consolidation"', () => {
      assert.ok(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.name.startsWith('Consolidation'));
      assert.ok(ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.name.startsWith('Consolidation'));
    });
  });

  describe('ICT-equivalent confidence fields', () => {
    it('score === 55 (flat ICT_CONSOLIDATION_SCORE)', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.confidence.score, 55);
    });

    it('conflict trigger also produces score === 55', () => {
      assert.equal(ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.confidence.score, 55);
    });

    it('supportStrength === 0.55 (score / 100)', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.confidence.supportStrength, 0.55);
    });

    it('oppositionStrength === 0', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.confidence.oppositionStrength, 0);
    });

    it('completeness === 1', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.confidence.completeness, 1);
    });

    it('score is identical for both trigger types', () => {
      assert.equal(
        ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.confidence.score,
        ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.confidence.score,
      );
    });
  });

  describe('evidence IDs', () => {
    it('compression: supportingEvidenceIds contains equal highs ID', () => {
      const high = makeEqualHighs('eq_high_check');
      assert.ok(ruleResult([high, EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.supportingEvidenceIds.includes('eq_high_check'));
    });

    it('compression: supportingEvidenceIds contains equal lows ID', () => {
      const low = makeEqualLows('eq_low_check');
      assert.ok(ruleResult([EQ_HIGH(), low], ZERO_CONFIDENCE, makeEmptyContext())!.supportingEvidenceIds.includes('eq_low_check'));
    });

    it('compression: supportingEvidenceIds excludes unrelated evidence', () => {
      const sb = makeStructureBreak('bullish', 'unrelated_check');
      assert.ok(!ruleResult([EQ_HIGH(), EQ_LOW(), sb], ZERO_CONFIDENCE, makeEmptyContext())!.supportingEvidenceIds.includes('unrelated_check'));
    });

    it('conflict: supportingEvidenceIds includes all evidence IDs', () => {
      const ev = [makeStructureBreak('bullish', 'b1'), makeStructureBreak('bearish', 'b2')];
      const h = ruleResult(ev, CONFLICTED_CONFIDENCE, makeEmptyContext());
      assert.ok(h!.supportingEvidenceIds.includes('b1'));
      assert.ok(h!.supportingEvidenceIds.includes('b2'));
    });

    it('opposingEvidenceIds is empty', () => {
      assert.deepEqual([...ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.opposingEvidenceIds], []);
    });

    it('missingEvidence is empty', () => {
      assert.deepEqual([...ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.missingEvidence], []);
    });
  });

  describe('preconditions', () => {
    it('exactly 1 precondition', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.preconditions.length, 1);
    });

    it('compression precondition mentions "equal"', () => {
      const pre = ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.preconditions[0]!;
      assert.ok(pre.toLowerCase().includes('equal'), `got: ${pre}`);
    });

    it('conflict precondition mentions "conflict"', () => {
      const pre = ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.preconditions[0]!;
      assert.ok(pre.toLowerCase().includes('conflict'), `got: ${pre}`);
    });

    it('conflict precondition includes actual conflictScore value', () => {
      const pre = ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.preconditions[0]!;
      assert.ok(pre.includes('0.80'), `got: ${pre}`);
    });
  });

  describe('invalidations', () => {
    it('exactly 2 invalidations', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.invalidations.length, 2);
    });

    it('first invalidation evidenceType === STRUCTURE_BREAK', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.invalidations[0]!.evidenceType, EvidenceType.STRUCTURE_BREAK);
    });

    it('second invalidation evidenceType === DISPLACEMENT', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.invalidations[1]!.evidenceType, EvidenceType.DISPLACEMENT);
    });

    it('all invalidation conditions are non-empty strings', () => {
      const h = ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!;
      for (const inv of h.invalidations) {
        assert.ok(typeof inv.condition === 'string' && inv.condition.length > 0);
      }
    });
  });

  describe('reasoning trace', () => {
    it('exactly 1 trace step', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.reasoningTrace.length, 1);
    });

    it('trace step has step === 1', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.step, 1);
    });

    it('trace description is non-empty', () => {
      assert.ok(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.description.length > 0);
    });

    it('compression trace evidenceIds includes equal highs ID', () => {
      const high = makeEqualHighs('trace_high_ev');
      assert.ok(ruleResult([high, EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.evidenceIds.includes('trace_high_ev'));
    });

    it('compression trace evidenceIds includes equal lows ID', () => {
      const low = makeEqualLows('trace_low_ev');
      assert.ok(ruleResult([EQ_HIGH(), low], ZERO_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.evidenceIds.includes('trace_low_ev'));
    });

    it('conflict trace description mentions "conflict"', () => {
      const desc = ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.description;
      assert.ok(desc.toLowerCase().includes('conflict'), `got: ${desc}`);
    });

    it('conflict trace description includes actual conflictScore value', () => {
      const desc = ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.reasoningTrace[0]!.description;
      assert.ok(desc.includes('0.80'), `got: ${desc}`);
    });
  });

  describe('metadata', () => {
    it('subType = "Equal Extrema Compression" for compression trigger', () => {
      assert.equal((ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['subType'], 'Equal Extrema Compression');
    });

    it('subType = "Evidence Conflict" for conflict trigger', () => {
      assert.equal((ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['subType'], 'Evidence Conflict');
    });

    it('conflictScore reflects confidence.conflictScore', () => {
      assert.equal((ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['conflictScore'], CONFLICTED_CONFIDENCE.conflictScore);
    });

    it('evidenceCount reflects confidence.evidenceCount', () => {
      assert.equal((ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['evidenceCount'], CONFLICTED_CONFIDENCE.evidenceCount);
    });

    it('equalHighsCount matches EQUAL_HIGHS evidence count', () => {
      const ev = [makeEqualHighs('h1'), makeEqualHighs('h2'), EQ_LOW()];
      assert.equal((ruleResult(ev, ZERO_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['equalHighsCount'], 2);
    });

    it('equalLowsCount matches EQUAL_LOWS evidence count', () => {
      const ev = [EQ_HIGH(), makeEqualLows('l1'), makeEqualLows('l2')];
      assert.equal((ruleResult(ev, ZERO_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['equalLowsCount'], 2);
    });

    it('hasNoStructureBreaks = true when context has no breaks', () => {
      assert.equal((ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['hasNoStructureBreaks'], true);
    });

    it('hasNoStructureBreaks = false when context has latestBos', () => {
      const ctx = { ...makeEmptyContext(), latestBos: makeBreak('bullish', 'bos1') };
      assert.equal((ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, ctx)!.metadata as Record<string, unknown>)['hasNoStructureBreaks'], false);
    });

    it('hasNoStructureBreaks = false when context has latestChoch', () => {
      const ctx = { ...makeEmptyContext(), latestChoch: makeBreak('bearish', 'choch1') };
      assert.equal((ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, ctx)!.metadata as Record<string, unknown>)['hasNoStructureBreaks'], false);
    });

    it('hasNoStructureBreaks = false when context has latestMss', () => {
      const ctx = { ...makeEmptyContext(), latestMss: makeBreak('bullish', 'mss1') };
      assert.equal((ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, ctx)!.metadata as Record<string, unknown>)['hasNoStructureBreaks'], false);
    });

    it('equalHighsCount = 0 when conflict trigger fires with no equal extrema', () => {
      assert.equal((ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['equalHighsCount'], 0);
    });

    it('equalLowsCount = 0 when conflict trigger fires with no equal extrema', () => {
      assert.equal((ruleResult([], CONFLICTED_CONFIDENCE, makeEmptyContext())!.metadata as Record<string, unknown>)['equalLowsCount'], 0);
    });
  });

  describe('hypothesis fields', () => {
    it('id is a non-empty string', () => {
      const h = ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext());
      assert.ok(typeof h!.id === 'string' && h!.id.length > 0);
    });

    it('id is unique per call', () => {
      const ev = [EQ_HIGH(), EQ_LOW()];
      const h1 = ruleResult(ev, ZERO_CONFIDENCE, makeEmptyContext());
      const h2 = ruleResult(ev, ZERO_CONFIDENCE, makeEmptyContext());
      assert.notEqual(h1!.id, h2!.id);
    });

    it('symbol matches seriesInfo.symbol', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.symbol, SERIES_INFO.symbol);
    });

    it('exchange matches seriesInfo.exchange', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.exchange, SERIES_INFO.exchange);
    });

    it('timeframe matches seriesInfo.timeframe', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.timeframe, SERIES_INFO.timeframe);
    });

    it('barTime matches provided barTime', () => {
      assert.deepEqual(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.barTime, BAR_TIME);
    });

    it('sourceProvider === ConsolidationRule', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.sourceProvider, 'ConsolidationRule');
    });

    it('providerVersion === 1.0.0', () => {
      assert.equal(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.providerVersion, '1.0.0');
    });

    it('generatedAt is a Date', () => {
      assert.ok(ruleResult([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, makeEmptyContext())!.generatedAt instanceof Date);
    });
  });

  describe('comparison with existing provider', () => {
    it('ConsolidationRule fires on equal extrema independently of existing provider', () => {
      const ev = [EQ_HIGH(), EQ_LOW()];
      const ruleOut = RULE.evaluate(ev, BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.equal(ruleOut.length, 1);
      assert.equal(ruleOut[0]!.category, HypothesisCategory.CONSOLIDATION);
    });

    it('sourceProvider in ConsolidationRule output is always ConsolidationRule', () => {
      const ev = [EQ_HIGH(), EQ_LOW()];
      const ruleOut = RULE.evaluate(ev, CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.ok(ruleOut.every(h => h.sourceProvider === 'ConsolidationRule'));
    });

    it('existing provider CONSOLIDATION uses indeterminate direction, ConsolidationRule uses neutral', () => {
      const existingOut = EXISTING.generateHypotheses([], CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      const existingConsolidation = existingOut.filter(h => h.category === HypothesisCategory.CONSOLIDATION);
      const ruleOut = RULE.evaluate([], CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.ok(ruleOut.every(h => h.direction === 'neutral'));
      assert.ok(existingConsolidation.every(h => h.direction === 'indeterminate' || h.direction === 'neutral'));
    });
  });

  describe('edge cases', () => {
    it('both triggers met returns exactly 1 hypothesis', () => {
      assert.equal(RULE.evaluate([EQ_HIGH(), EQ_LOW()], CONFLICTED_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('structure break in context does not suppress consolidation', () => {
      const ctx = { ...makeEmptyContext(), latestBos: makeBreak('bullish', 'bos_ctx') };
      assert.equal(RULE.evaluate([EQ_HIGH(), EQ_LOW()], ZERO_CONFIDENCE, ctx, BAR_TIME, SERIES_INFO).length, 1);
    });

    it('unrelated evidence alone does not trigger', () => {
      const ev = [makeStructureBreak('bullish', 'sb1'), makeDisplacementEv('bullish', 'dp1')];
      assert.equal(RULE.evaluate(ev, BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });

    it('equal extrema mixed with unrelated evidence fires as compression trigger', () => {
      const ev = [EQ_HIGH(), makeStructureBreak('bullish', 'sb1'), EQ_LOW()];
      const result = RULE.evaluate(ev, BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.equal(result.length, 1);
      assert.ok(result[0]!.name.includes('Equal Extrema Compression'));
    });

    it('consecutive calls produce distinct hypothesis IDs', () => {
      const ev = [EQ_HIGH(), EQ_LOW()];
      const ids = new Set(
        Array.from({ length: 5 }, () =>
          RULE.evaluate(ev, ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO)[0]!.id,
        ),
      );
      assert.equal(ids.size, 5);
    });

    it('conflict trigger with high evidenceCount fires correctly', () => {
      const highCountConf: ConfidenceScore = { ...CONFLICTED_CONFIDENCE, evidenceCount: 20 };
      assert.equal(RULE.evaluate([], highCountConf, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 1);
    });

    it('zero evidence with conflict below threshold returns []', () => {
      assert.equal(RULE.evaluate([], BELOW_THRESHOLD_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO).length, 0);
    });
  });

});