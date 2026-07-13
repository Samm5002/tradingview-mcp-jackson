/**
 * @file HypothesisEngine.test.ts
 * @purpose Unit tests for HypothesisEngine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HypothesisEngine }   from '../../../src/hypothesis/engines/HypothesisEngine.js';
import { ConflictResolver }   from '../../../src/hypothesis/engines/ConflictResolver.js';
import { HypothesisCategory } from '../../../src/hypothesis/types/HypothesisCategory.js';
import { Exchange }           from '../../../src/types/Exchange.js';
import { Timeframe }          from '../../../src/types/Timeframe.js';
import type { IHypothesisProvider, HypothesisProviderSeriesInfo } from '../../../src/hypothesis/contracts/IHypothesisProvider.js';
import type { HypothesisEngineSeriesInfo } from '../../../src/hypothesis/contracts/IHypothesisEngine.js';
import { EvidenceType }              from '../../../src/reasoning/types/Evidence.js';
import type { Evidence }             from '../../../src/reasoning/types/Evidence.js';
import { DEFAULT_EVIDENCE_WEIGHTS }  from '../../../src/reasoning/types/EvidenceWeightConfig.js';
import type { ConfidenceScore } from '../../../src/reasoning/types/ConfidenceScore.js';
import type { ReasoningContext } from '../../../src/reasoning/types/ReasoningContext.js';
import type { Hypothesis }      from '../../../src/hypothesis/types/Hypothesis.js';

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

const SERIES_INFO: HypothesisEngineSeriesInfo = {
  symbol:                  'BTC-USDT',
  exchange:                Exchange.BINGX,
  timeframe:               Timeframe.ONE_HOUR,
  barTime:                 new Date('2026-01-01T00:00:00Z'),
  sourceReasoningResultId: 'rsn_test_123',
};

// ─── Provider stubs ───────────────────────────────────────────────────────────

const noOpProvider: IHypothesisProvider = {
  providerName: 'NoOpProvider',
  providerVersion: '1.0.0',
  generateHypotheses: () => [],
};

function makeStubHypothesis(id: string, score: number): Hypothesis {
  return {
    id, name: 'Stub', category: HypothesisCategory.CONSOLIDATION,
    direction: 'neutral',
    confidence: { score, supportStrength: 1, oppositionStrength: 0, completeness: 0.5 },
    supportingEvidenceIds: [], opposingEvidenceIds: [], missingEvidence: [],
    preconditions: [], invalidations: [], reasoningTrace: [],
    sourceProvider: 'StubProvider', providerVersion: '1.0.0',
    generatedAt: new Date(), barTime: new Date(),
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
  };
}

const bullishProvider: IHypothesisProvider = {
  providerName: 'BullishProvider',
  providerVersion: '1.0.0',
  generateHypotheses: (_e, _c, _ctx, _bt, _si) => [makeStubHypothesis('hyp_bull', 70)],
};

const bearishProvider: IHypothesisProvider = {
  providerName: 'BearishProvider',
  providerVersion: '1.0.0',
  generateHypotheses: (_e, _c, _ctx, _bt, _si) => [makeStubHypothesis('hyp_bear', 60)],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HypothesisEngine', () => {
  it('zero providers → result has empty hypotheses and empty ranked', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.hypotheses.length, 0);
    assert.equal(result.resolution.ranked.length, 0);
  });

  it('one provider returning zero → hypotheses is []', () => {
    const engine = new HypothesisEngine([noOpProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.hypotheses.length, 0);
  });

  it('one provider returning one hypothesis → hypotheses.length === 1', () => {
    const engine = new HypothesisEngine([bullishProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.hypotheses.length, 1);
  });

  it('two providers each returning one hypothesis → hypotheses.length === 2', () => {
    const engine = new HypothesisEngine([bullishProvider, bearishProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.hypotheses.length, 2);
  });

  it('result.id starts with hres_', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(result.id.startsWith('hres_'), `id=${result.id}`);
  });

  it('result.schema === 1.0.0', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.schema, '1.0.0');
  });

  it('result.symbol matches seriesInfo', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.symbol, SERIES_INFO.symbol);
  });

  it('result.exchange matches seriesInfo', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.exchange, SERIES_INFO.exchange);
  });

  it('result.timeframe matches seriesInfo', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.timeframe, SERIES_INFO.timeframe);
  });

  it('result.barTime matches seriesInfo', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.barTime, SERIES_INFO.barTime);
  });

  it('result.sourceReasoningResultId matches seriesInfo', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.sourceReasoningResultId, SERIES_INFO.sourceReasoningResultId);
  });

  it('result.computedAt is a Date', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(result.computedAt instanceof Date);
  });

  it('engine preserves hypotheses from ALL providers even when they conflict', () => {
    const engine = new HypothesisEngine([bullishProvider, bearishProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    const ids = result.hypotheses.map(h => h.id);
    assert.ok(ids.includes('hyp_bull'), 'bullish hypothesis missing');
    assert.ok(ids.includes('hyp_bear'), 'bearish hypothesis missing');
  });

  it('ConflictResolver is called with ALL hypotheses from all providers', () => {
    let capturedHypotheses: ReadonlyArray<Hypothesis> = [];
    const spyResolver = {
      resolve: (hyps: ReadonlyArray<Hypothesis>) => {
        capturedHypotheses = hyps;
        return new ConflictResolver().resolve(hyps);
      },
    };
    const engine = new HypothesisEngine([bullishProvider, bearishProvider], spyResolver);
    engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(capturedHypotheses.length, 2);
  });

  it('each call produces a unique result.id', () => {
    const engine = new HypothesisEngine([], new ConflictResolver());
    const r1 = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    const r2 = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.notEqual(r1.id, r2.id);
  });

  it('provider that generates multiple hypotheses → all preserved', () => {
    const multiProvider: IHypothesisProvider = {
      providerName: 'Multi', providerVersion: '1.0.0',
      generateHypotheses: () => [
        makeStubHypothesis('hyp_1', 70),
        makeStubHypothesis('hyp_2', 60),
        makeStubHypothesis('hyp_3', 50),
      ],
    };
    const engine = new HypothesisEngine([multiProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.equal(result.hypotheses.length, 3);
  });

  it('resolution is present on result', () => {
    const engine = new HypothesisEngine([bullishProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(result.resolution !== undefined);
    assert.ok(typeof result.resolution.conflictLevel === 'string');
  });

  it('provider receives correct barTime via seriesInfo', () => {
    let capturedBarTime: Date | null = null;
    const spyProvider: IHypothesisProvider = {
      providerName: 'Spy', providerVersion: '1.0.0',
      generateHypotheses: (_e, _c, _ctx, bt, _si) => {
        capturedBarTime = bt;
        return [];
      },
    };
    const engine = new HypothesisEngine([spyProvider], new ConflictResolver());
    engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(capturedBarTime instanceof Date);
    assert.equal((capturedBarTime as Date).getTime(), SERIES_INFO.barTime.getTime());
  });

  it('provider receives correct seriesInfo (symbol/exchange/timeframe)', () => {
    let capturedSeries: HypothesisProviderSeriesInfo | null = null;
    const spyProvider: IHypothesisProvider = {
      providerName: 'Spy', providerVersion: '1.0.0',
      generateHypotheses: (_e, _c, _ctx, _bt, si) => {
        capturedSeries = si;
        return [];
      },
    };
    const engine = new HypothesisEngine([spyProvider], new ConflictResolver());
    engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(capturedSeries !== null);
    assert.equal((capturedSeries as HypothesisProviderSeriesInfo).symbol, 'BTC-USDT');
    assert.equal((capturedSeries as HypothesisProviderSeriesInfo).exchange, 'BINGX');
    assert.equal((capturedSeries as HypothesisProviderSeriesInfo).timeframe, '1h');
  });

  it('result.hypotheses is a ReadonlyArray (not modified by resolver)', () => {
    const engine = new HypothesisEngine([bullishProvider], new ConflictResolver());
    const result = engine.evaluate([], ZERO_CONFIDENCE, EMPTY_CONTEXT, SERIES_INFO);
    assert.ok(Array.isArray(result.hypotheses));
    assert.equal(result.hypotheses.length, 1);
  });
});

// ─── Enrichment fixtures ──────────────────────────────────────────────────────

function makeEvidence(
  id: string,
  type: EvidenceType,
  direction: 'bullish' | 'bearish' | 'neutral',
  sourceProvider?: string,
): Evidence {
  const metadata: Record<string, string | number | boolean | null> = {};
  if (sourceProvider !== undefined) metadata['sourceProvider'] = sourceProvider;
  return {
    id, type, direction,
    observationId: `obs_${id}`, observationType: type,
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
    barTime: new Date('2026-01-01T00:00:00Z'), detectedAt: new Date('2026-01-01T00:00:00Z'),
    tags: [], metadata,
  };
}

function makeExternalHypothesis(
  id: string,
  direction: 'bullish' | 'bearish' | 'neutral' | 'indeterminate',
  sourceProvider: string,
  score = 80,
): Hypothesis {
  return {
    id, name: `External ${direction}`, category: HypothesisCategory.CONSOLIDATION, direction,
    confidence: { score, supportStrength: 0.8, oppositionStrength: 0, completeness: 1 },
    supportingEvidenceIds: [], opposingEvidenceIds: [], missingEvidence: [],
    preconditions: [], invalidations: [], reasoningTrace: [],
    sourceProvider, providerVersion: '1.0.0',
    generatedAt: new Date(), barTime: new Date(),
    symbol: 'BTC-USDT', exchange: 'BINGX', timeframe: '1h',
  };
}

function makeConf(conflictScore: number): ConfidenceScore {
  return {
    bullishScore: 0, bearishScore: 0, netScore: 0, conflictScore,
    totalWeight: 0, bullishWeight: 0, bearishWeight: 0, neutralWeight: 0,
    evidenceCount: 0, bullishCount: 0, bearishCount: 0, neutralCount: 0,
    contextScore: 0,
  };
}

// ─── Enrichment tests ─────────────────────────────────────────────────────────

describe('HypothesisEngine — external hypothesis enrichment', () => {
  const engine = new HypothesisEngine([], new ConflictResolver());

  const run = (
    externalHypotheses: ReadonlyArray<Hypothesis>,
    evidence: ReadonlyArray<Evidence>,
    conf: ConfidenceScore = ZERO_CONFIDENCE,
  ) => engine.evaluate(evidence, conf, EMPTY_CONTEXT, SERIES_INFO, externalHypotheses).hypotheses;

  it('circular inflation: bullish hypothesis with only own-provider evidence floors at 5', () => {
    const ownEvidence = makeEvidence('e1', EvidenceType.ICT, 'bullish', 'ict-provider');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'ict-provider', 80);
    const hyps = run([h], [ownEvidence]);
    assert.equal(hyps.length, 1);
    assert.strictEqual(hyps[0]!.confidence.score, 5);
  });

  it('bullish hypothesis with only opposing structural evidence floors at 5', () => {
    const bear1   = makeEvidence('e1', EvidenceType.STRUCTURE_BREAK, 'bearish');
    const bear2   = makeEvidence('e2', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const ownBull = makeEvidence('e3', EvidenceType.CANDLESTICK_PATTERN, 'bullish', 'candlestick-provider');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [bear1, bear2, ownBull]);
    assert.strictEqual(hyps[0]!.confidence.score, 5);
  });

  it('bullish hypothesis with only supporting structural evidence caps at 95', () => {
    const bull1 = makeEvidence('e1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const bull2 = makeEvidence('e2', EvidenceType.CHARACTER_CHANGE, 'bullish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [bull1, bull2]);
    assert.strictEqual(hyps[0]!.confidence.score, 95);
  });

  it('mixed external evidence produces correct weighted directional score', () => {
    const bull = makeEvidence('e1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const bear = makeEvidence('e2', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [bull, bear]);
    const bW = DEFAULT_EVIDENCE_WEIGHTS[EvidenceType.STRUCTURE_BREAK];
    const oW = DEFAULT_EVIDENCE_WEIGHTS[EvidenceType.CHARACTER_CHANGE];
    const expected = (bW / (bW + oW)) * 100;
    assert.ok(
      Math.abs(hyps[0]!.confidence.score - expected) < 0.001,
      `score=${hyps[0]!.confidence.score} expected≈${expected.toFixed(3)}`,
    );
  });

  it('bearish hypothesis uses bearish-direction weight for directional score', () => {
    const bull = makeEvidence('e1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const bear = makeEvidence('e2', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bearish', 'ict-provider', 80);
    const hyps = run([h], [bull, bear]);
    const bearW = DEFAULT_EVIDENCE_WEIGHTS[EvidenceType.CHARACTER_CHANGE];
    const bullW = DEFAULT_EVIDENCE_WEIGHTS[EvidenceType.STRUCTURE_BREAK];
    const expected = (bearW / (bearW + bullW)) * 100;
    assert.ok(
      Math.abs(hyps[0]!.confidence.score - expected) < 0.001,
      `score=${hyps[0]!.confidence.score} expected≈${expected.toFixed(3)}`,
    );
  });

  it('own provider evidence excluded while cross-provider evidence is included in score', () => {
    const ownBull   = makeEvidence('e1', EvidenceType.CANDLESTICK_PATTERN, 'bullish', 'candlestick-provider');
    const otherBull = makeEvidence('e2', EvidenceType.ICT, 'bullish', 'ict-provider');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [ownBull, otherBull]);
    assert.strictEqual(hyps[0]!.confidence.score, 95);
    assert.ok( hyps[0]!.supportingEvidenceIds.includes('e2'), 'cross-provider evidence must be included');
    assert.ok(!hyps[0]!.supportingEvidenceIds.includes('e1'), 'own evidence must be excluded');
  });

  it('supportingEvidenceIds contains IDs of all supporting external evidence', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const s2 = makeEvidence('s2', EvidenceType.DISPLACEMENT, 'bullish');
    const o1 = makeEvidence('o1', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'ict-provider', 80);
    const hyps = run([h], [s1, s2, o1]);
    assert.strictEqual(hyps[0]!.supportingEvidenceIds.length, 2);
    assert.ok(hyps[0]!.supportingEvidenceIds.includes('s1'));
    assert.ok(hyps[0]!.supportingEvidenceIds.includes('s2'));
  });

  it('opposingEvidenceIds contains IDs of all opposing external evidence', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const o1 = makeEvidence('o1', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const o2 = makeEvidence('o2', EvidenceType.STRUCTURE_BREAK, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'ict-provider', 80);
    const hyps = run([h], [s1, o1, o2]);
    assert.strictEqual(hyps[0]!.opposingEvidenceIds.length, 2);
    assert.ok(hyps[0]!.opposingEvidenceIds.includes('o1'));
    assert.ok(hyps[0]!.opposingEvidenceIds.includes('o2'));
  });

  it('supportStrength is the count of supporting evidence objects (integer)', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const s2 = makeEvidence('s2', EvidenceType.PRICE_INEFFICIENCY, 'bullish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [s1, s2]);
    assert.strictEqual(hyps[0]!.confidence.supportStrength, 2);
  });

  it('oppositionStrength is the count of opposing evidence objects (integer)', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const o1 = makeEvidence('o1', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const o2 = makeEvidence('o2', EvidenceType.DISPLACEMENT, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [s1, o1, o2]);
    assert.strictEqual(hyps[0]!.confidence.oppositionStrength, 2);
  });

  it('completeness equals supportingCount / (supportingCount + opposingCount)', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const o1 = makeEvidence('o1', EvidenceType.CHARACTER_CHANGE, 'bearish');
    const o2 = makeEvidence('o2', EvidenceType.DISPLACEMENT, 'bearish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'candlestick-provider', 80);
    const hyps = run([h], [s1, o1, o2]);
    assert.ok(Math.abs(hyps[0]!.confidence.completeness - 1 / 3) < 0.001);
  });

  it('completeness is 1.0 when all external evidence supports the hypothesis', () => {
    const s1 = makeEvidence('s1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const s2 = makeEvidence('s2', EvidenceType.DISPLACEMENT, 'bullish');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'ict-provider', 80);
    const hyps = run([h], [s1, s2]);
    assert.strictEqual(hyps[0]!.confidence.completeness, 1);
  });

  it('indeterminate hypothesis: original score is not changed by enrichment', () => {
    const neutral = makeEvidence('n1', EvidenceType.BAR_CLOSE, 'neutral');
    const h = makeExternalHypothesis('hyp_ind', 'indeterminate', 'candlestick-provider', 72);
    const hyps = run([h], [neutral]);
    assert.strictEqual(hyps[0]!.confidence.score, 72);
  });

  it('indeterminate hypothesis: completeness equals confidence.conflictScore', () => {
    const conf = makeConf(0.6);
    const h = makeExternalHypothesis('hyp_ind', 'indeterminate', 'candlestick-provider', 72);
    const hyps = engine.evaluate([], conf, EMPTY_CONTEXT, SERIES_INFO, [h]).hypotheses;
    assert.strictEqual(hyps[0]!.confidence.completeness, 0.6);
  });

  it('indeterminate hypothesis: supportingEvidenceIds contains neutral evidence IDs only', () => {
    const n1   = makeEvidence('n1', EvidenceType.BAR_CLOSE, 'neutral');
    const n2   = makeEvidence('n2', EvidenceType.SESSION, 'neutral');
    const bull = makeEvidence('b1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const h = makeExternalHypothesis('hyp_ind', 'indeterminate', 'ict-provider', 72);
    const hyps = run([h], [n1, n2, bull]);
    assert.strictEqual(hyps[0]!.supportingEvidenceIds.length, 2);
    assert.ok(hyps[0]!.supportingEvidenceIds.includes('n1'));
    assert.ok(hyps[0]!.supportingEvidenceIds.includes('n2'));
    assert.strictEqual(hyps[0]!.opposingEvidenceIds.length, 0);
  });

  it('structural evidence (no sourceProvider in metadata) is never excluded', () => {
    const structural = makeEvidence('e1', EvidenceType.STRUCTURE_BREAK, 'bullish');
    const ownBear    = makeEvidence('e2', EvidenceType.ICT, 'bearish', 'ict-provider');
    const h = makeExternalHypothesis('hyp_ext', 'bullish', 'ict-provider', 80);
    const hyps = run([h], [structural, ownBear]);
    // structural bullish included; own bearish excluded → 100% bullish → capped 95
    assert.strictEqual(hyps[0]!.confidence.score, 95);
    assert.ok( hyps[0]!.supportingEvidenceIds.includes('e1'), 'structural evidence must be included');
    assert.ok(!hyps[0]!.supportingEvidenceIds.includes('e2'), 'own ICT evidence must be excluded');
  });
});