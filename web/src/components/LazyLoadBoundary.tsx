import { Component, type ErrorInfo, type ReactNode } from "react";

interface LazyLoadBoundaryProps {
  children: ReactNode;
  label: string;
  resetKey: string;
}

interface LazyLoadBoundaryState {
  failed: boolean;
  resetKey: string;
}

/** Keep a rejected route/chart chunk from blanking the authenticated shell. */
export class LazyLoadBoundary extends Component<LazyLoadBoundaryProps, LazyLoadBoundaryState> {
  state: LazyLoadBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<LazyLoadBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: LazyLoadBoundaryProps,
    state: LazyLoadBoundaryState,
  ): Partial<LazyLoadBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Chunk errors can contain URLs. Keep them out of logs and show fixed UI.
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex min-h-32 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
        <p className="text-sm text-muted-foreground">{this.props.label} could not be loaded.</p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary"
          onClick={() => window.location.reload()}
        >
          Reload Borealis
        </button>
      </div>
    );
  }
}
