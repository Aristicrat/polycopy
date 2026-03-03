import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import GlassPanel from '../components/effects/GlassPanel';
import PolymarketLoading from '../components/PolymarketLoading';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

type AnalyticsSnapshot = {
  periods: Record<string, LeaderboardEntry[]>;
  labels?: Record<string, string>;
  defaultPeriod?: string;
};

type TraderHistoryEntry = {
  timestamp: number;
  pnl: number | null;
  tradeCount: number;
  notionalVolume: number;
  marketCount: number;
  openPositions: number;
};

type TraderHistoryPayload = {
  address: string;
  history: TraderHistoryEntry[];
  latest?: TraderHistoryEntry | null;
  deltas?: {
    pnl24h?: number | null;
    pnl7d?: number | null;
    volume24h?: number | null;
    volume7d?: number | null;
    tradeCount24h?: number | null;
    tradeCount7d?: number | null;
  };
};

type BasicTrade = {
  created_at?: string | number;
  createdAt?: string | number;
  timestamp?: string | number;
  time?: string | number;
  executedAt?: string | number;
  updatedAt?: string | number;
  amount?: string | number;
  size?: string | number;
  shares?: string | number;
  quantity?: string | number;
  price?: string | number;
  avgPrice?: string | number;
  average_price?: string | number;
};

type LeaderboardEntry = {
  address: string;
  rank?: number;
  displayName?: string;
  roi?: number | null;
  pnl?: number | null;
  volume?: number | null;
  trades?: number | null;
};

type TraderInsight = {
  address: string;
  displayName: string;
  rank: number | null;
  confidenceScore: number;
  signal: 'Bullish Momentum' | 'Neutral' | 'Bearish Momentum';
  roi: number | null;
  pnl: number | null;
  volume: number | null;
  trades: number | null;
  latestPnl: number | null;
  pnl24h: number | null;
  volume24h: number | null;
  tradeVelocity24h: number | null;
  consistency: number;
};

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';

async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    const bodyPreview = (await response.text()).slice(0, 120);
    throw new Error(`${context}: expected JSON but received ${contentType || 'unknown'} (${bodyPreview})`);
  }
  return (await response.json()) as T;
}

function toNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatUsd(value: number | null) {
  if (value === null) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  });
}

function formatCompactUsd(value: number | null) {
  if (value === null) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  return `${value < 0 ? '-' : ''}$${abs.toFixed(0)}`;
}

function formatPercent(value: number | null) {
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatDelta(value: number | null) {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatCompactUsd(value)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeTimestampMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const abs = Math.abs(value);
    if (abs < 1e11) return Math.round(value * 1000);
    if (abs > 1e14) return Math.round(value / 1000);
    return Math.round(value);
  }
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return normalizeTimestampMs(asNumber);
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTradeNotional(trade: BasicTrade): number {
  const size = Number(trade.amount ?? trade.size ?? trade.shares ?? trade.quantity ?? 0);
  const price = Number(trade.price ?? trade.avgPrice ?? trade.average_price ?? 0);
  const safeSize = Number.isFinite(size) ? Math.abs(size) : 0;
  const safePrice = Number.isFinite(price) ? Math.abs(price) : 0;
  return safeSize * safePrice;
}

function buildFallbackHistoryPayload(address: string, trades: BasicTrade[]): TraderHistoryPayload {
  const ordered = trades
    .map((trade) => ({
      timestamp: normalizeTimestampMs(trade.created_at ?? trade.createdAt ?? trade.timestamp ?? trade.time ?? trade.executedAt ?? trade.updatedAt),
      notional: toTradeNotional(trade)
    }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

  let cumulativeNotional = 0;
  const history = ordered.map((entry, index) => {
    cumulativeNotional += Number(entry.notional || 0);
    return {
      timestamp: entry.timestamp as number,
      pnl: null,
      tradeCount: index + 1,
      notionalVolume: cumulativeNotional,
      marketCount: 0,
      openPositions: 0
    } as TraderHistoryEntry;
  });

  return {
    address,
    history,
    latest: history[history.length - 1] || null,
    deltas: {
      pnl24h: null,
      pnl7d: null,
      volume24h: history.length > 0 ? history[history.length - 1].notionalVolume : null,
      volume7d: history.length > 0 ? history[history.length - 1].notionalVolume : null,
      tradeCount24h: history.length > 0 ? history[history.length - 1].tradeCount : null,
      tradeCount7d: history.length > 0 ? history[history.length - 1].tradeCount : null
    }
  };
}

function computeConsistency(history: TraderHistoryEntry[]) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  const valid = [...history]
    .map((entry) => ({ t: Number(entry.timestamp), pnl: toNumber(entry.pnl) }))
    .filter((entry) => Number.isFinite(entry.t) && entry.pnl !== null)
    .sort((a, b) => a.t - b.t);

  if (valid.length < 2) return 0;

  let positiveSteps = 0;
  for (let i = 1; i < valid.length; i += 1) {
    if ((valid[i].pnl as number) >= (valid[i - 1].pnl as number)) {
      positiveSteps += 1;
    }
  }
  return positiveSteps / (valid.length - 1);
}

export default function AnalyticsDashboard() {
  const [analyticsData, setAnalyticsData] = useState<{ snapshot: AnalyticsSnapshot; fetchedAt: number } | null>(
    null
  );
  const [historyByAddress, setHistoryByAddress] = useState<Record<string, TraderHistoryPayload>>({});
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('weekly');
  const [isLeaderboardLoading, setIsLeaderboardLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadLeaderboard = async () => {
      setIsLeaderboardLoading(true);
      setError(null);
      try {
        const analyticsRes = await fetch(`${API_BASE}/analytics/leaderboard`, { credentials: 'include' });
        if (analyticsRes.ok) {
          const payload = await parseJsonResponse<{ snapshot: AnalyticsSnapshot; fetchedAt: number }>(
            analyticsRes,
            'Analytics leaderboard'
          );
          if (!cancelled) {
            setAnalyticsData(payload);
            const nextPeriod = payload?.snapshot?.defaultPeriod || 'weekly';
            setSelectedPeriod(nextPeriod);
          }
          return;
        }

        const leaderboardRes = await fetch(`${API_BASE}/leaderboard`, { credentials: 'include' });
        if (!leaderboardRes.ok) {
          throw new Error(`Failed to load analytics leaderboard (${analyticsRes.status}/${leaderboardRes.status})`);
        }
        const fallback = await parseJsonResponse<{
          periods?: Record<string, LeaderboardEntry[]>;
          labels?: Record<string, string>;
          defaultPeriod?: string;
          fetchedAt?: number;
        }>(leaderboardRes, 'Leaderboard fallback');

        const payload = {
          snapshot: {
            periods: fallback?.periods || {},
            labels: fallback?.labels || {},
            defaultPeriod: fallback?.defaultPeriod || 'weekly'
          },
          fetchedAt: Number.isFinite(Number(fallback?.fetchedAt)) ? Number(fallback?.fetchedAt) : Date.now()
        };

        if (!cancelled) {
          setAnalyticsData(payload);
          setSelectedPeriod(payload.snapshot.defaultPeriod || 'weekly');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load analytics data');
        }
      } finally {
        if (!cancelled) setIsLeaderboardLoading(false);
      }
    };

    void loadLeaderboard();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const entries = analyticsData?.snapshot?.periods?.[selectedPeriod];
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }

    const topAddresses = entries
      .slice(0, 8)
      .map((entry) => String(entry.address || '').toLowerCase())
      .filter((address) => /^0x[a-f0-9]{40}$/.test(address));

    if (topAddresses.length === 0) return;

    let cancelled = false;
    setIsHistoryLoading(true);

    Promise.allSettled(
      topAddresses.map(async (address) => {
        try {
          const historyRes = await fetch(`${API_BASE}/analytics/trader/${address}/history`, { credentials: 'include' });
          if (historyRes.ok) {
            const payload = await parseJsonResponse<TraderHistoryPayload>(historyRes, `Trader history ${address}`);
            if (Array.isArray(payload?.history) && payload.history.length > 0) {
              return payload;
            }
          }
        } catch {
          // Fallback below.
        }

        const tradesRes = await fetch(`${API_BASE}/users/${address}/trades?period=${selectedPeriod}&limit=250`, {
          credentials: 'include'
        });
        if (!tradesRes.ok) {
          throw new Error(`Failed to load trader history (${address})`);
        }
        const tradesPayload = await parseJsonResponse<{ trades?: BasicTrade[] }>(tradesRes, `Trader trades ${address}`);
        const trades = Array.isArray(tradesPayload?.trades) ? tradesPayload.trades : [];
        return buildFallbackHistoryPayload(address, trades);
      })
    )
      .then((results) => {
        if (cancelled) return;
        const fulfilled = results
          .filter((result): result is PromiseFulfilledResult<TraderHistoryPayload> => result.status === 'fulfilled')
          .map((result) => result.value)
          .filter((payload) => payload && payload.address);

        if (fulfilled.length === 0) {
          const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          setError(firstError?.reason instanceof Error ? firstError.reason.message : 'Failed to load trader history');
          return;
        }

        setHistoryByAddress((previous) => {
          const next = { ...previous };
          fulfilled.forEach((payload) => {
            next[payload.address.toLowerCase()] = payload;
          });
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setIsHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [analyticsData, selectedPeriod]);

  const periodLabels = analyticsData?.snapshot.labels || {};
  const periodKeys = useMemo(() => {
    const keys = Object.keys(analyticsData?.snapshot.periods || {});
    return keys.filter((key) => Array.isArray(analyticsData?.snapshot.periods?.[key]));
  }, [analyticsData]);

  const leaderboardEntries = useMemo(() => {
    const periodData = analyticsData?.snapshot.periods?.[selectedPeriod] || [];
    return Array.isArray(periodData) ? periodData.slice(0, 12) : [];
  }, [analyticsData, selectedPeriod]);

  useEffect(() => {
    if (!selectedAddress && leaderboardEntries.length > 0) {
      setSelectedAddress(leaderboardEntries[0].address.toLowerCase());
      return;
    }
    if (selectedAddress && !leaderboardEntries.some((entry) => entry.address.toLowerCase() === selectedAddress)) {
      setSelectedAddress(leaderboardEntries[0]?.address?.toLowerCase() || null);
    }
  }, [leaderboardEntries, selectedAddress]);

  const traderInsights = useMemo<TraderInsight[]>(() => {
    return leaderboardEntries.map((entry) => {
      const address = String(entry.address || '').toLowerCase();
      const history = historyByAddress[address]?.history || [];
      const deltas = historyByAddress[address]?.deltas || {};
      const latest = historyByAddress[address]?.latest || history[0] || null;
      const consistency = computeConsistency(history);
      const roi = toNumber(entry.roi);
      const pnl = toNumber(entry.pnl);
      const volume = toNumber(entry.volume);
      const trades = toNumber(entry.trades);
      const pnl24h = toNumber(deltas.pnl24h);
      const volume24h = toNumber(deltas.volume24h);
      const tradeVelocity24h = toNumber(deltas.tradeCount24h);

      const roiScore = clamp(((roi ?? 0) + 20) / 120, 0, 1);
      const pnlScore = clamp(Math.log10(Math.max(1, Math.abs(pnl ?? 0))) / 6, 0, 1);
      const volumeScore = clamp(Math.log10(Math.max(1, Math.abs(volume ?? 0))) / 7, 0, 1);
      const momentumScore = clamp(((pnl24h ?? 0) + 50_000) / 100_000, 0, 1);
      const activityScore = clamp((tradeVelocity24h ?? 0) / 30, 0, 1);

      const confidenceScore = Math.round(
        (roiScore * 0.23 + pnlScore * 0.22 + volumeScore * 0.2 + momentumScore * 0.2 + consistency * 0.1 + activityScore * 0.05) *
          100
      );

      let signal: TraderInsight['signal'] = 'Neutral';
      if ((pnl24h ?? 0) > 0 && consistency >= 0.55) signal = 'Bullish Momentum';
      if ((pnl24h ?? 0) < 0 && consistency < 0.45) signal = 'Bearish Momentum';

      return {
        address,
        displayName: entry.displayName || `${address.slice(0, 6)}…${address.slice(-4)}`,
        rank: toNumber(entry.rank),
        confidenceScore,
        signal,
        roi,
        pnl,
        volume,
        trades,
        latestPnl: toNumber(latest?.pnl),
        pnl24h,
        volume24h,
        tradeVelocity24h,
        consistency
      };
    });
  }, [leaderboardEntries, historyByAddress]);

  const consensusView = useMemo(() => {
    if (traderInsights.length === 0) {
      return { bullish: 0, bearish: 0, neutral: 0, headline: 'No signal yet' };
    }
    const bullish = traderInsights.filter((entry) => entry.signal === 'Bullish Momentum').length;
    const bearish = traderInsights.filter((entry) => entry.signal === 'Bearish Momentum').length;
    const neutral = Math.max(0, traderInsights.length - bullish - bearish);

    let headline = 'Top traders are mixed right now';
    if (bullish >= Math.max(3, bearish + 2)) headline = 'Risk-on regime from top traders';
    if (bearish >= Math.max(3, bullish + 2)) headline = 'Defensive regime from top traders';

    return { bullish, bearish, neutral, headline };
  }, [traderInsights]);

  const selectedHistory = useMemo(() => {
    if (!selectedAddress) return [];
    return (historyByAddress[selectedAddress]?.history || []).slice().sort((a, b) => a.timestamp - b.timestamp);
  }, [historyByAddress, selectedAddress]);

  const chartData = useMemo(
    () => {
      return selectedHistory
        .slice(-12)
        .map((entry) => ({
          ...entry,
          label: new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          pnl: toNumber(entry.pnl),
          notionalVolume: toNumber(entry.notionalVolume)
        }))
        .reverse();
    },
    [selectedHistory]
  );

  const selectedInsight = useMemo(() => {
    if (!selectedAddress) return null;
    return traderInsights.find((entry) => entry.address === selectedAddress) || null;
  }, [traderInsights, selectedAddress]);

  return (
    <div className="min-h-screen bg-[#040712] text-slate-100">
      <div className="relative z-10 mx-auto max-w-6xl px-3 pb-20 pt-8 space-y-6 sm:px-6">
        <GlassPanel className="rounded-3xl p-6 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.4em] text-blue-300">Analytics</p>
              <h1 className="text-2xl font-semibold text-white">Live leaderboard insights</h1>
            </div>
            <RouterLink
              to="/leaderboard"
              className="rounded-full border border-slate-600 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-slate-200 transition hover:border-white"
            >
              Back to leaderboard
            </RouterLink>
          </div>
          <p className="text-sm text-slate-300">
            Use top-trader momentum, consistency, and participation to build your own directional view before entering markets.
          </p>
          {analyticsData?.fetchedAt && (
            <p className="text-xs text-slate-400">
              Snapshot taken {new Date(analyticsData.fetchedAt).toLocaleTimeString()} from Polymarket.
            </p>
          )}
          {periodKeys.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {periodKeys.map((periodKey) => {
                const active = selectedPeriod === periodKey;
                return (
                  <button
                    key={periodKey}
                    type="button"
                    onClick={() => setSelectedPeriod(periodKey)}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.2em] transition ${
                      active
                        ? 'bg-blue-600 text-white shadow shadow-blue-500/30'
                        : 'border border-slate-700 text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    {periodLabels[periodKey] || periodKey}
                  </button>
                );
              })}
            </div>
          )}
          {error && <p className="text-sm text-rose-300">{error}</p>}
        </GlassPanel>

        <GlassPanel className="rounded-3xl p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3">
              <p className="text-[11px] uppercase text-slate-500">Consensus</p>
              <p className="mt-1 text-sm font-semibold text-white">{consensusView.headline}</p>
            </div>
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3">
              <p className="text-[11px] uppercase text-slate-500">Bullish</p>
              <p className="mt-1 text-xl font-semibold text-emerald-300">{consensusView.bullish}</p>
            </div>
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3">
              <p className="text-[11px] uppercase text-slate-500">Bearish</p>
              <p className="mt-1 text-xl font-semibold text-rose-300">{consensusView.bearish}</p>
            </div>
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/60 p-3">
              <p className="text-[11px] uppercase text-slate-500">Neutral</p>
              <p className="mt-1 text-xl font-semibold text-slate-200">{consensusView.neutral}</p>
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="rounded-3xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Top trader prediction signals</h2>
            <span className="text-xs text-slate-400 uppercase tracking-[0.3em]">
              {periodLabels[selectedPeriod] || selectedPeriod}
            </span>
          </div>
          {isLeaderboardLoading && (
            <div className="rounded-2xl border border-slate-800/60 bg-slate-900/40">
              <PolymarketLoading compact label="Loading PolyCopy Leaderboard" />
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            {traderInsights.map((entry) => (
              <button
                key={entry.address}
                type="button"
                onClick={() => setSelectedAddress(entry.address)}
                className={`flex flex-col gap-1 rounded-2xl border px-3 py-3 text-left transition ${
                  selectedAddress === entry.address
                    ? 'border-blue-500/60 bg-blue-500/10'
                    : 'border-slate-800/60 bg-slate-900/60 hover:border-slate-500'
                }`}
              >
                <span className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-400">
                  Rank {entry.rank || '—'} · Confidence {entry.confidenceScore}/100
                </span>
                <span className="text-base font-semibold text-white">{entry.displayName}</span>
                <span
                  className={`text-xs font-semibold ${
                    entry.signal === 'Bullish Momentum'
                      ? 'text-emerald-300'
                      : entry.signal === 'Bearish Momentum'
                      ? 'text-rose-300'
                      : 'text-slate-300'
                  }`}
                >
                  {entry.signal}
                </span>
                <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                  <span>ROI {formatPercent(entry.roi)}</span>
                  <span>24h PnL {formatDelta(entry.pnl24h)}</span>
                  <span>Volume {formatCompactUsd(entry.volume)}</span>
                  <span>24h Trades {entry.tradeVelocity24h ?? '—'}</span>
                </div>
                <span className="mt-1 text-xs text-slate-500">{entry.address}</span>
              </button>
            ))}
          </div>
        </GlassPanel>

        {selectedAddress && (
          <GlassPanel className="rounded-3xl p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Trader history</p>
                <h2 className="text-xl font-semibold text-white">{selectedAddress}</h2>
              </div>
              <button
                type="button"
                onClick={() => setSelectedAddress(null)}
                className="text-xs font-semibold text-slate-400 underline-offset-4 hover:text-slate-100"
              >
                Clear selection
              </button>
            </div>
            {selectedInsight && (
              <div className="grid grid-cols-2 gap-3 text-xs text-slate-300 sm:grid-cols-6">
                <div>
                  <p className="text-[11px] uppercase text-slate-500">Signal</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{selectedInsight.signal}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-slate-500">Confidence</p>
                  <p className="mt-1 text-sm font-semibold text-blue-300">{selectedInsight.confidenceScore}/100</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-slate-500">ROI</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{formatPercent(selectedInsight.roi)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-slate-500">Total PnL</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{formatUsd(selectedInsight.pnl)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-slate-500">24h Volume</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{formatCompactUsd(selectedInsight.volume24h)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase text-slate-500">Consistency</p>
                  <p className="mt-1 text-sm font-semibold text-slate-100">{Math.round(selectedInsight.consistency * 100)}%</p>
                </div>
              </div>
            )}
            {isHistoryLoading && (
              <div className="rounded-2xl border border-slate-800/60 bg-slate-900/40">
                <PolymarketLoading compact label="Loading PolyCopy Trader History" />
              </div>
            )}
            {!isHistoryLoading && selectedHistory.length === 0 && (
              <p className="text-sm text-slate-400">No history captured yet for this trader.</p>
            )}
            {selectedHistory.length > 0 && (
              <div className="space-y-4">
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155' }}
                        labelStyle={{ color: '#cbd5e1' }}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="pnl" stroke="#22c55e" strokeWidth={2} dot={false} name="PnL" />
                      <Line
                        type="monotone"
                        dataKey="notionalVolume"
                        stroke="#f59e0b"
                        strokeWidth={2}
                        dot={false}
                        name="Notional volume"
                      />
                      <Line type="monotone" dataKey="tradeCount" stroke="#60a5fa" strokeWidth={2} dot={false} name="Trades" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs text-slate-300 sm:grid-cols-4">
                  <div>
                    <p className="text-[11px] uppercase text-slate-500">Last PnL</p>
                    <p className="mt-1 text-sm font-semibold text-emerald-300">
                      {selectedHistory[selectedHistory.length - 1].pnl === null
                        ? '—'
                        : `$${selectedHistory[selectedHistory.length - 1].pnl?.toFixed(2)}`}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase text-slate-500">Trades</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {selectedHistory[selectedHistory.length - 1].tradeCount}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase text-slate-500">Market Count</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {selectedHistory[selectedHistory.length - 1].marketCount}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase text-slate-500">Open Positions</p>
                    <p className="mt-1 text-sm font-semibold text-slate-100">
                      {selectedHistory[selectedHistory.length - 1].openPositions}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </GlassPanel>
        )}
      </div>
    </div>
  );
}
