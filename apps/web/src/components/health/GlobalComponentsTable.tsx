import React from 'react';
import { Card, Table, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ComponentHealthObservation,
  ComponentType,
} from '@mahalla-ovozi/api-contracts';
import { HealthStatusBadge } from './HealthStatusBadge.js';
import { formatTashkentDate } from '../../lib/formatters.js';

const { Title, Text } = Typography;

export interface GlobalComponentsTableProps {
  components: ComponentHealthObservation[];
  loading?: boolean;
}

const COMPONENT_LABEL_MAP: Record<ComponentType, { name: string; description: string }> = {
  database: {
    name: 'Маълумотлар базаси',
    description: 'PostgreSQL асосий база ва уланиш ҳовузи',
  },
  processing_queue: {
    name: 'Навбат тизими',
    description: 'pg-boss вазифалар навбати ва режалаштирувчи',
  },
  storage: {
    name: 'Сақлаш тизими',
    description: 'Маълумотларни сақлаш ва файл тизими',
  },
  web_application: {
    name: 'Веб илова',
    description: 'Fastify сервер ва Node.js ижро муҳити',
  },
  retention_jobs: {
    name: 'Маълумотларни сақлаш муддати',
    description: 'Автоматик тозалаш ва архивлаш вазифалари',
  },
  scheduled_deletion: {
    name: 'Режалаштирилган ўчириш тизими',
    description: 'Муддати тугаган маълумотларни режали тозалаш навбати',
  },
  telegram_bot: {
    name: 'Telegram бот',
    description: 'Туман расмий боти',
  },
  telegram_groups: {
    name: 'Telegram гуруҳлар',
    description: 'Маҳалла гуруҳлари интеграцияси',
  },
  message_intake: {
    name: 'Хабарлар қабули',
    description: 'Аҳоли хабарларини қабул қилиш оқими',
  },
  ai_operations: {
    name: 'АИ операциялари',
    description: 'Сунъий интеллект таҳлил жараёнлари',
  },
  district_retention: {
    name: 'Туман маълумотлари муддати',
    description: 'Туман доирасида сақлаш муддати',
  },
};

export const GlobalComponentsTable: React.FC<GlobalComponentsTableProps> = ({
  components,
  loading = false,
}) => {
  const { token } = theme.useToken();

  const columns: ColumnsType<ComponentHealthObservation> = [
    {
      title: 'Компонент',
      dataIndex: 'component',
      key: 'component',
      render: (component: ComponentType) => {
        const info = COMPONENT_LABEL_MAP[component] || {
          name: component,
          description: '',
        };
        return (
          <div>
            <Text strong style={{ display: 'block', color: token.colorText }}>
              {info.name}
            </Text>
            {info.description && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {info.description}
              </Text>
            )}
          </div>
        );
      },
    },
    {
      title: 'Қамров',
      dataIndex: 'scope',
      key: 'scope',
      width: 120,
      render: () => <Tag color="blue">Глобал</Tag>,
    },
    {
      title: 'Ҳолат',
      dataIndex: 'status',
      key: 'status',
      width: 180,
      render: (status) => <HealthStatusBadge status={status} size="small" />,
    },
    {
      title: 'Кечикиш / Тафсилотлар',
      key: 'details',
      render: (_, record) => {
        if (record.errorMessage) {
          return (
            <Text type="danger" style={{ fontSize: 12 }}>
              {record.errorMessage}
            </Text>
          );
        }
        const parts: string[] = [];
        if (record.latencyMs !== null && record.latencyMs !== undefined) {
          parts.push(`${record.latencyMs} ms`);
        }
        if (record.diagnostics?.databaseSize) {
          parts.push(`Ҳажм: ${record.diagnostics.databaseSize}`);
        }
        if (record.diagnostics?.queueDepth !== undefined && record.diagnostics.queueDepth > 0) {
          parts.push(`Навбат: ${record.diagnostics.queueDepth}`);
        }
        if (record.diagnostics?.waitingConnectionCount !== undefined && record.diagnostics.waitingConnectionCount > 0) {
          parts.push(`Кутаётган: ${record.diagnostics.waitingConnectionCount}`);
        }

        if (parts.length > 0) {
          return (
            <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
              {parts.join(' • ')}
            </Text>
          );
        }
        return <Text type="secondary">-</Text>;
      },
    },
    {
      title: 'Сўнгги текширув',
      dataIndex: 'lastCheckAt',
      key: 'lastCheckAt',
      width: 180,
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
        marginBottom: 24,
      }}
      styles={{ body: { padding: '20px 24px' } }}
    >
      <Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
        Глобал платформа компонентлари
      </Title>
      <Table<ComponentHealthObservation>
        rowKey="component"
        columns={columns}
        dataSource={components}
        loading={loading}
        pagination={false}
        size="middle"
        scroll={{ x: 750 }}
      />
    </Card>
  );
};
