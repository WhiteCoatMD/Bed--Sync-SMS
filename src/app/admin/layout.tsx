import Link from 'next/link';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-brand-900 text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <Link href="/admin" className="font-bold text-lg">
              Bed Sync AI SMS
            </Link>
            <div className="flex items-center gap-6">
              <Link href="/admin" className="text-sm hover:text-brand-100 transition-colors">
                Conversations
              </Link>
              <Link href="/admin?tab=leads" className="text-sm hover:text-brand-100 transition-colors">
                Leads
              </Link>
              <span className="text-xs bg-brand-700 px-3 py-1 rounded-full">
                MVP
              </span>
            </div>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
