import { Component, type ReactNode } from "react";
import { ErrorBox } from "./ui";

/** A rendering bug in one view shows a recoverable message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("View crashed:", error);
  }

  render() {
    return this.state.error ? (
      <ErrorBox error={this.state.error} onRetry={() => window.location.reload()} />
    ) : (
      this.props.children
    );
  }
}
