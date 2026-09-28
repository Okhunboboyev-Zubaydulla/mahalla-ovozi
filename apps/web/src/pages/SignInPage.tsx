import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Form, Input, Button, Alert, Card, Typography, Space, theme } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/auth-context.js';
import { ApiError } from '../auth/auth-client.js';
import { FullPageLoader } from '../components/FullPageLoader.js';

const { Title, Text } = Typography;

export function SignInPage() {
  const { isAuthenticated, isLoading, signIn, isSigningIn } = useAuth();
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isNetworkError, setIsNetworkError] = useState(false);
  // F1: Consume design tokens from ConfigProvider — no hardcoded hex values.
  const { token } = theme.useToken();

  if (isLoading) {
    return <FullPageLoader />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (values: { username?: string; password?: string }) => {
    setErrorMessage(null);
    setIsNetworkError(false);

    const username = values.username?.trim();
    const password = values.password;

    if (!username || !password) {
      setErrorMessage('Фойдаланувчи номи ва паролни киритинг.');
      return;
    }

    try {
      await signIn({ username, password });
      navigate('/', { replace: true });
    } catch (err) {
      // F5: Distinguish AbortError (programmatic cancellation) from genuine network failure.
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Request was cancelled — do not show a misleading "network down" message
        return;
      }
      if (err instanceof ApiError) {
        setIsNetworkError(err.isNetworkError);
        setErrorMessage(err.message);
      } else {
        setErrorMessage('Нотўғри фойдаланувчи номи ёки парол.');
      }
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        backgroundColor: token.colorBgLayout,
        padding: 16,
      }}
    >
      <Card
        style={{
          width: '100%',
          maxWidth: 420,
          boxShadow: token.boxShadowSecondary,
          borderRadius: token.borderRadiusLG,
        }}
        variant="borderless"
      >
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ textAlign: 'center' }}>
            <Title level={2} style={{ color: token.colorPrimary, marginBottom: 4 }}>
              Тизимга кириш
            </Title>
            <Text style={{ color: token.colorTextSecondary, fontSize: 14 }}>
              Mahalla Ovozi — Маҳаллий муаммоларни тезкор мониторинг қилиш тизими
            </Text>
          </div>

          {errorMessage && (
            <Alert
              message={errorMessage}
              type={isNetworkError ? 'warning' : 'error'}
              showIcon
              role="alert"
              aria-live="assertive"
              style={{ borderRadius: token.borderRadius }}
            />
          )}

          <Form
            name="signInForm"
            layout="vertical"
            onFinish={handleSubmit}
            autoComplete="off"
            requiredMark={false}
          >
            <Form.Item
              label={<span style={{ fontWeight: 500, color: token.colorText }}>Фойдаланувчи номи</span>}
              name="username"
              rules={[{ required: true, message: 'Фойдаланувчи номини киритинг!' }]}
            >
              <Input
                prefix={<UserOutlined style={{ color: token.colorPrimary }} />}
                placeholder="Фойдаланувчи номини киритинг"
                id="username-input"
                autoComplete="username"
                disabled={isSigningIn}
                maxLength={64}
                style={{ height: 44, borderRadius: token.borderRadius }}
              />
            </Form.Item>

            <Form.Item
              label={<span style={{ fontWeight: 500, color: token.colorText }}>Парол</span>}
              name="password"
              rules={[{ required: true, message: 'Паролингизни киритинг!' }]}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: token.colorPrimary }} />}
                placeholder="Паролингизни киритинг"
                id="password-input"
                autoComplete="current-password"
                disabled={isSigningIn}
                style={{ height: 44, borderRadius: token.borderRadius }}
              />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
              <Button
                type="primary"
                htmlType="submit"
                loading={isSigningIn}
                id="submit-button"
                style={{
                  width: '100%',
                  height: 44,
                  fontSize: 16,
                  fontWeight: 600,
                  borderRadius: token.borderRadius,
                }}
              >
                Кириш
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
}
