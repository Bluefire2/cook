import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { primaryBtn } from '../lib/uiClasses';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  message: string | null;
};

// React only reports render errors to class components. This is the backstop
// that keeps a crashing subtree from white-screening the whole app.
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The fallback hides the crashed subtree, so keep it diagnosable here.
    console.error(error, info);
  }

  render() {
    if (this.state.message !== null) {
      return (
        <div className="mx-auto max-w-xl px-4 pb-24">
          <h1 className="py-4 text-2xl font-bold">Something went wrong.</h1>
          <p className="text-sm text-ink-muted">{this.state.message}</p>
          <button
            type="button"
            // A full reload is deliberate: the crashed subtree cannot be
            // recovered by client routing, and a class component has no
            // useNavigate.
            onClick={() => window.location.assign('/')}
            className={`${primaryBtn} mt-4 px-4 py-2`}
          >
            Back to library
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
