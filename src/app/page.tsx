import Link from 'next/link';

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-brand-900 mb-4">
          Bed Sync AI SMS Agent
        </h1>
        <p className="text-gray-600 mb-8 max-w-md mx-auto">
          AI-powered SMS sales agent for mattress dealers. Automatically
          qualifies leads, recommends products, and drives sales.
        </p>
        <Link
          href="/admin"
          className="inline-block px-8 py-3 bg-brand-900 text-white rounded-lg font-semibold hover:bg-brand-800 transition-colors"
        >
          Open Admin Dashboard
        </Link>
      </div>
    </div>
  );
}
