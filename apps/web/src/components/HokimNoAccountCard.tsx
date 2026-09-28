import { Card, Typography, Button } from 'antd';
import { UserOutlined, UserAddOutlined } from '@ant-design/icons';
import { themeColors } from '../theme/antd-theme.js';

const { Title, Paragraph } = Typography;

interface HokimNoAccountCardProps {
  isOffline: boolean;
  onCreateClick: () => void;
}

export function HokimNoAccountCard({ isOffline, onCreateClick }: HokimNoAccountCardProps) {
  return (
    <Card
      variant="borderless"
      style={{
        borderRadius: 12,
        boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
        textAlign: 'center',
        padding: '32px 16px',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: themeColors.colorBgEmpty,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0 auto 16px auto',
        }}
      >
        <UserOutlined style={{ fontSize: 32, color: themeColors.colorTextMuted }} />
      </div>

      <Title level={4} style={{ marginBottom: 8 }}>
        Ҳоким аккаунти яратилмаган
      </Title>
      <Paragraph type="secondary" style={{ maxWidth: 500, margin: '0 auto 24px auto' }}>
        Ушбу туман учун ҳали ҳоким аккаунти мавжуд эмас. Туман ҳокими тизимга кириши учун
        янги хавфсиз аккаунт яратинг.
      </Paragraph>

      <Button
        type="primary"
        icon={<UserAddOutlined />}
        onClick={onCreateClick}
        disabled={isOffline}
        style={{ height: 44, paddingInline: 24, fontSize: 15 }}
      >
        Ҳоким аккаунтини яратиш
      </Button>
    </Card>
  );
}
