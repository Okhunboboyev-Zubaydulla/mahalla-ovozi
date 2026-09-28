import React from 'react';
import { Table, Typography, Button, Empty, theme } from 'antd';
import { EditOutlined, EyeOutlined } from '@ant-design/icons';
import { DistrictSubscription } from '@mahalla-ovozi/api-contracts';
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge.js';
import { formatTashkentDate, formatScheduledTransitionType } from '../../lib/formatters.js';

const { Text } = Typography;

export interface DistrictSubscriptionTableProps {
  subscriptions: DistrictSubscription[];
  loading?: boolean;
  onSelectDistrict?: (districtId: string) => void;
  onEditSubscription?: (subscription: DistrictSubscription) => void;
  onStartGrace?: (subscription: DistrictSubscription) => void;
  onRestoreActive?: (subscription: DistrictSubscription) => void;
  onCancelDistrict?: (subscription: DistrictSubscription) => void;
  onStartRecovery?: (subscription: DistrictSubscription) => void;
  isOffline?: boolean;
}

export const DistrictSubscriptionTable: React.FC<DistrictSubscriptionTableProps> = ({
  subscriptions,
  loading = false,
  onSelectDistrict,
  onEditSubscription,
  onStartGrace,
  onRestoreActive,
  onCancelDistrict,
  onStartRecovery,
  isOffline = false,
}) => {
  const { token } = theme.useToken();

  const columns = [
    {
      title: 'Туман номи',
      dataIndex: 'districtName',
      key: 'districtName',
      render: (_: unknown, record: DistrictSubscription) => (
        <div style={{ wordBreak: 'break-word' }}>
          <Text strong>{record.districtName}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.region ? `${record.region} • ` : ''}ID: {record.districtId}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: 'Обуна ҳолати',
      dataIndex: 'status',
      key: 'status',
      render: (status: DistrictSubscription['status']) => (
        <SubscriptionStatusBadge status={status} />
      ),
    },
    {
      title: 'Ҳолат бошланган вақт',
      dataIndex: 'statusStartedAt',
      key: 'statusStartedAt',
      render: (statusStartedAt: string) => (
        <Text style={{ wordBreak: 'break-word', whiteSpace: 'nowrap' }}>
          {formatTashkentDate(statusStartedAt)}
        </Text>
      ),
    },
    {
      title: 'Кейинги режали ўзгариш',
      key: 'scheduledTransition',
      render: (_: unknown, record: DistrictSubscription) => (
        <Text style={{ wordBreak: 'break-word', whiteSpace: 'nowrap' }}>
          {record.scheduledTransitionAt
            ? `${formatTashkentDate(record.scheduledTransitionAt)}${
                record.scheduledTransitionType
                  ? ` (${formatScheduledTransitionType(record.scheduledTransitionType)})`
                  : ''
              }`
            : record.scheduledTransitionType
            ? `(${formatScheduledTransitionType(record.scheduledTransitionType)})`
            : '—'}
        </Text>
      ),
    },
    {
      title: 'Ташқи тўлов маълумотномаси',
      dataIndex: 'externalPaymentReference',
      key: 'externalPaymentReference',
      render: (ref?: string | null) => (
        <Text style={{ wordBreak: 'break-word' }}>{ref || '—'}</Text>
      ),
    },
    {
      title: 'Амаллар',
      key: 'actions',
      render: (_: unknown, record: DistrictSubscription) => (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {onSelectDistrict && (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => onSelectDistrict(record.districtId)}
            >
              Батафсил
            </Button>
          )}

          {record.status === 'ACTIVE' && onStartGrace && (
            <Button
              type="link"
              size="small"
              danger
              onClick={() => onStartGrace(record)}
              disabled={isOffline}
            >
              Имтиёзли давр (Grace)
            </Button>
          )}

          {(record.status === 'GRACE' || record.status === 'SUSPENDED') && onRestoreActive && (
            <Button
              type="link"
              size="small"
              onClick={() => onRestoreActive(record)}
              disabled={isOffline}
              style={isOffline ? undefined : { color: token.colorSuccess }}
            >
              Фаоллаштириш
            </Button>
          )}

          {['ACTIVE', 'GRACE', 'SUSPENDED'].includes(record.status) && onCancelDistrict && (
            <Button
              type="link"
              size="small"
              danger
              onClick={() => onCancelDistrict(record)}
              disabled={isOffline}
            >
              Бекор қилиш
            </Button>
          )}

          {record.status === 'CANCELLED' && onStartRecovery && (
            <Button
              type="link"
              size="small"
              onClick={() => onStartRecovery(record)}
              disabled={
                isOffline ||
                (record.scheduledTransitionAt
                  ? new Date(record.scheduledTransitionAt) <= new Date()
                  : true)
              }
              style={isOffline ? undefined : { color: token.colorPrimary }}
            >
              Тиклаш
            </Button>
          )}

          {onEditSubscription && (
            <Button
              type="link"
              size="small"
              icon={<EditOutlined />}
              onClick={() => onEditSubscription(record)}
              disabled={isOffline}
            >
              Таҳрирлаш
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Table<DistrictSubscription>
      rowKey="districtId"
      dataSource={subscriptions}
      columns={columns}
      loading={loading}
      pagination={false}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Ҳозирча туманлар мавжуд эмас"
          />
        ),
      }}
      scroll={{ x: 'max-content' }}
      style={{
        backgroundColor: token.colorBgContainer,
        borderRadius: token.borderRadiusLG,
      }}
    />
  );
};
