import React, { Suspense } from 'react';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';
import {
  Layout,
  Menu,
  Button,
  Tag,
  Typography,
  Alert,
  Space,
  theme,
} from 'antd';
import {
  AppstoreOutlined,
  HeartOutlined,
  ApartmentOutlined,
  SendOutlined,
  CreditCardOutlined,
  UserOutlined,
  RobotOutlined,
  HistoryOutlined,
  LogoutOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { useDistrict, DISTRICT_STORAGE_KEY } from '../district/district-context.js';
import { DistrictSelector } from './DistrictSelector.js';
import { UnsavedChangesModal } from './UnsavedChangesModal.js';
import { FullPageLoader } from './FullPageLoader.js';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const MENU_ITEMS = [
  {
    key: '/',
    icon: <AppstoreOutlined />,
    label: 'Умумий кўриниш',
  },
  {
    key: '/system-health',
    icon: <HeartOutlined />,
    label: 'Тизим ҳолати',
  },
  {
    key: '/districts',
    icon: <ApartmentOutlined />,
    label: 'Туманлар',
  },
  {
    key: '/telegram-setup',
    icon: <SendOutlined />,
    label: 'Телеграм созламалари',
  },
  {
    key: '/subscriptions',
    icon: <CreditCardOutlined />,
    label: 'Обуналар',
  },
  {
    key: '/hokim-accounts',
    icon: <UserOutlined />,
    label: 'Ҳоким ҳисоблари',
  },
  {
    key: '/ai-operations',
    icon: <RobotOutlined />,
    label: 'АИ операциялари',
  },
  {
    key: '/audit-history',
    icon: <HistoryOutlined />,
    label: 'Аудит тарихи',
  },
];

export const ConsoleLayout: React.FC = () => {
  const { token } = theme.useToken();
  const { actor, signOut } = useAuth();
  const { activeDistrictId, attemptTransition } = useDistrict();
  const navigate = useNavigate();
  const location = useLocation();

  const isOffline = useOnlineStatus();

  const handleMenuClick = ({ key }: { key: string }) => {
    if (key !== location.pathname) {
      attemptTransition(() => {
        const search = activeDistrictId ? `?districtId=${encodeURIComponent(activeDistrictId)}` : '';
        navigate(`${key}${search}`);
      });
    }
  };

  const handleSignOut = () => {
    attemptTransition(async () => {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(DISTRICT_STORAGE_KEY);
      }
      await signOut();
      navigate('/sign-in');
    });
  };

  // Determine current active menu key
  const selectedKey = MENU_ITEMS.some((item) => item.key === location.pathname)
    ? location.pathname
    : '/';

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgLayout }}>
      {/* 1. Persistent Top Header */}
      <Header
        style={{
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorder}`,
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 64,
          position: 'sticky',
          top: 0,
          zIndex: 1000,
        }}
      >
        <Space direction="horizontal" size="large" align="center">
          {/* P5-H: Uzbek Cyrillic wordmark */}
          <Text
            strong
            style={{
              fontSize: 18,
              color: token.colorPrimary,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
            }}
            onClick={() => handleMenuClick({ key: '/' })}
          >
            Маҳалла Овози
          </Text>

          {/* District context switcher in persistent header */}
          <DistrictSelector
            onOpenCreateDrawer={() => {
              attemptTransition(() => {
                navigate('/districts?action=create');
              });
            }}
          />
        </Space>

        <Space direction="horizontal" size="middle" align="center">
          {actor && (
            <Tag color="cyan" style={{ fontSize: 13, padding: '4px 10px', borderRadius: 6 }}>
              {actor.username} ({actor.role === 'DISTRICT_HOKIM' ? 'Туман ҳокими' : 'Масъул ходим'})
            </Tag>
          )}

          <Button
            id="sign-out-button"
            type="text"
            icon={<LogoutOutlined />}
            onClick={handleSignOut}
            style={{ color: token.colorTextSecondary }}
          >
            Чиқиш
          </Button>
        </Space>
      </Header>

      {/* P4-G: Offline notification banner */}
      {isOffline && (
        <Alert
          message="Сервер билан алоқа мавжуд эмас. Тармоқни текширинг."
          type="warning"
          banner
          showIcon
          style={{ textAlign: 'center' }}
        />
      )}

      {/* 2. Main Shell Layout */}
      <Layout>
        {/* Persistent 8-section Sidebar */}
        <Sider
          width={240}
          breakpoint="lg"
          collapsedWidth="0"
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorder}`,
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            onClick={handleMenuClick}
            items={MENU_ITEMS}
            style={{ borderRight: 0, padding: '12px 0' }}
          />
        </Sider>

        {/* Content Outlet for Nested Routes */}
        <Content style={{ padding: 24, minHeight: 'calc(100vh - 64px)' }}>
          <Suspense fallback={<FullPageLoader />}>
            <Outlet />
          </Suspense>
        </Content>
      </Layout>

      {/* P4-D: Single Unsaved Changes Modal */}
      <UnsavedChangesModal />
    </Layout>
  );
};
