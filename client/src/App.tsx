import { useCallback, useEffect, useMemo, useState } from 'react';
import { HashRouter as Router, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Leaderboard, type LeaderboardEntry } from './components/Leaderboard';
import BreakingNewsBanner from './components/BreakingNewsBanner';
import { TraderDashboard } from './components/TraderDashboard';
import { TraderSearch } from './components/TraderSearch';
import MetallicLogo from './components/MetallicLogo';
import Beams from './components/effects/Beams';
import GlassPanel from './components/effects/GlassPanel';
import PolymarketLoading from './components/PolymarketLoading';
import { useSession } from './hooks/useSession';
import { useTraderSearch } from './hooks/useTraderSearch';
import { useWalletConnection } from './hooks/useWalletConnection';
import TraderProfile from './pages/TraderProfile';
import MetallicLogoPreviewPage from './pages/MetallicLogoPreviewPage';
import AnalyticsDashboard from './pages/AnalyticsDashboard';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const OVERVIEW_PREFETCH_TTL_MS = 1000 * 60 * 3;
const overviewPrefetchCache = new Map<
  string,
  { expiresAt: number; promise: Promise<any> | null; data: any | null }
>();

function getOverviewCacheKey(address: string, period = 'all') {
  return `trader_overview_${address.toLowerCase()}_${period}`;
}

function persistOverview(address: string, payload: any) {
  const key = getOverviewCacheKey(address, 'all');
  const now = Date.now();
  overviewPrefetchCache.set(address.toLowerCase(), {
    expiresAt: now + OVERVIEW_PREFETCH_TTL_MS,
    promise: null,
    data: payload
  });
  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(key, JSON.stringify({ savedAt: now, payload }));
    } catch {}
  }
}

function prefetchTraderOverview(address: string) {
  const normalized = String(address || '').trim().toLowerCase();
  if (!normalized) return;
  const now = Date.now();
  const cached = overviewPrefetchCache.get(normalized);
  if (cached && cached.expiresAt > now) return;

  const promise = fetch(`${API_BASE}/users/${normalized}/overview?period=all&limit=250`, { credentials: 'include' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`overview ${res.status}`))))
    .then((payload) => {
      persistOverview(normalized, payload);
      return payload;
    })
    .catch(() => null)
    .finally(() => {
      const current = overviewPrefetchCache.get(normalized);
      if (current && current.promise) {
        overviewPrefetchCache.set(normalized, { ...current, promise: null });
      }
    });

  overviewPrefetchCache.set(normalized, {
    expiresAt: now + OVERVIEW_PREFETCH_TTL_MS,
    promise,
    data: cached?.data || null
  });
}

function shortAddress(address: string | null) {
  if (!address) return 'Not connected';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getUserInitials(name: string | null | undefined) {
  if (!name) return null;
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
}

function useLeaderboardData() {
  const [leaderboardPeriods, setLeaderboardPeriods] = useState<Record<string, LeaderboardEntry[]>>({});
  const [leaderboardLabels, setLeaderboardLabels] = useState<Record<string, string>>({});
  const [activeLeaderboardPeriod, setActiveLeaderboardPeriod] = useState<string>('weekly');
  const [isLeaderboardLoading, setIsLeaderboardLoading] = useState(true);
  const [leaderboardError, setLeaderboardError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    let intervalId: number | null = null;
    let inFlightController: AbortController | null = null;

    const load = async (force = false, initial = false) => {
      if (!isActive) return;
      if (initial) {
        setIsLeaderboardLoading(true);
      }
      setLeaderboardError(null);
      inFlightController?.abort();
      const controller = new AbortController();
      inFlightController = controller;
      try {
        const endpoint = `${API_BASE}/leaderboard${force ? '?refresh=1' : ''}`;
        const res = await fetch(endpoint, { signal: controller.signal, credentials: 'include' });
        if (!res.ok) {
          throw new Error(`Failed to load leaderboard (${res.status})`);
        }
        const data = await res.json();
        if (!isActive) return;

        const rawPeriods = data?.periods && typeof data.periods === 'object' ? data.periods : {};
        const rawLabels = data?.labels && typeof data.labels === 'object' ? data.labels : {};

        const nextPeriods = Object.entries(rawPeriods).reduce<Record<string, LeaderboardEntry[]>>((acc, [key, value]) => {
          if (!Array.isArray(value)) return acc;
          const filtered = value
            .filter((entry) => entry && typeof entry.address === 'string')
            .map((entry, index) => ({
              ...entry,
              rank: Number.isFinite(Number(entry.rank)) ? Number(entry.rank) : index + 1,
              address: entry.address.toLowerCase()
            }));
          if (filtered.length > 0) {
            acc[key] = filtered;
          }
          return acc;
        }, {});

        const availableKeys = Object.keys(nextPeriods);
        const preferred =
          (typeof data?.defaultPeriod === 'string' && availableKeys.includes(data.defaultPeriod) && data.defaultPeriod) ||
          (availableKeys.includes('weekly') && 'weekly') ||
          availableKeys[0] ||
          'weekly';

        setLeaderboardPeriods(nextPeriods);
        setLeaderboardLabels(
          availableKeys.reduce<Record<string, string>>((acc, key) => {
            acc[key] = rawLabels[key] || key;
            return acc;
          }, {})
        );
        setActiveLeaderboardPeriod((current) => (availableKeys.includes(current) ? current : preferred));
      } catch (err) {
        if (!isActive) return;
        setLeaderboardPeriods({});
        setLeaderboardLabels({});
        setLeaderboardError(err instanceof Error ? err.message : 'Failed to load leaderboard');
      } finally {
        if (isActive) {
          setIsLeaderboardLoading(false);
        }
      }
    };

    void load(false, true);
    intervalId = window.setInterval(() => {
      void load(true, false);
    }, 60_000);

    return () => {
      isActive = false;
      inFlightController?.abort();
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  const periodOptions = useMemo(() => {
    return Object.keys(leaderboardPeriods).map((key) => ({ key, label: leaderboardLabels[key] || key }));
  }, [leaderboardPeriods, leaderboardLabels]);

  const activeEntries = leaderboardPeriods[activeLeaderboardPeriod] || [];

  return {
    activeEntries,
    periodOptions,
    selectedPeriod: activeLeaderboardPeriod,
    onPeriodChange: setActiveLeaderboardPeriod,
    isLoading: isLeaderboardLoading,
    error: leaderboardError
  };
}

interface TopNavProps {
  currentPath: '/' | '/leaderboard';
  advancedGlass?: boolean;
  user: ReturnType<typeof useSession>['user'];
  isSessionLoading: boolean;
  isSessionActionPending: boolean;
  login: () => void;
  logout: () => Promise<void>;
  connectedWallet: string | null;
  walletChainId: string | null;
  isWalletConnecting: boolean;
  isWalletConnected: boolean;
  walletProviderAvailable: boolean;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
}

function TopNav({
  currentPath,
  advancedGlass = false,
  user,
  isSessionLoading,
  isSessionActionPending,
  login,
  logout,
  connectedWallet,
  walletChainId,
  isWalletConnecting,
  isWalletConnected,
  walletProviderAvailable,
  connectWallet,
  disconnectWallet
}: TopNavProps) {
  const initials = getUserInitials(user?.name);

  const handleSessionClick = useCallback(() => {
    if (user) {
      void logout();
    } else {
      login();
    }
  }, [user, logout, login]);

  const handleWalletClick = useCallback(() => {
    if (!walletProviderAvailable) return;
    if (isWalletConnected) {
      disconnectWallet();
    } else {
      void connectWallet();
    }
  }, [walletProviderAvailable, isWalletConnected, disconnectWallet, connectWallet]);

  return (
    <GlassPanel advanced={advancedGlass} className="px-3 py-3 sm:px-6 sm:py-4">
      <header className="flex flex-col gap-3 sm:gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center justify-between gap-3 sm:gap-8">
          <Link to="/" className="flex items-center gap-3">
            <MetallicLogo size={36} animated />
            <div>
              <p className="text-sm font-semibold tracking-wide text-white">PolyCopy</p>
              <p className="hidden text-xs text-slate-400 sm:block">Built for Polymarket</p>
            </div>
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-slate-300">
            <Link
              to="/"
              className={`transition ${currentPath === '/' ? 'text-white' : 'hover:text-white text-slate-300'}`}
            >
              Home
            </Link>
            <Link
              to="/leaderboard"
              className={`transition ${currentPath === '/leaderboard' ? 'text-white' : 'hover:text-white text-slate-300'}`}
            >
              Leaderboard
            </Link>
            <Link
              to="/analytics"
              className={`transition ${currentPath === '/analytics' ? 'text-white' : 'hover:text-white text-slate-300'}`}
            >
              Analytics
            </Link>
          </nav>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-3">
          <button
            type="button"
            onClick={handleSessionClick}
            disabled={(Boolean(user) && (isSessionLoading || isSessionActionPending)) || isSessionActionPending}
            className="w-full rounded-full border border-slate-700/80 bg-slate-900/80 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-slate-500 disabled:opacity-60 sm:w-auto"
          >
            {isSessionLoading ? (
              'Loading...'
            ) : user ? (
              <span className="inline-flex items-center gap-2">
                {initials && (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-slate-800/80 text-xs font-semibold">
                    {initials}
                  </span>
                )}
                <span>Sign out</span>
              </span>
            ) : (
              'Sign in'
            )}
          </button>
          <button
            type="button"
            onClick={handleWalletClick}
            disabled={isWalletConnecting || !walletProviderAvailable}
            className="w-full rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:opacity-60 sm:w-auto"
          >
            {isWalletConnecting ? 'Connecting...' : isWalletConnected ? shortAddress(connectedWallet) : 'Connect Wallet'}
          </button>
          {isWalletConnected && walletChainId && <span className="text-center text-xs text-slate-400 sm:text-left">Chain {walletChainId}</span>}
        </div>
      </header>
    </GlassPanel>
  );
}

function HomePage() {
  const [inputAddress, setInputAddress] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [isResolvingTrader, setIsResolvingTrader] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const {
    user,
    isLoading: isSessionLoading,
    isActionPending: isSessionActionPending,
    error: sessionError,
    login,
    logout
  } = useSession();

  const {
    address: connectedWallet,
    chainId: walletChainId,
    isConnecting: isWalletConnecting,
    isConnected: isWalletConnected,
    providerAvailable: walletProviderAvailable,
    error: walletError,
    connect: connectWallet,
    disconnect: disconnectWallet
  } = useWalletConnection();

  const { suggestions, isLoading: isSearchingTraders, error: traderSearchError } = useTraderSearch(inputAddress, {
    minimumLength: 2,
    debounceMs: 140,
    limit: 12
  });

  const applySelectedAddress = useCallback((address: string) => {
    const sanitized = address.trim().toLowerCase();
    setSelectedAddress(sanitized || null);
  }, []);

  const resolveAndSelectTrader = useCallback(
    async (rawValue: string) => {
      const trimmed = rawValue.trim();
      if (!trimmed) {
        setResolveError('Enter a wallet address or username.');
        return;
      }

      setResolveError(null);
      setIsResolvingTrader(true);
      try {
        if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
          const normalized = trimmed.toLowerCase();
          setInputAddress(normalized);
          applySelectedAddress(normalized);
          return;
        }

        const normalizedQuery = trimmed.toLowerCase().replace(/^@+/, '');
        const localMatch = suggestions.find((entry) => {
          const candidates = [
            entry.address,
            entry.username ? `@${entry.username}` : null,
            entry.username || null,
            entry.pseudonym || null,
            entry.displayName || null
          ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase().replace(/^@+/, ''));
          return candidates.includes(normalizedQuery);
        });

        if (localMatch?.address) {
          const normalized = localMatch.address.toLowerCase();
          setInputAddress(normalized);
          applySelectedAddress(normalized);
          return;
        }

        const params = new URLSearchParams({ query: trimmed });
        const res = await fetch(`${API_BASE}/trader-resolve?${params.toString()}`, {
          credentials: 'include'
        });

        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.error || `Unable to resolve trader (${res.status})`);
        }

        const payload = await res.json();
        const resolvedAddress = String(payload?.address || '').toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(resolvedAddress)) {
          throw new Error('Resolved trader address is invalid.');
        }

        setInputAddress(resolvedAddress);
        applySelectedAddress(resolvedAddress);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to resolve trader.';
        setResolveError(message);
      } finally {
        setIsResolvingTrader(false);
      }
    },
    [applySelectedAddress, suggestions]
  );

  const combinedTopError = sessionError || walletError;

  return (
    <div className="min-h-screen bg-[#040712] text-slate-100">
      <div className="pointer-events-none fixed inset-0 z-0 opacity-70">
        <Beams
          beamWidth={1.8}
          beamHeight={22}
          beamNumber={30}
          noiseIntensity={0.14}
          scale={0.24}
          rotation={36}
          speed={1.1}
          lightColor="#7ec7ff"
        />
      </div>
      {/* Removed or reduced radial gradient overlay to minimize fill behind navbar */}
      <div className="relative z-10 mx-auto max-w-7xl px-3 pb-16 pt-4 space-y-10 sm:px-6 sm:pb-20 sm:pt-8 sm:space-y-14">
        <div className="sticky top-0 z-30 flex flex-col gap-2 rounded-[22px] bg-transparent transition-all duration-300">
          <TopNav
            currentPath="/"
            advancedGlass
            user={user}
            isSessionLoading={isSessionLoading}
            isSessionActionPending={isSessionActionPending}
            login={login}
            logout={logout}
            connectedWallet={connectedWallet}
            walletChainId={walletChainId}
            isWalletConnecting={isWalletConnecting}
            isWalletConnected={isWalletConnected}
            walletProviderAvailable={walletProviderAvailable}
            connectWallet={connectWallet}
            disconnectWallet={disconnectWallet}
          />
          <div className="overflow-hidden rounded-[22px] border border-white/15 bg-transparent backdrop-blur-md">
            <BreakingNewsBanner />
          </div>
        </div>

        <section className="text-center space-y-4 sm:space-y-5 reveal">

          <div className="flex flex-col items-center justify-center gap-4 sm:gap-6 md:flex-row">
            <MetallicLogo size={420} animated />
            <h1 className="max-w-4xl text-xl font-semibold leading-tight text-white sm:text-3xl md:text-4xl">
              Discover top traders and track your own portfolio with confidence
            </h1>
          </div>
          <p className="mx-auto max-w-2xl px-2 text-sm text-slate-300 sm:px-0 sm:text-lg">
            Track your own portfolio and analyze other traders before deciding who to follow.
          </p>
          <div className="grid w-full max-w-sm grid-cols-1 gap-2 sm:flex sm:max-w-none sm:justify-center sm:gap-3">
            <Link to="/leaderboard" className="rounded-full bg-blue-600 px-6 py-3 text-sm font-semibold text-white transition hover:bg-blue-500">
              View Top Traders
            </Link>
            <a href="#search" className="rounded-full border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-100 transition hover:border-slate-400">
              Search Traders
            </a>
          </div>
        </section>

        {combinedTopError && (
          <GlassPanel className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {combinedTopError}
          </GlassPanel>
        )}
        {resolveError && (
          <GlassPanel className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            {resolveError}
          </GlassPanel>
        )}

        <section className="grid gap-4 lg:grid-cols-3 lg:gap-5">
          <GlassPanel className="rounded-3xl p-5 sm:p-6 reveal reveal-1">
            <article>
            <p className="text-xs uppercase tracking-wide text-blue-200">Leaderboard</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">Follow the most successful traders</h2>
            <p className="mt-3 text-sm text-slate-300">Open the leaderboard to compare PnL, ROI, and volume at a glance.</p>
            <Link to="/leaderboard" className="mt-5 inline-flex rounded-full bg-white px-5 py-2 text-sm font-semibold text-slate-900">
              Open Leaderboard
            </Link>
            </article>
          </GlassPanel>

          <GlassPanel className="rounded-3xl p-5 sm:p-6 reveal reveal-2">
            <article id="search">
            <p className="text-xs uppercase tracking-wide text-blue-200">Search Traders</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">Analyze any wallet</h2>
            <p className="mt-3 text-sm text-slate-300">Search by wallet or username and inspect the trader profile instantly.</p>
            <div className="mt-5">
              <TraderSearch
                value={inputAddress}
                onChange={setInputAddress}
                onSubmit={(nextValue) => {
                  void resolveAndSelectTrader(nextValue);
                }}
                suggestions={suggestions}
                isSearching={isSearchingTraders || isResolvingTrader}
                searchError={traderSearchError}
                selectedAddress={selectedAddress}
              />
            </div>
            </article>
          </GlassPanel>

          <GlassPanel className="rounded-3xl p-5 sm:p-6 reveal reveal-3">
            <article>
            <p className="text-xs uppercase tracking-wide text-blue-200">Portfolio View</p>
            <h2 className="mt-3 text-2xl font-semibold text-white">Track your own edge</h2>
            <p className="mt-3 text-sm text-slate-300">Compare your process with top traders and refine your strategy over time.</p>
            <GlassPanel className="mt-5 rounded-2xl p-4">
              <p className="text-xs uppercase text-slate-400">Selected trader</p>
              <p className="mt-1 font-mono text-sm text-slate-100 break-all">{selectedAddress || 'No trader selected yet'}</p>
              {selectedAddress && (
                <Link
                  to={`/profile/${selectedAddress}`}
                  className="mt-3 inline-flex rounded-full border border-blue-400/50 px-4 py-2 text-xs font-semibold text-blue-200"
                >
                  View trader profile
                </Link>
              )}
            </GlassPanel>
            </article>
          </GlassPanel>
        </section>

        {selectedAddress && <TraderDashboard address={selectedAddress} />}
      </div>
    </div>
  );
}

function LeaderboardPage() {
  const navigate = useNavigate();
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const {
    user,
    isLoading: isSessionLoading,
    isActionPending: isSessionActionPending,
    error: sessionError,
    login,
    logout
  } = useSession();

  const {
    address: connectedWallet,
    chainId: walletChainId,
    isConnecting: isWalletConnecting,
    isConnected: isWalletConnected,
    providerAvailable: walletProviderAvailable,
    error: walletError,
    connect: connectWallet,
    disconnect: disconnectWallet,
    resetError: resetWalletError
  } = useWalletConnection();

  const { activeEntries, periodOptions, selectedPeriod, onPeriodChange, isLoading, error } = useLeaderboardData();
  const handlePrefetch = useCallback((address: string) => {
    prefetchTraderOverview(address);
  }, []);

  return (
    <div className="min-h-screen bg-[#040712] text-slate-100">
      <div className="pointer-events-none fixed inset-0 z-0 opacity-70">
        <Beams
          beamWidth={1.8}
          beamHeight={22}
          beamNumber={30}
          noiseIntensity={0.14}
          scale={0.24}
          rotation={36}
          speed={1.1}
          lightColor="#7ec7ff"
        />
      </div>
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top,rgba(49,114,255,0.22),transparent_52%)]" />
      <div className="relative z-10 mx-auto max-w-7xl px-3 pb-16 pt-4 space-y-8 sm:px-6 sm:pb-20 sm:pt-8 sm:space-y-10">
        <div className="sticky top-0 z-30 flex flex-col gap-2 rounded-[22px] bg-transparent transition-all duration-300">
          <TopNav
            currentPath="/leaderboard"
            advancedGlass
            user={user}
            isSessionLoading={isSessionLoading}
            isSessionActionPending={isSessionActionPending}
            login={login}
            logout={logout}
            connectedWallet={connectedWallet}
            walletChainId={walletChainId}
            isWalletConnecting={isWalletConnecting}
            isWalletConnected={isWalletConnected}
            walletProviderAvailable={walletProviderAvailable}
            connectWallet={connectWallet}
            disconnectWallet={disconnectWallet}
          />
          <div className="overflow-hidden rounded-[22px] border border-white/15 bg-transparent backdrop-blur-md">
            <BreakingNewsBanner />
          </div>
        </div>

        {(sessionError || walletError) && (
          <GlassPanel className="flex items-start justify-between gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
            <p>{sessionError || walletError}</p>
            {walletError && (
              <button
                type="button"
                onClick={resetWalletError}
                className="rounded-full border border-rose-400/50 px-3 py-1 text-xs font-semibold text-rose-50 transition hover:border-rose-200"
              >
                Dismiss
              </button>
            )}
          </GlassPanel>
        )}

        {/* Removed duplicate heading for clarity */}

        <Leaderboard
          entries={activeEntries}
          isLoading={isLoading}
          error={error}
          selectedAddress={selectedAddress}
          periodOptions={periodOptions}
          selectedPeriod={selectedPeriod}
          onPeriodChange={(next) => {
            if (periodOptions.some((option) => option.key === next)) {
              onPeriodChange(next);
            }
          }}
          onSelect={(address, entry) => {
            setSelectedAddress(address);
            navigate(`/profile/${address}`, {
              state: {
                leaderboardEntry: entry || null
              }
            });
          }}
          onPrefetch={(address) => handlePrefetch(address)}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [showInitialLoader, setShowInitialLoader] = useState(true);
  const [fadeOutLoader, setFadeOutLoader] = useState(false);

  useEffect(() => {
    const splashDurationMs = 2600; // one full animation cycle
    const fadeDurationMs = 700;
    const fadeTimer = window.setTimeout(() => {
      setFadeOutLoader(true);
    }, splashDurationMs);
    const hideTimer = window.setTimeout(() => {
      setShowInitialLoader(false);
    }, splashDurationMs + fadeDurationMs);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return (
    <>
      {showInitialLoader && <PolymarketLoading fullscreen fadeOut={fadeOutLoader} />}
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="/analytics" element={<AnalyticsDashboard />} />
          <Route path="/profile/:address" element={<TraderProfile />} />
          <Route path="/logo-preview" element={<MetallicLogoPreviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </>
  );
}
