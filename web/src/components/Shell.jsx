import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Logo } from './ui.jsx';

export default function Shell({ children }) {
  const { user, logout, settings } = useAuth();
  const nav = useNavigate();

  const link = ({ isActive }) => (isActive ? 'active' : undefined);

  return (
    <>
      <header className="nav">
        <div className="shell nav-in">
          <NavLink to="/" className="brand">
            <Logo />
            <span className="wordmark">Unee<span>Rooms</span></span>
          </NavLink>
          <nav className="nav-links">
            <NavLink to="/" end className={link}>Dashboard</NavLink>
            <NavLink to="/calendar" className={link}>Calendar</NavLink>
            <NavLink to="/bookings" className={link}>My bookings</NavLink>
            {user.role === 'admin' && (
              <>
                <NavLink to="/admin/approvals" className={link}>Approvals</NavLink>
                <NavLink to="/admin/rooms" className={link}>Rooms</NavLink>
                <NavLink to="/admin/people" className={link}>People</NavLink>
                <NavLink to="/admin/settings" className={link}>Settings</NavLink>
              </>
            )}
            <NavLink to="/profile" title="Your account and password"
                     className={({ isActive }) => `nav-user${isActive ? ' active' : ''}`}>
              {user.name.split(' ')[0]} · {user.role}
            </NavLink>
            <button className="btn btn-sec btn-sm" onClick={() => logout().then(() => nav('/login'))}>
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main>{children}</main>

      <footer className="footer">
        <div className="shell footer-in">
          <span>{settings?.org_name || 'Uneecops Technologies Limited'}</span>
          <span>UneeRooms · Conference room booking</span>
          <span>Bookable {settings?.work_start}–{settings?.work_end}</span>
          <span style={{ marginLeft: 'auto' }}>Signed in as {user.email}</span>
        </div>
      </footer>
    </>
  );
}
