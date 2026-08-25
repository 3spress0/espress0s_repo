import { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import Home from './pages/Home';
import Browse from './pages/Browse';
import ItemDetail from './pages/ItemDetail';
import Ask from './pages/Ask';
import Login from './pages/Login';
import Register from './pages/Register';
import Admin from './pages/Admin';
import AdminOverview from './pages/admin/Overview';
import AdminItems from './pages/admin/Items';
import AdminCategories from './pages/admin/Categories';
import AdminStorage from './pages/admin/Storage';
import AdminSettings from './pages/admin/Settings';
import UserManager from './components/UserManager';
import Encryption from './pages/Encryption';
import Security from './pages/Security';
import NotFound from './pages/NotFound';
import Account from './pages/Account';
import Monitoring from './components/Monitoring';
import AskAIPopup from './components/AskAIPopup';
import { AuthProvider } from './context/AuthContext';
import { SettingsProvider } from './context/SettingsContext';

function ItemRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/file/${slug}`} replace />;
}

function AppContent() {
  const [askOpen, setAskOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-textPrimary flex flex-col transition-colors duration-300">
      <Navbar onAskOpen={() => setAskOpen(true)} />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home onAskOpen={() => setAskOpen(true)} />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/file/:slug" element={<ItemDetail />} />
          <Route path="/item/:slug" element={<ItemRedirect />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/account" element={<Account />} />
          {/* Admin: layout + one route per area, each with a real URL */}
          <Route path="/admin" element={<Admin />}>
            <Route index element={<AdminOverview />} />
            <Route path="items" element={<AdminItems />} />
            <Route path="items/:id" element={<AdminItems />} />
            <Route path="categories" element={<AdminCategories />} />
            <Route path="users" element={<div className="glass rounded-2xl border border-white/5 p-6"><UserManager /></div>} />
            <Route path="storage" element={<AdminStorage />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="monitoring" element={<Monitoring />} />
          </Route>
          <Route path="/encryption" element={<Encryption />} />
          <Route path="/security" element={<Security />} />
          <Route path="/monitoring" element={<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8"><Monitoring /></div>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
      <AskAIPopup isOpen={askOpen} onClose={() => setAskOpen(false)} />
    </div>
  );
}

function App() {
  return (
    <SettingsProvider>
      <AuthProvider>
        <Router>
          <AppContent />
        </Router>
      </AuthProvider>
    </SettingsProvider>
  );
}

export default App;
