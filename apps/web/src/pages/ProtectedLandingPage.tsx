import { useNavigate } from 'react-router-dom';
import { Layout, Typography, Button, Space, Card, Tag, theme, notification } from 'antd';
import { LogoutOutlined, UserOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/auth-context.js';
import { ApiError } from '../auth/auth-client.js';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

export function ProtectedLandingPage() {
  const { actor, signOut, isSigningOut } = useAuth();
  const navigate = useNavigate();
  // F1: Consume design tokens — no hardcoded hex values.
  const { token } = theme.useToken();
  const [notificationApi, notificationContextHolder] = notification.useNotification();

  const handleSignOut = async () => {
    try {
      await signOut();
      navigate('/sign-in', { replace: true });
    } catch (err) {
      // F2: Sign-out failed (network error) — the server session may still be active.
      // Inform the user rather than silently pretending logout succeeded.
      const isNetworkErr = err instanceof ApiError && err.isNetworkError;
      if (isNetworkErr) {
        notificationApi.warning({
          message: 'Чиқиш амалга ошмади',
          description: 'Сервер билан алоқа мавжуд эмас. Тармоқни текширинг ва қайта уриниб кўринг.',
          duration: 8,
        });
      } else {
        // Non-network error — local state was cleared, navigate to sign-in anyway
        navigate('/sign-in', { replace: true });
      }
    }
  };

  return (
    <>
      {notificationContextHolder}
      <Layout style={{ minHeight: '100vh', backgroundColor: token.colorBgLayout }}>
        <Header
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: token.colorBgContainer,
            padding: '0 24px',
            borderBottom: `1px solid ${token.colorBorder}`,
            height: 64,
          }}
        >
          <Space align="center" size="middle">
            <SafetyCertificateOutlined style={{ fontSize: 24, color: token.colorPrimary }} />
            <Title level={4} style={{ margin: 0, color: token.colorPrimary }}>
              Mahalla Ovozi
            </Title>
          </Space>

          <Space size="middle">
            <Tag icon={<UserOutlined />} color={token.colorPrimary}>
              {actor?.username} ({actor?.role === 'PRODUCT_OWNER' ? 'Маҳсулот эгаси' : actor?.role})
            </Tag>
            <Button
              type="default"
              icon={<LogoutOutlined />}
              onClick={handleSignOut}
              loading={isSigningOut}
              id="sign-out-button"
              style={{ borderRadius: token.borderRadius }}
            >
              Чиқиш
            </Button>
          </Space>
        </Header>

        <Content style={{ padding: '32px 24px', maxWidth: 1000, margin: '0 auto', width: '100%' }}>
          <Card
            style={{
              borderRadius: token.borderRadiusLG,
              boxShadow: token.boxShadowTertiary,
              border: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <Title level={3} style={{ color: token.colorText, marginTop: 0 }}>
              Масъул ходим бошқарув панели
            </Title>
            <Text style={{ fontSize: 16, color: token.colorTextSecondary, display: 'block', marginBottom: 24 }}>
              Сиз тизимга хавфсиз тарзда киргансиз.
            </Text>

            <div
              style={{
                padding: 16,
                backgroundColor: token.colorBgLayout,
                borderRadius: token.borderRadius,
                border: `1px solid ${token.colorBorder}`,
              }}
            >
              <Text strong style={{ color: token.colorText }}>
                Сессия маълумотлари:
              </Text>
              <ul style={{ marginTop: 8, marginBottom: 0, color: token.colorTextSecondary, paddingLeft: 20 }}>
                <li>
                  <strong>Фойдаланувчи ID:</strong> {actor?.id}
                </li>
                <li>
                  <strong>Фойдаланувчи номи:</strong> {actor?.username}
                </li>
                <li>
                  <strong>Роль:</strong> {actor?.role}
                </li>
              </ul>
            </div>
          </Card>
        </Content>
      </Layout>
    </>
  );
}
