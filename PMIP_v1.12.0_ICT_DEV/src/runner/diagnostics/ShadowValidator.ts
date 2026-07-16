/**
 * ShadowValidator — compares ProfessionalHypothesisProvider output vs the existing
 * hypothesis system (StructureBasedHypothesisProvider via HypothesisPipeline) on
 * every live bar.
 *
 * Single global instance shared across all series (same pattern as ICTDryRunObserver).
 * Call compareBar() from Step 7b in BarPipelineProcessor — observation only, no
 * behavioral effect on the pipeline.
 *
 * Matching semantics:
 *   - Comparison key: `${category}:${direction}`
 *   - Full match: both providers generated at least one hypothesis and their key sets are identical
 *   - Partial match: at least one key in common (when one or both have hypotheses)
 *   - Agreement: key appears in both sets (counted per bar, not per hypothesis)
 *   - PHP-only: key in PHP set but not existing set
 *   - Existing-only: key in existing set but not PHP set
 */
import type { Hypothesis } from '../../hypothesis/types/Hypothesis.js';

// Print a summary every this many live bars across all symbols.
const AUTO_REPORT_EVERY = 200;

// ── Per-symbol accumulator ────────────────────────────────────────────────────

interface SymbolState {
  bars: number;
  fullMatchBars: number;
  partialMatchBars: number;
  bothEmptyBars: number;
  phpEmptyBars: number;
  existingEmptyBars: number;
  totalPhp: number;
  totalExisting: number;
  agreement: Record<string, number>;
  phpOnly: Record<string, number>;
  existingOnly: Record<string, number>;
}

function emptySymbolState(): SymbolState {
  return {
    bars: 0, fullMatchBars: 0, partialMatchBars: 0,
    bothEmptyBars: 0, phpEmptyBars: 0, existingEmptyBars: 0,
    totalPhp: 0, totalExisting: 0,
    agreement: {}, phpOnly: {}, existingOnly: {},
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface ShadowSymbolMetrics {
  readonly symbol: string;
  readonly bars: number;
  readonly fullMatchBars: number;
  readonly partialMatchBars: number;
  readonly bothEmptyBars: number;
  readonly phpEmptyBars: number;
  readonly existingEmptyBars: number;
  readonly fullMatchRate: number;
  readonly partialMatchRate: number;
  readonly totalPhpHypotheses: number;
  readonly totalExistingHypotheses: number;
  readonly byCategoryAgreement: Readonly<Record<string, number>>;
  readonly byCategoryPhpOnly: Readonly<Record<string, number>>;
  readonly byCategoryExistingOnly: Readonly<Record<string, number>>;
}

export interface ShadowGlobalMetrics {
  readonly bars: number;
  readonly symbols: number;
  readonly fullMatchBars: number;
  readonly partialMatchBars: number;
  readonly bothEmptyBars: number;
  readonly phpEmptyBars: number;
  readonly existingEmptyBars: number;
  readonly fullMatchRate: number;
  readonly partialMatchRate: number;
  readonly totalPhpHypotheses: number;
  readonly totalExistingHypotheses: number;
  readonly byCategoryAgreement: Readonly<Record<string, number>>;
  readonly byCategoryPhpOnly: Readonly<Record<string, number>>;
  readonly byCategoryExistingOnly: Readonly<Record<string, number>>;
  readonly perSymbol: ReadonlyArray<ShadowSymbolMetrics>;
}

// ── ShadowValidator ───────────────────────────────────────────────────────────

export class ShadowValidator {
  private readonly _symbols = new Map<string, SymbolState>();
  private _totalBars = 0;

  // ── Core comparison ───────────────────────────────────────────────────────

  compareBar(
    symbol: string,
    _timeframe: string,
    _barTime: Date,
    existing: ReadonlyArray<Hypothesis>,
    php: ReadonlyArray<Hypothesis>,
  ): void {
    let state = this._symbols.get(symbol);
    if (state === undefined) {
      state = emptySymbolState();
      this._symbols.set(symbol, state);
    }

    state.bars++;
    state.totalExisting += existing.length;
    state.totalPhp += php.length;
    this._totalBars++;

    const existingKeys = new Set(existing.map(h => `${h.category}:${h.direction}`));
    const phpKeys      = new Set(php.map(h => `${h.category}:${h.direction}`));

    // Classify bar
    const eEmpty = existingKeys.size === 0;
    const pEmpty = phpKeys.size === 0;

    if (eEmpty && pEmpty) {
      state.bothEmptyBars++;
      return;
    }
    if (pEmpty) { state.phpEmptyBars++;      return; }
    if (eEmpty) { state.existingEmptyBars++; return; }

    // Compute set differences
    let matchCount = 0;
    for (const key of phpKeys) {
      if (existingKeys.has(key)) {
        matchCount++;
        state.agreement[key] = (state.agreement[key] ?? 0) + 1;
      } else {
        state.phpOnly[key] = (state.phpOnly[key] ?? 0) + 1;
      }
    }
    for (const key of existingKeys) {
      if (!phpKeys.has(key)) {
        state.existingOnly[key] = (state.existingOnly[key] ?? 0) + 1;
      }
    }

    if (matchCount > 0) state.partialMatchBars++;

    const fullMatch =
      matchCount === existingKeys.size &&
      matchCount === phpKeys.size;
    if (fullMatch) state.fullMatchBars++;

    // Periodic auto-report via console (avoids needing logger dependency)
    if (this._totalBars % AUTO_REPORT_EVERY === 0) {
      process.stdout.write(`[SHADOW/AUTO] ${this._totalBars} bars | ${(this.getGlobalMetrics().fullMatchRate * 100).toFixed(1)}% full-match | ${(this.getGlobalMetrics().partialMatchRate * 100).toFixed(1)}% partial-match\n`);
    }
  }

  // ── Metrics ───────────────────────────────────────────────────────────────

  getGlobalMetrics(): ShadowGlobalMetrics {
    // Aggregate across all symbols
    let bars = 0, fullMatchBars = 0, partialMatchBars = 0;
    let bothEmptyBars = 0, phpEmptyBars = 0, existingEmptyBars = 0;
    let totalPhp = 0, totalExisting = 0;
    const agreement: Record<string, number> = {};
    const phpOnly: Record<string, number>   = {};
    const existOnly: Record<string, number> = {};

    const perSymbol: ShadowSymbolMetrics[] = [];

    for (const [sym, st] of this._symbols) {
      bars             += st.bars;
      fullMatchBars    += st.fullMatchBars;
      partialMatchBars += st.partialMatchBars;
      bothEmptyBars    += st.bothEmptyBars;
      phpEmptyBars     += st.phpEmptyBars;
      existingEmptyBars += st.existingEmptyBars;
      totalPhp         += st.totalPhp;
      totalExisting    += st.totalExisting;

      for (const [k, v] of Object.entries(st.agreement))  { agreement[k] = (agreement[k] ?? 0) + v; }
      for (const [k, v] of Object.entries(st.phpOnly))    { phpOnly[k]   = (phpOnly[k]   ?? 0) + v; }
      for (const [k, v] of Object.entries(st.existingOnly)) { existOnly[k] = (existOnly[k] ?? 0) + v; }

      perSymbol.push({
        symbol: sym,
        bars: st.bars,
        fullMatchBars:    st.fullMatchBars,
        partialMatchBars: st.partialMatchBars,
        bothEmptyBars:    st.bothEmptyBars,
        phpEmptyBars:     st.phpEmptyBars,
        existingEmptyBars: st.existingEmptyBars,
        fullMatchRate:    st.bars === 0 ? 0 : st.fullMatchBars    / st.bars,
        partialMatchRate: st.bars === 0 ? 0 : st.partialMatchBars / st.bars,
        totalPhpHypotheses:      st.totalPhp,
        totalExistingHypotheses: st.totalExisting,
        byCategoryAgreement:  { ...st.agreement },
        byCategoryPhpOnly:    { ...st.phpOnly },
        byCategoryExistingOnly: { ...st.existingOnly },
      });
    }

    return {
      bars, symbols: this._symbols.size,
      fullMatchBars, partialMatchBars,
      bothEmptyBars, phpEmptyBars, existingEmptyBars,
      fullMatchRate:    bars === 0 ? 0 : fullMatchBars    / bars,
      partialMatchRate: bars === 0 ? 0 : partialMatchBars / bars,
      totalPhpHypotheses:      totalPhp,
      totalExistingHypotheses: totalExisting,
      byCategoryAgreement:  agreement,
      byCategoryPhpOnly:    phpOnly,
      byCategoryExistingOnly: existOnly,
      perSymbol: perSymbol.sort((a, b) => b.bars - a.bars),
    };
  }

  // ── Report formatting ──────────────────────────────────────────────────────

  formatReport(): string {
    const m = this.getGlobalMetrics();
    const D  = '─'.repeat(58);
    const D2 = '─'.repeat(44);
    const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
    const row = (label: string, value: string | number) =>
      `  ${label.padEnd(26)}${value}`;

    const lines: string[] = [
      `\n${D}`,
      'Shadow Validation Report',
      D,
      row('Bars compared:', m.bars.toLocaleString()),
      row('Symbols:', m.symbols),
      row('Avg PHP hyp/bar:', m.bars === 0 ? '0' : (m.totalPhpHypotheses      / m.bars).toFixed(2)),
      row('Avg existing hyp/bar:', m.bars === 0 ? '0' : (m.totalExistingHypotheses / m.bars).toFixed(2)),
      D,
      'Match Rates',
      row('  Full match:', pct(m.fullMatchRate)),
      row('  Partial match:', pct(m.partialMatchRate)),
      row('  Both empty:', `${m.bothEmptyBars} bars`),
      row('  PHP empty (existing had hyps):', `${m.phpEmptyBars} bars`),
      row('  Existing empty (PHP had hyps):', `${m.existingEmptyBars} bars`),
    ];

    // Agreement breakdown
    if (Object.keys(m.byCategoryAgreement).length > 0) {
      lines.push(D, 'Agreement (in both systems, count of bars)');
      const sorted = Object.entries(m.byCategoryAgreement).sort((a, b) => b[1] - a[1]);
      for (const [key, count] of sorted) {
        lines.push(row(`  ${key}:`, count));
      }
    }

    // PHP-only differences
    if (Object.keys(m.byCategoryPhpOnly).length > 0) {
      lines.push(D, 'PHP-only (Professional generated, existing did not)');
      const sorted = Object.entries(m.byCategoryPhpOnly).sort((a, b) => b[1] - a[1]);
      for (const [key, count] of sorted) {
        lines.push(row(`  ${key}:`, count));
      }
    }

    // Existing-only differences
    if (Object.keys(m.byCategoryExistingOnly).length > 0) {
      lines.push(D, 'Existing-only (existing generated, Professional did not)');
      const sorted = Object.entries(m.byCategoryExistingOnly).sort((a, b) => b[1] - a[1]);
      for (const [key, count] of sorted) {
        lines.push(row(`  ${key}:`, count));
      }
    }

    // Per-symbol summary (top 10 by bars)
    const topSymbols = m.perSymbol.slice(0, 10);
    if (topSymbols.length > 0) {
      lines.push(D, 'Per-symbol (top 10 by bars)');
      lines.push(`  ${'Symbol'.padEnd(18)} ${'Bars'.padStart(5)} ${'Full%'.padStart(6)} ${'Part%'.padStart(6)} ${'PHPe'.padStart(5)} ${'Ee'.padStart(4)}`);
      lines.push(`  ${D2}`);
      for (const s of topSymbols) {
        lines.push(
          `  ${s.symbol.padEnd(18)} ${String(s.bars).padStart(5)} ` +
          `${pct(s.fullMatchRate).padStart(6)} ${pct(s.partialMatchRate).padStart(6)} ` +
          `${String(s.phpEmptyBars).padStart(5)} ${String(s.existingEmptyBars).padStart(4)}`,
        );
      }
    }

    lines.push(`${D}\n`);
    return lines.join('\n');
  }
}
