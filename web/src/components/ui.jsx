import { useEffect } from 'react';
import logoUrl from '../assets/uneecops-logo.png';

/**
 * The corporate lockup. It ships as an opaque PNG with a navy wordmark, so on a
 * dark background it needs the white plate rather than sitting on the panel —
 * placed directly on navy it would show a white box and lose its own wordmark.
 */
export const Logo = ({ plate = false, height, width }) => {
  const img = (
    <img src={logoUrl} alt="Uneecops Technologies Limited"
         className="brand-logo" style={height ? { height } : undefined} />
  );
  return plate ? <span className="logo-plate" style={width ? { width } : undefined}>{img}</span> : img;
};

export const Eyebrow = ({ children, mute }) => (
  <p className={`eyebrow${mute ? ' eyebrow-mute' : ''}`}>{children}</p>
);

export const StatusChip = ({ status }) => (
  <span className={`chip chip-${status}`}>{status}</span>
);

export const Loading = ({ label = 'Loading' }) => <div className="loading">{label}…</div>;

export const Notice = ({ tone = '', children }) =>
  children ? <div className={`notice ${tone ? `notice-${tone}` : ''}`}>{children}</div> : null;

export function Modal({ title, eyebrow, onClose, children, footer, wide }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = ''; };
  }, [onClose]);

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { maxWidth: 760 } : undefined} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-h">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h2 style={{ marginTop: eyebrow ? 8 : 0 }}>{title}</h2>
        </div>
        <div className="modal-b">{children}</div>
        {footer && <div className="modal-f">{footer}</div>}
      </div>
    </div>
  );
}

export const Field = ({ label, children }) => (
  <label className="field"><span>{label}</span>{children}</label>
);

export const KPI = ({ items }) => (
  <div className="kpi">
    {items.map((it) => (
      <div key={it.label}>
        <div className="lbl">{it.label}</div>
        <div className="stat">{it.value}</div>
        <div className="ctx">{it.context}</div>
      </div>
    ))}
  </div>
);
