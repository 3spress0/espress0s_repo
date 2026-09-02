import { useState, useEffect } from 'react';
import { Users, Shield, Edit, Trash2, Search, Plus, AlertTriangle, Lock, Mail, Crown, Eye, UserCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';

export default function UserManager() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [editingUser, setEditingUser] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [formData, setFormData] = useState({ username: '', email: '', password: '', role: 'viewer' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchUsers = async (page = 1) => {
    if (!isAuthenticated) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/admin/users', { params: { page, limit: 20, q: searchQuery || undefined, role: roleFilter || undefined } });
      setUsers(res.data.users || []);
      setPagination(res.data.pagination || { page: 1, total: 0, totalPages: 0 });
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error || 'Failed to load users';
      if (status === 401) {
        setError('Authentication required - please login again as admin');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchUsers(1);
    }
  }, [isAuthenticated]);

  const handleSearch = () => fetchUsers(1);

  const handleRoleChange = async (userId, newRole) => {
    if (!confirm(`Change role to ${newRole}?`)) return;
    try {
      await api.put(`/admin/users/${userId}`, { role: newRole });
      setSuccess(`Role updated to ${newRole}`);
      fetchUsers(pagination.page);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update role');
    }
  };

  const handleDelete = async (userId) => {
    if (!confirm('Delete this user? This cannot be undone.')) return;
    try {
      await api.delete(`/admin/users/${userId}`);
      setSuccess('User deleted');
      fetchUsers(pagination.page);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete');
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/admin/users', formData);
      setSuccess('User created');
      setShowCreate(false);
      setFormData({ username: '', email: '', password: '', role: 'viewer' });
      fetchUsers(1);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create');
    }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const payload = {};
      if (formData.username) payload.username = formData.username;
      if (formData.email) payload.email = formData.email;
      if (formData.role) payload.role = formData.role;
      
      await api.put(`/admin/users/${editingUser.id}`, payload);
      setSuccess('User updated');
      setEditingUser(null);
      setFormData({ username: '', email: '', password: '', role: 'viewer' });
      fetchUsers(pagination.page);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update');
    }
  };

  const roleColors = {
    admin: 'bg-red-500/10 text-red-400 border-red-500/20',
    editor: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
    viewer: 'bg-green-500/10 text-green-400 border-green-500/20',
  };

  const roleIcons = {
    admin: Crown,
    editor: Edit,
    viewer: Eye,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-textPrimary flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            User Manager
          </h2>
          <p className="text-sm text-textMuted mt-1">Manage users, roles, encrypted emails • {pagination.total} users</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-gradient-primary text-white rounded-xl text-sm font-medium flex items-center gap-2 shadow-lg shadow-purple-500/20"
        >
          <Plus className="w-4 h-4" />
          Create User
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
          <button onClick={() => setError('')} className="ml-auto text-xs underline">Dismiss</button>
        </div>
      )}
      {success && (
        <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20 text-sm text-green-400 flex items-center gap-2">
          <UserCheck className="w-4 h-4" />
          {success}
          <button onClick={() => setSuccess('')} className="ml-auto text-xs underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-textMuted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Search username or email..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="px-4 py-2.5 bg-surface border border-border rounded-xl text-sm"
        >
          <option value="">All roles</option>
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </select>
        <button onClick={handleSearch} className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm hover:border-primary/30">
          Search
        </button>
      </div>

      <div className="glass rounded-2xl border border-white/5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-surface border-b border-border text-xs text-textMuted uppercase tracking-widest">
              <tr>
                <th className="text-left p-4">User</th>
                <th className="text-left p-4">Email (decrypted for admin)</th>
                <th className="text-left p-4">Role</th>
                <th className="text-left p-4">Encryption</th>
                <th className="text-left p-4">Created</th>
                <th className="text-right p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(5)].map((_, i) => (
                  <tr key={i} className="border-b border-white/5 animate-pulse">
                    <td colSpan={6} className="p-4"><div className="h-8 bg-surface rounded" /></td>
                  </tr>
                ))
              ) : users.length ? users.map(user => {
                const RoleIcon = roleIcons[user.role] || Users;
                return (
                  <tr key={user.id} className="border-b border-white/5 hover:bg-surface/50">
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-xl bg-gradient-primary flex items-center justify-center text-white font-bold text-xs">
                          {user.username[0]?.toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-textPrimary">{user.username}</div>
                          <div className="text-xs text-textMuted">ID: {user.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-1.5">
                        <Mail className="w-3 h-3 text-textMuted" />
                        <span className="font-mono text-xs">{user.email}</span>
                      </div>
                      <div className="text-[10px] text-textMuted font-mono mt-1 truncate max-w-[200px]">enc: {user.email_encrypted?.slice(0,30)}...</div>
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium ${roleColors[user.role]}`}>
                        <RoleIcon className="w-3 h-3" />
                        {user.role}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="flex flex-col gap-1">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${user.isEncrypted ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400'}`}>
                          {user.isEncrypted ? 'AES-256-GCM' : 'Legacy'}
                        </span>
                        <span className="text-[10px] text-textMuted">{user.encryption_version}</span>
                      </div>
                    </td>
                    <td className="p-4 text-xs text-textMuted">{new Date(user.created_at).toLocaleDateString()}</td>
                    <td className="p-4">
                      <div className="flex items-center justify-end gap-1">
                        <select
                          value={user.role}
                          onChange={(e) => handleRoleChange(user.id, e.target.value)}
                          className="px-2 py-1 bg-surface border border-border rounded-lg text-xs"
                        >
                          <option value="viewer">viewer</option>
                          <option value="editor">editor</option>
                          <option value="admin">admin</option>
                        </select>
                        <button
                          onClick={() => { setEditingUser(user); setFormData({ username: user.username, email: user.email, password: '', role: user.role }); }}
                          className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-primary"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(user.id)}
                          className="p-2 hover:bg-surfaceHover rounded-lg text-textMuted hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={6} className="p-8 text-center text-textMuted">No users found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {(showCreate || editingUser) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="glass-strong rounded-3xl border border-white/10 w-full max-w-md">
            <div className="p-6 border-b border-white/5">
              <h3 className="font-bold text-textPrimary">{editingUser ? 'Edit User' : 'Create User'}</h3>
              <p className="text-xs text-textMuted mt-1">Email will be AES-256-GCM encrypted, password pepper+bcrypt</p>
            </div>
            <form onSubmit={editingUser ? handleEdit : handleCreate} className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Username</label>
                <input type="text" value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm" required />
              </div>
              <div>
                <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Email (encrypted at rest)</label>
                <input type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm" required />
              </div>
              {!editingUser && (
                <div>
                  <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Password (pepper+bcrypt)</label>
                  <input type="password" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm" required minLength={8} />
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-textMuted uppercase tracking-widest mb-2 block">Role</label>
                <select value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})} className="w-full px-4 py-2.5 bg-surface border border-border rounded-xl text-sm">
                  <option value="viewer">Viewer — can browse, download</option>
                  <option value="editor">Editor — can edit items</option>
                  <option value="admin">Admin — full access</option>
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowCreate(false); setEditingUser(null); setFormData({ username: '', email: '', password: '', role: 'viewer' }); }} className="px-5 py-2.5 bg-surface border border-border rounded-xl text-sm">Cancel</button>
                <button type="submit" className="px-5 py-2.5 bg-gradient-primary text-white rounded-xl text-sm font-medium">{editingUser ? 'Update' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="glass rounded-2xl border border-white/5 p-4">
        <h4 className="text-xs font-semibold text-textPrimary uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Lock className="w-3 h-3" />
          Encryption Details
        </h4>
        <div className="grid sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3 rounded-xl bg-surface border border-border">
            <div className="font-medium text-textPrimary">Email</div>
            <div className="text-textMuted mt-1">AES-256-GCM random IV<br/>HMAC hash for lookup<br/>Decrypted only for admin view</div>
          </div>
          <div className="p-3 rounded-xl bg-surface border border-border">
            <div className="font-medium text-textPrimary">Password</div>
            <div className="text-textMuted mt-1">HMAC-SHA256(pepper, pwd)<br/>then bcryptjs cost 12<br/>stored as pepper_v1: prefixed hash (versioned)</div>
          </div>
          <div className="p-3 rounded-xl bg-surface border border-border">
            <div className="font-medium text-textPrimary">Roles</div>
            <div className="text-textMuted mt-1">viewer: browse/download<br/>editor: edit items<br/>admin: users + system</div>
          </div>
        </div>
      </div>
    </div>
  );
}
