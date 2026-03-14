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
              <a href="https://www.bed-sync.com/admin.html" className="text-sm hover:text-brand-100 transition-colors flex items-center gap-1">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
                Bed Sync Admin
              </a>
              <span className="text-xs bg-amber-500 text-white px-3 py-1 rounded-full">
                Beta
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
