import { Card, Typography, Space, Button, Tag, Descriptions, Divider } from 'antd';
import {
  UserOutlined,
  KeyOutlined,
  SwapOutlined,
  StopOutlined,
  CheckCircleOutlined,
  SafetyCertificateOutlined,
  EditOutlined,
} from '@ant-design/icons';
import type { DistrictHokimAccount } from '@mahalla-ovozi/api-contracts';
import { themeColors } from '../theme/antd-theme.js';

const { Title, Text } = Typography;

interface HokimActiveAccountCardProps {
  account: DistrictHokimAccount;
  isOffline: boolean;
  onEditClick: () => void;
  onResetClick: () => void;
  onReplaceClick: () => void;
  onDisableClick: () => void;
}

export function HokimActiveAccountCard({
  account,
  isOffline,
  onEditClick,
  onResetClick,
  onReplaceClick,
  onDisableClick,
}: HokimActiveAccountCardProps) {
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
              background: themeColors.colorSuccessBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <UserOutlined style={{ fontSize: 24, color: themeColors.colorSuccess }} />
          </div>
          <div>
            <Space align="center" size={8}>
              <Title level={4} style={{ margin: 0 }}>
                {account.username.includes(' ') ? account.username : `@${account.username}`}
              </Title>
              <Tag color="blue" icon={<SafetyCertificateOutlined />}>
                Туман ҳокими
              </Tag>
              <Tag color="success" icon={<CheckCircleOutlined />}>
                Фаол
              </Tag>
            </Space>
            <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 13 }}>
              Туманга бириктирилган ягона расмий ҳоким ҳисоби
            </Text>
          </div>
        </Space>

        <Space wrap size={12}>
          <Button icon={<EditOutlined />} onClick={onEditClick} disabled={isOffline} style={{ height: 44 }}>
            Исмни таҳрирлаш
          </Button>
          <Button icon={<KeyOutlined />} onClick={onResetClick} disabled={isOffline} style={{ height: 44 }}>
            Паролни янгилаш
          </Button>
          <Button icon={<SwapOutlined />} onClick={onReplaceClick} disabled={isOffline} style={{ height: 44 }}>
            Аккаунтни алмаштириш
          </Button>
          <Button danger icon={<StopOutlined />} onClick={onDisableClick} disabled={isOffline} style={{ height: 44 }}>
            Фаолсизлантириш
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
        <Descriptions.Item label="Калит версияси (Версия)">
          <Tag>{account.credentialVersion}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="Ҳолати">
          <Text strong style={{ color: themeColors.colorSuccess }}>Фаол</Text>
        </Descriptions.Item>
        <Descriptions.Item label="Яратилган вақти">
          {new Date(account.createdAt).toLocaleString('uz-UZ')}
        </Descriptions.Item>
        <Descriptions.Item label="Охирги янгиланиш">
          {new Date(account.updatedAt).toLocaleString('uz-UZ')}
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
