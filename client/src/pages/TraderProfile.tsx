import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import GlassPanel from '../components/effects/GlassPanel';
import PolymarketLoading from '../components/PolymarketLoading';
import type { Trade } from '../hooks/useLiveTrades';

type LeaderboardContextEntry = {
  displayName?: string | null;
  rank?: number | null;
  roi?: number | null;
  pnl?: number | null;
  volume?: number | null;
  trades?: number | null;
  avatarUrl?: string | null;
};

type TraderProfileSummary = {
  address: string;
  displayName: string;
  username?: string | null;
  pseudonym?: string | null;
  polymarketUrl?: string | null;
  avatarUrl?: string | null;
  rank?: number | null;
  roi?: number | null;
  pnl?: number | null;
  volume?: number | null;
  trades?: number | null;
};

type PositionRow = {
  market: string;
  side: string | null;
  size: number;
  currentValue: number;
  initialValue: number;
  cashPnl: number | null;
  realizedPnl: number | null;
};

type OverviewPayload = {
  address: string;
  period: string;
  profile?: TraderProfileSummary;
  trades?: Trade[];
  pnl?: {
    pnl?: number | null;
    cashflowProxy?: number | null;
    tradeCount?: number;
    calculation?: string;
  };
  portfolio?: {
    portfolioValue?: number | null;
    marketCount?: number;
    notionalVolume?: number;
    positionsValue?: number;
    positionsInitialValue?: number;
    positionsCashPnl?: number;
    positionsRealizedPnl?: number;
  };
  positions?: {
    positions?: PositionRow[];
    source?: string;
  };
  openOrders?: {
    openOrders?: Array<{
      market?: string;
      side?: string;
      size?: number;
      price?: number | null;
      status?: string;
    }>;
    note?: string;
  };
};

type HistoryPoint = {
  timestamp: number;
  pnl: number | null;
  tradeCount: number;
  notionalVolume: number;
  portfolioValue?: number | null;
};

type HistoryPayload = {
  history?: HistoryPoint[];
  deltas?: {
    pnl24h?: number | null;
    pnl7d?: number | null;
    volume24h?: number | null;
    volume7d?: number | null;
    portfolioValue24h?: number | null;
    portfolioValue7d?: number | null;
  };
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

function getTradeTimestamp(trade: Trade): number | null {
  return normalizeTimestampMs(
    trade.created_at || trade.createdAt || trade.timestamp || trade.time || trade.executedAt || trade.updatedAt || null
  );
}

function extractTradeSide(trade: Trade) {
  const side = String(trade.side || trade.type || '').toLowerCase();
  if (side.includes('buy')) return 'buy';
  if (side.includes('sell')) return 'sell';
  return side || 'unknown';
}

function extractTradeSize(trade: Trade) {
  const size = Number(trade.amount || trade.size || trade.shares || 0);
  return Number.isFinite(size) ? size : 0;
}

function extractTradePrice(trade: Trade) {
  const price = Number(trade.price || 0);
  return Number.isFinite(price) ? price : 0;
}

function extractTradeMarket(trade: Trade) {
  const market =
    (typeof trade.market === 'string' ? trade.market : trade.market?.question || trade.market?.title) ||
    trade.marketId ||
    trade.market_id ||
    'Unknown market';
  return String(market);
}

function buildHistoryFromTrades(trades: Trade[]): HistoryPayload {
  const timeline = trades
    .map((trade) => {
      const timestamp = getTradeTimestamp(trade);
      const size = Math.abs(extractTradeSize(trade));
      const price = Math.abs(extractTradePrice(trade));
      return {
        timestamp,
        notional: size * price
      };
    })
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((a, b) => (a.timestamp as number) - (b.timestamp as number));

  let cumulativeNotional = 0;
  const history = timeline.map((entry, index) => {
    cumulativeNotional += Number(entry.notional || 0);
    return {
      timestamp: entry.timestamp as number,
      pnl: null,
      tradeCount: index + 1,
      notionalVolume: cumulativeNotional,
      portfolioValue: null
    };
  });

  return {
    history,
    deltas: {
      volume24h: history.length > 0 ? history[history.length - 1].notionalVolume : null,
      volume7d: history.length > 0 ? history[history.length - 1].notionalVolume : null
    }
  };
}

function formatUsd(value: number | null | undefined, fractionDigits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: fractionDigits
  });
}

function formatCompactUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${value < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  return `${value < 0 ? '-' : ''}$${abs.toFixed(0)}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export default function TraderProfile() {
  const { address } = useParams<{ address: string }>();
  const location = useLocation();
  const navigationEntry = (location.state as { leaderboardEntry?: LeaderboardContextEntry } | null)?.leaderboardEntry || null;

  const [period, setPeriod] = useState<'today' | 'weekly' | 'monthly' | 'all'>('all');
  const [overview, setOverview] = useState<OverviewPayload | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setRefreshTick((current) => current + 1), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const controller = new AbortController();

    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        const [overviewRes, historyRes] = await Promise.all([
          fetch(`${API_BASE}/users/${address}/overview?period=${period}&limit=500`, {
            signal: controller.signal,
            credentials: 'include'
          }),
          fetch(`${API_BASE}/analytics/trader/${address}/history`, {
            signal: controller.signal,
            credentials: 'include'
          })
        ]);

        if (!overviewRes.ok) {
          throw new Error(`Failed to load overview (${overviewRes.status})`);
        }

        const overviewPayload = await parseJsonResponse<OverviewPayload>(overviewRes, 'Trader overview');

        let historyPayload: HistoryPayload | null = null;
        if (historyRes.ok) {
          try {
            historyPayload = await parseJsonResponse<HistoryPayload>(historyRes, 'Trader analytics history');
          } catch {
            historyPayload = null;
          }
        }

        if (!historyPayload || !Array.isArray(historyPayload.history) || historyPayload.history.length === 0) {
          const fallbackTrades = Array.isArray(overviewPayload.trades) ? overviewPayload.trades : [];
          historyPayload = buildHistoryFromTrades(fallbackTrades);
        }

        if (cancelled) return;
        setOverview(overviewPayload);
        setHistory(historyPayload);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load trader profile');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, period, refreshTick]);

  const profile = useMemo(() => {
    if (overview?.profile) return overview.profile;
    if (!address) return null;
    return {
      address: address.toLowerCase(),
      displayName: navigationEntry?.displayName || shortAddress(address.toLowerCase()),
      rank: navigationEntry?.rank ?? null,
      roi: navigationEntry?.roi ?? null,
      pnl: navigationEntry?.pnl ?? null,
      volume: navigationEntry?.volume ?? null,
      trades: navigationEntry?.trades ?? null,
      avatarUrl: navigationEntry?.avatarUrl ?? null
    } as TraderProfileSummary;
  }, [overview, address, navigationEntry]);

  const trades = useMemo(() => {
    const rows = Array.isArray(overview?.trades) ? overview.trades : [];
    return [...rows].sort((a, b) => {
      const ta = getTradeTimestamp(a) || 0;
      const tb = getTradeTimestamp(b) || 0;
      return tb - ta;
    });
  }, [overview]);

  const metrics = useMemo(() => {
    const marketMap = new Map<string, { trades: number; notional: number; buy: number; sell: number }>();
    const activeDaySet = new Set<string>();
    let buyCount = 0;
    let sellCount = 0;
    let totalNotional = 0;

    for (const trade of trades) {
      const market = extractTradeMarket(trade);
      const side = extractTradeSide(trade);
      const size = Math.abs(extractTradeSize(trade));
      const price = extractTradePrice(trade);
      const notional = Math.abs(size * price);
      const ts = getTradeTimestamp(trade);

      totalNotional += notional;
      if (side === 'buy') buyCount += 1;
      if (side === 'sell') sellCount += 1;
      if (ts) activeDaySet.add(new Date(ts).toISOString().slice(0, 10));

      const current = marketMap.get(market) || { trades: 0, notional: 0, buy: 0, sell: 0 };
      current.trades += 1;
      current.notional += notional;
      if (side === 'buy') current.buy += 1;
      if (side === 'sell') current.sell += 1;
      marketMap.set(market, current);
    }

    return {
      buyCount,
      sellCount,
      totalNotional,
      uniqueMarkets: marketMap.size,
      activeDays: activeDaySet.size,
      topMarkets: Array.from(marketMap.entries())
        .map(([market, stats]) => ({ market, ...stats }))
        .sort((a, b) => b.notional - a.notional)
        .slice(0, 8)
    };
  }, [trades]);

  const displayedPnl = useMemo(() => {
    if (typeof profile?.pnl === 'number' && Number.isFinite(profile.pnl)) {
      return profile.pnl;
    }
    if (typeof overview?.pnl?.pnl === 'number' && Number.isFinite(overview.pnl.pnl)) {
      return overview.pnl.pnl;
    }
    return null;
  }, [profile?.pnl, overview?.pnl?.pnl]);

  const historyCurve = useMemo(() => {
    const points = Array.isArray(history?.history) ? history.history : [];
    return [...points]
      .map((entry) => ({
        timestamp: normalizeTimestampMs(entry.timestamp),
        portfolioValue: Number.isFinite(Number(entry.portfolioValue)) ? Number(entry.portfolioValue) : null,
        pnl: Number.isFinite(Number(entry.pnl)) ? Number(entry.pnl) : null,
        notionalVolume: Number(entry.notionalVolume || 0),
        tradeCount: Number(entry.tradeCount || 0)
      }))
      .filter((entry) => Number.isFinite(entry.timestamp))
      .sort((a, b) => (a.timestamp as number) - (b.timestamp as number))
      .map((entry) => ({
        label: new Date(entry.timestamp as number).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        portfolioValue: entry.portfolioValue,
        pnl: entry.pnl,
        notionalVolume: entry.notionalVolume,
        tradeCount: entry.tradeCount
      }));
  }, [history]);

  const portfolioSeriesAvailable = historyCurve.some((entry) => typeof entry.portfolioValue === 'number');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-8 sm:px-6">
        <GlassPanel className="rounded-2xl border border-slate-800/80 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Trader Profile</p>
              <h1 className="mt-1 truncate text-2xl font-semibold text-white">{profile?.displayName || 'Trader'}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                <span className="font-mono text-slate-300">{address}</span>
                {typeof profile?.rank === 'number' && <span>Rank #{profile.rank}</span>}
                {typeof profile?.roi === 'number' && <span>ROI {formatPercent(profile.roi)}</span>}
                {profile?.polymarketUrl && (
                  <a href={profile.polymarketUrl} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:underline">
                    Polymarket Profile
                  </a>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/" className="rounded-full border border-slate-700 px-3 py-1.5 text-xs font-semibold hover:border-slate-500">
                Dashboard
              </Link>
              <Link
                to="/leaderboard"
                className="rounded-full border border-slate-700 px-3 py-1.5 text-xs font-semibold hover:border-slate-500"
              >
                Leaderboard
              </Link>
            </div>
          </div>
        </GlassPanel>

        <GlassPanel className="rounded-2xl border border-slate-800/80 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {[
              { key: 'today', label: 'Today' },
              { key: 'weekly', label: 'This Week' },
              { key: 'monthly', label: 'This Month' },
              { key: 'all', label: 'All Time' }
            ].map((option) => {
              const active = period === option.key;
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setPeriod(option.key as typeof period)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                    active ? 'bg-blue-600 text-white' : 'border border-slate-700 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setRefreshTick((current) => current + 1)}
              className="ml-auto rounded-full border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-slate-500"
            >
              Refresh Data
            </button>
          </div>
        </GlassPanel>

        {loading && (
          <GlassPanel className="rounded-2xl border border-slate-800/80 p-4">
            <PolymarketLoading compact label="Loading PolyCopy Profile Data" />
          </GlassPanel>
        )}
        {error && <GlassPanel className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</GlassPanel>}

        {!loading && !error && (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3 xl:col-span-2">
                <p className="text-[11px] uppercase text-slate-500">PnL (Profile)</p>
                <p className={`mt-1 text-lg font-semibold ${(displayedPnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {formatCompactUsd(displayedPnl)}
                </p>
              </GlassPanel>
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3 xl:col-span-2">
                <p className="text-[11px] uppercase text-slate-500">Portfolio Value (Live)</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{formatCompactUsd(overview?.portfolio?.portfolioValue)}</p>
              </GlassPanel>
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3">
                <p className="text-[11px] uppercase text-slate-500">Trades (Profile)</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{typeof profile?.trades === 'number' ? profile.trades.toLocaleString() : '—'}</p>
              </GlassPanel>
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3">
                <p className="text-[11px] uppercase text-slate-500">Volume (Profile)</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{formatCompactUsd(profile?.volume)}</p>
              </GlassPanel>
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3">
                <p className="text-[11px] uppercase text-slate-500">ROI (Profile)</p>
                <p className="mt-1 text-lg font-semibold text-slate-100">{formatPercent(profile?.roi)}</p>
              </GlassPanel>
              <GlassPanel className="rounded-xl border border-slate-800/80 p-3">
                <p className="text-[11px] uppercase text-slate-500">Net Cashflow</p>
                <p className={`mt-1 text-lg font-semibold ${(overview?.pnl?.cashflowProxy || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                  {formatCompactUsd(overview?.pnl?.cashflowProxy)}
                </p>
              </GlassPanel>
            </section>

            <GlassPanel className="rounded-2xl border border-slate-800/80 p-3">
              <div className="flex flex-wrap gap-2 text-xs text-slate-400">
                <span className="rounded-full border border-slate-700 px-2 py-1">Position Value: {formatUsd(overview?.portfolio?.positionsValue, 0)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">Position Cost: {formatUsd(overview?.portfolio?.positionsInitialValue, 0)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">Position Cash PnL: {formatUsd(overview?.portfolio?.positionsCashPnl, 0)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">24h Portfolio: {formatUsd(history?.deltas?.portfolioValue24h, 0)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">7d Portfolio: {formatUsd(history?.deltas?.portfolioValue7d, 0)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">24h PnL: {formatUsd(history?.deltas?.pnl24h)}</span>
                <span className="rounded-full border border-slate-700 px-2 py-1">7d PnL: {formatUsd(history?.deltas?.pnl7d)}</span>
              </div>
            </GlassPanel>

            <section className="grid gap-4 lg:grid-cols-2">
              <GlassPanel className="rounded-2xl border border-slate-800/80 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-base font-semibold text-white">Portfolio Tracker</h2>
                  <span className="text-xs text-slate-500">Snapshot-based</span>
                </div>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={historyCurve}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                      <XAxis dataKey="label" minTickGap={24} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} />
                      <Tooltip contentStyle={{ backgroundColor: '#020617', border: '1px solid #334155' }} />
                      <Legend />
                      {portfolioSeriesAvailable && (
                        <Line type="monotone" dataKey="portfolioValue" stroke="#60a5fa" strokeWidth={2.4} dot={false} name="Portfolio value" />
                      )}
                      <Line type="monotone" dataKey="pnl" stroke="#22c55e" strokeWidth={2} dot={false} name="PnL" />
                      <Line type="monotone" dataKey="notionalVolume" stroke="#f59e0b" strokeWidth={2} dot={false} name="Notional" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </GlassPanel>

              <GlassPanel className="rounded-2xl border border-slate-800/80 p-4">
                <h2 className="text-base font-semibold text-white">Positions</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-left text-slate-400">
                        <th className="px-2 py-2">Market</th>
                        <th className="px-2 py-2">Side</th>
                        <th className="px-2 py-2 text-right">Size</th>
                        <th className="px-2 py-2 text-right">Current</th>
                        <th className="px-2 py-2 text-right">Cash PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(overview?.positions?.positions || []).length === 0 && (
                        <tr>
                          <td className="px-2 py-3 text-slate-500" colSpan={5}>
                            No positions returned by source.
                          </td>
                        </tr>
                      )}
                      {(overview?.positions?.positions || []).slice(0, 40).map((row, index) => (
                        <tr key={`${row.market}-${index}`} className="border-t border-slate-800/70">
                          <td className="px-2 py-2 text-slate-200">{row.market}</td>
                          <td className="px-2 py-2 text-slate-300 uppercase">{row.side || '—'}</td>
                          <td className="px-2 py-2 text-right text-slate-300">{Number(row.size || 0).toFixed(4)}</td>
                          <td className="px-2 py-2 text-right text-slate-300">{formatUsd(row.currentValue, 2)}</td>
                          <td className={`px-2 py-2 text-right ${Number(row.cashPnl || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
                            {formatUsd(row.cashPnl, 2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassPanel>
            </section>

            <GlassPanel className="rounded-2xl border border-slate-800/80 p-4">
              <h2 className="text-base font-semibold text-white">Recent Trades</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th className="px-2 py-2">Time</th>
                      <th className="px-2 py-2">Market</th>
                      <th className="px-2 py-2">Side</th>
                      <th className="px-2 py-2 text-right">Size</th>
                      <th className="px-2 py-2 text-right">Price</th>
                      <th className="px-2 py-2 text-right">Notional</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 && (
                      <tr>
                        <td className="px-2 py-3 text-slate-500" colSpan={6}>
                          No trade fills returned for this period.
                        </td>
                      </tr>
                    )}
                    {trades.slice(0, 120).map((trade, index) => {
                      const ts = getTradeTimestamp(trade);
                      const side = extractTradeSide(trade);
                      const size = Math.abs(extractTradeSize(trade));
                      const price = extractTradePrice(trade);
                      const notional = Math.abs(size * price);
                      return (
                        <tr key={`${ts || 't'}-${index}`} className="border-t border-slate-800/70">
                          <td className="px-2 py-2 text-slate-300">{ts ? new Date(ts).toLocaleString() : '—'}</td>
                          <td className="px-2 py-2 text-slate-200">{extractTradeMarket(trade)}</td>
                          <td
                            className={`px-2 py-2 font-medium ${
                              side === 'buy' ? 'text-emerald-300' : side === 'sell' ? 'text-rose-300' : 'text-slate-300'
                            }`}
                          >
                            {side.toUpperCase()}
                          </td>
                          <td className="px-2 py-2 text-right text-slate-300">{size.toFixed(4)}</td>
                          <td className="px-2 py-2 text-right text-slate-300">{price.toFixed(4)}</td>
                          <td className="px-2 py-2 text-right text-slate-300">{formatUsd(notional, 2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </GlassPanel>
          </>
        )}
      </div>
    </div>
  );
}
