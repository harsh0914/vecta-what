import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ExternalLink,
  ArrowRight,
  RefreshCw,
  Store,
  Utensils,
  BookOpen,
  Layers,
  Edit3,
  Clock,
  Play,
  Check,
  Search,
  Filter,
} from 'lucide-react';

interface FactCheckResult {
  availableTonight: boolean;
  correctPrice: boolean;
  meetsTheDiet: boolean;
  sideSuggested: boolean;
  sources: boolean;
}

interface CompareResult {
  store: 'Demo Spice Kitchen' | 'Vecta Demo Bistro';
  reply: string;
  seconds: number;
  fetched: string[];
  checks: FactCheckResult;
}

interface ReviewItem {
  item_id: string;
  name: string;
  price_cents: number;
  categories: string[];
  tags: string[];
  status: 'PENDING' | 'APPROVED' | 'EDITED';
  proposal?: any;
  approved?: any;
  pairings: Array<{
    item_id: string;
    role: string;
    reason: string;
    name: string;
    approved: boolean;
  }>;
  pairings_status: string;
}

interface MerchantOverview {
  merchantId: string;
  name: string;
  status: string;
  disconnectedReason?: string;
  lastSyncedAt?: number;
  stageCounts: Record<string, number>;
  reviewCounts: Record<string, number>;
  itemsWithPairings: number;
  jobCounts: Record<string, number>;
  recentRuns: any[];
  reviewUrl: string;
  reviewKey: string;
}

export default function App() {
  // Navigation: 'demo' | 'review' | 'admin' | 'health'
  const [currentTab, setCurrentTab] = useState<'demo' | 'review' | 'admin' | 'health'>('demo');

  // Compare Demo State
  const defaultPrompt = "I'm vegan, spend under $20, and don't like very spicy food. Using {site}, pick me a main course that's actually available tonight, and tell me what to order with it.";
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [comparing, setComparing] = useState(false);
  const [compareResults, setCompareResults] = useState<CompareResult[] | null>(null);

  // Review State
  const [merchantId, setMerchantId] = useState('');
  const [reviewKey, setReviewKey] = useState('');
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewFilter, setReviewFilter] = useState<'ALL' | 'PENDING' | 'APPROVED'>('ALL');
  const [editingItem, setEditingItem] = useState<ReviewItem | null>(null);
  const [editForm, setEditForm] = useState<any>({});
  const [bulkApproving, setBulkApproving] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // Admin State
  const [merchants, setMerchants] = useState<MerchantOverview[]>([]);
  const [loadingAdmin, setLoadingAdmin] = useState(false);

  // Health State
  const [healthData, setHealthData] = useState<any>(null);

  // Parse path & query on mount
  useEffect(() => {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const key = params.get('k') || params.get('key') || '';

    if (path.startsWith('/review')) {
      const parts = path.split('/').filter(Boolean);
      if (parts[1]) {
        setMerchantId(parts[1]);
      }
      if (key) {
        setReviewKey(key);
      }
      setCurrentTab('review');
    } else if (path === '/admin') {
      setCurrentTab('admin');
    } else if (path === '/health') {
      setCurrentTab('health');
    } else {
      setCurrentTab('demo');
    }
  }, []);

  // Fetch Review Items
  const fetchReviewItems = async (mid: string, key: string) => {
    if (!mid) return;
    setLoadingReview(true);
    try {
      const url = `/api/review/${mid}${key ? `?k=${key}` : ''}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setReviewItems(data.items || []);
      }
    } catch (err) {
      console.error('Failed to load review data:', err);
    } finally {
      setLoadingReview(false);
    }
  };

  // Fetch Admin Overview
  const fetchAdminOverview = async () => {
    setLoadingAdmin(true);
    try {
      const res = await fetch('/api/overview');
      if (res.ok) {
        const data = await res.json();
        setMerchants(data.merchants || []);
      }
    } catch (err) {
      console.error('Failed to load admin overview:', err);
    } finally {
      setLoadingAdmin(false);
    }
  };

  useEffect(() => {
    if (currentTab === 'review') {
      fetchAdminOverview();
      if (merchantId) {
        fetchReviewItems(merchantId, reviewKey);
      }
    } else if (currentTab === 'admin') {
      fetchAdminOverview();
    } else if (currentTab === 'health') {
      fetch('/healthz').then((r) => r.json()).then(setHealthData).catch(() => {});
    }
  }, [currentTab, merchantId, reviewKey]);

  // Handle Ask Both
  const handleAskBoth = async () => {
    setComparing(true);
    setCompareResults(null);
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      setCompareResults(data);
    } catch (err) {
      console.error('Compare request failed:', err);
    } finally {
      setComparing(false);
    }
  };

  // Handle Approve Item
  const handleApprove = async (item: ReviewItem, pairingIds?: string[]) => {
    try {
      const url = `/api/review/${merchantId}/${item.item_id}?k=${reviewKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          profile: item.proposal,
          pairing_ids: pairingIds ?? item.pairings.filter((p) => p.approved).map((p) => p.item_id),
        }),
      });
      if (res.ok) {
        await fetchReviewItems(merchantId, reviewKey);
      }
    } catch (err) {
      console.error('Approve failed:', err);
    }
  };

  // Handle Bulk Approve
  const handleBulkApprove = async () => {
    setBulkApproving(true);
    try {
      const url = `/api/review/${merchantId}/bulk-approve?k=${reviewKey}`;
      const res = await fetch(url, { method: 'POST' });
      if (res.ok) {
        await fetchReviewItems(merchantId, reviewKey);
      }
    } catch (err) {
      console.error('Bulk approve failed:', err);
    } finally {
      setBulkApproving(false);
    }
  };

  // Handle Re-sync Menu
  const handleResync = async () => {
    setResyncing(true);
    try {
      const url = `/api/review/${merchantId}/resync?k=${reviewKey}`;
      const res = await fetch(url, { method: 'POST' });
      if (res.ok) {
        setTimeout(() => fetchReviewItems(merchantId, reviewKey), 1200);
      }
    } catch (err) {
      console.error('Re-sync failed:', err);
    } finally {
      setResyncing(false);
    }
  };

  // Handle Save Edit
  const handleSaveEdit = async () => {
    if (!editingItem) return;
    try {
      const url = `/api/review/${merchantId}/${editingItem.item_id}?k=${reviewKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'edit',
          profile: editForm,
        }),
      });
      if (res.ok) {
        setEditingItem(null);
        await fetchReviewItems(merchantId, reviewKey);
      }
    } catch (err) {
      console.error('Save edit failed:', err);
    }
  };

  const filteredReviewItems = reviewItems.filter((item) => {
    if (reviewFilter === 'PENDING') return item.status === 'PENDING';
    if (reviewFilter === 'APPROVED') return item.status === 'APPROVED' || item.status === 'EDITED';
    return true;
  });

  return (
    <div className="min-h-screen bg-[#f7f7f5] text-neutral-900 font-sans antialiased">
      {/* Clover-style Navigation Header */}
      <header className="sticky top-0 z-40 bg-white border-b border-[#e4e4df]">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded-lg bg-[#1a7f37] flex items-center justify-center text-white font-bold text-sm shadow-sm">
                V
              </div>
              <span className="font-semibold text-lg tracking-tight">Vecta-what</span>
            </div>

            {/* Navigation Tabs */}
            <nav className="flex space-x-1">
              <button
                onClick={() => setCurrentTab('demo')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'demo'
                    ? 'bg-[#1a7f37]/10 text-[#1a7f37]'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                AI Comparison Demo
              </button>
              <button
                onClick={() => setCurrentTab('review')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'review'
                    ? 'bg-[#1a7f37]/10 text-[#1a7f37]'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                Merchant Review
              </button>
              <button
                onClick={() => setCurrentTab('admin')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'admin'
                    ? 'bg-[#1a7f37]/10 text-[#1a7f37]'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                Admin
              </button>
              <button
                onClick={() => setCurrentTab('health')}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  currentTab === 'health'
                    ? 'bg-[#1a7f37]/10 text-[#1a7f37]'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                Health
              </button>
            </nav>
          </div>

          <div className="flex items-center space-x-3 text-xs text-neutral-500">
            <a
              href="/sites/bistro"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1 hover:text-[#1a7f37]"
            >
              <span>Vecta Bistro Site</span>
              <ExternalLink className="w-3 h-3" />
            </a>
            <span>•</span>
            <a
              href="/sites/spice"
              target="_blank"
              rel="noreferrer"
              className="flex items-center space-x-1 hover:text-[#1a7f37]"
            >
              <span>Spice Kitchen Site</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* ==================== 1. DEMO COMPARISON VIEW ==================== */}
        {currentTab === 'demo' && (
          <div className="space-y-6">
            <div className="text-center max-w-2xl mx-auto space-y-2">
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-neutral-900">
                Can a general AI assistant order from these restaurants?
              </h1>
              <p className="text-sm text-neutral-600">
                Compare an AI agent browsing a traditional website vs. discovering real-time Vecta agent capabilities.
              </p>
            </div>

            {/* Prompt Card */}
            <div className="bg-white rounded-xl border border-[#e4e4df] p-5 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-neutral-700 flex items-center space-x-2">
                  <Sparkles className="w-4 h-4 text-[#1a7f37]" />
                  <span>Shared Prompt (with <code className="bg-neutral-100 px-1 py-0.5 rounded text-xs">{"{site}"}</code> variable)</span>
                </label>
                <button
                  onClick={() => setPrompt(defaultPrompt)}
                  className="text-xs text-neutral-500 hover:text-neutral-800 underline"
                >
                  Reset to default prompt
                </button>
              </div>

              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="w-full text-sm rounded-lg border border-neutral-300 p-3 focus:outline-none focus:ring-2 focus:ring-[#1a7f37] focus:border-transparent font-sans"
              />

              <div className="flex justify-end">
                <button
                  onClick={handleAskBoth}
                  disabled={comparing}
                  className="inline-flex items-center space-x-2 bg-[#1a7f37] hover:bg-[#16692e] text-white px-5 py-2.5 rounded-lg text-sm font-medium shadow-sm transition-all disabled:opacity-50"
                >
                  {comparing ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Asking Both Agents in Parallel...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      <span>Ask Both</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Side-by-Side Comparison Columns (Stacks under 768px) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left Column: Demo Spice Kitchen */}
              <div className="bg-white rounded-xl border border-[#e4e4df] shadow-sm flex flex-col overflow-hidden">
                <div className="p-4 border-b border-[#e4e4df] bg-[#f4f7f2] flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-neutral-900">Demo Spice Kitchen</h3>
                    <p className="text-xs text-neutral-500">Oakland · Plain Website Only (No Vecta)</p>
                  </div>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700">
                    Stale HTML
                  </span>
                </div>

                <div className="p-5 flex-1 space-y-4">
                  {comparing && !compareResults && (
                    <div className="py-16 text-center text-neutral-400 space-y-2">
                      <RefreshCw className="w-6 h-6 animate-spin mx-auto text-[#1a7f37]" />
                      <p className="text-sm">Scraping site &amp; evaluating response...</p>
                    </div>
                  )}

                  {!comparing && !compareResults && (
                    <div className="py-16 text-center text-neutral-400 space-y-2">
                      <Utensils className="w-8 h-8 mx-auto stroke-1" />
                      <p className="text-sm">Click "Ask Both" to run live comparison</p>
                    </div>
                  )}

                  {compareResults && (
                    <>
                      {/* Latency & Fetched URLs */}
                      <div className="flex items-center justify-between text-xs text-neutral-500 pb-2 border-b border-neutral-100">
                        <span className="flex items-center space-x-1">
                          <Clock className="w-3.5 h-3.5" />
                          <span>{compareResults[0]?.seconds}s response time</span>
                        </span>
                        <span className="font-medium text-neutral-700">
                          {compareResults[0]?.fetched.length} URL(s) fetched
                        </span>
                      </div>

                      {/* Fetched Pills */}
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-neutral-500">What it fetched:</div>
                        <div className="flex flex-wrap gap-1">
                          {compareResults[0]?.fetched.map((url, i) => (
                            <span
                              key={i}
                              className="text-xs px-2 py-0.5 rounded bg-neutral-100 text-neutral-700 font-mono truncate max-w-full"
                              title={url}
                            >
                              {url}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Agent Reply */}
                      <div className="bg-[#fbfbf9] rounded-lg p-3 text-sm text-neutral-800 leading-relaxed border border-[#ecece8]">
                        {compareResults[0]?.reply}
                      </div>

                      {/* Fact Checks */}
                      <div className="pt-2 space-y-2">
                        <div className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                          Fact-Check Tonight
                        </div>
                        <div className="space-y-1.5 text-xs">
                          <CheckRow
                            label="Available tonight (no sold-out items)"
                            passed={compareResults[0]?.checks.availableTonight}
                            detail={!compareResults[0]?.checks.availableTonight ? 'Chana Masala is sold out tonight' : undefined}
                          />
                          <CheckRow
                            label="Correct price (matches tonight's register)"
                            passed={compareResults[0]?.checks.correctPrice}
                            detail={!compareResults[0]?.checks.correctPrice ? 'Stale menu prices quoted' : undefined}
                          />
                          <CheckRow
                            label="Meets the diet (verified vegan main)"
                            passed={compareResults[0]?.checks.meetsTheDiet}
                          />
                          <CheckRow
                            label="Side suggested (real available side/drink)"
                            passed={compareResults[0]?.checks.sideSuggested}
                          />
                          <CheckRow
                            label="Sources cited"
                            passed={compareResults[0]?.checks.sources}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Right Column: Vecta Demo Bistro */}
              <div className="bg-white rounded-xl border border-[#e4e4df] shadow-sm flex flex-col overflow-hidden">
                <div className="p-4 border-b border-[#e4e4df] bg-[#1a7f37]/5 flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-neutral-900">Vecta Demo Bistro</h3>
                    <p className="text-xs text-[#1a7f37]">Berkeley · Powered by Vecta-what (Live Discovery)</p>
                  </div>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-[#1a7f37]/15 text-[#1a7f37]">
                    Live Agent API
                  </span>
                </div>

                <div className="p-5 flex-1 space-y-4">
                  {comparing && !compareResults && (
                    <div className="py-16 text-center text-neutral-400 space-y-2">
                      <RefreshCw className="w-6 h-6 animate-spin mx-auto text-[#1a7f37]" />
                      <p className="text-sm">Calling agent discovery and live API...</p>
                    </div>
                  )}

                  {!comparing && !compareResults && (
                    <div className="py-16 text-center text-neutral-400 space-y-2">
                      <Sparkles className="w-8 h-8 mx-auto text-[#1a7f37] stroke-1" />
                      <p className="text-sm">Click "Ask Both" to see real-time agent results</p>
                    </div>
                  )}

                  {compareResults && (
                    <>
                      {/* Latency & Fetched URLs */}
                      <div className="flex items-center justify-between text-xs text-neutral-500 pb-2 border-b border-neutral-100">
                        <span className="flex items-center space-x-1">
                          <Clock className="w-3.5 h-3.5" />
                          <span>{compareResults[1]?.seconds}s response time</span>
                        </span>
                        <span className="font-medium text-neutral-700">
                          {compareResults[1]?.fetched.length} URL(s) fetched
                        </span>
                      </div>

                      {/* Fetched Pills */}
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-neutral-500">What it fetched:</div>
                        <div className="flex flex-wrap gap-1">
                          {compareResults[1]?.fetched.map((url, i) => (
                            <span
                              key={i}
                              className="text-xs px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 font-mono truncate max-w-full border border-emerald-100"
                              title={url}
                            >
                              {url}
                            </span>
                          ))}
                        </div>
                      </div>

                      {/* Agent Reply */}
                      <div className="bg-[#f0f9f3] rounded-lg p-3 text-sm text-neutral-800 leading-relaxed border border-[#d2edd9]">
                        {compareResults[1]?.reply}
                      </div>

                      {/* Fact Checks */}
                      <div className="pt-2 space-y-2">
                        <div className="text-xs font-semibold text-neutral-700 uppercase tracking-wider">
                          Fact-Check Tonight
                        </div>
                        <div className="space-y-1.5 text-xs">
                          <CheckRow
                            label="Available tonight (no sold-out items)"
                            passed={compareResults[1]?.checks.availableTonight}
                          />
                          <CheckRow
                            label="Correct price (matches tonight's register)"
                            passed={compareResults[1]?.checks.correctPrice}
                          />
                          <CheckRow
                            label="Meets the diet (verified vegan main)"
                            passed={compareResults[1]?.checks.meetsTheDiet}
                          />
                          <CheckRow
                            label="Side suggested (real available side/drink)"
                            passed={compareResults[1]?.checks.sideSuggested}
                          />
                          <CheckRow
                            label="Sources cited"
                            passed={compareResults[1]?.checks.sources}
                          />
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ==================== 2. MERCHANT REVIEW VIEW ==================== */}
        {currentTab === 'review' && !merchantId && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-bold text-neutral-900">Merchant Review</h1>
              <p className="text-sm text-neutral-600 mt-1">
                Select a merchant to review AI-generated dietary tags, allergen profiles, and pairings before publishing them live.
              </p>
            </div>

            {loadingAdmin ? (
              <div className="bg-white rounded-xl border border-[#e4e4df] p-12 text-center text-neutral-400">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-[#1a7f37]" />
                <p className="text-sm mt-2">Loading connected merchants...</p>
              </div>
            ) : merchants.length === 0 ? (
              <div className="bg-white rounded-xl border border-[#e4e4df] p-12 text-center text-neutral-400">
                <p className="text-sm">No connected merchants found.</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-[#e4e4df] divide-y divide-[#e4e4df] shadow-sm overflow-hidden">
                {merchants.map((m) => (
                  <div
                    key={m.merchantId}
                    className="p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-neutral-50/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-neutral-900">{m.name}</span>
                        <span
                          className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            m.status === 'CONNECTED' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {m.status}
                        </span>
                      </div>
                      <p className="text-xs text-neutral-500">ID: {m.merchantId}</p>
                    </div>

                    <div className="flex items-center space-x-6">
                      <div className="text-xs space-y-0.5 text-right">
                        <div className="font-semibold text-[#b35c00]">
                          {m.reviewCounts.PENDING || 0} pending review
                        </div>
                        <div className="text-neutral-500">
                          {m.reviewCounts.APPROVED || 0} approved ({m.stageCounts.INDEXED || 0} indexed)
                        </div>
                      </div>

                      <button
                        onClick={() => {
                          setMerchantId(m.merchantId);
                          setReviewKey(m.reviewKey);
                          window.history.pushState({}, '', m.reviewUrl);
                        }}
                        className="bg-[#1a7f37] hover:bg-[#16692e] text-white px-4 py-2 rounded-lg text-xs font-semibold flex items-center space-x-1.5 shadow-sm transition-colors"
                      >
                        <span>Review items</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {currentTab === 'review' && merchantId && (
          <div className="space-y-6">
            {/* Back Link */}
            <div>
              <button
                onClick={() => {
                  setMerchantId('');
                  setReviewKey('');
                  setReviewItems([]);
                  window.history.pushState({}, '', '/review');
                }}
                className="text-xs text-neutral-500 hover:text-neutral-900 font-medium flex items-center space-x-1"
              >
                <span>← All Merchants</span>
              </button>
            </div>

            {/* Review Header Banner */}
            <div className="bg-white rounded-xl border border-[#e4e4df] p-6 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="text-2xl font-bold text-neutral-900">Merchant Review</h1>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">
                    Merchant {merchantId}
                  </span>
                </div>
                <p className="text-sm text-neutral-600 mt-1 max-w-2xl">
                  Review AI-enriched dietary tags, allergen profiles, and pairings before publishing them live to AI agents.
                  Merchant tags are ground truth. Once approved, items are served through public agent APIs.
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={handleResync}
                  disabled={resyncing}
                  className="bg-white hover:bg-neutral-50 text-neutral-700 border border-[#e4e4df] px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-sm disabled:opacity-50 flex items-center space-x-2"
                >
                  <RefreshCw className={`w-4 h-4 ${resyncing ? 'animate-spin' : ''}`} />
                  <span>Re-sync menu</span>
                </button>
                <button
                  onClick={handleBulkApprove}
                  disabled={bulkApproving || reviewItems.length === 0}
                  className="bg-[#1a7f37] hover:bg-[#16692e] text-white px-4 py-2 rounded-lg text-sm font-medium transition-all shadow-sm disabled:opacity-50 flex items-center space-x-2"
                >
                  {bulkApproving ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Check className="w-4 h-4" />
                  )}
                  <span>Bulk Approve High-Confidence (≥0.8)</span>
                </button>
              </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center justify-between">
              <div className="flex space-x-2">
                {(['ALL', 'PENDING', 'APPROVED'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setReviewFilter(filter)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      reviewFilter === filter
                        ? 'bg-neutral-900 text-white'
                        : 'bg-white border border-[#e4e4df] text-neutral-600 hover:bg-neutral-50'
                    }`}
                  >
                    {filter === 'ALL' ? `All (${reviewItems.length})` : filter}
                  </button>
                ))}
              </div>

              <button
                onClick={() => fetchReviewItems(merchantId, reviewKey)}
                disabled={loadingReview}
                className="text-xs text-neutral-500 hover:text-neutral-800 flex items-center space-x-1"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingReview ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            {/* Items Table / Cards */}
            {loadingReview && (
              <div className="bg-white rounded-xl border border-[#e4e4df] p-12 text-center text-neutral-400">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-[#1a7f37]" />
                <p className="text-sm mt-2">Loading catalog items for review...</p>
              </div>
            )}

            {!loadingReview && filteredReviewItems.length === 0 && (
              <div className="bg-white rounded-xl border border-[#e4e4df] p-12 text-center text-neutral-400">
                <p className="text-sm">No items matching this filter.</p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4">
              {filteredReviewItems.map((item) => {
                const profile = item.approved || item.proposal || {};
                const confidence = profile.confidence ?? 0.9;
                const isPending = item.status === 'PENDING';

                return (
                  <div
                    key={item.item_id}
                    className="bg-white rounded-xl border border-[#e4e4df] p-5 shadow-sm space-y-4 hover:border-neutral-300 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-neutral-100 pb-3">
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="font-semibold text-neutral-900">{item.name}</h3>
                          <span className="text-sm text-neutral-500">
                            ${(item.price_cents / 100).toFixed(2)}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 font-medium">
                            {item.categories.join(', ')}
                          </span>
                        </div>
                        {item.tags.length > 0 && (
                          <div className="flex items-center space-x-1 mt-1 text-xs text-neutral-500">
                            <span className="font-medium text-neutral-400">Clover Tags:</span>
                            {item.tags.map((t, idx) => (
                              <span key={idx} className="bg-amber-50 text-amber-800 px-1.5 py-0.5 rounded text-[11px] border border-amber-200">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center space-x-2">
                        {/* Status Badge */}
                        <span
                          className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                            isPending
                              ? 'bg-[#b35c00]/10 text-[#b35c00]'
                              : 'bg-[#1a7f37]/10 text-[#1a7f37]'
                          }`}
                        >
                          {item.status}
                        </span>

                        {/* Actions */}
                        {isPending && (
                          <button
                            onClick={() => handleApprove(item)}
                            className="bg-[#1a7f37] hover:bg-[#16692e] text-white px-3 py-1 rounded-lg text-xs font-medium transition-all shadow-sm"
                          >
                            Approve
                          </button>
                        )}

                        <button
                          onClick={() => {
                            setEditingItem(item);
                            setEditForm({ ...profile });
                          }}
                          className="border border-[#e4e4df] hover:bg-neutral-50 text-neutral-700 px-3 py-1 rounded-lg text-xs font-medium transition-all"
                        >
                          Edit
                        </button>
                      </div>
                    </div>

                    {/* Proposal Details */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                      <div className="space-y-1">
                        <div className="text-neutral-400 font-medium uppercase tracking-wider text-[10px]">
                          Description
                        </div>
                        <p className="text-neutral-700 leading-relaxed">
                          {profile.description || 'No description available.'}
                        </p>
                      </div>

                      <div className="space-y-1">
                        <div className="text-neutral-400 font-medium uppercase tracking-wider text-[10px]">
                          Diet &amp; Attributes
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {profile.vegan && (
                            <span className="bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-medium">
                              Vegan
                            </span>
                          )}
                          {profile.vegetarian && (
                            <span className="bg-green-100 text-green-800 px-1.5 py-0.5 rounded font-medium">
                              Vegetarian
                            </span>
                          )}
                          {profile.gluten_free && (
                            <span className="bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded font-medium">
                              Gluten-Free
                            </span>
                          )}
                          <span className="bg-neutral-100 text-neutral-700 px-1.5 py-0.5 rounded">
                            Spice: {profile.spice_level ?? 0}/3
                          </span>
                          <span className="bg-neutral-100 text-neutral-700 px-1.5 py-0.5 rounded">
                            Course: {profile.course || 'main'}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="text-neutral-400 font-medium uppercase tracking-wider text-[10px] flex items-center justify-between">
                          <span>Pairings ({item.pairings.length})</span>
                          <span>Conf: {(confidence * 100).toFixed(0)}%</span>
                        </div>
                        <div className="space-y-1">
                          {item.pairings.length === 0 ? (
                            <span className="text-neutral-400">None proposed</span>
                          ) : (
                            item.pairings.map((p, pIdx) => (
                              <div key={pIdx} className="text-neutral-700 flex items-center space-x-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#1a7f37]" />
                                <span className="font-medium">{p.name}</span>
                                <span className="text-neutral-400">({p.role})</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Inline Edit Modal */}
            {editingItem && (
              <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
                <div className="bg-white rounded-xl border border-[#e4e4df] max-w-lg w-full p-6 shadow-xl space-y-4">
                  <div className="flex items-center justify-between border-b pb-3">
                    <h3 className="font-semibold text-lg">Edit {editingItem.name}</h3>
                    <button
                      onClick={() => setEditingItem(null)}
                      className="text-neutral-400 hover:text-neutral-700 text-sm"
                    >
                      ✕
                    </button>
                  </div>

                  <div className="space-y-3 text-xs">
                    <div>
                      <label className="font-medium text-neutral-700 block mb-1">Description</label>
                      <textarea
                        value={editForm.description || ''}
                        onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                        rows={2}
                        className="w-full border rounded p-2 text-sm"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="font-medium text-neutral-700 block mb-1">Cuisine</label>
                        <input
                          type="text"
                          value={editForm.cuisine || ''}
                          onChange={(e) => setEditForm({ ...editForm, cuisine: e.target.value })}
                          className="w-full border rounded p-2 text-sm"
                        />
                      </div>
                      <div>
                        <label className="font-medium text-neutral-700 block mb-1">Course</label>
                        <select
                          value={editForm.course || 'main'}
                          onChange={(e) => setEditForm({ ...editForm, course: e.target.value })}
                          className="w-full border rounded p-2 text-sm bg-white"
                        >
                          <option value="appetizer">appetizer</option>
                          <option value="soup_salad">soup_salad</option>
                          <option value="main">main</option>
                          <option value="side">side</option>
                          <option value="bread">bread</option>
                          <option value="dessert">dessert</option>
                          <option value="drink">drink</option>
                          <option value="other">other</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center space-x-4 pt-2">
                      <label className="flex items-center space-x-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!editForm.vegan}
                          onChange={(e) => setEditForm({ ...editForm, vegan: e.target.checked })}
                          className="rounded text-[#1a7f37]"
                        />
                        <span>Vegan</span>
                      </label>
                      <label className="flex items-center space-x-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!editForm.vegetarian}
                          onChange={(e) => setEditForm({ ...editForm, vegetarian: e.target.checked })}
                          className="rounded text-[#1a7f37]"
                        />
                        <span>Vegetarian</span>
                      </label>
                      <label className="flex items-center space-x-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!editForm.gluten_free}
                          onChange={(e) => setEditForm({ ...editForm, gluten_free: e.target.checked })}
                          className="rounded text-[#1a7f37]"
                        />
                        <span>Gluten-Free</span>
                      </label>
                    </div>
                  </div>

                  <div className="flex justify-end space-x-2 pt-3 border-t">
                    <button
                      onClick={() => setEditingItem(null)}
                      className="px-4 py-2 border rounded-lg text-xs font-medium text-neutral-600 hover:bg-neutral-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="px-4 py-2 bg-[#1a7f37] hover:bg-[#16692e] text-white rounded-lg text-xs font-medium shadow-sm"
                    >
                      Save &amp; Approve
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ==================== 3. ADMIN VIEW ==================== */}
        {currentTab === 'admin' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-bold text-neutral-900">Admin Dashboard</h1>
                <p className="text-sm text-neutral-600">Merchant connections, sync state, and catalog indexes.</p>
              </div>
              <button
                onClick={fetchAdminOverview}
                disabled={loadingAdmin}
                className="bg-white border border-[#e4e4df] text-neutral-700 px-3 py-1.5 rounded-lg text-xs font-medium flex items-center space-x-1.5 hover:bg-neutral-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingAdmin ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {merchants.map((m) => (
                <div key={m.merchantId} className="bg-white rounded-xl border border-[#e4e4df] p-6 shadow-sm space-y-5">
                  <div className="flex items-center justify-between border-b pb-3">
                    <div>
                      <h2 className="font-semibold text-lg text-neutral-900">{m.name}</h2>
                      <p className="text-xs text-neutral-500">ID: {m.merchantId}</p>
                    </div>
                    <span
                      className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                        m.status === 'CONNECTED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {m.status}
                    </span>
                  </div>

                  {/* Stage Counts */}
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                      <div className="text-xl font-bold text-neutral-900">{m.stageCounts.INDEXED || 0}</div>
                      <div className="text-[11px] text-neutral-500 uppercase tracking-wider mt-0.5">Indexed Items</div>
                    </div>
                    <div className="bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                      <div className="text-xl font-bold text-[#b35c00]">{m.reviewCounts.PENDING || 0}</div>
                      <div className="text-[11px] text-neutral-500 uppercase tracking-wider mt-0.5">Pending Review</div>
                    </div>
                    <div className="bg-neutral-50 p-3 rounded-lg border border-neutral-100">
                      <div className="text-xl font-bold text-[#1a7f37]">{m.reviewCounts.APPROVED || 0}</div>
                      <div className="text-[11px] text-neutral-500 uppercase tracking-wider mt-0.5">Approved</div>
                    </div>
                  </div>

                  {/* Quick Links */}
                  <div className="space-y-2 pt-2">
                    <div className="text-xs font-medium text-neutral-700">Quick Actions</div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <a
                        href={m.reviewUrl}
                        className="bg-[#1a7f37] text-white px-3 py-1.5 rounded-lg font-medium hover:bg-[#16692e] flex items-center space-x-1"
                      >
                        <span>Open Review UI</span>
                        <ArrowRight className="w-3 h-3" />
                      </a>
                      <a
                        href="/sites/bistro"
                        target="_blank"
                        rel="noreferrer"
                        className="border border-[#e4e4df] text-neutral-700 px-3 py-1.5 rounded-lg font-medium hover:bg-neutral-50 flex items-center space-x-1"
                      >
                        <span>View Website</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                      <a
                        href="/llms.txt"
                        target="_blank"
                        rel="noreferrer"
                        className="border border-[#e4e4df] text-neutral-700 px-3 py-1.5 rounded-lg font-medium hover:bg-neutral-50 font-mono"
                      >
                        /llms.txt
                      </a>
                      <a
                        href="/.well-known/agent-card.json"
                        target="_blank"
                        rel="noreferrer"
                        className="border border-[#e4e4df] text-neutral-700 px-3 py-1.5 rounded-lg font-medium hover:bg-neutral-50 font-mono"
                      >
                        agent-card.json
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ==================== 4. HEALTH VIEW ==================== */}
        {currentTab === 'health' && (
          <div className="bg-white rounded-xl border border-[#e4e4df] p-6 shadow-sm space-y-4">
            <h1 className="text-xl font-bold text-neutral-900">System Health</h1>
            <pre className="bg-neutral-900 text-emerald-400 p-4 rounded-lg text-xs overflow-auto font-mono">
              {JSON.stringify(healthData, null, 2)}
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}

function CheckRow({ label, passed, detail }: { label: string; passed?: boolean; detail?: string }) {
  return (
    <div className="flex items-start justify-between py-1 border-b border-neutral-100 last:border-0">
      <div className="flex items-center space-x-2">
        {passed ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
        )}
        <span className={passed ? 'text-neutral-800' : 'text-neutral-700'}>{label}</span>
      </div>
      {detail && <span className="text-red-500 text-[11px] font-medium">{detail}</span>}
    </div>
  );
}
