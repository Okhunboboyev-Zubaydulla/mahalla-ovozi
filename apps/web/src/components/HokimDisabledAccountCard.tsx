import { Card, Typography, Space, Button, Tag, Descriptions, Divider } from 'antd';
import {
  StopOutlined,
  SwapOutlined,
  UserAddOutlined,
  CloseCircleOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { DistrictHokimAccount } from '@mahalla-ovozi/api-contracts';
import { themeColors } from '../theme/antd-theme.js';

const { Title, Text } = Typography;

interface HokimDisabledAccountCardProps {
  account: DistrictHokimAccount;
  isOffline: boolean;
  onReplaceClick: () => void;
  onCreateClick: () => void;
}

export function HokimDisabledAccountCard({
  account,
  isOffline,
  onReplaceClick,
  onCreateClick,
}: HokimDisabledAccountCardProps) {
  return (
    <Card
      variant="borderless"
      style={{ borderRadius: 12, boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <Space align="center" size={16}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 8,
              background: themeColors.colorErrorBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <StopOutlined style={{ fontSize: 24, color: themeColors.colorError }} />
          </div>
          <div>
            <Space align="center" size={8}>
              <Title level={4} style={{ margin: 0, color: themeColors.colorTextMuted }}>
                @{account.username}
              </Title>
              <Tag color="default" icon={<SafetyCertificateOutlined />}>
                Туман ҳокими
              </Tag>
              <Tag color="error" icon={<CloseCircleOutlined />}>
                Фаолсизлантирилган
              </Tag>
            </Space>
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
              Ушбу аккаунт ҳозирда фаол эмас ва тизимга кириш ҳуқуқи чекланган
            </Text>
          </div>
        </Space>

        <Space wrap size={12}>
          <Button type="primary" icon={<SwapOutlined />} onClick={onReplaceClick} disabled={isOffline} style={{ height: 44 }}>
            Аккаунтни алмаштириш
          </Button>
          <Button icon={<UserAddOutlined />} onClick={onCreateClick} disabled={isOffline} style={{ height: 44 }}>
            Янги аккаунт яратиш
          </Button>
        </Space>
      </div>

      <Divider style={{ margin: '16px 0' }} />

      <Descriptions
        bordered
        size="small"
        column={{ xs: 1, sm: 2, md: 3 }}
        style={{ background: themeColors.colorBgSubtle, borderRadius: 8 }}
      >
        <Descriptions.Item label="Аккаунт ID">
          <Text copyable style={{ fontSize: 13 }}>{account.id}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Ҳолати">
          <Text strong type="danger">Фаолсизлантирилган</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Фаолсизлантирилган вақти">
          {new Date(account.updatedAt).toLocaleString('uz-UZ')}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
