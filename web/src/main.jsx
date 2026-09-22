import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth.jsx';
import Shell from './components/Shell.jsx';
import { Loading } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Profile from './pages/Profile.jsx';
import Decide from './pages/Decide.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Calendar from './pages/Calendar.jsx';
import MyBookings from './pages/MyBookings.jsx';
import Pass from './pages/Pass.jsx';
import AdminApprovals from './pages/AdminApprovals.jsx';
import AdminRooms from './pages/AdminRooms.jsx';
import AdminPeople from './pages/AdminPeople.jsx';
import AdminSettings from './pages/AdminSettings.jsx';

function Private({ children, adminOnly }) {
  const { loading, user } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="shell"><Loading /></div>;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (adminOnly && user.role !== 'admin') return <Navigate to="/" replace />;
  return <Shell>{children}</Shell>;
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/pass/:code" element={<Pass />} />
      {/* Signed link from the notification email; deliberately outside Private. */}
      <Route path="/decide/:token" element={<Decide />} />
      <Route path="/" element={<Private><Dashboard /></Private>} />
      <Route path="/calendar" element={<Private><Calendar /></Private>} />
      <Route path="/bookings" element={<Private><MyBookings /></Private>} />
      <Route path="/profile" element={<Private><Profile /></Private>} />
      <Route path="/admin/approvals" element={<Private adminOnly><AdminApprovals /></Private>} />
      <Route path="/admin/rooms" element={<Private adminOnly><AdminRooms /></Private>} />
      <Route path="/admin/people" element={<Private adminOnly><AdminPeople /></Private>} />
      <Route path="/admin/settings" element={<Private adminOnly><AdminSettings /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider><App /></AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
