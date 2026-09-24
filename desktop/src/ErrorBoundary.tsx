import React from 'react';
import { t } from './i18n';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Last line of defense: without this, any render-time throw in a screen (a bad API
 * response shape, a null-deref, etc.) unmounts the whole React tree and leaves the
 * user staring at a blank white window with no way back except force-quitting. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[insightest] unhandled render error', error, info.componentStack);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-3 p-6 text-center">
          <h2 className="text-lg font-semibold text-ink-primary">{t('Something went wrong')}</h2>
          <p className="max-w-md break-words text-sm text-ink-muted">{this.state.error.message}</p>
          <button onClick={() => this.setState({ error: null })}>{t('Try again')}</button>
        </div>
      );
    }
    return this.props.children;
  }
}
