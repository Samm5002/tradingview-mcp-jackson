import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProfessionalHypothesisProvider } from '../../../../src/hypothesis/providers/professional/ProfessionalHypothesisProvider.js';
import { StructureContinuationRule }    from '../../../../src/hypothesis/providers/professional/rules/StructureContinuationRule.js';
import { StructureReversalRule }        from '../../../../src/hypothesis/providers/professional/rules/StructureReversalRule.js';
import { BlockReactionRule }            from '../../../../src/hypothesis/providers/professional/rules/BlockReactionRule.js';
import { LiquiditySweepRule }           from '../../../../src/hypothesis/providers/professional/rules/LiquiditySweepRule.js';
import { InefficiencyFillRule }         from '../../../../src/hypothesis/providers/professional/rules/InefficiencyFillRule.js';
import { DisplacementRule }             from '../../../../src/hypothesis/providers/professional/rules/DisplacementRule.js';
import { ConsolidationRule }            from '../../../../src/hypothesis/providers/professional/rules/ConsolidationRule.js';
import { MultiFactorConfluenceRule }    from '../../../../src/hypothesis/providers/professional/rules/MultiFactorConfluenceRule.js';
import type { ConfidenceScore }         from '../../../../src/reasoning/types/ConfidenceScore.js';
import type { ReasoningContext }        from '../../../../src/reasoning/types/ReasoningContext.js';
import type { HypothesisProviderSeriesInfo } from '../../../../src/hypothesis/contracts/IHypothesisProvider.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ZERO_CONFIDENCE: ConfidenceScore = {
  bullishScore: 0, bearishScore: 0, netScore: 0, conflictScore: 0,
  totalWeight: 0, bullishWeight: 0, bearishWeight: 0, neutralWeight: 0,
  evidenceCount: 0, bullishCount: 0, bearishCount: 0, neutralCount: 0,
};

const EMPTY_CONTEXT: ReasoningContext = {
  symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
  barTime: new Date('2026-01-01T00:00:00Z'),
  latestExternalHigh: null, latestExternalLow: null,
  latestInternalHigh: null, latestInternalLow: null,
  latestBos: null, latestChoch: null, latestMss: null,
  activeFvgs: [], activeOrderBlocks: [],
  activeBuySidePools: [], activeSellSidePools: [],
};

const SERIES_INFO: HypothesisProviderSeriesInfo = {
  symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
};

const BAR_TIME = new Date('2026-01-01T00:00:00Z');
const PROVIDER = new ProfessionalHypothesisProvider();

// ─── Tests: provider metadata ──────────────────────────────────────────────

describe('ProfessionalHypothesisProvider', () => {

  it('providerName === ProfessionalHypothesisProvider', () => {
    assert.equal(PROVIDER.providerName, 'ProfessionalHypothesisProvider');
  });

  it('providerVersion === 1.0.0', () => {
    assert.equal(PROVIDER.providerVersion, '1.0.0');
  });

  // ─── Tests: IHypothesisProvider contract ────────────────────────────────

  it('implements generateHypotheses', () => {
    assert.equal(typeof PROVIDER.generateHypotheses, 'function');
  });

  it('generateHypotheses returns an array', () => {
    const result = PROVIDER.generateHypotheses([], ZERO_CONFIDENCE, EMPTY_CONTEXT, BAR_TIME, SERIES_INFO);
    assert.ok(Array.isArray(result));
  });

  it('generateHypotheses returns [] for zero evidence and zero confidence', () => {
    const result = PROVIDER.generateHypotheses([], ZERO_CONFIDENCE, EMPTY_CONTEXT, BAR_TIME, SERIES_INFO);
    assert.equal(result.length, 0);
  });

  it('generateHypotheses is stable across multiple calls with identical input', () => {
    const r1 = PROVIDER.generateHypotheses([], ZERO_CONFIDENCE, EMPTY_CONTEXT, BAR_TIME, SERIES_INFO);
    const r2 = PROVIDER.generateHypotheses([], ZERO_CONFIDENCE, EMPTY_CONTEXT, BAR_TIME, SERIES_INFO);
    assert.equal(r1.length, r2.length);
  });

  // ─── Tests: rule inventory ───────────────────────────────────────────────

  it('StructureContinuationRule has correct ruleName', () => {
    assert.equal(new StructureContinuationRule().ruleName, 'StructureContinuationRule');
  });

  it('StructureReversalRule has correct ruleName', () => {
    assert.equal(new StructureReversalRule().ruleName, 'StructureReversalRule');
  });

  it('BlockReactionRule has correct ruleName', () => {
    assert.equal(new BlockReactionRule().ruleName, 'BlockReactionRule');
  });

  it('LiquiditySweepRule has correct ruleName', () => {
    assert.equal(new LiquiditySweepRule().ruleName, 'LiquiditySweepRule');
  });

  it('InefficiencyFillRule has correct ruleName', () => {
    assert.equal(new InefficiencyFillRule().ruleName, 'InefficiencyFillRule');
  });

  it('DisplacementRule has correct ruleName', () => {
    assert.equal(new DisplacementRule().ruleName, 'DisplacementRule');
  });

  it('ConsolidationRule has correct ruleName', () => {
    assert.equal(new ConsolidationRule().ruleName, 'ConsolidationRule');
  });

  it('MultiFactorConfluenceRule has correct ruleName', () => {
    assert.equal(new MultiFactorConfluenceRule().ruleName, 'MultiFactorConfluenceRule');
  });

  it('all rule names are unique', () => {
    const names = [
      new StructureContinuationRule().ruleName,
      new StructureReversalRule().ruleName,
      new BlockReactionRule().ruleName,
      new LiquiditySweepRule().ruleName,
      new InefficiencyFillRule().ruleName,
      new DisplacementRule().ruleName,
      new ConsolidationRule().ruleName,
      new MultiFactorConfluenceRule().ruleName,
    ];
    assert.equal(new Set(names).size, names.length, 'Duplicate rule names found');
  });

  // ─── Tests: empty rule evaluate() ───────────────────────────────────────

  it('each rule returns empty array from evaluate()', () => {
    const rules = [
      new StructureContinuationRule(),
      new StructureReversalRule(),
      new BlockReactionRule(),
      new LiquiditySweepRule(),
      new InefficiencyFillRule(),
      new DisplacementRule(),
      new ConsolidationRule(),
      new MultiFactorConfluenceRule(),
    ];
    for (const rule of rules) {
      const result = rule.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, BAR_TIME, SERIES_INFO);
      assert.equal(result.length, 0, `${rule.ruleName}.evaluate() must return [] for zero evidence`);
    }
  });
});
