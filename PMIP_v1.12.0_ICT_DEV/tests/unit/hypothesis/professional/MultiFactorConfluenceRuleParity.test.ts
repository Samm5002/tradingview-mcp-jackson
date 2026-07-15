/**
 * @file MultiFactorConfluenceRuleParity.test.ts
 *
 * Verifies MultiFactorConfluenceRule as the Evidence-layer synthesis of ICT multi-factor
 * confluence -- when >=2 independent ICT signal domains align in the same direction simultaneously.
 *
 * Six signal domains under test (re-derived from Evidence/Context, not actual PHP rule outputs):
 *   1. STRUCTURE_CONTINUATION -- context.latestBos direction
 *   2. STRUCTURE_REVERSAL     -- context.latestChoch / latestMss direction
 *   3. BLOCK_REACTION         -- BLOCK_ZONE evidence (strength >= 65)
 *   4. LIQUIDITY_SWEEP        -- LIQUIDITY_EVENT+SWEEP or EQUAL_EXTREMA+EQUAL_HIGHS/LOWS
 *   5. INEFFICIENCY_FILL      -- PRICE_INEFFICIENCY+FVG direction
 *   6. DISPLACEMENT_FOLLOW    -- DISPLACEMENT+IMPULSIVE direction
 *
 * Documented architectural gaps:
 *   - Re-derives trigger conditions rather than reading actual PHP rule outputs
 *     (RuleExecutionPipeline provides no inter-rule output access)
 *   - Context-based signals (STRUCTURE_CONTINUATION, STRUCTURE_REVERSAL) carry no evidence IDs
 *   - No HypothesisCategory.CONFLUENCE exists -- category from highest-priority aligned signal
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MultiFactorConfluenceRule }        from '../../../../src/hypothesis/providers/professional/rules/MultiFactorConfluenceRule.js';
import { HypothesisCategory }               from '../../../../src/hypothesis/types/HypothesisCategory.js';
import { EvidenceType }                     from '../../../../src/reasoning/types/Evidence.js';
import { EvidenceTag }                      from '../../../../src/reasoning/types/EvidenceTag.js';
import type { Evidence, EvidenceDirection } from '../../../../src/reasoning/types/Evidence.js';
import type { ConfidenceScore }             from '../../../../src/reasoning/types/ConfidenceScore.js';
import type { ReasoningContext, BreakSummary } from '../../../../src/reasoning/types/ReasoningContext.js';
import type { HypothesisProviderSeriesInfo }   from '../../../../src/hypothesis/contracts/IHypothesisProvider.js';

// ─── Evidence factories ──────────────────────────────────────────────────────

function makeEvidence(
  type: EvidenceType,
  direction: EvidenceDirection,
  tags: EvidenceTag[] = [],
  id = `evd_${type}_${direction}`,
  strength = 50,
): Evidence {
  return {
    id, type, direction,
    observationId: `obs_${id}`,
    observationType: 'BAR_CLOSED',
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '15m',
    barTime:    new Date('2026-01-01T00:00:00Z'),
    detectedAt: new Date('2026-01-01T00:00:00Z'),
    strength,
    tags,
    metadata: {},
  };
}

function makeBlock(dir: EvidenceDirection, id: string, strength = 80): Evidence {
  return makeEvidence(EvidenceType.BLOCK_ZONE, dir, [EvidenceTag.UNFILLED], id, strength);
}

function makeFvg(dir: EvidenceDirection, id: string): Evidence {
  return makeEvidence(EvidenceType.PRICE_INEFFICIENCY, dir, [EvidenceTag.FVG, EvidenceTag.UNFILLED], id);
}

function makeDisp(dir: EvidenceDirection, id: string): Evidence {
  return makeEvidence(EvidenceType.DISPLACEMENT, dir, [EvidenceTag.IMPULSIVE], id);
}

// BUY_SIDE sweep -> rule fires bearish; SELL_SIDE sweep -> rule fires bullish
function makeSweepBuySide(id: string): Evidence {
  return makeEvidence(EvidenceType.LIQUIDITY_EVENT, 'bearish', [EvidenceTag.SWEEP, EvidenceTag.BUY_SIDE], id);
}

function makeSweepSellSide(id: string): Evidence {
  return makeEvidence(EvidenceType.LIQUIDITY_EVENT, 'bullish', [EvidenceTag.SWEEP, EvidenceTag.SELL_SIDE], id);
}

function makeEqualHighs(id: string): Evidence {
  return makeEvidence(EvidenceType.EQUAL_EXTREMA, 'neutral', [EvidenceTag.EQUAL_HIGHS], id);
}

function makeEqualLows(id: string): Evidence {
  return makeEvidence(EvidenceType.EQUAL_EXTREMA, 'neutral', [EvidenceTag.EQUAL_LOWS], id);
}

// ─── BreakSummary / context factories ────────────────────────────────────────

function makeBreak(direction: EvidenceDirection, obsId: string): BreakSummary {
  return {
    obsId,
    observationType: direction === 'bullish' ? 'BULLISH_BOS_CONFIRMED' : 'BEARISH_BOS_CONFIRMED',
    direction,
    barTime:     new Date('2026-01-01T00:00:00Z'),
    brokenPrice: direction === 'bullish' ? 49900 : 50100,
  };
}

function makeEmptyContext(): ReasoningContext {
  return {
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '15m',
    barTime: new Date('2026-01-01T00:00:00Z'),
    latestExternalHigh: null, latestExternalLow: null,
    latestInternalHigh: null, latestInternalLow: null,
    latestBos: null, latestChoch: null, latestMss: null,
    activeFvgs: [], activeOrderBlocks: [],
    activeBuySidePools: [], activeSellSidePools: [],
  };
}

function withBos(dir: EvidenceDirection): ReasoningContext {
  return { ...makeEmptyContext(), latestBos: makeBreak(dir, `bos_${dir}`) };
}

function withChoch(dir: EvidenceDirection): ReasoningContext {
  return { ...makeEmptyContext(), latestChoch: makeBreak(dir, `choch_${dir}`) };
}

function withMss(dir: EvidenceDirection): ReasoningContext {
  return { ...makeEmptyContext(), latestMss: makeBreak(dir, `mss_${dir}`) };
}

function withBosAndChoch(bosDir: EvidenceDirection, chochDir: EvidenceDirection): ReasoningContext {
  return {
    ...makeEmptyContext(),
    latestBos:   makeBreak(bosDir,   `bos_${bosDir}`),
    latestChoch: makeBreak(chochDir, `choch_${chochDir}`),
  };
}

// ─── Confidence fixtures ──────────────────────────────────────────────────────

const BULLISH_CONFIDENCE: ConfidenceScore = {
  bullishScore: 80, bearishScore: 20, netScore: 60, conflictScore: 0.2,
  totalWeight: 5, bullishWeight: 4, bearishWeight: 1, neutralWeight: 0,
  evidenceCount: 5, bullishCount: 4, bearishCount: 1, neutralCount: 0,
};

const BEARISH_CONFIDENCE: ConfidenceScore = {
  bullishScore: 20, bearishScore: 80, netScore: -60, conflictScore: 0.2,
  totalWeight: 5, bullishWeight: 1, bearishWeight: 4, neutralWeight: 0,
  evidenceCount: 5, bullishCount: 1, bearishCount: 4, neutralCount: 0,
};

const ZERO_CONFIDENCE: ConfidenceScore = {
  bullishScore: 0, bearishScore: 0, netScore: 0, conflictScore: 0,
  totalWeight: 0, bullishWeight: 0, bearishWeight: 0, neutralWeight: 0,
  evidenceCount: 0, bullishCount: 0, bearishCount: 0, neutralCount: 0,
};

// ─── Series info ──────────────────────────────────────────────────────────────

const SERIES_INFO: HypothesisProviderSeriesInfo = {
  symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '15m',
};

const rule = new MultiFactorConfluenceRule();
const BAR_TIME = new Date('2026-01-01T00:00:00Z');

describe('MultiFactorConfluenceRule', () => {

  describe('rule contract', () => {
    it('ruleName === "MultiFactorConfluenceRule"', () => {
      assert.strictEqual(rule.ruleName, 'MultiFactorConfluenceRule');
    });
    it('no evidence, zero confidence, empty context → []', () => {
      assert.deepStrictEqual(rule.evaluate([], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO), []);
    });
    it('returns an array', () => {
      assert.ok(Array.isArray(rule.evaluate([], ZERO_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO)));
    });
    it('single context signal (BOS only) → [] — below minimum confluence', () => {
      assert.deepStrictEqual(rule.evaluate([], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO), []);
    });
    it('single evidence signal (FVG only) → [] — below minimum confluence', () => {
      assert.deepStrictEqual(rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO), []);
    });
  });

  describe('minimum confluence threshold', () => {
    it('2 aligned bullish → fires (BOS + FVG)', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
    });
    it('2 aligned bearish → fires (CHOCH + OB)', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
    });
    it('1 bull + 1 bear (tied) → [] — ambiguous', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r, []);
    });
    it('2 bull + 1 bear → fires bullish', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1'), makeBlock('bearish', 'b1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('1 bull + 2 bear → fires bearish', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1'), makeDisp('bearish', 'd1')], BEARISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
    it('2 bull + 2 bear (equal) → []', () => {
      const ctx = withBosAndChoch('bullish', 'bearish');
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bearish', 'f1')], BULLISH_CONFIDENCE, ctx, BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r, []);
    });
  });

  describe('bullish confluence — signal combinations', () => {
    it('BOS(bullish) + FVG(bullish) → fires bullish', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('BOS(bullish) + OB(bullish) → fires bullish', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('BOS(bullish) + displacement(bullish) → fires bullish', () => {
      const r = rule.evaluate([makeDisp('bullish', 'd1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('CHOCH(bullish) + sell-side sweep → fires bullish', () => {
      const r = rule.evaluate([makeSweepSellSide('sw1')], BULLISH_CONFIDENCE, withChoch('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('BOS(bullish) + CHOCH(bullish) context-only → fires bullish, count=2', () => {
      const r = rule.evaluate([], BULLISH_CONFIDENCE, withBosAndChoch('bullish', 'bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0]!.direction, 'bullish');
      assert.strictEqual((r[0]!.metadata as Record<string, unknown>)['confluenceCount'], 2);
    });
    it('BOS(bullish) + OB(bullish) + FVG(bullish) → count=3', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual((r[0]!.metadata as Record<string, unknown>)['confluenceCount'], 3);
    });
  });

  describe('bearish confluence — signal combinations', () => {
    it('CHOCH(bearish) + OB(bearish) → fires bearish', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
    it('BOS(bearish) + buy-side sweep → fires bearish', () => {
      const r = rule.evaluate([makeSweepBuySide('sw1')], BEARISH_CONFIDENCE, withBos('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
    it('BOS(bearish) + FVG(bearish) + disp(bearish) → fires bearish, count=3', () => {
      const r = rule.evaluate([makeFvg('bearish', 'f1'), makeDisp('bearish', 'd1')], BEARISH_CONFIDENCE, withBos('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
      assert.strictEqual((r[0]!.metadata as Record<string, unknown>)['confluenceCount'], 3);
    });
    it('MSS(bearish) + OB(bearish) → fires bearish (latestMss path)', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BEARISH_CONFIDENCE, withMss('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
  });

  describe('direction', () => {
    it('bullish confluence → direction = "bullish"', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('bearish confluence → direction = "bearish"', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
  });

  describe('category determination — ICT structural priority', () => {
    it('STRUCTURE_REVERSAL + STRUCTURE_CONTINUATION → STRUCTURE_REVERSAL (highest priority)', () => {
      const ctx = withBosAndChoch('bullish', 'bullish');
      const r = rule.evaluate([], BULLISH_CONFIDENCE, ctx, BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.STRUCTURE_REVERSAL);
    });
    it('STRUCTURE_CONTINUATION alone → STRUCTURE_CONTINUATION', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.STRUCTURE_CONTINUATION);
    });
    it('DISPLACEMENT_FOLLOW + BLOCK_REACTION (no context) → DISPLACEMENT_FOLLOW', () => {
      const r = rule.evaluate([makeDisp('bullish', 'd1'), makeBlock('bullish', 'b1')], BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.DISPLACEMENT_FOLLOW);
    });
    it('BLOCK_REACTION + LIQUIDITY_SWEEP (no context) → BLOCK_REACTION', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1'), makeSweepBuySide('sw1')], BEARISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.BLOCK_REACTION);
    });
    it('LIQUIDITY_SWEEP + INEFFICIENCY_FILL (no context) → LIQUIDITY_SWEEP', () => {
      const r = rule.evaluate([makeSweepSellSide('sw1'), makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, makeEmptyContext(), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.LIQUIDITY_SWEEP);
    });
    it('STRUCTURE_REVERSAL alone + any other → STRUCTURE_REVERSAL', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1')], BULLISH_CONFIDENCE, withChoch('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.category, HypothesisCategory.STRUCTURE_REVERSAL);
    });
  });

  describe('score scaling', () => {
    it('2 aligned signals → score = 65', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.score, 65);
    });
    it('3 aligned signals → score = 75', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.score, 75);
    });
    it('4 aligned signals → score = 85', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bullish', 'f1'), makeDisp('bullish', 'd1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.score, 85);
    });
    it('5+ aligned signals → score capped at 90', () => {
      const ctx = withBosAndChoch('bullish', 'bullish');
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bullish', 'f1'), makeDisp('bullish', 'd1')], BULLISH_CONFIDENCE, ctx, BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.score, 90);
    });
  });

  describe('ICT-equivalent confidence fields', () => {
    it('supportStrength = score / 100', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.supportStrength, r[0]!.confidence.score / 100);
    });
    it('oppositionStrength = 0', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.oppositionStrength, 0);
    });
    it('completeness = 1', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.confidence.completeness, 1);
    });
  });

  describe('evidence IDs', () => {
    it('context-only confluence → supportingEvidenceIds is empty', () => {
      const r = rule.evaluate([], BULLISH_CONFIDENCE, withBosAndChoch('bullish', 'bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r[0]!.supportingEvidenceIds, []);
    });
    it('FVG evidence ID appears in supportingEvidenceIds', () => {
      const fvg = makeFvg('bullish', 'my-fvg-id');
      const r = rule.evaluate([fvg], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok((r[0]!.supportingEvidenceIds as string[]).includes('my-fvg-id'));
    });
    it('block evidence ID appears in supportingEvidenceIds', () => {
      const ob = makeBlock('bearish', 'my-ob-id');
      const r = rule.evaluate([ob], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.ok((r[0]!.supportingEvidenceIds as string[]).includes('my-ob-id'));
    });
    it('BOS(context) + FVG(evidence) — BOS contributes no IDs, FVG does', () => {
      const fvg = makeFvg('bullish', 'fvg-id');
      const r = rule.evaluate([fvg], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok((r[0]!.supportingEvidenceIds as string[]).includes('fvg-id'));
      assert.strictEqual((r[0]!.supportingEvidenceIds as string[]).length, 1);
    });
    it('opposingEvidenceIds is always empty', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r[0]!.opposingEvidenceIds, []);
    });
    it('missingEvidence is always empty', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r[0]!.missingEvidence, []);
    });
  });

  describe('name format', () => {
    it('name starts with "Multi-Factor Confluence"', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.name.startsWith('Multi-Factor Confluence'));
    });
    it('bullish → name contains "Bullish"', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.name.includes('Bullish'));
    });
    it('bearish → name contains "Bearish"', () => {
      const r = rule.evaluate([makeBlock('bearish', 'b1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.name.includes('Bearish'));
    });
    it('name contains the confluence count', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.name.includes('2'));
    });
  });

  describe('preconditions and invalidations', () => {
    it('exactly 1 precondition', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.preconditions.length, 1);
    });
    it('precondition mentions aligned signal count', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.preconditions[0]!.includes('2'));
    });
    it('precondition mentions direction', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.preconditions[0]!.includes('bullish'));
    });
    it('exactly 2 invalidations', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.invalidations.length, 2);
    });
    it('first invalidation: evidenceType = EvidenceType.STRUCTURE_BREAK', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.invalidations[0]!.evidenceType, EvidenceType.STRUCTURE_BREAK);
    });
    it('second invalidation: evidenceType = null', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.invalidations[1]!.evidenceType, null);
    });
  });

  describe('reasoning trace', () => {
    it('exactly 2 trace steps', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.reasoningTrace.length, 2);
    });
    it('step 1 has step === 1', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.reasoningTrace[0]!.step, 1);
    });
    it('step 2 has step === 2', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.reasoningTrace[1]!.step, 2);
    });
    it('step 1 description mentions signal count', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(r[0]!.reasoningTrace[0]!.description.includes('2'));
    });
    it('step 1 evidenceIds matches supportingEvidenceIds', () => {
      const r = rule.evaluate([makeFvg('bullish', 'fvg-id')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r[0]!.reasoningTrace[0]!.evidenceIds, r[0]!.supportingEvidenceIds);
    });
    it('step 2 evidenceIds is empty', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r[0]!.reasoningTrace[1]!.evidenceIds, []);
    });
  });

  describe('metadata', () => {
    it('confluenceCount matches aligned signal count', () => {
      const r = rule.evaluate([makeBlock('bullish', 'b1'), makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual((r[0]!.metadata as Record<string, unknown>)['confluenceCount'], 3);
    });
    it('confluenceDirection matches hypothesis direction', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual((r[0]!.metadata as Record<string, unknown>)['confluenceDirection'], r[0]!.direction);
    });
    it('alignedSignals is an array of signal names', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      const meta = r[0]!.metadata as Record<string, unknown>;
      assert.ok(Array.isArray(meta['alignedSignals']));
      assert.ok((meta['alignedSignals'] as string[]).includes('STRUCTURE_CONTINUATION'));
      assert.ok((meta['alignedSignals'] as string[]).includes('INEFFICIENCY_FILL'));
    });
    it('totalSignalsDetected >= confluenceCount', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1'), makeBlock('bearish', 'b1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      const meta = r[0]!.metadata as Record<string, unknown>;
      assert.ok((meta['totalSignalsDetected'] as number) >= (meta['confluenceCount'] as number));
    });
    it('opposingSignalCount = totalSignalsDetected - confluenceCount', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1'), makeBlock('bearish', 'b1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      const meta = r[0]!.metadata as Record<string, unknown>;
      assert.strictEqual(
        meta['opposingSignalCount'] as number,
        (meta['totalSignalsDetected'] as number) - (meta['confluenceCount'] as number),
      );
    });
  });

  describe('hypothesis fields', () => {
    it('id is a non-empty string', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.ok(typeof r[0]!.id === 'string' && r[0]!.id.length > 0);
    });
    it('sourceProvider === "MultiFactorConfluenceRule"', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.sourceProvider, 'MultiFactorConfluenceRule');
    });
    it('providerVersion === "1.0.0"', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.providerVersion, '1.0.0');
    });
    it('returns exactly 1 hypothesis when confluence fires', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
    });
    it('consecutive calls produce distinct IDs', () => {
      const args: [Evidence[], ConfidenceScore, ReasoningContext, Date, HypothesisProviderSeriesInfo] =
        [[makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO];
      const r1 = rule.evaluate(...args);
      const r2 = rule.evaluate(...args);
      assert.notStrictEqual(r1[0]!.id, r2[0]!.id);
    });
    it('barTime matches input', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.barTime, BAR_TIME);
    });
    it('symbol / exchange / timeframe match seriesInfo', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.symbol,   SERIES_INFO.symbol);
      assert.strictEqual(r[0]!.exchange, SERIES_INFO.exchange);
      assert.strictEqual(r[0]!.timeframe, SERIES_INFO.timeframe);
    });
  });

  describe('domain-specific signal detection', () => {
    it('block below ICT_BLOCK_THRESHOLD (strength 64) → does not count as signal', () => {
      const weakBlock = makeBlock('bullish', 'wb', 64);
      const r = rule.evaluate([weakBlock], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      // Only BOS fires (1 signal) → below threshold → []
      assert.deepStrictEqual(r, []);
    });
    it('block at ICT_BLOCK_THRESHOLD (strength 65) → counts as signal', () => {
      const atThreshold = makeBlock('bullish', 'bt', 65);
      const r = rule.evaluate([atThreshold], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r.length, 1);
    });
    it('IFVG evidence (no FVG tag) → does not trigger inefficiency signal', () => {
      const ifvg = makeEvidence(EvidenceType.PRICE_INEFFICIENCY, 'bullish', [EvidenceTag.IFVG, EvidenceTag.UNFILLED], 'ifvg1');
      const r = rule.evaluate([ifvg], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      // Only BOS fires → no confluence
      assert.deepStrictEqual(r, []);
    });
    it('sweep takes priority over equal extrema when both present', () => {
      // Sweep = sell-side (bullish). Equal highs = bearish. Net: sweep wins, bullish signal.
      const sweep = makeSweepSellSide('sw1');
      const highs = makeEqualHighs('eh1');
      const r = rule.evaluate([sweep, highs], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      // BOS bullish + sweep bullish = 2 bullish signals → fires
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('buy-side sweep event → LIQUIDITY_SWEEP signal is bearish', () => {
      // 2 bearish: CHOCH bearish + buy-side sweep (bearish direction)
      const r = rule.evaluate([makeSweepBuySide('sw1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
      assert.ok(((r[0]!.metadata as Record<string, unknown>)['alignedSignals'] as string[]).includes('LIQUIDITY_SWEEP'));
    });
    it('sell-side sweep event → LIQUIDITY_SWEEP signal is bullish', () => {
      const r = rule.evaluate([makeSweepSellSide('sw1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('equal highs formation → LIQUIDITY_SWEEP signal is bearish', () => {
      // CHOCH bearish + equal highs → STRUCTURE_REVERSAL + LIQUIDITY_SWEEP both bearish
      const r = rule.evaluate([makeEqualHighs('eh1')], BEARISH_CONFIDENCE, withChoch('bearish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bearish');
    });
    it('equal lows formation → LIQUIDITY_SWEEP signal is bullish', () => {
      const r = rule.evaluate([makeEqualLows('el1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      assert.strictEqual(r[0]!.direction, 'bullish');
    });
    it('BOS bearish + CHOCH bullish → signals cancel → returns []', () => {
      const ctx = withBosAndChoch('bearish', 'bullish');
      const r = rule.evaluate([], BULLISH_CONFIDENCE, ctx, BAR_TIME, SERIES_INFO);
      assert.deepStrictEqual(r, []);
    });
    it('category value is a valid HypothesisCategory member', () => {
      const r = rule.evaluate([makeFvg('bullish', 'f1')], BULLISH_CONFIDENCE, withBos('bullish'), BAR_TIME, SERIES_INFO);
      const validCategories = Object.values(HypothesisCategory) as string[];
      assert.ok(validCategories.includes(r[0]!.category as string));
    });
  });

}); // end MultiFactorConfluenceRule
