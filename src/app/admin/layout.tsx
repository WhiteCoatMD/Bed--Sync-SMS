'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const navItems = [
    { href: '/admin', label: 'Conversations' },
    { href: '/admin/appointments', label: 'Appointments' },
    { href: '/admin/settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen bg-ink-bg">
      <header className="bg-ink-card border-b border-ink-border shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/admin" className="text-lg font-bold text-brand-900">
              SMS Agent
            </Link>
            <nav className="flex gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    pathname === item.href
                      ? 'bg-brand-900 text-white'
                      : 'text-ink-muted hover:bg-ink-hover'
                  }`}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <a
            href="https://www.bed-sync.com/admin.html"
            className="text-xs text-ink-muted hover:text-brand-900"
          >
            Back to Bed Sync
          </a>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
