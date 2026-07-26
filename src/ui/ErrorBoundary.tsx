import { Component, type ErrorInfo, type ReactNode } from 'react';
import { trackError } from '../net/analytics';
import { Rail } from './common';

/**
 * Top-level render-error catch-all. React error boundaries must be class
 * components (there's no hook equivalent) — this is the one exception to the
 * rest of Clapper's function-component style.
 *
 * Wraps the app so a bug in any screen doesn't blank the phone: it logs the
 * crash (best-effort, via `trackError`) and renders a small on-brand recovery
 * screen instead of a white page. The reassurance matters more than the copy
 * here — everything a user has logged already lives in IndexedDB on-device,
 * untouched by a render crash, so a reload is genuinely safe.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { crashed: false };
  }

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    try {
      trackError(error, {
        boundary: true,
        componentStack: info?.componentStack?.slice(0, 800),
      });
    } catch {
      /* logging itself must never keep the fallback UI from rendering */
    }
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;

    return (
      <div className="app crashscreen">
        <Rail clap />
        <div className="crashscreen__body">
          <h1 className="crashscreen__title">Something broke.</h1>
          <p className="crashscreen__msg">
            Your shot log is saved on this device. Reload to keep going.
          </p>
          <button
            type="button"
            className="btn btn--go btn--full"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
