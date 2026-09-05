import { lazy, Suspense, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import Loading from './components/Loading';
import Home from './pages/Home';
import Browse from './pages/Browse';
import People from './pages/People';
import ItemDetail from './pages/ItemDetail';
import Ask from './pages/Ask';
import Login from './pages/Login';
import Register from './pages/Register';
import NotFound from './pages/NotFound';
import Account from './pages/Account';
import AskAIPopup from './components/AskAIPopup';
import CommandPalette from './components/CommandPalette';
import MaintenanceBanner from './components/MaintenanceBanner';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';
import { ThemeProvider } from './context/ThemeContext';
import { I18nProvider } from './i18n/index.jsx';

/**
 * The admin panel, the inline item editor and the encryption explainer are
 * loaded on demand. Together they are ~4.4k lines of JSX plus the charting and
 * management code that hangs off them, and a visitor browsing the catalogue
 * never touches any of it — so they should not be in the bundle that is parsed
 * before the homepage paints. Everything above stays eager because it is what
 * an arrival actually needs.
 *
 * Each admin area is its own chunk as well, so opening "File pages" does not
 * first download "Backup".
 */
const Admin = lazy(() => import('./pages/Admin'));
const Profile = lazy(() => import('./pages/Profile'));
const AdminOverview = lazy(() => import('./pages/admin/Overview'));
const AdminItems = lazy(() => import('./pages/admin/Items'));
const AdminCategories = lazy(() => import('./pages/admin/Categories'));
const AdminFolders = lazy(() => import('./pages/admin/Folders'));
const AdminBackup = lazy(() => import('./pages/admin/Backup'));
const AdminImports = lazy(() => import('./pages/admin/Imports'));
const AdminReviews = lazy(() => import('./pages/admin/Reviews'));
const AdminAnalytics = lazy(() => import('./pages/admin/Analytics'));
const AdminStorage = lazy(() => import('./pages/admin/Storage'));
const AdminSettings = lazy(() => import('./pages/admin/Settings'));
const UserManager = lazy(() => import('./components/UserManager'));
const WebhookManager = lazy(() => import('./components/WebhookManager'));
const Monitoring = lazy(() => import('./components/Monitoring'));
const Encryption = lazy(() => import('./pages/Encryption'));

function ItemRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/file/${slug}`} replace />;
}

function AppContent() {
  const [askOpen, setAskOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col transition-colors duration-300">
      <Navbar onAskOpen={() => setAskOpen(true)} />
      <MaintenanceBanner />
      <main className="flex-1">
        {/* One fallback for the split routes: the same dots the rest of the app
            uses, full-screen, so a chunk fetch looks like every other wait. */}
        <Suspense fallback={<Loading fullScreen text="Loading…" />}>
          <Routes>
            <Route path="/" element={<Home onAskOpen={() => setAskOpen(true)} />} />
            <Route path="/browse" element={<Browse />} />
            <Route path="/people" element={<People />} />
            <Route path="/file/:slug" element={<ItemDetail />} />
            <Route path="/item/:slug" element={<ItemRedirect />} />
            <Route path="/ask" element={<Ask />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/account" element={<Account />} />
            {/* Public account page: what someone chose to share. */}
            <Route path="/u/:username" element={<Profile />} />
            {/* Admin: layout + one route per area, each with a real URL */}
            <Route path="/admin" element={<Admin />}>
              <Route index element={<AdminOverview />} />
              <Route path="items" element={<AdminItems />} />
              <Route path="items/:id" element={<AdminItems />} />
              <Route path="categories" element={<AdminCategories />} />
              <Route path="folders" element={<AdminFolders />} />
              <Route path="users" element={<div className="glass rounded-2xl border border-white/5 p-6"><UserManager /></div>} />
              <Route path="storage" element={<AdminStorage />} />
              <Route path="imports" element={<AdminImports />} />
              <Route path="reviews" element={<AdminReviews />} />
              <Route path="analytics" element={<AdminAnalytics />} />
              <Route path="backup" element={<AdminBackup />} />
              <Route path="webhooks" element={<div className="glass rounded-2xl border border-white/5 p-6"><WebhookManager scope="admin" /></div>} />
              <Route path="settings" element={<AdminSettings />} />
              <Route path="monitoring" element={<Monitoring />} />
            </Route>
            <Route path="/encryption" element={<Encryption />} />
            <Route path="/monitoring" element={<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"><Monitoring /></div>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <Footer />
      <AskAIPopup isOpen={askOpen} onClose={() => setAskOpen(false)} />
      <CommandPalette onAskOpen={() => setAskOpen(true)} />
    </div>
  );
}

function App() {
  return (
    <SettingsProvider>
      {/* Theme sits inside Settings: the admin's default scheme is a setting. */}
      <ThemeProvider>
        <AuthProvider>
          <I18nProvider>
            <Router>
              <AppContent />
            </Router>
          </I18nProvider>
        </AuthProvider>
      </ThemeProvider>
    </SettingsProvider>
  );
}

export default App;
