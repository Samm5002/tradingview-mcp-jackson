import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTradePipeline } from '../../../../src/runner/paper-trading/pipeline/PaperTradePipeline.js';
import { PaperTradeEngine } from '../../../../src/runner/paper-trading/engines/PaperTradeEngine.js';
import { MarketEventArbiter } from '../../../../src/runner/paper-trading/engines/MarketEventArbiter.js';
import { InMemoryPaperTradeRegistry } from '../../../../src/runner/paper-trading/impl/InMemoryPaperTradeRegistry.js';
import { InMemoryLearningRegistry } from '../../../../src/learning/impl/registries/InMemoryLearningRegistry.js';
import { DEFAULT_PAPER_TRADE_CONFIG } from '../../../../src/runner/paper-trading/types/PaperTradeConfig.js';
import { PortfolioAccount } from '../../../../src/runner/paper-trading/portfolio/PortfolioAccount.js';
import type { PortfolioConfig } from '../../../../src/runner/paper-trading/portfolio/PortfolioAccount.js';
import { makeBar, makePaperTrade, T0, T1, T2, T3, T4, T5, T10 } from './helpers.js';
import { makeDecision, makeOpportunity } from '../../presentation/helpers.js';

const PT_CONFIG = { ...DEFAULT_PAPER_TRADE_CONFIG, enabled: true };
const DEFAULT_SYMBOL = 'BTC-USDT';

function makePipeline(symbol = DEFAULT_SYMBOL) {
  const engine = new PaperTradeEngine(PT_CONFIG);
  const tradeRegistry = new InMemoryPaperTradeRegistry();
  const learningRegistry = new InMemoryLearningRegistry();
  const pipeline = new PaperTradePipeline(engine, tradeRegistry, learningRegistry, symbol);
  return { pipeline, tradeRegistry, learningRegistry };
}

function makeActDecisionAndOpp() {
  const dec = makeDecision({ decisionType: 'ACT' });
  const opp = makeOpportunity({ id: dec.opportunityId, direction: 'bullish' });
  return { dec, opp };
}

describe('PaperTradePipeline — trade creation', () => {
  it('creates a new trade for ACT decision', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    const { dec, opp } = makeActDecisionAndOpp();
    const bar = makeBar(44800, 45100, 44700, 45000, T0, 100);
    const result = pipeline.process({
      newActDecisions: [dec],
      allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: bar,
    });
    assert.strictEqual(result.newTrades.length, 1);
    assert.strictEqual(tradeRegistry.size(), 1);
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('does not create trade when opportunity is missing from map', () => {
    const { pipeline } = makePipeline();
    const dec = makeDecision({ decisionType: 'ACT' });
    const bar = makeBar(44800, 45100, 44700, 45000, T0, 100);
    const result = pipeline.process({
      newActDecisions: [dec],
      allOpportunitiesById: new Map(), // opp not present
      currentBar: bar,
    });
    assert.strictEqual(result.newTrades.length, 0);
  });

  it('fires TRADE_PENDING event for new trade', () => {
    const { pipeline } = makePipeline();
    const { dec, opp } = makeActDecisionAndOpp();
    const bar = makeBar(44800, 45100, 44700, 45000, T0, 100);
    const result = pipeline.process({
      newActDecisions: [dec],
      allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: bar,
    });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });
});

describe('PaperTradePipeline — per-symbol deduplication', () => {
  const bar = makeBar(44800, 45100, 44700, 45000, T1, 100);

  function makeActInput(direction: 'bullish' | 'bearish' = 'bullish') {
    const dec = makeDecision({ decisionType: 'ACT' });
    const opp = makeOpportunity({ id: dec.opportunityId, direction });
    return { newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: bar };
  }

  it('prevents a duplicate LONG while a LONG trade is PENDING', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makePaperTrade({ status: 'PENDING', direction: 'LONG' }));
    const result = pipeline.process(makeActInput('bullish'));
    assert.strictEqual(result.newTrades.length, 0);
    assert.ok(!result.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('prevents a duplicate SHORT while a SHORT trade is OPEN', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // SHORT geometry: SL above entry (47000 > bar.high 45100), TP below entry (43000 < bar.low 44700) — won't trigger
    tradeRegistry.register(makePaperTrade({ status: 'OPEN', direction: 'SHORT', filledAt: T0, filledPrice: 45000, entryPrice: 45000, stopLoss: 47000, tp1: 43000 }));
    const result = pipeline.process(makeActInput('bearish'));
    assert.strictEqual(result.newTrades.length, 0);
  });

  it('prevents an opposite-direction trade while any ACTIVE trade exists', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // OPEN LONG with SL below bar.low (43500 < 44700) and TP1 above bar.high (46000 > 45100) — won't trigger
    tradeRegistry.register(makePaperTrade({ status: 'OPEN', direction: 'LONG', filledAt: T0, filledPrice: 44500, entryPrice: 44500, stopLoss: 43500, tp1: 46000 }));
    const result = pipeline.process(makeActInput('bearish'));
    assert.strictEqual(result.newTrades.length, 0);
  });

  it('allows a new trade after previous trade reaches CLOSED_PROFIT', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makePaperTrade({ status: 'CLOSED_PROFIT' }));
    const result = pipeline.process(makeActInput('bullish'));
    assert.strictEqual(result.newTrades.length, 1);
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('allows a new trade after previous trade reaches STOP_LOSS', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makePaperTrade({ status: 'STOP_LOSS' }));
    const result = pipeline.process(makeActInput('bullish'));
    assert.strictEqual(result.newTrades.length, 1);
  });

  it('allows a new trade after previous trade reaches EXPIRED', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makePaperTrade({ status: 'EXPIRED' }));
    const result = pipeline.process(makeActInput('bullish'));
    assert.strictEqual(result.newTrades.length, 1);
  });
});

describe('PaperTradePipeline — trade monitoring', () => {
  it('fills pending trade on next bar and fires TRADE_FILLED', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // Pre-register a PENDING trade
    const trade = makePaperTrade({
      status: 'PENDING',
      entryPrice: 45000,
      stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0,
      expirationBarTime: T10,
    });
    tradeRegistry.register(trade);
    const bar = makeBar(44900, 45200, 44800, 45100, T1); // low 44800 <= entry 45000
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_FILLED'));
    assert.strictEqual(tradeRegistry.getActive().length, 1);
    assert.strictEqual(tradeRegistry.getActive()[0]?.status, 'OPEN');
  });

  it('closes trade with STOP_LOSS and creates OutcomeRecord', () => {
    const { pipeline, tradeRegistry, learningRegistry } = makePipeline();
    const trade = makePaperTrade({
      status: 'OPEN',
      filledAt: T1,
      filledPrice: 45000,
      entryPrice: 45000,
      stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0,
      expirationBarTime: T10,
    });
    tradeRegistry.register(trade);
    const bar = makeBar(44500, 44800, 43900, 44200, T2); // SL hit
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_STOP_LOSS'));
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_CLOSED'));
    assert.strictEqual(result.newOutcomes.length, 1);
    assert.strictEqual(result.newOutcomes[0]!.outcomeClass, 'ADVERSE');
    assert.strictEqual(learningRegistry.getAllOutcomes().length, 1);
  });

  it('closes trade at TP1 as CLOSED_PROFIT and creates FAVORABLE OutcomeRecord', () => {
    const { pipeline, tradeRegistry, learningRegistry } = makePipeline();
    const openTrade = makePaperTrade({
      status: 'OPEN',
      filledAt: T1,
      filledPrice: 45000,
      entryPrice: 45000,
      stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0,
      expirationBarTime: T10,
    });
    tradeRegistry.register(openTrade);
    const bar = makeBar(46000, 46700, 45900, 46500, T3); // TP1 hit
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_TP1_HIT'));
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_CLOSED'));
    assert.strictEqual(result.newOutcomes.length, 1);
    assert.strictEqual(result.newOutcomes[0]!.outcomeClass, 'FAVORABLE');
    assert.strictEqual(learningRegistry.getAllOutcomes().length, 1);
  });

  it('creates NEUTRAL OutcomeRecord for expired trade', () => {
    const { pipeline, tradeRegistry, learningRegistry } = makePipeline();
    const trade = makePaperTrade({
      status: 'PENDING',
      entryPrice: 45000,
      stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0,
      expirationBarTime: T5,
    });
    tradeRegistry.register(trade);
    const bar = makeBar(45100, 45300, 45050, 45200, T5); // openTime >= expirationBarTime; low 45050 > entry 45000 so no fill
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_EXPIRED'));
    assert.strictEqual(result.newOutcomes.length, 1);
    assert.strictEqual(result.newOutcomes[0]!.outcomeClass, 'NEUTRAL');
    assert.strictEqual(learningRegistry.getAllOutcomes().length, 1);
  });

  it('handles multiple simultaneous trades', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // trade1: OPEN, SL well below bar range, TP well above — stays OPEN
    const trade1 = makePaperTrade({ status: 'OPEN', filledAt: T0, filledPrice: 45000, stopLoss: 43000, tp1: 48000, expirationBarTime: T10 });
    // trade2: PENDING entry at 45500; SL at 44000 — bar fills it (low 44800 <= 45500) and SL 44000 is not hit (low 44800 > 44000)
    const trade2 = makePaperTrade({ status: 'PENDING', entryPrice: 45500, stopLoss: 44000, tp1: 47500, creationBarTime: T0, expirationBarTime: T10 });
    tradeRegistry.register(trade1);
    tradeRegistry.register(trade2);
    const bar = makeBar(45100, 46200, 44800, 46000, T2);
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    assert.ok(result.lifecycleEvents.some(e => e.eventType === 'TRADE_FILLED'));
    assert.strictEqual(tradeRegistry.getActive().length, 2);
  });

  it('full winning sequence: PENDING → OPEN → TP1 → CLOSED_PROFIT', () => {
    const { pipeline, tradeRegistry, learningRegistry } = makePipeline();
    const trade = makePaperTrade({
      status: 'PENDING',
      entryPrice: 45000, stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0, expirationBarTime: T10,
    });
    tradeRegistry.register(trade);

    const allEvents: string[] = [];

    // Bar 1: fills
    const b1 = makeBar(44900, 45200, 44800, 45100, T1);
    allEvents.push(...pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: b1 }).lifecycleEvents.map(e => e.eventType));

    // Bar 2: TP1 closes trade directly as CLOSED_PROFIT
    const b2 = makeBar(46000, 46700, 45900, 46500, T2);
    allEvents.push(...pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: b2 }).lifecycleEvents.map(e => e.eventType));

    assert.ok(allEvents.includes('TRADE_FILLED'));
    assert.ok(allEvents.includes('TRADE_TP1_HIT'));
    assert.ok(allEvents.includes('TRADE_CLOSED'));
    assert.strictEqual(learningRegistry.getAllOutcomes().length, 1);
    assert.strictEqual(learningRegistry.getAllOutcomes()[0]!.outcomeClass, 'FAVORABLE');
    assert.strictEqual(tradeRegistry.getClosed()[0]?.status, 'CLOSED_PROFIT');
  });
});

describe('PaperTradePipeline — lifecycle event ordering', () => {
  it('terminal events fire in step-1 order and re-entry lock blocks step-2 TRADE_PENDING', () => {
    // An OPEN trade is SL-hit by the bar (step 1). The re-entry lock is set.
    // An ACT decision is present but must NOT produce TRADE_PENDING on the same bar.
    const { pipeline, tradeRegistry } = makePipeline();
    // OPEN LONG: SL=43500, TP1=46000 — will be hit by bar.low=43200
    tradeRegistry.register(makePaperTrade({
      status: 'OPEN', filledAt: T0, filledPrice: 44500,
      entryPrice: 44500, stopLoss: 43500, tp1: 46000,
      expirationBarTime: T10,
    }));
    const { dec, opp } = makeActDecisionAndOpp();
    const bar = makeBar(44000, 45100, 43200, 44500, T1, 100);
    const result = pipeline.process({
      newActDecisions: [dec],
      allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: bar,
    });
    const types = result.lifecycleEvents.map(e => e.eventType);
    assert.ok(types.includes('TRADE_STOP_LOSS'), 'expected TRADE_STOP_LOSS');
    assert.ok(types.includes('TRADE_CLOSED'),    'expected TRADE_CLOSED');
    assert.ok(!types.includes('TRADE_PENDING'),  're-entry lock must block TRADE_PENDING on the terminal bar');
    assert.ok(types.indexOf('TRADE_STOP_LOSS') < types.indexOf('TRADE_CLOSED'), 'TRADE_STOP_LOSS must precede TRADE_CLOSED');
  });

  it('fill + SL on same bar: TRADE_FILLED is first in lifecycle events (lock set, no re-entry)', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // PENDING LONG: entry=45000, SL=43000; bar fills then immediately stops out
    tradeRegistry.register(makePaperTrade({
      status: 'PENDING', direction: 'LONG',
      entryPrice: 45000, stopLoss: 43000,
      tp1: 46500,
      creationBarTime: T0, expirationBarTime: T10,
    }));
    const bar = makeBar(45100, 45300, 42800, 43500, T1, 100);
    const result = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: bar });
    const types = result.lifecycleEvents.map(e => e.eventType);
    assert.strictEqual(types[0], 'TRADE_FILLED', 'first event must be TRADE_FILLED');
    assert.ok(types.includes('TRADE_CLOSED'), 'TRADE_CLOSED must be present');
    assert.ok(types.indexOf('TRADE_FILLED') < types.indexOf('TRADE_CLOSED'), 'TRADE_FILLED before TRADE_CLOSED');
  });
});

// ── Evidence maps used across re-entry lock tests ──────────────────────────────
const BOS_BULLISH   = new Map([['ev-1', 'BULLISH_BOS_CONFIRMED']]);
const BOS_BEARISH   = new Map([['ev-1', 'BEARISH_BOS_CONFIRMED']]);
const CHOCH_BULLISH = new Map([['ev-1', 'BULLISH_CHOCH_CONFIRMED']]);
const CHOCH_BEARISH = new Map([['ev-1', 'BEARISH_CHOCH_CONFIRMED']]);
const MSS_BULLISH   = new Map([['ev-1', 'BULLISH_MSS_CONFIRMED']]);
const MSS_BEARISH   = new Map([['ev-1', 'BEARISH_MSS_CONFIRMED']]);
const NON_STRUCTURE = new Map([['ev-1', 'PRICE_VOID_FORMED']]);

// OPEN LONG: SL=43500. A bar with low < 43500 will SL-hit it.
function makeSLTrade() {
  return makePaperTrade({
    status: 'OPEN', filledAt: T0, filledPrice: 44500,
    entryPrice: 44500, stopLoss: 43500, tp1: 46000,
    expirationBarTime: T10,
  });
}
// low=43200 < SL=43500 → triggers STOP_LOSS
function makeSLBar(t: Date) { return makeBar(44000, 45100, 43200, 44500, t, 100); }
// Normal bar well inside SL/TP range — does not trigger any lifecycle event
function makeQuietBar(t: Date) { return makeBar(44200, 44900, 44100, 44600, t, 100); }

describe('PaperTradePipeline — re-entry lock', () => {
  // ── Lock activation ──────────────────────────────────────────────────────────

  it('blocks re-entry on the same bar a STOP_LOSS fires', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeSLBar(T1),
    });
    assert.ok(r.lifecycleEvents.some(e => e.eventType === 'TRADE_STOP_LOSS'));
    assert.ok(!r.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'), 'lock must block TRADE_PENDING on the terminal bar');
    assert.strictEqual(r.newTrades.length, 0);
  });

  it('blocks re-entry on the same bar a CLOSED_PROFIT fires', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    // OPEN: bar.high=46700 > TP1=46500 → TRADE_TP1_HIT + TRADE_CLOSED (CLOSED_PROFIT)
    tradeRegistry.register(makePaperTrade({
      status: 'OPEN', filledAt: T0, filledPrice: 45000,
      entryPrice: 45000, stopLoss: 44000, tp1: 46500,
      creationBarTime: T0, expirationBarTime: T10,
    }));
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeBar(46000, 46700, 45900, 46500, T1, 100),
    });
    assert.ok(r.lifecycleEvents.some(e => e.eventType === 'TRADE_CLOSED'));
    assert.ok(!r.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'), 'lock must block re-entry after CLOSED_PROFIT');
    assert.strictEqual(r.newTrades.length, 0);
  });

  it('blocks re-entry on the same bar a TRADE_EXPIRED fires', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makePaperTrade({
      status: 'PENDING', entryPrice: 45000, stopLoss: 44000,
      tp1: 46500,
      creationBarTime: T0, expirationBarTime: T5,
    }));
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeBar(45100, 45300, 45050, 45200, T5), // low 45050 > entry 45000 so no fill, expiry fires
    });
    assert.ok(r.lifecycleEvents.some(e => e.eventType === 'TRADE_EXPIRED'));
    assert.ok(!r.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'), 'lock must block re-entry after EXPIRED');
    assert.strictEqual(r.newTrades.length, 0);
  });

  // ── Lock persistence ─────────────────────────────────────────────────────────

  it('time alone does not clear the lock across multiple bars', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    for (const t of [T2, T3, T4]) {
      const { dec, opp } = makeActDecisionAndOpp();
      const r = pipeline.process({
        newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
        currentBar: makeQuietBar(t),
      });
      assert.strictEqual(r.newTrades.length, 0, `lock must persist on bar ${t.toISOString()} without structure`);
    }
  });

  it('non-structure evidence does not clear the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2),
      evidenceTypeById: NON_STRUCTURE,
    });
    assert.strictEqual(r.newTrades.length, 0, 'non-structure evidence must not clear the lock');
  });

  it('structure evidence on the same bar as the terminal event does not clear the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    const { dec, opp } = makeActDecisionAndOpp();
    // BOS fires on the same bar (T1) as the SL — lock set to T1, unlock requires T > T1
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeSLBar(T1),
      evidenceTypeById: BOS_BULLISH,
    });
    assert.strictEqual(r.newTrades.length, 0, 'same-bar structure must not unlock — requires a subsequent bar');
  });

  // ── Unlock triggers ──────────────────────────────────────────────────────────

  it('BULLISH_BOS_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: BOS_BULLISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BULLISH_BOS_CONFIRMED must clear the lock');
  });

  it('BEARISH_BOS_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: BOS_BEARISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BEARISH_BOS_CONFIRMED must clear the lock');
  });

  it('BULLISH_CHOCH_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: CHOCH_BULLISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BULLISH_CHOCH_CONFIRMED must clear the lock');
  });

  it('BEARISH_CHOCH_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: CHOCH_BEARISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BEARISH_CHOCH_CONFIRMED must clear the lock');
  });

  it('BULLISH_MSS_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: MSS_BULLISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BULLISH_MSS_CONFIRMED must clear the lock');
  });

  it('BEARISH_MSS_CONFIRMED on a subsequent bar clears the lock', () => {
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: MSS_BEARISH,
    });
    assert.strictEqual(r.newTrades.length, 1, 'BEARISH_MSS_CONFIRMED must clear the lock');
  });

  it('lock clears when structure fires on a bar with no ACT decisions, not on the next one', () => {
    // Structure on T2 (no decisions) should clear the lock so T3 (with decision) trades freely.
    const { pipeline, tradeRegistry } = makePipeline();
    tradeRegistry.register(makeSLTrade());
    pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    // T2: BOS fires but no ACT decision present
    pipeline.process({
      newActDecisions: [], allOpportunitiesById: new Map(),
      currentBar: makeQuietBar(T2), evidenceTypeById: BOS_BULLISH,
    });
    // T3: ACT decision, no structure — lock should already be gone
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({
      newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]),
      currentBar: makeQuietBar(T3),
    });
    assert.strictEqual(r.newTrades.length, 1, 'lock must clear when structure fires, not deferred to next trade attempt');
  });

  // ── Per-symbol isolation ─────────────────────────────────────────────────────

  it('lock is isolated per pipeline instance — locked symbol does not block a different symbol', () => {
    // Two independent pipeline instances simulate two separate symbols.
    const { pipeline: pipelineA, tradeRegistry: regA } = makePipeline('A-USDT');
    const { pipeline: pipelineB } = makePipeline('B-USDT');

    // Pipeline A: trade hits SL on T1 → locked
    regA.register(makeSLTrade());
    pipelineA.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });

    // Pipeline A is locked — confirm it blocks a new trade
    const { dec: dA, opp: oA } = makeActDecisionAndOpp();
    const rA = pipelineA.process({
      newActDecisions: [dA], allOpportunitiesById: new Map([[oA.id, oA]]),
      currentBar: makeQuietBar(T2),
    });
    assert.strictEqual(rA.newTrades.length, 0, 'pipeline A must be locked');

    // Pipeline B: independent instance — must not be affected by A's lock
    const { dec: dB, opp: oB } = makeActDecisionAndOpp();
    const rB = pipelineB.process({
      newActDecisions: [dB], allOpportunitiesById: new Map([[oB.id, oB]]),
      currentBar: makeQuietBar(T2),
    });
    assert.strictEqual(rB.newTrades.length, 1, 'pipeline B must trade normally — lock on A must not bleed across symbols');
    assert.ok(rB.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('two pipeline instances each track their own lock independently', () => {
    const { pipeline: pA, tradeRegistry: rA } = makePipeline('A-USDT');
    const { pipeline: pB, tradeRegistry: rB } = makePipeline('B-USDT');

    // Both symbols take a loss on T1
    rA.register(makeSLTrade());
    rB.register(makeSLTrade());
    pA.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });
    pB.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeSLBar(T1) });

    // T2: structure fires only for pipeline A
    const { dec: dA, opp: oA } = makeActDecisionAndOpp();
    const ra2 = pA.process({
      newActDecisions: [dA], allOpportunitiesById: new Map([[oA.id, oA]]),
      currentBar: makeQuietBar(T2), evidenceTypeById: BOS_BULLISH,
    });
    assert.strictEqual(ra2.newTrades.length, 1, 'pipeline A unlocked by structure');

    // T2: no structure for pipeline B — still locked
    const { dec: dB, opp: oB } = makeActDecisionAndOpp();
    const rb2 = pB.process({
      newActDecisions: [dB], allOpportunitiesById: new Map([[oB.id, oB]]),
      currentBar: makeQuietBar(T2),
    });
    assert.strictEqual(rb2.newTrades.length, 0, 'pipeline B still locked — no structure yet');
  });
});

// ── MarketEventArbiter integration ────────────────────────────────────────────

function makeArbiterPipeline(symbol: string, arbiter: MarketEventArbiter) {
  const engine = new PaperTradeEngine(PT_CONFIG);
  const tradeRegistry = new InMemoryPaperTradeRegistry();
  const learningRegistry = new InMemoryLearningRegistry();
  const pipeline = new PaperTradePipeline(engine, tradeRegistry, learningRegistry, symbol, arbiter);
  return { pipeline, tradeRegistry };
}

function makeActInput(barTime: Date) {
  const dec = makeDecision({ decisionType: 'ACT' });
  const opp = makeOpportunity({ id: dec.opportunityId, direction: 'bullish' });
  const bar = makeBar(44800, 45100, 44700, 45000, barTime, 100);
  return { dec, opp, bar, input: { newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: bar } };
}

describe('PaperTradePipeline — MarketEventArbiter', () => {
  it('defers trade creation to next bar — no TRADE_PENDING on ACT bar', () => {
    const arbiter = new MarketEventArbiter(1);
    const { pipeline } = makeArbiterPipeline('BTC-USDT', arbiter);
    const { input } = makeActInput(T1);

    const r1 = pipeline.process(input);
    assert.strictEqual(r1.newTrades.length, 0, 'no trade on ACT bar');
    assert.strictEqual(r1.blockedByMarketEvent, 1);
    assert.ok(!r1.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('creates PENDING trade on next bar after arbiter approves', () => {
    const arbiter = new MarketEventArbiter(1);
    const { pipeline } = makeArbiterPipeline('BTC-USDT', arbiter);

    // Bar T1: ACT decision submitted to arbiter
    const { input: input1 } = makeActInput(T1);
    pipeline.process(input1);

    // Bar T2: empty input — arbiter settles T1 and pipeline claims approval
    const barT2 = makeBar(44900, 45200, 44800, 45100, T2, 100);
    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: barT2 });

    assert.strictEqual(r2.newTrades.length, 1, 'trade created on bar T2 from T1 approval');
    assert.ok(r2.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
  });

  it('best quality symbol wins the market event slot', () => {
    const arbiter = new MarketEventArbiter(1);
    const makeQ = (score: number) => ({ score, evidenceCompleteness: score / 100, hypothesisAgreement: 1, contextRichness: 0.5, conflictPenalty: 0, policyStrength: 0.8 });

    const { pipeline: pA, tradeRegistry: regA } = makeArbiterPipeline('A-USDT', arbiter);
    const { pipeline: pB, tradeRegistry: regB } = makeArbiterPipeline('B-USDT', arbiter);

    // Both submit on T1; B has higher quality
    const decA = makeDecision({ decisionType: 'ACT', symbol: 'A-USDT', qualitySnapshot: makeQ(70) });
    const oppA = makeOpportunity({ id: decA.opportunityId, symbol: 'A-USDT' });
    const decB = makeDecision({ decisionType: 'ACT', symbol: 'B-USDT', qualitySnapshot: makeQ(90) });
    const oppB = makeOpportunity({ id: decB.opportunityId, symbol: 'B-USDT' });
    const barT1 = makeBar(44800, 45100, 44700, 45000, T1, 100);

    pA.process({ newActDecisions: [decA], allOpportunitiesById: new Map([[oppA.id, oppA]]), currentBar: barT1 });
    pB.process({ newActDecisions: [decB], allOpportunitiesById: new Map([[oppB.id, oppB]]), currentBar: barT1 });

    // Bar T2: each pipeline claims
    const barT2 = makeBar(44900, 45200, 44800, 45100, T2, 100);
    const emptyInput = { newActDecisions: [] as [], allOpportunitiesById: new Map() as Map<string, never>, currentBar: barT2 };
    const rA2 = pA.process(emptyInput);
    const rB2 = pB.process(emptyInput);

    assert.strictEqual(rA2.newTrades.length, 0, 'A-USDT (quality=70) must not be selected');
    assert.strictEqual(rB2.newTrades.length, 1, 'B-USDT (quality=90) must be selected');
    assert.strictEqual(regA.size(), 0);
    assert.strictEqual(regB.size(), 1);
  });

  it('single symbol ACT with arbiter still produces one trade', () => {
    const arbiter = new MarketEventArbiter(1);
    const { pipeline } = makeArbiterPipeline('BTC-USDT', arbiter);

    const { input: input1 } = makeActInput(T1);
    pipeline.process(input1);

    const barT2 = makeBar(44900, 45200, 44800, 45100, T2, 100);
    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: barT2 });

    assert.strictEqual(r2.newTrades.length, 1, 'idiosyncratic signal (only 1 symbol) still approved');
  });

  it('approved trade from arbiter is immediately eligible for fill on the claim bar', () => {
    const arbiter = new MarketEventArbiter(1);
    const { pipeline, tradeRegistry } = makeArbiterPipeline('BTC-USDT', arbiter);

    // T1: submit ACT — PENDING created on T2 with T1's geometry (entry=45000 for LONG)
    const dec = makeDecision({ decisionType: 'ACT' });
    const opp = makeOpportunity({ id: dec.opportunityId, direction: 'bullish' });
    const barT1 = makeBar(44800, 45100, 44700, 45000, T1, 100);
    pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: barT1 });

    // T2: claim bar — if bar low touches entry, fill happens in same process() call
    // Entry is computed from T1's ATR; we just verify the trade is registered
    const barT2 = makeBar(44900, 45200, 44800, 45100, T2, 100);
    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: barT2 });

    assert.strictEqual(r2.newTrades.length, 1, 'PENDING trade created');
    // The trade could be OPEN if T2 bar touched entry; we only assert the trade exists
    assert.ok(tradeRegistry.size() >= 1);
  });

  it('active trade on the ACT bar blocks submission to arbiter — no claim on next bar', () => {
    // When a symbol already has an ACTIVE trade, its ACT decision is blocked before reaching
    // the arbiter. The arbiter never selects this symbol, so no claim fires on the next bar.
    const arbiter = new MarketEventArbiter(1);
    const { pipeline, tradeRegistry } = makeArbiterPipeline('BTC-USDT', arbiter);

    // Pre-existing PENDING trade
    tradeRegistry.register(makePaperTrade({ status: 'PENDING', entryPrice: 45500, stopLoss: 44000, tp1: 47000, creationBarTime: T0, expirationBarTime: T10 }));

    // T1: ACT decision arrives — but active PENDING trade blocks submission (blockedByActiveTrade=1)
    const { input: input1 } = makeActInput(T1);
    const r1 = pipeline.process(input1);
    assert.strictEqual(r1.blockedByActiveTrade, 1, 'ACT blocked on T1 due to active trade');
    assert.strictEqual(arbiter.pendingCount, 0, 'arbiter never received this symbol (submission blocked)');

    // T2: no claim fires because nothing was submitted
    const barT2 = makeBar(45100, 45300, 45050, 45200, T2, 100);
    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: barT2 });
    assert.strictEqual(r2.newTrades.length, 0, 'no approved trade on T2');
    assert.strictEqual(r2.blockedByActiveTrade, 0, 'nothing to block on T2 claim — arbiter was never submitted to');
  });

  it('blockedByInsufficientBalance is 0 on a normal result', () => {
    const { pipeline } = makePipeline();
    const { dec, opp } = makeActDecisionAndOpp();
    const bar = makeBar(44800, 45100, 44700, 45000, T1, 100);
    const r = pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: bar });
    assert.strictEqual(r.blockedByInsufficientBalance, 0);
  });

  it('blockedByMarketEvent is 0 when no arbiter is wired', () => {
    const { pipeline } = makePipeline();
    const { dec, opp } = makeActDecisionAndOpp();
    const bar = makeBar(44800, 45100, 44700, 45000, T1, 100);
    const r = pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: bar });
    assert.strictEqual(r.blockedByMarketEvent, 0);
    assert.strictEqual(r.newTrades.length, 1, 'trade created immediately without arbiter');
  });

  it('blockedByInsufficientBalance is 0 in arbiter path under normal conditions', () => {
    const arbiter = new MarketEventArbiter(1);
    const { pipeline } = makeArbiterPipeline('BTC-USDT', arbiter);
    const { input: input1 } = makeActInput(T1);
    pipeline.process(input1);
    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeBar(44900, 45200, 44800, 45100, T2, 100) });
    assert.strictEqual(r2.blockedByInsufficientBalance, 0);
  });

  it('maxTradesPerEvent=2 — top-2 pipelines both create trades, third does not', () => {
    const makeQ = (score: number) => ({ score, evidenceCompleteness: score / 100, hypothesisAgreement: 1, contextRichness: 0.5, conflictPenalty: 0, policyStrength: 0.8 });
    const arbiter = new MarketEventArbiter(2);

    const { pipeline: pA, tradeRegistry: regA } = makeArbiterPipeline('A-USDT', arbiter);
    const { pipeline: pB, tradeRegistry: regB } = makeArbiterPipeline('B-USDT', arbiter);
    const { pipeline: pC, tradeRegistry: regC } = makeArbiterPipeline('C-USDT', arbiter);

    const barT1 = makeBar(44800, 45100, 44700, 45000, T1, 100);
    const decA = makeDecision({ decisionType: 'ACT', symbol: 'A-USDT', qualitySnapshot: makeQ(90) });
    const oppA = makeOpportunity({ id: decA.opportunityId, symbol: 'A-USDT' });
    const decB = makeDecision({ decisionType: 'ACT', symbol: 'B-USDT', qualitySnapshot: makeQ(80) });
    const oppB = makeOpportunity({ id: decB.opportunityId, symbol: 'B-USDT' });
    const decC = makeDecision({ decisionType: 'ACT', symbol: 'C-USDT', qualitySnapshot: makeQ(60) });
    const oppC = makeOpportunity({ id: decC.opportunityId, symbol: 'C-USDT' });

    pA.process({ newActDecisions: [decA], allOpportunitiesById: new Map([[oppA.id, oppA]]), currentBar: barT1 });
    pB.process({ newActDecisions: [decB], allOpportunitiesById: new Map([[oppB.id, oppB]]), currentBar: barT1 });
    pC.process({ newActDecisions: [decC], allOpportunitiesById: new Map([[oppC.id, oppC]]), currentBar: barT1 });

    const barT2 = makeBar(44900, 45200, 44800, 45100, T2, 100);
    const empty = { newActDecisions: [] as [], allOpportunitiesById: new Map() as Map<string, never>, currentBar: barT2 };
    const rA2 = pA.process(empty);
    const rB2 = pB.process(empty);
    const rC2 = pC.process(empty);

    assert.strictEqual(rA2.newTrades.length, 1, 'A-USDT (score=90, rank 1) approved');
    assert.strictEqual(rB2.newTrades.length, 1, 'B-USDT (score=80, rank 2) approved');
    assert.strictEqual(rC2.newTrades.length, 0, 'C-USDT (score=60, rank 3) rejected — limit=2');
    assert.strictEqual(regA.size(), 1);
    assert.strictEqual(regB.size(), 1);
    assert.strictEqual(regC.size(), 0);
  });
});

// ── Insufficient balance guard ────────────────────────────────────────────────

function makePipelineWithPortfolio(config: PortfolioConfig, symbol = DEFAULT_SYMBOL) {
  const engine = new PaperTradeEngine(PT_CONFIG);
  const registry = new InMemoryPaperTradeRegistry();
  const learning = new InMemoryLearningRegistry();
  const portfolio = new PortfolioAccount(config);
  const pipeline = new PaperTradePipeline(engine, registry, learning, symbol, null, portfolio);
  return { pipeline, registry, portfolio };
}

const EXHAUSTED_ALLOC = { positionSize: 0.01, marginUsed: 100, notional: 10 };

describe('PaperTradePipeline — insufficient balance guard', () => {
  it('direct path — creates trade when freeMargin is sufficient', () => {
    const { pipeline, registry } = makePipelineWithPortfolio({ initialBalance: 1000, leverage: 10, maxMarginPerTrade: 100 });
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: makeBar(44800, 45100, 44700, 45000, T0, 100) });
    assert.strictEqual(r.newTrades.length, 1);
    assert.ok(r.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
    assert.strictEqual(r.blockedByInsufficientBalance, 0);
    assert.strictEqual(registry.size(), 1);
  });

  it('direct path — rejects trade and emits no TRADE_PENDING when freeMargin exhausted', () => {
    const { pipeline, registry, portfolio } = makePipelineWithPortfolio({ initialBalance: 100, leverage: 10, maxMarginPerTrade: 100 });
    portfolio.confirmTrade('other', 'OTHER-USDT', 'LONG', EXHAUSTED_ALLOC);
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: makeBar(44800, 45100, 44700, 45000, T0, 100) });
    assert.strictEqual(r.newTrades.length, 0);
    assert.ok(!r.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
    assert.strictEqual(registry.size(), 0);
  });

  it('direct path — trace has blockReason INSUFFICIENT_BALANCE and counter is 1', () => {
    const { pipeline, portfolio } = makePipelineWithPortfolio({ initialBalance: 100, leverage: 10, maxMarginPerTrade: 100 });
    portfolio.confirmTrade('other', 'OTHER-USDT', 'LONG', EXHAUSTED_ALLOC);
    const { dec, opp } = makeActDecisionAndOpp();
    const r = pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: makeBar(44800, 45100, 44700, 45000, T0, 100) });
    assert.strictEqual(r.blockedByInsufficientBalance, 1);
    const trace = r.decisionTraces[0];
    assert.ok(trace !== undefined);
    assert.strictEqual(trace.blocked, true);
    assert.strictEqual(trace.blockReason, 'INSUFFICIENT_BALANCE');
    assert.strictEqual(trace.createdTradeId, null);
  });

  it('direct path — usedMargin does not increase when balance is insufficient', () => {
    const { pipeline, portfolio } = makePipelineWithPortfolio({ initialBalance: 100, leverage: 10, maxMarginPerTrade: 100 });
    portfolio.confirmTrade('other', 'OTHER-USDT', 'LONG', EXHAUSTED_ALLOC);
    const usedBefore = portfolio.snapshot().usedMargin;
    const { dec, opp } = makeActDecisionAndOpp();
    pipeline.process({ newActDecisions: [dec], allOpportunitiesById: new Map([[opp.id, opp]]), currentBar: makeBar(44800, 45100, 44700, 45000, T0, 100) });
    assert.strictEqual(portfolio.snapshot().usedMargin, usedBefore);
  });

  it('arbiter path — rejects trade at claim time when freeMargin is exhausted', () => {
    const arbiter = new MarketEventArbiter(1);
    const engine = new PaperTradeEngine(PT_CONFIG);
    const registry = new InMemoryPaperTradeRegistry();
    const learning = new InMemoryLearningRegistry();
    const portfolio = new PortfolioAccount({ initialBalance: 100, leverage: 10, maxMarginPerTrade: 100 });
    const pipeline = new PaperTradePipeline(engine, registry, learning, DEFAULT_SYMBOL, arbiter, portfolio);

    const { input: input1 } = makeActInput(T1);
    pipeline.process(input1);

    // Exhaust margin between submission and claim
    portfolio.confirmTrade('other', 'OTHER-USDT', 'LONG', EXHAUSTED_ALLOC);

    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeBar(44900, 45200, 44800, 45100, T2, 100) });
    assert.strictEqual(r2.newTrades.length, 0);
    assert.ok(!r2.lifecycleEvents.some(e => e.eventType === 'TRADE_PENDING'));
    assert.strictEqual(registry.size(), 0);
  });

  it('arbiter path — trace has blockReason INSUFFICIENT_BALANCE and counter is 1', () => {
    const arbiter = new MarketEventArbiter(1);
    const engine = new PaperTradeEngine(PT_CONFIG);
    const registry = new InMemoryPaperTradeRegistry();
    const learning = new InMemoryLearningRegistry();
    const portfolio = new PortfolioAccount({ initialBalance: 100, leverage: 10, maxMarginPerTrade: 100 });
    const pipeline = new PaperTradePipeline(engine, registry, learning, DEFAULT_SYMBOL, arbiter, portfolio);

    const { input: input1 } = makeActInput(T1);
    pipeline.process(input1);
    portfolio.confirmTrade('other', 'OTHER-USDT', 'LONG', EXHAUSTED_ALLOC);

    const r2 = pipeline.process({ newActDecisions: [], allOpportunitiesById: new Map(), currentBar: makeBar(44900, 45200, 44800, 45100, T2, 100) });
    assert.strictEqual(r2.blockedByInsufficientBalance, 1);
    const trace = r2.decisionTraces[0];
    assert.ok(trace !== undefined);
    assert.strictEqual(trace.blocked, true);
    assert.strictEqual(trace.blockReason, 'INSUFFICIENT_BALANCE');
  });
});
