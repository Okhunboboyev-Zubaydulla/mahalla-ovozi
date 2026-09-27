import { Spin } from 'antd';

/**
 * Full-page loading indicator — used while session is being verified.
 * Uses the Ant Design Spin component for theme-consistent styling.
 */
export function FullPageLoader() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
      }}
    >
      <Spin size="large" />
    </div>
  );
}
