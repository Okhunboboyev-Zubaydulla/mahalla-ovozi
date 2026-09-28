import React from 'react';
import { Card, Table, Tag, Typography, Empty, Space, Tooltip, theme } from 'antd';
import { Link } from 'react-router-dom';
import type { ColumnsType } from 'antd/es/table';
import {
  DistrictHealthSummary,
  ComponentType,
  HealthStatus,
  ComponentDiagnostics,
} from '@mahalla-ovozi/api-contracts';
import { HealthStatusBadge } from './HealthStatusBadge.js';
import { formatTashkentDate } from '../../lib/formatters.js';

const { Title, Text } = Typography;

export interface DistrictHealthMatrixProps {
  districts: DistrictHealthSummary[];
  loading?: boolean;
  activeDistrictId?: string | null;
}

function getComponentInfo(
  district: DistrictHealthSummary,
  type: ComponentType,
): {
  status: HealthStatus | null;
  isApplicable: boolean;
  diagnostics?: ComponentDiagnostics | null;
} {
  const comp = district.components?.find((c) => c.component === type);
  if (!comp || !comp.isApplicable) {
    return { status: null, isApplicable: false, diagnostics: null };
  }
  return { status: comp.status, isApplicable: true, diagnostics: comp.diagnostics };
}

export const DistrictHealthMatrix: React.FC<DistrictHealthMatrixProps> = ({
  districts,
  loading = false,
  activeDistrictId,
}) => {
  const { token } = theme.useToken();

  const columns: ColumnsType<DistrictHealthSummary> = [
    {
      title: 'Туман',
      key: 'districtName',
      fixed: 'left',
      width: 220,
      render: (_, record) => {
        const isSelected = activeDistrictId === record.districtId;
        const isSuspended = record.lifecycleStatus === 'SUSPENDED';
        const isCancelled = record.lifecycleStatus === 'CANCELLED';

        return (
          <Space direction="vertical" size={2}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text
                strong
                style={{
                  color: isSelected ? token.colorPrimary : token.colorText,
                  fontWeight: isSelected ? 600 : 500,
                }}
              >
                {record.districtName}
              </Text>
              {isSelected && <Tag color="processing">Танланган</Tag>}
            </div>

            {isSuspended && (
              <Text type="warning" style={{ fontSize: 12 }}>
                Обуна тўхтатилган (
                <Link to="/subscriptions" style={{ color: token.colorPrimary }}>
                  Обуналар
                </Link>
                )
              </Text>
            )}

            {isCancelled && (
              <Text type="danger" style={{ fontSize: 12 }}>
                Обуна бекор қилинган (
                <Link to="/subscriptions" style={{ color: token.colorPrimary }}>
                  Обуналар
                </Link>
                )
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Умумий ҳолат',
      dataIndex: 'status',
      key: 'status',
      width: 160,
      render: (status: HealthStatus) => <HealthStatusBadge status={status} size="small" />,
    },
    {
      title: 'Telegram бот',
      key: 'telegram_bot',
      width: 140,
      render: (_, record) => {
        const { status, isApplicable, diagnostics } = getComponentInfo(record, 'telegram_bot');
        if (!isApplicable || !status) {
          return <Text type="secondary" style={{ fontSize: 12 }}>Қўлланилмайди</Text>;
        }
        const tooltip = diagnostics?.lastValidatedAt
          ? `Сўнгги текширув: ${formatTashkentDate(diagnostics.lastValidatedAt)}`
          : undefined;
        return (
          <Tooltip title={tooltip}>
            <span>
              <HealthStatusBadge status={status} size="small" />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Telegram гуруҳлар',
      key: 'telegram_groups',
      width: 150,
      render: (_, record) => {
        const { status, isApplicable, diagnostics } = getComponentInfo(record, 'telegram_groups');
        if (!isApplicable || !status) {
          return <Text type="secondary" style={{ fontSize: 12 }}>Қўлланилмайди</Text>;
        }
        const tooltip =
          diagnostics?.connectedGroupsCount !== undefined
            ? `Жами: ${diagnostics.connectedGroupsCount}, Фаол: ${diagnostics.activeGroupsCount || 0}, Хатолик: ${diagnostics.failedGroupsCount || 0}`
            : undefined;
        return (
          <Tooltip title={tooltip}>
            <span>
              <HealthStatusBadge status={status} size="small" />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Хабарлар қабули',
      key: 'message_intake',
      width: 150,
      render: (_, record) => {
        const { status, isApplicable, diagnostics } = getComponentInfo(record, 'message_intake');
        if (!isApplicable || !status) {
          return <Text type="secondary" style={{ fontSize: 12 }}>Қўлланилмайди</Text>;
        }
        const tooltip = diagnostics?.lastMessageReceivedAt
          ? `Сўнгги хабар: ${formatTashkentDate(diagnostics.lastMessageReceivedAt)}`
          : undefined;
        return (
          <Tooltip title={tooltip}>
            <span>
              <HealthStatusBadge status={status} size="small" />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'АИ операциялари',
      key: 'ai_operations',
      width: 150,
      render: (_, record) => {
        const { status, isApplicable, diagnostics } = getComponentInfo(record, 'ai_operations');
        if (!isApplicable || !status) {
          return <Text type="secondary" style={{ fontSize: 12 }}>Қўлланилмайди</Text>;
        }
        const tooltip = diagnostics?.activeModelVersion
          ? `Модель: ${diagnostics.activeModelVersion}${diagnostics.activePromptVersion ? ` (${diagnostics.activePromptVersion})` : ''}`
          : undefined;
        return (
          <Tooltip title={tooltip}>
            <span>
              <HealthStatusBadge status={status} size="small" />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Маълумотлар муддати',
      key: 'district_retention',
      width: 150,
      render: (_, record) => {
        const { status, isApplicable } = getComponentInfo(record, 'district_retention');
        if (!isApplicable || !status) {
          return <Text type="secondary" style={{ fontSize: 12 }}>Қўлланилмайди</Text>;
        }
        return <HealthStatusBadge status={status} size="small" />;
      },
    },
    {
      title: 'Сўнгги текширув',
      dataIndex: 'lastCheckAt',
      key: 'lastCheckAt',
      width: 170,
      render: (lastCheckAt: string) => (
        <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          {formatTashkentDate(lastCheckAt)}
        </Text>
      ),
    },
  ];

  return (
    <Card
      variant="borderless"
      style={{
        borderRadius: 12,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary || '#E2EAE7'}`,
      }}
      styles={{ body: { padding: '20px 24px' } }}
    >
      <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
        Туманлар ҳолати матрицаси
      </Title>

      {districts.length === 0 && !loading ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Ҳозирча туманлар мавжуд эмас"
          style={{ margin: '32px 0' }}
        />
      ) : (
        <Table<DistrictHealthSummary>
          rowKey="districtId"
          columns={columns}
          dataSource={districts}
          loading={loading}
          pagination={false}
          size="middle"
          scroll={{ x: 1290 }}
          rowClassName={(record) =>
            activeDistrictId === record.districtId ? 'ant-table-row-selected' : ''
          }
        />
      )}
    </Card>
  );
};
