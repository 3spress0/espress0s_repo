import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Shield, Database, HardDrive, FolderTree, Folder, Users, Activity, ExternalLink, Settings, Archive, FileArchive } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import Loading from '../components/Loading';

/**
 * Admin layout. Each area is its own route (see App.jsx) rather than a tab
 * inside one file, so every panel has a real, linkable, refreshable URL and its
 * own component file.
 */
// `editor: true` marks the areas an editor may open; everything else is
// admin-only (mirrors EDITOR_ROUTES in backend/src/routes/admin.js).
const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: Database },
  { to: '/admin/items', label: 'File pages', icon: HardDrive, editor: true },
  { to: '/admin/categories', label: 'Categories', icon: FolderTree, editor: true },
  { to: '/admin/folders', label: 'Folders', icon: Folder, editor: true },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/storage', label: 'Storage', icon: ExternalLink },
  { to: '/admin/imports', label: 'Catalogue', icon: FileArchive },
  { to: '/admin/backup', label: 'Backup', icon: Archive },
  { to: '/admin/settings', label: 'Site Settings', icon: Settings },
  { to: '/admin/monitoring', label: 'Monitoring', icon: Activity },
];

export default function Admin() {
  const { user, isAdmin, isEditor, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const nav = isAdmin ? NAV : NAV.filter(n => n.editor);
  const allowedHere = isAdmin || nav.some(n => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)));

  useEffect(() => {
    if (!loading && !isEditor) navigate('/login', { replace: true });
    // An editor landing on an admin-only area (or /admin itself) goes to File pages.
    else if (!loading && isEditor && !allowedHere) navigate('/admin/items', { replace: true });
  }, [loading, isEditor, allowedHere, navigate]);

  if (loading) {
    return <Loading fullScreen text="Checking admin access…" />;
  }

  if (!isEditor) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-bold text-textPrimary mb-2">Admin access required</h1>
        <p className="text-sm text-textMuted">Sign in with an administrator account to continue.</p>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-textPrimary flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-gradient-primary flex items-center justify-center">
            <Shield className="w-5 h-5 text-white" />
          </span>
          {isAdmin ? 'Admin Panel' : 'Editor Panel'}
        </h1>
        <p className="text-sm text-textMuted mt-1">
          Signed in as {user?.username} ({user?.role}) • data encrypted at rest
        </p>
      </div>

      <nav className="flex flex-wrap gap-2 mb-8 border-b border-white/5 pb-4">
        {nav.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-all ${
                isActive
                  ? 'bg-gradient-primary text-white shadow-lg shadow-purple-500/20'
                  : 'bg-surface border border-border text-textSecondary hover:border-primary/30'
              }`
            }
          >
            <item.icon className="w-4 h-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
