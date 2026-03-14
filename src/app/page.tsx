import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <span className="inline-block mb-3 text-xs font-semibold uppercase tracking-widest bg-amber-100 text-amber-800 px-3 py-1 rounded-full">
          Beta
        </span>
        <h1 className="text-4xl font-bold text-brand-900 mb-4">
          Bed Sync AI SMS Agent
        </h1>
        <p className="text-gray-600 mb-6 max-w-md mx-auto">
          AI-powered SMS sales agent for mattress dealers. Automatically
          qualifies leads, recommends products, and drives sales.
        </p>
        <p className="text-sm text-gray-400 mb-8 max-w-sm mx-auto">
          Automated voice answering coming early summer 2026.
        </p>
        <Link
          href="/admin"
          className="inline-block px-8 py-3 bg-brand-900 text-white rounded-lg font-semibold hover:bg-brand-800 transition-colors"
        >
          Open Admin Dashboard
        </Link>
        <div className="mt-4">
          <a
            href="https://www.bed-sync.com"
            className="text-sm text-gray-500 hover:text-brand-900 transition-colors"
          >
            &larr; Back to Bed Sync
          </a>
        </div>
      </div>
    </div>
  );
}
