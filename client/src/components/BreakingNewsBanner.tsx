
import { useState, useEffect, useRef } from 'react';

const API_BASE = (import.meta as any).env ? (import.meta as any).env.VITE_API_BASE_URL || '/api' : '/api';

interface HeadlineItem {
  text: string;
  url: string;
  chance: number | null;
  logoUrl?: string | null;
  updatedAt?: string | null;
}

function parseChanceFromMarket(market: any): number | null {
  const directCandidates = [
    market?.probability,
    market?.chance,
    market?.prob,
    market?.lastTradePrice,
    market?.last_price
  ];

  for (const value of directCandidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const normalized = numeric > 1 ? numeric : numeric * 100;
      if (normalized >= 0 && normalized <= 100) {
        return Math.round(normalized);
      }
    }
  }

  const outcomeCandidates = [market?.outcomePrices, market?.prices, market?.outcomes];
  for (const candidate of outcomeCandidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    const first = Number(candidate[0]);
    if (Number.isFinite(first)) {
      const normalized = first > 1 ? first : first * 100;
      if (normalized >= 0 && normalized <= 100) {
        return Math.round(normalized);
      }
    }
  }

  return null;
}

function parseTimestampMillis(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const asNumber = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

export default function BreakingNewsBanner() {
  const tickerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const contentWidthRef = useRef(0);
  const pausedRef = useRef(false);
  const lastFrameTimeRef = useRef<number | null>(null);
  const [headlines, setHeadlines] = useState<HeadlineItem[]>([]);
  const [isPaused, setIsPaused] = useState(false);
  const lastPayloadRef = useRef('');

  // Fetch live markets on an interval without rotating content windows
  // so the marquee remains visually stable.
  useEffect(() => {
    let cancelled = false;
    async function fetchMarkets() {
      try {
        const res = await fetch(`${API_BASE}/breaking-news?limit=18`);
        const data = await res.json();
        if (!Array.isArray(data.stories)) return;

        // De-duplicate + limit repeats from the same event.
        const uniqueByQuestion = new Map<string, any>();
        const eventCounts = new Map<string, number>();
        for (const market of data.stories) {
          const question = String(market?.title || market?.question || '').trim();
          if (!question) continue;

          const eventKey = String(market?.eventSlug || market?.eventTitle || '').trim().toLowerCase();
          if (eventKey) {
            const eventCount = eventCounts.get(eventKey) || 0;
            if (eventCount >= 2) continue;
            eventCounts.set(eventKey, eventCount + 1);
          }

          const key = question.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s%$]/g, '');
          if (!uniqueByQuestion.has(key)) {
            uniqueByQuestion.set(key, market);
          }
        }

        const uniqueMarkets = Array.from(uniqueByQuestion.values()).sort((a, b) => {
          const aTs = parseTimestampMillis(a?.updatedAt || a?.publishedAt);
          const bTs = parseTimestampMillis(b?.updatedAt || b?.publishedAt);
          if (aTs !== null || bTs !== null) {
            if (aTs === null) return 1;
            if (bTs === null) return -1;
            if (bTs !== aTs) return bTs - aTs;
          }
          return Number(b?.volume24h || 0) - Number(a?.volume24h || 0);
        });

        const chunkSize = 16;
        const selected = uniqueMarkets.slice(0, chunkSize);

        const formatted = selected.map((m: any) => {
          const chance = parseChanceFromMarket(m) ?? (Number.isFinite(Number(m?.chance)) ? Number(m.chance) : null);
          const resolvedUrl =
            typeof m?.url === 'string' && /^https?:\/\//.test(m.url)
              ? m.url
              : m?.eventSlug
              ? `https://polymarket.com/event/${m.eventSlug}`
              : m?.slug
              ? `https://polymarket.com/event/${m.slug}`
              : `https://polymarket.com/market/${m.id}`;

          return {
            text: String(m.title || m.question || 'Polymarket market'),
            url: resolvedUrl,
            chance,
            updatedAt: typeof m?.updatedAt === 'string' ? m.updatedAt : typeof m?.publishedAt === 'string' ? m.publishedAt : null,
            logoUrl:
              (typeof m?.logoUrl === 'string' && /^https?:\/\//.test(m.logoUrl) && m.logoUrl) ||
              (typeof m?.eventImage === 'string' && /^https?:\/\//.test(m.eventImage) && m.eventImage) ||
              (typeof m?.image === 'string' && /^https?:\/\//.test(m.image) && m.image) ||
              '/polycopy-logo3.png'
          };
        });
        if (!cancelled) {
          const serialized = JSON.stringify(formatted);
          if (serialized !== lastPayloadRef.current) {
            lastPayloadRef.current = serialized;
            setHeadlines(formatted);
          }
        }
      } catch {}
    }
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Measure one full content cycle width (we render the list twice).
  useEffect(() => {
    pausedRef.current = isPaused;
  }, [isPaused]);

  // Measure one full content cycle width (we render the list twice).
  useEffect(() => {
    const ticker = tickerRef.current;
    if (!ticker) return;
    const measure = () => {
      contentWidthRef.current = ticker.scrollWidth / 2;
      const loopWidth = contentWidthRef.current;
      if (loopWidth > 0) {
        const normalized = ((offsetRef.current % loopWidth) + loopWidth) % loopWidth;
        offsetRef.current = -normalized;
        ticker.style.transform = `translateX(${offsetRef.current}px)`;
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [headlines]);

  // Animate ticker with seamless looping + true hover pause.
  useEffect(() => {
    const ticker = tickerRef.current;
    if (!ticker) return;
    let animationId: number;
    const speedPxPerSecond = 34;

    function animate(time: number) {
      if (!ticker) return;
      if (lastFrameTimeRef.current === null) {
        lastFrameTimeRef.current = time;
      }
      const deltaMs = Math.min(64, time - lastFrameTimeRef.current);
      lastFrameTimeRef.current = time;

      if (!pausedRef.current) {
        offsetRef.current -= (speedPxPerSecond * deltaMs) / 1000;
        const loopWidth = contentWidthRef.current;
        if (loopWidth > 0 && Math.abs(offsetRef.current) >= loopWidth) {
          offsetRef.current += loopWidth;
        }
        ticker.style.transform = `translateX(${offsetRef.current}px)`;
      }
      animationId = requestAnimationFrame(animate);
    }

    animationId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationId);
      lastFrameTimeRef.current = null;
    };
  }, []);

  return (
    <div
      className="w-full bg-gradient-to-r from-blue-600 via-blue-500 to-blue-400 text-white py-2 px-4 overflow-hidden relative flex items-center border-b border-blue-400/40"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <span className="mr-2 inline-block h-2 w-2 rounded-full bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.7)]" />
      <span className="font-bold uppercase tracking-widest mr-4">Breaking News</span>
      <div className="flex-1 overflow-hidden">
        <div ref={tickerRef} className="whitespace-nowrap flex gap-8 text-sm font-medium" style={{ willChange: 'transform' }}>
          {headlines.length === 0 ? (
            <span className="opacity-70">Loading markets…</span>
          ) : (
            [...headlines, ...headlines].map((h, i) => (
              <a
                key={`${h.url}-${i}`}
                href={h.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 hover:underline hover:text-yellow-200 transition-colors"
              >
                {h.logoUrl && (
                  <img
                    src={h.logoUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-6 w-6 rounded-full object-cover border border-white/25"
                  />
                )}
                <span className="text-white">LIVE</span>
                <span>{h.text}</span>
                <span className={`font-semibold ${h.chance !== null && h.chance >= 50 ? 'text-emerald-200' : 'text-rose-200'}`}>
                  {h.chance === null ? 'N/A chance' : `${Math.round(h.chance)}% chance`}
                </span>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
