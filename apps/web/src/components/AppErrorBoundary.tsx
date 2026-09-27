import { Component, ReactNode } from 'react';
import { Result, Button } from 'antd';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Top-level error boundary — catches unhandled render errors and displays a
 * safe recovery screen instead of a blank white page.
 */
export class AppErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[AppErrorBoundary] Unhandled render error:', error);
  }

  resetErrorBoundary = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '100vh',
          }}
        >
          <Result
            status="error"
            title="Хатолик юз берди"
            subTitle="Илтимос, қайта уриниб кўринг ёки саҳифани янгиланг."
            extra={[
              <Button type="primary" key="retry" onClick={this.resetErrorBoundary}>
                Қайта уриниш
              </Button>,
              <Button key="reload" onClick={() => window.location.reload()}>
                Янгилаш
              </Button>,
            ]}
          />
        </div>
      );
    }

    return this.props.children;
  }
}
