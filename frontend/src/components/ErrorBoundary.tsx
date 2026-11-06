import { Component, ReactNode } from "react";

// A page that throws must never blank the app: the shell stays, the page shows this card.
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error) { console.error("page error", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto mt-10 max-w-lg rounded-lg border bg-card p-6 text-center">
        <div className="text-[length:var(--text-ui-md)] font-medium">This page hit a problem</div>
        <p className="mt-1 text-[length:var(--text-ui-sm)] text-muted-foreground">
          The rest of the service keeps working. Reload the page, or pick another one from the menu.
        </p>
        <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-background p-2 text-left text-[11px] text-subtle">{String(this.state.error.message)}</pre>
        <button className="mt-4 rounded-md border px-3 py-1.5 text-[length:var(--text-ui-sm)] hover:bg-muted" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
