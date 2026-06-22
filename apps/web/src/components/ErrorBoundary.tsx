import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("SynchroPage error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100dvh",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
            color: "var(--pp-fg, #1a1a1a)",
            backgroundColor: "var(--pp-bg, #fafafa)",
          }}
        >
          <h2 style={{ marginBottom: "0.5rem", fontSize: "1.25rem", fontWeight: 600 }}>
            Something went wrong
          </h2>
          <p
            style={{
              marginBottom: "1rem",
              color: "var(--pp-fg-muted, #666)",
              maxWidth: "32rem",
              textAlign: "center",
            }}
          >
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => {
              this.setState({ hasError: false, error: null });
              window.location.reload();
            }}
            style={{
              padding: "0.5rem 1.25rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              border: "1px solid var(--pp-border, #ddd)",
              borderRadius: "0.375rem",
              cursor: "pointer",
              backgroundColor: "var(--pp-surface, #fff)",
              color: "var(--pp-fg, #1a1a1a)",
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
